// wave-phone is the core as the phones run it, on Linux, for the end-to-end
// tests: every call goes through wavemobile -- the surface gomobile binds and
// the iOS extension and Android service call -- with a TUN descriptor, the
// settings as JSON and the state as bytes, exactly as the platforms see them.
//
// What a person does in the app arrives as lines on a command pipe, so a test
// script can do the same: join, cancel, pause, resume, leave, rename, and say
// the network changed. The status goes to a file every second, the shape the
// app decodes.
//
//	wave-phone --dev wave0 --state state.json --status status.json --commands pipe
//
// Commands, one per line:
//
//	login <control-url> [auth-key]   join a wave (blocks until approved)
//	add <control-url> [auth-key]     join a further wave at a server already joined
//	cancel <control-url>             give up on a login waiting for approval
//	pause <wave-id>                  switch a wave off without leaving it
//	resume <wave-id>                 switch it back on
//	logout <wave-id>                 leave a wave
//
// A wave id is the "id" in the status: the server's address for the first
// wave there, and an id of its own for every further one.
//
//	hostname <name>                  the name the next enrolment asks for
//	network                          the platform saw the network change
//	wake                             the platform woke from sleep
//
// Each finished command logs "command <line>: ok" or "command <line>: <error>".
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"

	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavemobile"
	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavesettings"
)

func main() {
	var (
		statePath = flag.String("state", "wave-state.json", "where the enrolments are kept")
		device    = flag.String("dev", "wave0", "the TUN interface to create")
		statusOut = flag.String("status", "", "write the status as JSON here, once a second")
		commands  = flag.String("commands", "", "a named pipe to read commands from")
		hostname  = flag.String("hostname", "phone", "the name enrolments ask for")
		platform  = flag.String("platform", "ios", "what the hello says this device is")
		version   = flag.String("version", "0.0.0-e2e", "what the hello says this build is")
	)
	flag.Parse()
	logger := log.New(os.Stdout, "", log.Ltime)
	if err := run(logger, *statePath, *device, *statusOut, *commands, *hostname, *platform, *version); err != nil {
		logger.Printf("wave-phone failed: %v", err)
		os.Exit(1)
	}
}

func run(logger *log.Logger, statePath, device, statusOut, commands, hostname, platform, version string) error {
	stored, err := os.ReadFile(statePath)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	fd, err := openTUN(device)
	if err != nil {
		return err
	}
	logger.Printf("%s created", device)

	callbacks := &phoneHost{device: device, statePath: statePath, logger: logger}
	core, err := wavemobile.New(string(stored), hostname, false, "", callbacks)
	if err != nil {
		return err
	}
	core.SetClientInfo(platform, version)
	if err := core.Start(fd, false, wavesettings.DefaultMTU); err != nil {
		return err
	}
	defer core.Stop()
	logger.Printf("core running")

	if commands != "" {
		go readCommands(logger, core, commands)
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			logger.Printf("stopping")
			return nil
		case <-ticker.C:
			if statusOut != "" {
				writeStatus(logger, statusOut, core.Status())
			}
		}
	}
}

// readCommands runs every line of the pipe in its own goroutine: a login
// blocks until somebody approves, and the cancel that ends it has to get
// through meanwhile -- the same as on the phone, where the app asks the
// extension while a login is pending.
func readCommands(logger *log.Logger, core *wavemobile.Core, path string) {
	// Read-write, so the pipe never reports end-of-file between writers.
	pipe, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		logger.Printf("could not open the command pipe: %v", err)
		return
	}
	scanner := bufio.NewScanner(pipe)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		go func() {
			err := execute(core, strings.Fields(line))
			if err != nil {
				logger.Printf("command %s: %v", line, err)
				return
			}
			logger.Printf("command %s: ok", line)
		}()
	}
}

func execute(core *wavemobile.Core, words []string) error {
	argument := func(i int) string {
		if i < len(words) {
			return words[i]
		}
		return ""
	}
	switch words[0] {
	case "login":
		return core.Login(argument(1), argument(2))
	case "add":
		return core.AddWave(argument(1), argument(2))
	case "cancel":
		core.CancelLogin(argument(1))
		return nil
	case "pause":
		return core.SetEnabled(argument(1), false)
	case "resume":
		return core.SetEnabled(argument(1), true)
	case "logout":
		return core.Logout(argument(1))
	case "hostname":
		core.SetHostname(strings.Join(words[1:], " "))
		return nil
	case "network":
		core.NetworkChanged()
		return nil
	case "wake":
		core.Woke()
		return nil
	}
	return fmt.Errorf("unknown command %q", words[0])
}

func writeStatus(logger *log.Logger, path, payload string) {
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, []byte(payload+"\n"), 0o644); err != nil {
		logger.Printf("could not write the status: %v", err)
		return
	}
	if err := os.Rename(temporary, path); err != nil {
		logger.Printf("could not write the status: %v", err)
	}
}

// phoneHost is the platform half: what the iOS extension and the Android
// service implement, here with ip(8) instead of NEPacketTunnelNetworkSettings.
type phoneHost struct {
	device    string
	statePath string
	logger    *log.Logger

	mu         sync.Mutex
	applied    wavesettings.Settings
	hasApplied bool
	count      int
}

// ApplySettings takes the JSON the platforms take, decodes it the way they do
// and applies it. Counted, so a test can see whether something re-applied.
func (h *phoneHost) ApplySettings(settingsJSON string) error {
	var settings wavesettings.Settings
	if err := json.Unmarshal([]byte(settingsJSON), &settings); err != nil {
		return fmt.Errorf("the settings JSON does not decode: %w", err)
	}
	h.mu.Lock()
	previous, had := h.applied, h.hasApplied
	h.applied, h.hasApplied = settings, true
	h.count++
	count := h.count
	h.mu.Unlock()

	if err := h.ip("link", "set", "dev", h.device, "mtu", fmt.Sprint(settings.MTU), "up"); err != nil {
		return err
	}
	for _, address := range settings.Addresses {
		if err := h.ip("addr", "replace", address, "dev", h.device); err != nil {
			return fmt.Errorf("address %s: %w", address, err)
		}
	}
	for _, route := range settings.Routes {
		arguments := []string{"route", "replace", route.CIDR, "dev", h.device}
		if route.Source != "" {
			arguments = append(arguments, "src", route.Source)
		}
		if err := h.ip(arguments...); err != nil {
			return fmt.Errorf("route %s: %w", route.CIDR, err)
		}
	}
	if had {
		wanted := map[string]bool{}
		for _, route := range settings.Routes {
			wanted[route.CIDR] = true
		}
		for _, route := range previous.Routes {
			if !wanted[route.CIDR] {
				_ = h.ip("route", "del", route.CIDR, "dev", h.device)
			}
		}
		addresses := map[string]bool{}
		for _, address := range settings.Addresses {
			addresses[address] = true
		}
		for _, address := range previous.Addresses {
			if !addresses[address] {
				_ = h.ip("addr", "del", address, "dev", h.device)
			}
		}
	}
	h.logger.Printf("applied #%d: %d address(es), %d route(s), dns %s for %s",
		count, len(settings.Addresses), len(settings.Routes),
		strings.Join(settings.DNSServers, ","), strings.Join(settings.MatchDomains, ","))
	return nil
}

func (h *phoneHost) Log(line string) { h.logger.Print(line) }

func (h *phoneHost) SaveState(encoded []byte) {
	if err := os.MkdirAll(filepath.Dir(h.statePath), 0o700); err != nil {
		h.logger.Printf("could not make the state directory: %v", err)
		return
	}
	if err := os.WriteFile(h.statePath, encoded, 0o600); err != nil {
		h.logger.Printf("could not write the state: %v", err)
	}
}

func (h *phoneHost) OpenAuthURL(url string) { h.logger.Printf("open this link: %s", url) }

func (h *phoneHost) ProtectSocket(int) bool { return true }

func (h *phoneHost) ip(arguments ...string) error {
	output, err := exec.Command("ip", arguments...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("ip %s: %w: %s", strings.Join(arguments, " "), err, strings.TrimSpace(string(output)))
	}
	return nil
}

// openTUN creates the interface and hands back its descriptor, the way the
// platforms hand one to the core: no packet information, non-blocking.
func openTUN(name string) (int, error) {
	fd, err := unix.Open("/dev/net/tun", unix.O_RDWR|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, fmt.Errorf("open /dev/net/tun: %w", err)
	}
	var request struct {
		name  [unix.IFNAMSIZ]byte
		flags uint16
		pad   [22]byte
	}
	copy(request.name[:], name)
	request.flags = unix.IFF_TUN | unix.IFF_NO_PI
	if _, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(fd), uintptr(unix.TUNSETIFF), uintptr(unsafe.Pointer(&request))); errno != 0 {
		unix.Close(fd)
		return -1, fmt.Errorf("TUNSETIFF %s: %w", name, errno)
	}
	return fd, nil
}
