package waveengine

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.zx2c4.com/wireguard/device"

	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavecontrol"
	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavecrypto"
	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavedns"
	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavemagic"
	"github.com/moellenbeck-digital/wave-mesh/mobile/core/waveoverlap"
	"github.com/moellenbeck-digital/wave-mesh/mobile/core/waveproto"
	"github.com/moellenbeck-digital/wave-mesh/mobile/core/waverelay"
	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavesettings"
	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavetun"
)

// keepaliveSeconds keeps NAT state alive on paths that would otherwise time out.
const keepaliveSeconds = 25

// candidateRefresh is how often we ask again where we are. A phone moves, so
// this matters more here than on a desk.
const candidateRefresh = 60 * time.Second

// DefaultListenPort is the port to try first, the same number the desktop uses.
//
// A fixed default rather than "any free port", because the port is what peers
// have been told to send to: after a restart on a fresh port, every peer keeps
// sending to the old one until its path times out -- fifteen seconds of a
// tunnel that looks up on both sides and carries nothing. Keeping the number
// makes a restart invisible to them.
//
// Nothing depends on getting it: if something else holds it, the socket takes
// an ephemeral one and the candidates say so. Which is also why a rebind after
// a network change deliberately does move -- there the point is to get away
// from a mapping that may be poisoned.
const DefaultListenPort = 41641

// Host is what the platform gives the core.
type Host interface {
	// ApplySettings hands the union to the one tunnel the platform allows.
	//
	// Called only when the union has actually changed, because applying it
	// interrupts the tunnel and knows no partial failure.
	ApplySettings(settings wavesettings.Settings) error
	// Log is where a line ends up: Console.app or logcat.
	Log(line string)
	// SaveState persists the enrolments, private keys included.
	SaveState(encoded []byte)
	// OpenAuthURL is the enrolment link. The platform decides whether that
	// means opening a browser or showing it.
	OpenAuthURL(url string)
}

// Options configures the engine.
type Options struct {
	Host  Host
	State State
	// The UDP port to try first. Zero means DefaultListenPort.
	ListenPort int
	// Hostname as it will appear in the wave.
	Hostname string
	// SystemWideDNS is true on Android, where the resolver cannot be limited to
	// our own names. It is what turns forwarding from optional into mandatory.
	SystemWideDNS bool
	// Upstreams is where everything that is not ours goes when SystemWideDNS.
	Upstreams []string
	// ResolverAddress overrides where the resolver answers, for every wave.
	//
	// Only the harness sets it, and only to try something: a phone takes the
	// address from its netmap, because it has to be one nobody else holds and
	// the control server is the side that allocates. See resolverAddressFor.
	ResolverAddress string
	// Protect is the platform's escape from its own tunnel: every socket the
	// core opens goes through it. Without it on Android, our WireGuard traffic
	// would be routed into the tunnel it is carrying.
	Protect func(fd uintptr)
	// Platform and Version go to the server in the hello of every control
	// connection ("ios", "0.8.0"), which is what it shows next to the device.
	Platform string
	Version  string
}

type wave struct {
	profile Profile
	client  *wavecontrol.Client
	socket  *wavecontrol.Socket
	device  *device.Device
	netmap  *waveproto.Netmap
	// This wave's relay connection. One per wave rather than one per device:
	// the relay routes by disco key, and each enrolment has its own.
	relay *waverelay.Client
	// Where this wave's resolver answers, as reconcile worked it out.
	resolver string
	// pendingHints is a punch signal that overtook the netmap introducing the
	// peer it names.
	pendingHints map[string][]waveproto.Candidate
	// What the last policy line said, so a change is logged once.
	filterSaid string
	// The candidates last published for this wave, so an unchanged list is
	// not sent again. The socket resends it by itself after a reconnect.
	published string
	// Why the last netmap from the server was refused, until one is accepted.
	rejected string
}

// key is how a wave is filed everywhere in the core.
//
// The control URL, not the wave id from the netmap: it is the identity, it is
// known before the first netmap arrives, and there is no second name to keep in
// step with it.
func (w *wave) key() string { return w.profile.ControlURL }

// Engine is the core.
type Engine struct {
	options  Options
	host     Host
	sock     *wavemagic.Sock
	mux      *wavetun.Multiplexer
	resolver *resolver
	http     *http.Client

	mu       sync.Mutex
	state    State
	waves    map[string]*wave
	applied  wavesettings.Settings
	hasAppl  bool
	started  bool
	stopping bool
	// Why a wave that should be running is not, by control URL; shown in the
	// status until it comes up.
	failures map[string]string

	// reconcileMu keeps two reconciles from interleaving: several waves'
	// sockets, Logout and SetEnabled all reconcile, and an older union
	// overtaking a newer one would leave stale routes on the platform.
	reconcileMu sync.Mutex

	stop chan struct{}
	done sync.WaitGroup
}

// New makes an engine. Start opens the sockets.
func New(options Options) *Engine {
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	if options.Protect != nil {
		dialer.Control = func(_, _ string, connection syscall.RawConn) error {
			return connection.Control(options.Protect)
		}
	}
	engine := &Engine{
		options:  options,
		host:     options.Host,
		resolver: newResolver(dialer),
		http: &http.Client{
			Timeout:   30 * time.Second,
			Transport: &http.Transport{DialContext: dialer.DialContext},
		},
		state: options.State,
		waves: map[string]*wave{},
		stop:  make(chan struct{}),
	}
	if engine.state.Version == 0 {
		engine.state.Version = StateVersion
	}
	return engine
}

func (e *Engine) log(format string, arguments ...any) {
	if e.host != nil {
		e.host.Log(fmt.Sprintf(format, arguments...))
	}
}

// Start opens the UDP socket and takes over the tunnel, then brings up every
// enrolment that wants to start by itself.
func (e *Engine) Start(link wavetun.Link, mtu int) error {
	e.mu.Lock()
	if e.started {
		e.mu.Unlock()
		return errors.New("the engine is already running")
	}
	e.started = true
	// An enrolment that was never approved can never come up -- only a new
	// login could approve it, and that creates its own. Older builds left
	// such leftovers behind; they go here instead of failing on every start.
	kept := e.state.Profiles[:0]
	var forgotten []string
	for _, profile := range e.state.Profiles {
		if profile.NetmapPublicKey == "" {
			forgotten = append(forgotten, profile.ControlURL)
			continue
		}
		kept = append(kept, profile)
	}
	e.state.Profiles = kept
	profiles := append([]Profile(nil), e.state.Profiles...)
	e.mu.Unlock()
	if len(forgotten) > 0 {
		for _, controlURL := range forgotten {
			e.log("[%s] forgot an enrolment that was never approved", WaveLabel(controlURL))
		}
		e.saveState()
	}

	listenPort := e.options.ListenPort
	if listenPort == 0 {
		listenPort = DefaultListenPort
	}
	e.sock = wavemagic.New(wavemagic.Options{
		ListenPort: listenPort,
		Log:        func(line string) { e.log("%s", line) },
		Protect:    e.options.Protect,
	})
	// The socket carries no disco identity of its own: there are N of them, one
	// per enrolment, and bringUp hands each wave's keys over with its peers.
	if err := e.sock.Start(); err != nil {
		return err
	}

	e.mux = wavetun.New(link, mtu, func(line string) { e.log("%s", line) })
	e.mux.Start()

	e.done.Add(1)
	go e.candidateLoop()

	// One wave that cannot come up is that wave's problem, not the device's:
	// the others start, and the failure goes to the log. Returning it made the
	// platform treat the whole tunnel as failed -- iOS then refused to start
	// at all, and the only way back was deleting the app.
	for _, profile := range profiles {
		if !profile.AutoStart {
			continue
		}
		if err := e.bringUp(profile); err != nil {
			e.log("[%s] did not come up: %v", WaveLabel(profile.ControlURL), err)
			e.noteFailure(profile.ControlURL, err)
		}
	}
	return nil
}

// ReplaceLink hands the core a new tunnel descriptor.
//
// Android hands back a new one from every establish(), so applying settings
// there means swapping the tunnel underneath. iOS keeps its packet flow and
// never calls this.
func (e *Engine) ReplaceLink(link wavetun.Link) {
	if e.mux == nil {
		_ = link.Close()
		return
	}
	e.mux.ReplaceLink(link)
}

// Login joins a wave, or returns the enrolment already there.
//
// An unknown address is always a further wave, never a replacement. A server
// that moved is a new enrolment and the old one is left with Logout -- that
// costs an approval, and it is the price of nothing ever guessing.
func (e *Engine) Login(ctx context.Context, controlURL, authKey string) error {
	normalised, ok := NormaliseControlURL(controlURL)
	if !ok {
		return fmt.Errorf("%q is not a control server address", controlURL)
	}

	e.mu.Lock()
	profile, exists := e.state.Find(normalised)
	if !exists {
		created, err := NewProfile(normalised)
		if err != nil {
			e.mu.Unlock()
			return err
		}
		profile = created
		e.state.Profiles = append(e.state.Profiles, profile)
	}
	e.mu.Unlock()
	e.saveState()

	if err := e.enrol(ctx, &profile, authKey); err != nil {
		// A first login that never got approved -- the page was closed, the
		// wait timed out, the server said no -- must not leave its enrolment
		// behind. It would come back on every start as a wave that can never
		// come up, and on a phone that used to keep the whole tunnel down.
		// One that was approved before keeps its keys: the next try can still
		// succeed with them.
		if profile.NetmapPublicKey == "" {
			e.forget(normalised)
		}
		return err
	}
	return e.bringUp(profile)
}

// forget drops an enrolment from the state without telling any server.
func (e *Engine) forget(controlURL string) {
	e.mu.Lock()
	kept := e.state.Profiles[:0]
	for _, profile := range e.state.Profiles {
		if profile.ControlURL != controlURL {
			kept = append(kept, profile)
		}
	}
	e.state.Profiles = kept
	e.mu.Unlock()
	e.saveState()
}

// enrol registers and waits for whoever has to approve this device. A pre-auth
// key is an approval given in advance, and skips the waiting entirely.
func (e *Engine) enrol(ctx context.Context, profile *Profile, authKey string) error {
	identity := identityOf(*profile, e.hostname())
	client := wavecontrol.NewClient(identity, e.http)

	registration, err := client.Register(ctx, authKey)
	if err != nil {
		return err
	}
	nodeID, signed, netmapKey := registration.NodeID, registration.Netmap, registration.NetmapPublicKey
	if registration.Status != "authorized" {
		e.log("open this link to connect this device: %s", registration.AuthURL)
		if e.host != nil {
			e.host.OpenAuthURL(registration.AuthURL)
		}
		poll, err := client.WaitForApproval(ctx, registration.PollSecret, 15*time.Minute)
		if err != nil {
			return err
		}
		nodeID, signed, netmapKey = poll.NodeID, poll.Netmap, poll.NetmapPublicKey
	}

	if profile.NetmapPublicKey != "" && profile.NetmapPublicKey != netmapKey {
		return errors.New("the control server presented a different netmap signing key than the one pinned at enrolment")
	}
	if _, err := signed.Verify(netmapKey); err != nil {
		return err
	}

	e.mu.Lock()
	profile.NodeID, profile.NetmapPublicKey = nodeID, netmapKey
	// A new approval undoes a removal.
	profile.Removed = ""
	profile.AutoStart = true
	for i, existing := range e.state.Profiles {
		if existing.ControlURL == profile.ControlURL {
			e.state.Profiles[i] = *profile
		}
	}
	e.mu.Unlock()
	e.saveState()
	return nil
}

// bringUp starts one wave: its control socket, its WireGuard device, and its
// place in the multiplexer.
func (e *Engine) bringUp(profile Profile) error {
	if profile.NetmapPublicKey == "" {
		return errors.New("this enrolment has never been approved; log in again")
	}

	// Read before taking the lock: hostname() takes it too, and a Go mutex is
	// not reentrant. Asking inside hung every approved wave in build 4.
	hostname := e.hostname()
	e.mu.Lock()
	if _, running := e.waves[profile.ControlURL]; running {
		e.mu.Unlock()
		return nil
	}
	identity := identityOf(profile, hostname)
	entry := &wave{
		profile:      profile,
		client:       wavecontrol.NewClient(identity, e.http),
		pendingHints: map[string][]waveproto.Candidate{},
	}
	e.waves[profile.ControlURL] = entry
	e.mu.Unlock()

	// One WireGuard device per wave, over a virtual TUN and a view of the one
	// socket. The node keys stay separate, which is the whole reason this is N
	// devices rather than one with a shared key: the same public key in every
	// netmap would let two waves with a common member recognise the device.
	virtual := e.mux.DeviceFor(entry.key())
	bind := e.sock.BindFor(entry.key())
	e.sock.SetDiscoIdentity(entry.key(), profile.DiscoKey.PublicKey, profile.DiscoKey.PrivateKey)

	logger := device.NewLogger(device.LogLevelError, "["+WaveLabel(profile.ControlURL)+"] ")
	entry.device = device.NewDevice(virtual, bind, logger)

	privateKey, err := wavecrypto.KeyToHex(profile.NodeKey.PrivateKey)
	if err != nil {
		return err
	}
	if err := entry.device.IpcSet("private_key=" + privateKey + "\n"); err != nil {
		return err
	}
	if err := entry.device.Up(); err != nil {
		return err
	}

	entry.socket = wavecontrol.NewSocket(wavecontrol.SocketOptions{
		Identity:   identity,
		HTTPClient: e.http,
		Log:        func(line string) { e.log("[%s] %s", WaveLabel(profile.ControlURL), line) },
		OnNetmap: func(netmap waveproto.Netmap) {
			if err := e.applyNetmap(entry, netmap); err != nil {
				e.log("[%s] could not apply netmap v%d: %v", WaveLabel(profile.ControlURL), netmap.Version, err)
			}
		},
		OnDiscoHint: func(nodeID string, candidates []waveproto.Candidate) {
			e.punch(entry, nodeID, candidates)
		},
		OnLogout: func(reason string) {
			e.log("[%s] the server ended this enrolment: %s", WaveLabel(profile.ControlURL), reason)
			go e.endedByServer(profile.ControlURL, reason)
		},
		OnRejectedNetmap: func(err error) {
			e.mu.Lock()
			entry.rejected = err.Error()
			e.mu.Unlock()
		},
		Hello: e.hello(),
	})

	// The first netmap over REST rather than waiting for the socket to push
	// one: the tunnel can be up before the socket is.
	signed, err := entry.client.Netmap(context.Background())
	if err == nil {
		if netmap, err := signed.Verify(profile.NetmapPublicKey); err == nil {
			if err := e.applyNetmap(entry, netmap); err != nil {
				e.log("[%s] %v", WaveLabel(profile.ControlURL), err)
			}
		} else {
			e.log("[%s] rejected netmap: %v", WaveLabel(profile.ControlURL), err)
		}
	}

	entry.socket.Connect()
	e.clearFailure(profile.ControlURL)
	go func() {
		if err := e.refreshCandidates(); err != nil {
			e.log("could not publish candidates: %v", err)
		}
	}()
	go e.refreshRegistration(entry)
	return nil
}

// refreshRegistration registers again with the keys the wave already has, as
// the desktop does on every start. For a known machine the server answers at
// once and moves the key expiry forward; a phone that only ever registered at
// enrolment would expire after 180 days the moment expiry is enforced. An
// answer other than "authorized" means the server no longer knows this
// device: it was removed while the phone was away, and the socket alone would
// never say so.
func (e *Engine) refreshRegistration(entry *wave) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	registration, err := entry.client.Register(ctx, "")
	if err != nil {
		e.log("[%s] could not refresh the registration: %v", WaveLabel(entry.key()), err)
		return
	}
	if registration.Status != "authorized" {
		e.endedByServer(entry.key(), "node-removed")
	}
}

// endedByServer takes a wave down that the server has ended -- the device was
// removed in the web interface, or the server stopped knowing it. The
// enrolment stays, marked, so the screen can say what happened instead of
// "not connected" forever; only a new login brings the wave back.
func (e *Engine) endedByServer(controlURL, reason string) {
	e.mu.Lock()
	entry := e.waves[controlURL]
	delete(e.waves, controlURL)
	for i := range e.state.Profiles {
		if e.state.Profiles[i].ControlURL == controlURL {
			e.state.Profiles[i].Removed = reason
			e.state.Profiles[i].AutoStart = false
		}
	}
	e.mu.Unlock()
	if entry != nil {
		e.teardown(controlURL, entry)
	}
	e.saveState()
	if err := e.reconcile(); err != nil {
		e.log("[%s] %v", WaveLabel(controlURL), err)
	}
}

// hello is what every control connection opens with, when the platform said
// what it is.
func (e *Engine) hello() *waveproto.ClientMessage {
	e.mu.Lock()
	platform, version := e.options.Platform, e.options.Version
	e.mu.Unlock()
	if platform == "" || version == "" {
		return nil
	}
	return &waveproto.ClientMessage{Type: "hello", Version: version, Platform: platform}
}

func (e *Engine) noteFailure(controlURL string, err error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.failures == nil {
		e.failures = map[string]string{}
	}
	e.failures[controlURL] = err.Error()
}

func (e *Engine) clearFailure(controlURL string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	delete(e.failures, controlURL)
}

// Logout leaves one wave and takes everything of it off the device.
func (e *Engine) Logout(ctx context.Context, controlURL string) error {
	normalised, ok := NormaliseControlURL(controlURL)
	if !ok {
		normalised = controlURL
	}
	hostname := e.hostname()

	e.mu.Lock()
	entry := e.waves[normalised]
	delete(e.waves, normalised)
	kept := e.state.Profiles[:0]
	var left *Profile
	for _, profile := range e.state.Profiles {
		if profile.ControlURL == normalised {
			copied := profile
			left = &copied
			continue
		}
		kept = append(kept, profile)
	}
	e.state.Profiles = kept
	e.mu.Unlock()

	if left == nil && entry == nil {
		return fmt.Errorf("not in a wave at %s", normalised)
	}

	// Best effort and bounded: the enrolment goes either way, and an
	// unreachable server must not hold this open. The server is told even
	// when the wave is not running -- paused, or never came up this time --
	// or the device would stay in the wave there as a ghost.
	client := (*wavecontrol.Client)(nil)
	switch {
	case entry != nil:
		client = entry.client
	case left != nil && left.NetmapPublicKey != "" && left.Removed == "":
		client = wavecontrol.NewClient(identityOf(*left, hostname), e.http)
	}
	if client != nil {
		bounded, cancel := context.WithTimeout(ctx, 10*time.Second)
		if err := client.Logout(bounded); err != nil {
			e.log("[%s] the server was not told: %v", WaveLabel(normalised), err)
		}
		cancel()
	}
	if entry != nil {
		e.teardown(normalised, entry)
	}
	e.clearFailure(normalised)
	e.saveState()
	return e.reconcile()
}

// teardown stops one running wave: its sockets, its WireGuard device and its
// place in the multiplexer. The enrolment itself is the caller's business.
func (e *Engine) teardown(controlURL string, entry *wave) {
	if entry.socket != nil {
		entry.socket.Close()
	}
	if entry.relay != nil {
		entry.relay.Close()
	}
	if entry.device != nil {
		entry.device.Close()
	}
	e.sock.RemoveWave(controlURL)
	e.mux.RemoveWave(controlURL)
}

// SetEnabled switches one wave on or off without leaving it: the enrolment and
// its keys stay, and switching it back on needs no approval. The choice is
// kept across restarts, the same as the switch on each card of the tray.
func (e *Engine) SetEnabled(controlURL string, enabled bool) error {
	normalised, ok := NormaliseControlURL(controlURL)
	if !ok {
		normalised = controlURL
	}
	e.mu.Lock()
	index := -1
	for i, profile := range e.state.Profiles {
		if profile.ControlURL == normalised {
			index = i
		}
	}
	if index < 0 {
		e.mu.Unlock()
		return fmt.Errorf("not in a wave at %s", normalised)
	}
	if enabled && e.state.Profiles[index].Removed != "" {
		e.mu.Unlock()
		return fmt.Errorf("the server removed this device from the wave at %s; log in again", normalised)
	}
	e.state.Profiles[index].AutoStart = enabled
	profile := e.state.Profiles[index]
	entry := e.waves[normalised]
	if !enabled {
		delete(e.waves, normalised)
	}
	e.mu.Unlock()
	e.saveState()

	if enabled {
		e.mu.Lock()
		running := e.started && !e.stopping
		e.mu.Unlock()
		if !running {
			return nil // comes up with the next start
		}
		return e.bringUp(profile)
	}
	if entry != nil {
		e.teardown(normalised, entry)
	}
	return e.reconcile()
}

// SetClientInfo says what this device is, for the hello on every control
// connection. Called before Start; a wave already running keeps what it had.
func (e *Engine) SetClientInfo(platform, version string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.options.Platform, e.options.Version = platform, version
}

// SetHostname is the name the next enrolment asks for. A device that is
// already in a wave keeps the name it got there.
func (e *Engine) SetHostname(name string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.options.Hostname = strings.TrimSpace(name)
}

func (e *Engine) hostname() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.options.Hostname
}

// applyNetmap is where a wave's view of the world becomes the device's.
func (e *Engine) applyNetmap(entry *wave, netmap waveproto.Netmap) error {
	if conflict := e.conflictWith(entry, netmap); conflict != nil {
		// Refused rather than repaired: renumbering a wave is the server's
		// business, and rotating a key is the other node's. The waves already
		// running are untouched.
		return errors.New(conflict.Describe(WaveLabel(entry.key())))
	}

	e.mu.Lock()
	entry.netmap = &netmap
	entry.rejected = ""
	e.mu.Unlock()

	e.syncRelay(entry, netmap)

	peers := make([]wavemagic.PeerConfig, 0, len(netmap.Peers))
	for _, peer := range netmap.Peers {
		peers = append(peers, wavemagic.PeerConfig{
			NodeKey:    peer.NodeKey,
			DiscoKey:   peer.DiscoKey,
			Candidates: candidateAddrs(peer.Candidates),
		})
	}
	if err := e.sock.SetPeers(entry.key(), peers); err != nil {
		return err
	}

	// Punching comes before the WireGuard and routing work: every millisecond
	// spent here widens the gap between the two sides starting to punch, and
	// that gap has to stay below the round-trip time to the peer.
	if len(netmap.Self.Candidates) > 0 {
		e.sock.EnableProbing()
	}
	e.mu.Lock()
	hints := entry.pendingHints
	entry.pendingHints = map[string][]waveproto.Candidate{}
	e.mu.Unlock()
	for nodeID, candidates := range hints {
		e.punch(entry, nodeID, candidates)
	}

	// Before WireGuard learns a new peer, so there is no moment in which it can
	// send and the ports it may use are not yet in place.
	e.mux.SetFilter(entry.key(), filterFrom(netmap.PacketFilter))
	if said := describeFilter(netmap.PacketFilter); said != entry.filterSaid {
		// "No policy" at the start is not news.
		if entry.filterSaid != "" || netmap.PacketFilter != nil {
			e.log("%s: %s", WaveLabel(entry.key()), said)
		}
		// The core always holds the ports itself, so under a policy the
		// answer is yes; the server shows it next to the device.
		if netmap.PacketFilter != nil && entry.socket != nil {
			entry.socket.ReportFilter(true, "")
		}
		entry.filterSaid = said
	}

	// Against what the device holds now, not what was last written: peers
	// that left are removed, every other one is updated in place and keeps
	// its session. Declaring the whole set with replace_peers dropped every
	// session in the wave on every netmap -- once a minute per phone.
	current, err := entry.device.IpcGet()
	if err != nil {
		return err
	}
	if err := entry.device.IpcSet(uapiConfig(netmap, configuredPeers(current))); err != nil {
		return err
	}
	return e.reconcile()
}

// conflictWith checks this netmap against every other wave on the device.
func (e *Engine) conflictWith(entry *wave, netmap waveproto.Netmap) *waveoverlap.Conflict {
	wanted := claimOf(entry.key(), netmap)

	e.mu.Lock()
	held := make([]waveoverlap.Claim, 0, len(e.waves))
	for _, other := range e.waves {
		if other == entry || other.netmap == nil {
			continue
		}
		held = append(held, claimOf(other.key(), *other.netmap))
	}
	e.mu.Unlock()
	return waveoverlap.Find(wanted, held)
}

func claimOf(controlURL string, netmap waveproto.Netmap) waveoverlap.Claim {
	claim := waveoverlap.Claim{ControlURL: controlURL}
	claim.CIDRs = append(claim.CIDRs, netmap.Self.Addresses...)
	for _, peer := range netmap.Peers {
		claim.CIDRs = append(claim.CIDRs, peer.AllowedIPs...)
		claim.NodeKeys = append(claim.NodeKeys, peer.NodeKey)
		claim.DiscoKeys = append(claim.DiscoKeys, peer.DiscoKey)
	}
	return claim
}

// reconcile rebuilds everything that is a property of all the waves at once:
// the routing table, the resolver, and the settings the platform applies.
func (e *Engine) reconcile() error {
	e.reconcileMu.Lock()
	defer e.reconcileMu.Unlock()

	// In the order the waves were added, never in map order: the union keeps
	// its search domains in input order and compares them in order, so a
	// shuffled input looked like a change and re-applied -- interrupting the
	// tunnel -- for nothing, and made "which wave answers a bare name" random.
	e.mu.Lock()
	entries := make([]*wave, 0, len(e.waves))
	for _, entry := range e.orderedWaves() {
		if entry.netmap != nil {
			entries = append(entries, entry)
		}
	}
	e.mu.Unlock()

	var (
		routes       []wavetun.Route
		zones        []wavedns.Zone
		unionInput   []wavesettings.Wave
		resolverAddr []netip.Addr
	)
	for _, entry := range entries {
		netmap := *entry.netmap
		for _, cidr := range routableCIDRs(netmap) {
			if prefix, err := netip.ParsePrefix(cidr); err == nil {
				routes = append(routes, wavetun.Route{Prefix: prefix.Masked(), WaveID: entry.key()})
			}
		}

		resolverAddress := e.options.ResolverAddress
		if resolverAddress == "" {
			resolverAddress = resolverAddressFor(netmap)
		}
		if address, err := netip.ParseAddr(resolverAddress); err == nil {
			resolverAddr = append(resolverAddr, address)
		}

		reverse := wavedns.ReverseZonesFor(netmap.Self.Addresses)
		records := make([]wavedns.Record, 0, len(netmap.Peers)+len(netmap.Services)+1)
		for _, entryRecord := range append([]waveproto.Peer{netmap.Self.Peer}, netmap.Peers...) {
			records = append(records, wavedns.Record{
				Name: entryRecord.DNSName, IPv4: entryRecord.IPv4, IPv6: entryRecord.IPv6,
			})
		}
		// Services sit in the same zone as the devices and answer the same way
		// (D11); their addresses are already routed, because they live in the
		// connector's allowed IPs.
		for _, service := range netmap.Services {
			records = append(records, wavedns.Record{
				Name: service.DNSName, IPv4: service.IPv4, IPv6: service.IPv6,
			})
		}
		delegated := make([]string, 0, len(netmap.DNS.Routes))
		dnsRoutes := make([]wavedns.Route, 0, len(netmap.DNS.Routes))
		for _, route := range netmap.DNS.Routes {
			delegated = append(delegated, route.Suffix)
			dnsRoutes = append(dnsRoutes, wavedns.Route{Suffix: route.Suffix, Nameservers: route.Nameservers})
		}
		zones = append(zones, wavedns.Zone{
			ControlURL: entry.key(),
			Suffix:     netmap.DNS.Suffix,
			Records:    records,
			Routes:     dnsRoutes,
			Reverse:    reverse,
		})
		e.mu.Lock()
		entry.resolver = resolverAddress
		e.mu.Unlock()
		if resolverAddress == netmap.Self.IPv4 {
			e.log("[%s] the resolver answers on %s, which this device also holds: "+
				"lookups from the device itself will be refused locally. "+
				"The wave needs a reserved resolver address from its control server.",
				WaveLabel(entry.key()), resolverAddress)
		}
		unionInput = append(unionInput, wavesettings.Wave{
			Addresses:         netmap.Self.Addresses,
			Routes:            routableCIDRs(netmap),
			Suffix:            netmap.DNS.Suffix,
			ReverseZones:      reverse,
			DelegatedSuffixes: delegated,
			ResolverAddress:   resolverAddress,
		})
	}

	e.mux.SetRoutes(routes)
	e.resolver.update(wavedns.Config{
		Zones:      zones,
		Upstreams:  e.options.Upstreams,
		SystemWide: e.options.SystemWideDNS,
	})
	e.mux.SetResolver(e.resolver, resolverAddr)

	settings := wavesettings.Union(unionInput)
	e.mu.Lock()
	unchanged := e.hasAppl && e.applied.Equal(settings)
	e.applied, e.hasAppl = settings, true
	e.mu.Unlock()
	// Applying interrupts the tunnel, so a netmap that only bumped its version
	// must not reach the platform at all.
	if unchanged || e.host == nil {
		return nil
	}
	if err := e.host.ApplySettings(settings); err != nil {
		// Not applied, so not remembered as applied: otherwise the next,
		// identical union counts as "unchanged" and the device keeps the old
		// routes and DNS until something else happens to change. Tried again
		// shortly, since nothing else may come along.
		e.mu.Lock()
		e.hasAppl = false
		stopping := e.stopping
		e.mu.Unlock()
		if !stopping {
			time.AfterFunc(applyRetry, func() {
				if err := e.reconcile(); err != nil {
					e.log("could not apply the tunnel settings: %v", err)
				}
			})
		}
		return err
	}
	return nil
}

// applyRetry is how soon settings the platform refused are offered again. A
// variable only so the test need not wait it out.
var applyRetry = 5 * time.Second

// orderedWaves is every running wave in the order its enrolment was added,
// then any without one (tests add waves directly), sorted. Called with e.mu
// held.
func (e *Engine) orderedWaves() []*wave {
	ordered := make([]*wave, 0, len(e.waves))
	seen := map[string]bool{}
	for _, profile := range e.state.Profiles {
		if entry, running := e.waves[profile.ControlURL]; running {
			ordered = append(ordered, entry)
			seen[profile.ControlURL] = true
		}
	}
	rest := []string{}
	for key := range e.waves {
		if !seen[key] {
			rest = append(rest, key)
		}
	}
	slices.Sort(rest)
	for _, key := range rest {
		ordered = append(ordered, e.waves[key])
	}
	return ordered
}

// resolverAddressFor decides where this wave's resolver answers.
//
// The wave's reserved address when the netmap carries one, and this node's own
// otherwise -- which is what the desktop uses, because there the resolver holds
// a real socket on it.
//
// Here it holds none: the query has to arrive as a packet on the tunnel, and one
// addressed to an address the interface *holds* never gets there. The kernel
// delivers it locally, finds nothing listening and answers ICMP port
// unreachable. So a lookup from the device only works against an address that is
// routed into the tunnel and assigned to nobody -- a reservation out of the
// wave's own block, which only the control server can make: it is the side that
// allocates. `DnsConfig.resolverAddress` carries it, and the field is optional
// because a wave numbered before the reservation existed may have given that
// address to a node; the server then sends nothing rather than pointing DNS at
// a device.
//
// Falling back to our own address keeps such a wave working for everything that
// reaches the resolver *through* the tunnel, and leaves lookups from the device
// itself unanswered. Said in the log rather than hidden, because the symptom is
// otherwise "DNS does not work on the phone" with nothing pointing at the cause.
func resolverAddressFor(netmap waveproto.Netmap) string {
	reserved := netmap.DNS.ResolverAddress
	if reserved == "" || reserved == netmap.Self.IPv4 {
		return netmap.Self.IPv4
	}
	address, err := netip.ParseAddr(reserved)
	if err != nil {
		return netmap.Self.IPv4
	}
	// It has to be a reservation, not a node: routing a peer's address to our
	// own resolver would take that peer off the network.
	for _, peer := range netmap.Peers {
		if peer.IPv4 == reserved || peer.IPv6 == reserved {
			return netmap.Self.IPv4
		}
	}
	for _, service := range netmap.Services {
		if service.IPv4 == reserved || service.IPv6 == reserved {
			return netmap.Self.IPv4
		}
	}
	// And inside the wave, or it would be a route to somebody else's network.
	if !withinWave(netmap, address) {
		return netmap.Self.IPv4
	}
	return reserved
}

// withinWave reports whether an address falls inside this wave's own block.
//
// Each wave gets a /16 of IPv4 and a /48 of IPv6 (D5), which is the same
// invariant wavedns.ReverseZonesFor already derives its PTR zones from. Asking
// for it here keeps a server from pointing the device's DNS at an address
// outside the wave it is offering.
func withinWave(netmap waveproto.Netmap, address netip.Addr) bool {
	bits := 16
	if !address.Is4() {
		bits = 48
	}
	for _, cidr := range netmap.Self.Addresses {
		own, err := netip.ParsePrefix(cidr)
		if err != nil || own.Addr().Is4() != address.Is4() {
			continue
		}
		if netip.PrefixFrom(own.Addr(), bits).Masked().Contains(address) {
			return true
		}
	}
	return false
}

// routableCIDRs is everything that has to go into the tunnel for one wave: the
// addresses of every peer, and with them the service addresses that belong to
// no device at all (D11).
func routableCIDRs(netmap waveproto.Netmap) []string {
	var cidrs []string
	for _, peer := range netmap.Peers {
		cidrs = append(cidrs, peer.AllowedIPs...)
	}
	return cidrs
}

// uapiConfig brings the device's peers to the netmap, written the way
// wireguard-go reads it.
//
// It converges on observed state -- the keys the device holds now -- for the
// same reason the desktop diffs against the interface rather than replaying
// remembered commands: a restart, a missed update and an externally modified
// device all have to end in the same place. What it no longer does is declare
// the set whole with replace_peers: that removes every peer and adds it back,
// and with it every handshake, so each netmap -- and a phone sees one at least
// every time anybody's candidates change -- cost every session in the wave.
func uapiConfig(netmap waveproto.Netmap, configured []string) string {
	var out strings.Builder
	wanted := map[string]bool{}
	for _, peer := range netmap.Peers {
		if publicKey, err := wavecrypto.KeyToHex(peer.NodeKey); err == nil {
			wanted[publicKey] = true
		}
	}
	for _, publicKey := range configured {
		if !wanted[publicKey] {
			out.WriteString("public_key=" + publicKey + "\nremove=true\n")
		}
	}
	for _, peer := range netmap.Peers {
		publicKey, err := wavecrypto.KeyToHex(peer.NodeKey)
		if err != nil {
			continue
		}
		out.WriteString("public_key=" + publicKey + "\n")
		// The endpoint is the peer itself; the magic socket decides the path,
		// so this line never changes when the path does.
		out.WriteString("endpoint=" + wavemagic.FormatEndpoint(peer.NodeKey) + "\n")
		out.WriteString(fmt.Sprintf("persistent_keepalive_interval=%d\n", keepaliveSeconds))
		out.WriteString("replace_allowed_ips=true\n")
		for _, allowed := range peer.AllowedIPs {
			out.WriteString("allowed_ip=" + allowed + "\n")
		}
	}
	return out.String()
}

// syncRelay connects one wave to the relay its netmap names, so peers that no
// direct path reaches are still usable. The relay is just another path: it
// loses to a direct one on round-trip time as soon as punching succeeds.
//
// Per wave, not per device. The relay authenticates and routes by disco key,
// and each enrolment has its own -- a single connection made with one wave's
// key would leave the relay with no session for the others, and their relayed
// traffic would never arrive. N connections is what per-enrolment keys cost.
func (e *Engine) syncRelay(entry *wave, netmap waveproto.Netmap) {
	// STUN is the one part that really is device-wide: there is one socket and
	// one reflexive address, so every wave's servers go into the same list.
	stun := make([]netip.AddrPort, 0, len(netmap.Relays))
	for _, relay := range netmap.Relays {
		if relay.STUN == nil {
			continue
		}
		if address, err := netip.ParseAddrPort(relay.STUN.String()); err == nil {
			stun = append(stun, address)
		}
	}
	// One list for the device, from every wave's relays: each netmap used to
	// replace it with its own, so the last wave to update decided alone.
	e.mu.Lock()
	for _, other := range e.waves {
		if other == entry || other.netmap == nil {
			continue
		}
		for _, relay := range other.netmap.Relays {
			if relay.STUN == nil {
				continue
			}
			if address, err := netip.ParseAddrPort(relay.STUN.String()); err == nil && !slices.Contains(stun, address) {
				stun = append(stun, address)
			}
		}
	}
	e.mu.Unlock()
	if len(stun) > 0 {
		e.sock.SetSTUNServers(stun)
	}

	wanted := ""
	if len(netmap.Relays) > 0 {
		wanted = relayWebsocketURL(netmap.Relays[0].URL)
	}

	e.mu.Lock()
	current := entry.relay
	if current != nil && current.URL() == wanted {
		e.mu.Unlock()
		return
	}
	entry.relay = nil
	e.mu.Unlock()

	if current != nil {
		current.Close()
		e.sock.SetRelay(entry.key(), nil)
	}
	if wanted == "" {
		return
	}

	client := waverelay.New(waverelay.Options{
		URL:             wanted,
		DiscoPublicKey:  entry.profile.DiscoKey.PublicKey,
		DiscoPrivateKey: entry.profile.DiscoKey.PrivateKey,
		OnPacket:        e.sock.OnRelayPacket,
		Log:             func(line string) { e.log("[%s] %s", WaveLabel(entry.key()), line) },
	})
	client.Start()

	e.mu.Lock()
	entry.relay = client
	e.mu.Unlock()
	e.sock.SetRelay(entry.key(), client)
	e.log("[%s] relay %s at %s", WaveLabel(entry.key()), netmap.Relays[0].ID, netmap.Relays[0].URL)
}

func relayWebsocketURL(raw string) string {
	if after, found := strings.CutPrefix(raw, "https://"); found {
		return "wss://" + after
	}
	if after, found := strings.CutPrefix(raw, "http://"); found {
		return "ws://" + after
	}
	return raw
}

// punch tells one peer's paths to start probing again, right now.
func (e *Engine) punch(entry *wave, nodeID string, candidates []waveproto.Candidate) {
	e.mu.Lock()
	netmap := entry.netmap
	if netmap == nil {
		// A hint can overtake the netmap that introduces the peer.
		entry.pendingHints[nodeID] = candidates
		e.mu.Unlock()
		return
	}
	nodeKey := ""
	for _, peer := range netmap.Peers {
		if peer.ID == nodeID {
			nodeKey = peer.NodeKey
			break
		}
	}
	if nodeKey == "" {
		entry.pendingHints[nodeID] = candidates
		e.mu.Unlock()
		return
	}
	delete(entry.pendingHints, nodeID)
	e.mu.Unlock()

	e.sock.PunchNow(entry.key(), nodeKey, candidateAddrs(candidates))
}

// NetworkChanged is the phone saying it moved: WiFi to LTE, or a tower to the
// next one.
//
// On the desktop a rebind waits until peers have gone unreachable, because a
// cable rarely changes underneath. Here it is the normal case, and waiting
// would mean a tunnel that stalls for ten seconds every time somebody walks out
// of the building.
func (e *Engine) NetworkChanged() {
	e.log("the network changed; rebinding and re-publishing")
	if _, err := e.sock.Rebind(); err != nil {
		e.log("could not rebind: %v", err)
		return
	}
	if err := e.refreshCandidates(); err != nil {
		e.log("could not publish candidates: %v", err)
	}
	// The control and relay connections are bound to the old path as well.
	// Left alone they die only when their heartbeat notices, up to a minute
	// later, and peers reachable only through the relay wait that long.
	e.mu.Lock()
	entries := e.orderedWaves()
	e.mu.Unlock()
	for _, entry := range entries {
		if entry.socket != nil {
			entry.socket.Reconnect()
		}
		if entry.relay != nil {
			entry.relay.Reconnect()
		}
	}
}

func (e *Engine) candidateLoop() {
	defer e.done.Done()
	ticker := time.NewTicker(candidateRefresh)
	defer ticker.Stop()
	for {
		select {
		case <-e.stop:
			return
		case <-ticker.C:
			if err := e.refreshCandidates(); err != nil {
				e.log("could not publish candidates: %v", err)
			}
		}
	}
}

// refreshCandidates rediscovers where we are and tells every control server.
//
// One list for all of them, which is the simplification the single socket
// brings: there is one port, one set of local addresses and one reflexive
// address, instead of a STUN round per wave.
func (e *Engine) refreshCandidates() error {
	_, mapping := e.sock.DiscoverReflexive(2500 * time.Millisecond)
	candidates := wavemagic.LocalCandidates(e.sock.Port())
	for _, reflexive := range e.sock.ReflexiveCandidates() {
		candidates = append(candidates, waveproto.Candidate{
			Kind: "stun", IP: reflexive.Addr().String(), Port: int(reflexive.Port()),
		})
	}

	e.mu.Lock()
	entries := make([]*wave, 0, len(e.waves))
	for _, entry := range e.waves {
		entries = append(entries, entry)
	}
	e.mu.Unlock()

	// Only on change, like the desktop. Every publish makes the server bump
	// the wave's netmap and push it to every node with punch hints for all of
	// them; sent once a minute regardless, a phone kept its whole wave busy.
	signature := candidateSignature(candidates)
	sent := 0
	for _, entry := range entries {
		if entry.socket == nil {
			continue // nothing sent, so nothing remembered as sent
		}
		e.mu.Lock()
		same := entry.published == signature
		entry.published = signature
		e.mu.Unlock()
		if same {
			continue
		}
		entry.socket.PublishEndpoints(candidates)
		sent++
	}
	if sent > 0 {
		e.log("published %d candidate(s); NAT mapping %s", len(candidates), mapping)
	}
	return nil
}

// candidateSignature is a candidate list in a form two lists can be compared
// in, whatever order discovery returned them in.
func candidateSignature(candidates []waveproto.Candidate) string {
	parts := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		parts = append(parts, fmt.Sprintf("%s|%s|%d", candidate.Kind, candidate.IP, candidate.Port))
	}
	slices.Sort(parts)
	return strings.Join(parts, ",")
}

// Stop takes everything down.
func (e *Engine) Stop() {
	e.mu.Lock()
	if e.stopping {
		e.mu.Unlock()
		return
	}
	e.stopping = true
	entries := make([]*wave, 0, len(e.waves))
	for _, entry := range e.waves {
		entries = append(entries, entry)
	}
	e.waves = map[string]*wave{}
	e.mu.Unlock()

	close(e.stop)
	for _, entry := range entries {
		if entry.socket != nil {
			entry.socket.Close()
		}
		if entry.relay != nil {
			entry.relay.Close()
		}
		if entry.device != nil {
			entry.device.Close()
		}
	}
	if e.mux != nil {
		_ = e.mux.Close()
	}
	if e.sock != nil {
		_ = e.sock.Close()
	}
	e.done.Wait()
}

func (e *Engine) saveState() {
	e.mu.Lock()
	state := e.state
	e.mu.Unlock()
	encoded, err := state.Encode()
	if err != nil {
		e.log("could not encode the state: %v", err)
		return
	}
	if e.host != nil {
		e.host.SaveState(encoded)
	}
}

func identityOf(profile Profile, hostname string) *wavecontrol.Identity {
	if hostname == "" {
		hostname = "phone"
	}
	return &wavecontrol.Identity{
		ControlURL:      profile.ControlURL,
		MachineKey:      profile.MachineKey,
		NodeKey:         profile.NodeKey,
		DiscoKey:        profile.DiscoKey,
		NetmapPublicKey: profile.NetmapPublicKey,
		NodeID:          profile.NodeID,
		Hostname:        hostname,
	}
}

// configuredPeers reads the public keys out of a device's IpcGet answer.
func configuredPeers(uapi string) []string {
	var keys []string
	for _, line := range strings.Split(uapi, "\n") {
		if key, found := strings.CutPrefix(line, "public_key="); found {
			keys = append(keys, key)
		}
	}
	return keys
}

func candidateAddrs(candidates []waveproto.Candidate) []netip.AddrPort {
	out := make([]netip.AddrPort, 0, len(candidates))
	for _, candidate := range candidates {
		if address, err := netip.ParseAddrPort(candidate.Endpoint().String()); err == nil {
			out = append(out, address)
		}
	}
	return out
}
