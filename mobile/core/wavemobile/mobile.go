// Package wavemobile is the surface gomobile binds: the one package iOS and
// Android see.
//
// Everything crossing this boundary is a string, a number, a bool, []byte or an
// interface -- what `gomobile bind` can carry. Anything with a shape travels as
// JSON, which is why there is one definition of that shape rather than one per
// language.
//
// Keeping the boundary this thin is deliberate. The platforms are where nothing
// can be tested from a development machine, so as little as possible lives
// there: the host does what only it can do -- hand over a descriptor, apply
// settings, keep a socket out of its own tunnel -- and everything else is Go
// that runs under `go test`.
package wavemobile

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"

	"github.com/pinguin45orga/wave-mesh/mobile/core/waveengine"
	"github.com/pinguin45orga/wave-mesh/mobile/core/wavesettings"
	"github.com/pinguin45orga/wave-mesh/mobile/core/wavetun"
)

// Callbacks is what the platform implements: NEPacketTunnelProvider on iOS,
// VpnService on Android.
type Callbacks interface {
	// ApplySettings receives the union of every wave as JSON, and applies it to
	// the one tunnel. Returning an error means the tunnel is not what the core
	// believes it is, and the core says so rather than carrying on.
	//
	// Called only when something actually changed: applying interrupts the
	// tunnel, and on iOS it is atomic with no partial failure.
	ApplySettings(settingsJSON string) error
	// Log takes one line. Console.app, or logcat.
	Log(line string)
	// SaveState persists the enrolments. It contains private keys, so it
	// belongs in the keychain or in encrypted shared preferences -- never in a
	// plain file, and never anywhere that is backed up in the clear.
	SaveState(encoded []byte)
	// OpenAuthURL is the enrolment link. The platform decides whether that
	// means opening a browser or showing the link.
	OpenAuthURL(url string)
	// ProtectSocket keeps one of our sockets out of the tunnel we are building.
	//
	// Android's VpnService.protect. On iOS there is nothing to do and the
	// implementation returns true: a packet tunnel provider's own sockets do
	// not go through its tunnel. Returning false is not fatal here -- it is
	// logged, and the socket will simply not work, which is easier to find than
	// a silent loop.
	ProtectSocket(fd int) bool
}

// Core is the whole engine behind one object.
type Core struct {
	engine *waveengine.Engine

	mu      sync.Mutex
	started bool
}

// host adapts Callbacks to what the engine wants. It exists so the engine's
// interface can stay in Go terms -- a settings struct, not a JSON string.
type host struct {
	callbacks Callbacks
}

func (h host) ApplySettings(settings wavesettings.Settings) error {
	encoded, err := json.Marshal(settings)
	if err != nil {
		return err
	}
	return h.callbacks.ApplySettings(string(encoded))
}

func (h host) Log(line string) { h.callbacks.Log(line) }

func (h host) SaveState(encoded []byte) { h.callbacks.SaveState(encoded) }

func (h host) OpenAuthURL(url string) { h.callbacks.OpenAuthURL(url) }

// New makes a core.
//
// stateJSON is what SaveState wrote last time, or empty on a device that has
// never joined anything. upstreams is a comma-separated list, because a slice
// of strings does not cross this boundary; it is only read when systemWideDNS
// is set, which is Android.
func New(stateJSON string, hostname string, systemWideDNS bool, upstreams string, callbacks Callbacks) (*Core, error) {
	if callbacks == nil {
		return nil, errors.New("a core without callbacks can do nothing")
	}
	state, err := waveengine.ParseState([]byte(stateJSON))
	if err != nil {
		return nil, err
	}

	adapter := host{callbacks: callbacks}
	engine := waveengine.New(waveengine.Options{
		Host:          adapter,
		State:         state,
		Hostname:      hostname,
		SystemWideDNS: systemWideDNS,
		Upstreams:     splitList(upstreams),
		Protect: func(fd uintptr) {
			if !callbacks.ProtectSocket(int(fd)) {
				callbacks.Log("the platform refused to protect a socket; it will not carry traffic")
			}
		},
	})
	return &Core{engine: engine}, nil
}

// Start takes over the tunnel descriptor and brings up every wave that is set
// to start by itself.
//
// utunFraming says how packets appear on the descriptor: true on iOS, where a
// utun prefixes each one with a four-byte address family, false on Android,
// where they are bare IP packets. Getting it wrong does not fail -- it produces
// a tunnel where nothing is ever parsed, which is why it is a parameter and not
// a guess.
//
// The descriptor belongs to the core afterwards. The platform must not close
// it: on a phone the number is reused, and closing it twice closes something
// else.
func (c *Core) Start(tunFD int, utunFraming bool, mtu int) error {
	c.mu.Lock()
	if c.started {
		c.mu.Unlock()
		return errors.New("the core is already running")
	}
	c.started = true
	c.mu.Unlock()

	framing := wavetun.FramingRaw
	if utunFraming {
		framing = wavetun.FramingUtun
	}
	if mtu <= 0 {
		mtu = wavesettings.DefaultMTU
	}
	link, err := wavetun.NewFDLink(tunFD, framing, mtu)
	if err != nil {
		return err
	}
	return c.engine.Start(link, mtu)
}

// ReplaceTunnel hands over a new tunnel descriptor, taking over from the one
// Start was given.
//
// Android calls this after every establish(), because VpnService.Builder hands
// back a new descriptor each time and closes the old one -- a core still
// reading the first would see a tunnel that has simply gone quiet. iOS keeps
// its packet flow across setTunnelNetworkSettings and never needs it.
func (c *Core) ReplaceTunnel(tunFD int, utunFraming bool, mtu int) error {
	framing := wavetun.FramingRaw
	if utunFraming {
		framing = wavetun.FramingUtun
	}
	if mtu <= 0 {
		mtu = wavesettings.DefaultMTU
	}
	link, err := wavetun.NewFDLink(tunFD, framing, mtu)
	if err != nil {
		return err
	}
	c.engine.ReplaceLink(link)
	return nil
}

// Login joins a wave. It blocks until somebody approves the device in a
// browser, which is what OpenAuthURL is for -- so the platform calls this off
// the main thread. An empty authKey means the interactive way; a pre-auth key
// is an approval given in advance.
func (c *Core) Login(controlURL string, authKey string) error {
	return c.engine.Login(context.Background(), controlURL, authKey)
}

// Logout leaves one wave, named by its control server. There is no other name.
func (c *Core) Logout(controlURL string) error {
	return c.engine.Logout(context.Background(), controlURL)
}

// NetworkChanged is the phone saying it moved: WiFi to LTE, or one tower to the
// next. It rebinds the socket and republishes where we are.
//
// The platform has to call it -- NWPathMonitor on iOS,
// ConnectivityManager.NetworkCallback on Android. Without it the tunnel still
// recovers, but only once the paths have timed out, which is the difference
// between a pause nobody notices and ten seconds of nothing.
func (c *Core) NetworkChanged() { c.engine.NetworkChanged() }

// Status is the whole device as JSON: the waves, their peers, the path each one
// is on. What a user interface draws, and the only thing it needs.
func (c *Core) Status() string { return c.engine.StatusJSON() }

// Stop takes everything down. The descriptor handed to Start is closed with it.
func (c *Core) Stop() {
	c.mu.Lock()
	if !c.started {
		c.mu.Unlock()
		return
	}
	c.started = false
	c.mu.Unlock()
	c.engine.Stop()
}

func splitList(value string) []string {
	var out []string
	for _, part := range strings.Split(value, ",") {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}
