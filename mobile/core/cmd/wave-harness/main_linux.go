//go:build linux

// Command wave-harness runs the mobile core on Linux, against a real TUN
// device.
//
// It exists because the core is the part that decides things and the phones are
// the part that cannot be tested here. Everything above the tunnel descriptor
// is the same code that runs on a phone -- the demultiplexer sorting two waves
// into one interface, N WireGuard devices, the resolver answering on the tunnel
// with no socket of its own, one UDP port for every wave. This binary supplies
// the two things a phone would: a descriptor, and something that applies the
// settings the core computes.
//
// It is a test harness and says so: settings are applied by shelling out to
// `ip`, which is what the platform hosts do through their own APIs. Nobody
// should ship this; it is what makes `test/e2e/mobile-core.sh` possible.
package main

import (
	"context"
	"errors"
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

	"github.com/pinguin45orga/wave-mesh/mobile/core/waveengine"
	"github.com/pinguin45orga/wave-mesh/mobile/core/wavesettings"
)

func main() {
	var (
		statePath = flag.String("state", "wave-state.json", "where the enrolments are kept")
		device    = flag.String("dev", "wave0", "the TUN interface to create")
		authKey   = flag.String("auth-key", "", "a pre-auth key, for joining without a browser")
		mtu       = flag.Int("mtu", wavesettings.DefaultMTU, "tunnel MTU")
		statusOut = flag.String("status", "", "write the status as JSON here, once a second")
		resolver  = flag.String("resolver", "", "answer DNS here instead of at the address the netmap reserves")
		controls  controlList
	)
	// Repeatable, because a device can be in several waves and there is only
	// one of this process: the interface belongs to it, so a second invocation
	// could not take it even to enrol. On a phone the app calls Login again on
	// the core it already has, which is what this reproduces.
	flag.Var(&controls, "control", "a control server to join (may be given more than once)")
	flag.Parse()

	logger := log.New(os.Stdout, "", log.Ltime)
	if err := run(logger, *statePath, *device, controls, *authKey, *mtu, *statusOut, *resolver); err != nil {
		logger.Printf("harness failed: %v", err)
		os.Exit(1)
	}
}

// controlList collects a repeated --control flag.
type controlList []string

func (c *controlList) String() string { return strings.Join(*c, ",") }

func (c *controlList) Set(value string) error {
	*c = append(*c, value)
	return nil
}

func run(logger *log.Logger, statePath, device string, controls []string, authKey string, mtu int, statusOut, resolver string) error {
	stored, err := os.ReadFile(statePath)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	state, err := waveengine.ParseState(stored)
	if err != nil {
		return err
	}

	link, err := openTUN(device)
	if err != nil {
		return err
	}
	logger.Printf("%s created", device)

	host := &linuxHost{device: device, statePath: statePath, logger: logger}
	engine := waveengine.New(waveengine.Options{
		Host:     host,
		State:    state,
		Hostname: hostname(),
		// The resolver is reachable on the wave addresses, and nothing here
		// touches /etc/resolv.conf: what a test wants is to ask it directly,
		// and what a phone does is the platform's business. So no forwarding
		// either -- a name outside the waves is not ours.
		SystemWideDNS: false,
		// On Linux there is nothing to protect a socket from: only the wave's
		// own prefixes are routed into the tunnel, so our UDP to a peer never
		// enters it. Android is where this matters.
		Protect: nil,
		// Normally empty: the wave reserves one and the netmap carries it. The
		// flag is for trying another, not for making one up.
		ResolverAddress: resolver,
	})
	host.engine = engine

	if err := engine.Start(link, mtu); err != nil {
		return err
	}
	defer engine.Stop()

	if len(controls) > 0 {
		// One at a time: each waits for somebody to approve the device, and two
		// links printed at once would be two things to tell apart for no gain.
		go func() {
			for _, control := range controls {
				if err := engine.Login(context.Background(), control, authKey); err != nil {
					logger.Printf("could not join %s: %v", control, err)
					continue
				}
				logger.Printf("joined %s", control)
			}
		}()
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
			host.announce()
			if statusOut != "" {
				writeStatus(logger, statusOut, engine.StatusJSON())
			}
		}
	}
}

// writeStatus writes the status where a script can read it, atomically -- a
// reader must never catch it half-written.
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

// linuxHost is what a phone's platform half would be.
type linuxHost struct {
	device    string
	statePath string
	logger    *log.Logger
	engine    *waveengine.Engine

	mu         sync.Mutex
	applied    wavesettings.Settings
	hasApplied bool
	announced  map[string]bool
}

// ApplySettings puts the union of every wave onto the one interface.
//
// The same contract the phones have: it arrives whole, it is applied whole, and
// it only arrives when something actually changed. What is added and what is
// taken away is computed against the last set, because `ip addr del` on an
// address that is gone is an error and leaving a stale one behind is worse.
func (h *linuxHost) ApplySettings(settings wavesettings.Settings) error {
	h.mu.Lock()
	previous, had := h.applied, h.hasApplied
	h.applied, h.hasApplied = settings, true
	h.mu.Unlock()

	if err := h.run("link", "set", "dev", h.device, "mtu", fmt.Sprint(settings.MTU), "up"); err != nil {
		return err
	}

	// Added first, removed after: for a moment both sets are configured, which
	// is the harmless order. The other way round leaves a window with neither.
	for _, address := range settings.Addresses {
		if err := h.run("addr", "replace", address, "dev", h.device); err != nil {
			return fmt.Errorf("address %s: %w", address, err)
		}
	}
	for _, route := range settings.Routes {
		// `src` is what makes a two-wave device work at all: without it this
		// host route shadows the on-link route the widened address created, and
		// the kernel falls back to the first address on the interface -- which
		// for the second wave is the wrong one, and the peer drops the packet.
		arguments := []string{"route", "replace", route.CIDR, "dev", h.device}
		if route.Source != "" {
			arguments = append(arguments, "src", route.Source)
		}
		if err := h.run(arguments...); err != nil {
			return fmt.Errorf("route %s: %w", route.CIDR, err)
		}
	}

	if had {
		for _, route := range missingRoutes(previous.Routes, settings.Routes) {
			if err := h.run("route", "del", route, "dev", h.device); err != nil {
				h.logger.Printf("could not remove route %s: %v", route, err)
			}
		}
		for _, address := range missing(previous.Addresses, settings.Addresses) {
			if err := h.run("addr", "del", address, "dev", h.device); err != nil {
				h.logger.Printf("could not remove address %s: %v", address, err)
			}
		}
	}

	h.logger.Printf("%s: %d address(es), %d route(s), mtu %d, resolver on %s for %s",
		h.device, len(settings.Addresses), len(settings.Routes), settings.MTU,
		strings.Join(settings.DNSServers, ", "), strings.Join(settings.MatchDomains, ", "))
	h.announce()
	return nil
}

func (h *linuxHost) Log(line string) { h.logger.Print(line) }

// SaveState keeps the enrolments. 0600 because it holds three private keys per
// wave; on a phone this is the keychain or encrypted preferences.
func (h *linuxHost) SaveState(encoded []byte) {
	if err := os.MkdirAll(filepath.Dir(h.statePath), 0o700); err != nil {
		h.logger.Printf("could not make the state directory: %v", err)
		return
	}
	if err := os.WriteFile(h.statePath, encoded, 0o600); err != nil {
		h.logger.Printf("could not write the state: %v", err)
	}
}

// OpenAuthURL is where a phone would open a browser. There is none here, and
// the engine has already logged the link, so this only says what it is waiting
// for -- printing it twice would just be two lines to grep.
func (h *linuxHost) OpenAuthURL(string) {
	h.logger.Printf("waiting for somebody to approve this device")
}

// announce says " up as " once per wave, in the same words the desktop client
// uses -- so a test script waits for the same line whichever client it is
// driving.
func (h *linuxHost) announce() {
	if h.engine == nil {
		return
	}
	for _, wave := range h.engine.Status().Waves {
		if wave.IPv4 == "" {
			continue
		}
		h.mu.Lock()
		if h.announced == nil {
			h.announced = map[string]bool{}
		}
		already := h.announced[wave.ControlURL]
		h.announced[wave.ControlURL] = true
		h.mu.Unlock()
		if already {
			continue
		}
		h.logger.Printf("[%s] %s up as %s (%s), %d peer(s)",
			wave.ControlURL, h.device, wave.IPv4, wave.DNSName, len(wave.Peers))
	}
}

func (h *linuxHost) run(arguments ...string) error {
	command := exec.Command("ip", arguments...)
	output, err := command.CombinedOutput()
	if err != nil {
		return fmt.Errorf("ip %s: %w: %s", strings.Join(arguments, " "), err, strings.TrimSpace(string(output)))
	}
	return nil
}

// missingRoutes is every destination `before` had that `after` no longer wants.
// Compared by destination alone: a route whose source changed is replaced, not
// removed and added.
func missingRoutes(before, after []wavesettings.Route) []string {
	wanted := make(map[string]bool, len(after))
	for _, route := range after {
		wanted[route.CIDR] = true
	}
	var gone []string
	for _, route := range before {
		if !wanted[route.CIDR] {
			gone = append(gone, route.CIDR)
		}
	}
	return gone
}

// missing is everything in `before` that `after` no longer wants.
func missing(before, after []string) []string {
	wanted := make(map[string]bool, len(after))
	for _, value := range after {
		wanted[value] = true
	}
	var gone []string
	for _, value := range before {
		if !wanted[value] {
			gone = append(gone, value)
		}
	}
	return gone
}

func hostname() string {
	name, err := os.Hostname()
	if err != nil || name == "" {
		return "harness"
	}
	return name
}
