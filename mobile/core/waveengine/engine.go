package waveengine

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
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
	profiles := append([]Profile(nil), e.state.Profiles...)
	e.mu.Unlock()

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

	e.mu.Lock()
	if _, running := e.waves[profile.ControlURL]; running {
		e.mu.Unlock()
		return nil
	}
	identity := identityOf(profile, e.hostname())
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
		},
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
	go func() {
		if err := e.refreshCandidates(); err != nil {
			e.log("could not publish candidates: %v", err)
		}
	}()
	return nil
}

// Logout leaves one wave and takes everything of it off the device.
func (e *Engine) Logout(ctx context.Context, controlURL string) error {
	normalised, ok := NormaliseControlURL(controlURL)
	if !ok {
		normalised = controlURL
	}

	e.mu.Lock()
	entry := e.waves[normalised]
	delete(e.waves, normalised)
	kept := e.state.Profiles[:0]
	found := false
	for _, profile := range e.state.Profiles {
		if profile.ControlURL == normalised {
			found = true
			continue
		}
		kept = append(kept, profile)
	}
	e.state.Profiles = kept
	e.mu.Unlock()

	if !found && entry == nil {
		return fmt.Errorf("not in a wave at %s", normalised)
	}
	if entry != nil {
		// Best effort and bounded: the enrolment goes either way, and an
		// unreachable server must not hold this open.
		if err := entry.client.Logout(ctx); err != nil {
			e.log("[%s] the server was not told: %v", WaveLabel(normalised), err)
		}
		e.teardown(normalised, entry)
	}
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

	if err := entry.device.IpcSet(uapiConfig(netmap)); err != nil {
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
	e.mu.Lock()
	entries := make([]*wave, 0, len(e.waves))
	for _, entry := range e.waves {
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
	return e.host.ApplySettings(settings)
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

// uapiConfig is the whole peer set, written the way wireguard-go reads it.
//
// Whole rather than incremental (replace_peers), for the same reason the
// desktop diffs against observed state rather than replaying remembered
// commands: a restart, a missed update and an externally modified device all
// have to converge on the same result.
func uapiConfig(netmap waveproto.Netmap) string {
	var out strings.Builder
	out.WriteString("replace_peers=true\n")
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

	for _, entry := range entries {
		if entry.socket != nil {
			entry.socket.PublishEndpoints(candidates)
		}
	}
	e.log("published %d candidate(s); NAT mapping %s", len(candidates), mapping)
	return nil
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

func candidateAddrs(candidates []waveproto.Candidate) []netip.AddrPort {
	out := make([]netip.AddrPort, 0, len(candidates))
	for _, candidate := range candidates {
		if address, err := netip.ParseAddrPort(candidate.Endpoint().String()); err == nil {
			out = append(out, address)
		}
	}
	return out
}
