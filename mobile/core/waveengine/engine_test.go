package waveengine

import (
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"

	"golang.zx2c4.com/wireguard/device"

	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavecrypto"
	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavemagic"
	"github.com/moellenbeck-digital/wave-mesh/mobile/core/waveproto"
	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavesettings"
	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavetun"
)

// An in-memory tunnel: everything above it is the code that runs on a phone.
type memoryLink struct {
	inbound chan []byte
	mu      sync.Mutex
	closed  bool
}

func newMemoryLink() *memoryLink { return &memoryLink{inbound: make(chan []byte, 8)} }

func (l *memoryLink) ReadPacket(buf []byte) (int, error) {
	packet, ok := <-l.inbound
	if !ok {
		return 0, wavetun.ErrLinkClosed
	}
	return copy(buf, packet), nil
}

func (l *memoryLink) WritePacket([]byte) error { return nil }

func (l *memoryLink) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.closed {
		l.closed = true
		close(l.inbound)
	}
	return nil
}

type fakeHost struct {
	mu       sync.Mutex
	applied  []wavesettings.Settings
	lines    []string
	saved    []byte
	authURLs []string
	// refuse is how many applications to refuse before taking one, as a
	// platform that is not ready yet would.
	refuse int
}

func (h *fakeHost) ApplySettings(settings wavesettings.Settings) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.refuse > 0 {
		h.refuse--
		return errors.New("the platform refused the settings")
	}
	h.applied = append(h.applied, settings)
	return nil
}

func (h *fakeHost) Log(line string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.lines = append(h.lines, line)
}

func (h *fakeHost) SaveState(encoded []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.saved = encoded
}

func (h *fakeHost) OpenAuthURL(url string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.authURLs = append(h.authURLs, url)
}

func (h *fakeHost) applications() []wavesettings.Settings {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]wavesettings.Settings(nil), h.applied...)
}

// newTestEngine builds the engine without the control server: enrolment is
// tested in wavecontrol, and what matters here is what happens to a netmap once
// it has arrived.
func newTestEngine(t *testing.T) (*Engine, *fakeHost) {
	t.Helper()
	host := &fakeHost{}
	engine := &Engine{
		host:     host,
		resolver: newResolver(nil),
		state:    State{Version: StateVersion},
		waves:    map[string]*wave{},
		stop:     make(chan struct{}),
		started:  true,
	}
	engine.sock = wavemagic.New(wavemagic.Options{Log: host.Log})
	if err := engine.sock.Start(); err != nil {
		t.Fatal(err)
	}
	engine.mux = wavetun.New(newMemoryLink(), 1280, host.Log)
	engine.mux.Start()
	t.Cleanup(func() {
		engine.mu.Lock()
		engine.stopping = true
		engine.mu.Unlock()
		close(engine.stop)
		for _, entry := range engine.waves {
			entry.device.Close()
		}
		_ = engine.mux.Close()
		_ = engine.sock.Close()
	})
	return engine, host
}

func addWave(t *testing.T, engine *Engine, controlURL string) *wave {
	t.Helper()
	profile, err := NewProfile(controlURL)
	if err != nil {
		t.Fatal(err)
	}
	return addProfile(t, engine, profile)
}

// addProfile runs an enrolment the test made itself, e.g. a further one at a
// server that already has one.
func addProfile(t *testing.T, engine *Engine, profile Profile) *wave {
	t.Helper()
	profile.NetmapPublicKey = "pinned"
	entry := &wave{profile: profile, pendingHints: map[string][]waveproto.Candidate{}}

	virtual := engine.mux.DeviceFor(entry.key())
	bind := engine.sock.BindFor(entry.key())
	engine.sock.SetDiscoIdentity(entry.key(), profile.DiscoKey.PublicKey, profile.DiscoKey.PrivateKey)
	entry.device = device.NewDevice(virtual, bind, device.NewLogger(device.LogLevelSilent, ""))

	engine.mu.Lock()
	engine.waves[entry.key()] = entry
	engine.mu.Unlock()
	return entry
}

// netmapFor builds one wave's netmap. Each wave gets a /16 and a /48 of its
// own (D5), so the fixture spells both out: sharing either is the collision the
// engine is supposed to refuse.
func netmapFor(t *testing.T, waveID, suffix, selfIPv4, selfIPv6 string, peers ...waveproto.Peer) waveproto.Netmap {
	t.Helper()
	nodeKey, discoKey := testKey(t), testKey(t)
	return waveproto.Netmap{
		Version: 1,
		WaveID:  waveID,
		Self: waveproto.SelfNode{
			Peer: waveproto.Peer{
				ID: "n_self", NodeKey: nodeKey, DiscoKey: discoKey,
				Hostname: "phone", DNSName: "phone." + suffix,
				IPv4: selfIPv4, IPv6: selfIPv6,
				AllowedIPs: []string{selfIPv4 + "/32"}, Online: true,
			},
			Addresses: []string{selfIPv4 + "/32", selfIPv6 + "/128"},
		},
		Peers: peers,
		DNS:   waveproto.DNSConfig{Suffix: suffix},
	}
}

func testPeer(t *testing.T, hostname, suffix, ipv4, ipv6 string) waveproto.Peer {
	t.Helper()
	return waveproto.Peer{
		ID: "n_" + hostname, NodeKey: testKey(t), DiscoKey: testKey(t),
		Hostname: hostname, DNSName: hostname + "." + suffix,
		IPv4: ipv4, IPv6: ipv6,
		AllowedIPs: []string{ipv4 + "/32", ipv6 + "/128"}, Online: true,
	}
}

func testKey(t *testing.T) string {
	t.Helper()
	pair, err := wavecrypto.GenerateX25519()
	if err != nil {
		t.Fatal(err)
	}
	return pair.PublicKey
}

// Two waves, one union, applied once. This is the whole shape of D10 on the
// settings side.
func TestTwoWavesBecomeOneSetOfSettings(t *testing.T) {
	engine, host := newTestEngine(t)
	first := addWave(t, engine, "https://a.example")
	second := addWave(t, engine, "https://b.example")

	if err := engine.applyNetmap(first, netmapFor(t, "w1", "a.wave.example.com", "10.77.0.1", "fd7a:1::1",
		testPeer(t, "laptop", "a.wave.example.com", "10.77.0.2", "fd7a:1::2"))); err != nil {
		t.Fatal(err)
	}
	if err := engine.applyNetmap(second, netmapFor(t, "w2", "b.wave.example.com", "10.96.0.1", "fd7b:2::1",
		testPeer(t, "server", "b.wave.example.com", "10.96.0.2", "fd7b:2::2"))); err != nil {
		t.Fatal(err)
	}

	applications := host.applications()
	last := applications[len(applications)-1]
	if len(last.Addresses) != 4 {
		t.Fatalf("addresses %v", last.Addresses)
	}
	// One route per peer address, both families, both waves.
	if len(last.Routes) != 4 {
		t.Fatalf("routes %v", last.Routes)
	}
	if len(last.MatchDomains) < 2 {
		t.Fatalf("match domains %v", last.MatchDomains)
	}
	if len(last.SearchDomains) != 2 {
		t.Fatalf("search domains %v", last.SearchDomains)
	}
}

// Applying interrupts the tunnel, so a netmap that changed nothing must not
// reach the platform at all.
func TestANetmapThatChangesNothingIsNotApplied(t *testing.T) {
	engine, host := newTestEngine(t)
	entry := addWave(t, engine, "https://a.example")
	netmap := netmapFor(t, "w1", "a.wave.example.com", "10.77.0.1", "fd7a:1::1",
		testPeer(t, "laptop", "a.wave.example.com", "10.77.0.2", "fd7a:1::2"))

	if err := engine.applyNetmap(entry, netmap); err != nil {
		t.Fatal(err)
	}
	before := len(host.applications())

	// The same wave again, with nothing but a higher version -- which is what
	// a peer coming online looks like.
	netmap.Version = 2
	netmap.Peers[0].Online = false
	if err := engine.applyNetmap(entry, netmap); err != nil {
		t.Fatal(err)
	}
	if after := len(host.applications()); after != before {
		t.Fatalf("the tunnel was re-applied for nothing (%d -> %d)", before, after)
	}
}

// The one that cannot be repaired from here: a second wave handing out the same
// range. It is refused by name, and the first keeps running.
func TestAnOverlappingSecondWaveIsRefused(t *testing.T) {
	engine, host := newTestEngine(t)
	first := addWave(t, engine, "https://a.example")
	second := addWave(t, engine, "https://b.example")

	if err := engine.applyNetmap(first, netmapFor(t, "w1", "a.wave.example.com", "10.77.0.1", "fd7a:1::1",
		testPeer(t, "laptop", "a.wave.example.com", "10.77.0.2", "fd7a:1::2"))); err != nil {
		t.Fatal(err)
	}
	applied := len(host.applications())

	err := engine.applyNetmap(second, netmapFor(t, "w2", "b.wave.example.com", "10.96.0.1", "fd7b:2::1",
		testPeer(t, "other", "b.wave.example.com", "10.77.0.2", "fd7b:2::2")))
	if err == nil {
		t.Fatal("a second wave claiming the same address must be refused")
	}
	if !strings.Contains(err.Error(), "a.example") {
		t.Fatalf("the refusal must name the wave that keeps running: %v", err)
	}
	if len(host.applications()) != applied {
		t.Fatal("the refused wave still changed the tunnel")
	}
	// And the first wave is untouched. Looked up by its server and read from
	// one status: the waves come out of a map, in a different order each
	// time, and indexing two separate calls could look at the empty one twice.
	for _, view := range engine.Status().Waves {
		if view.ControlURL == "https://a.example" && view.WaveID != "w1" {
			t.Fatalf("the first wave lost its netmap: %+v", view)
		}
	}
}

// The reason keys are checked at all: the waves share one socket here, and a
// disco packet carries its sender's key in the clear.
func TestASecondWaveSharingADiscoKeyIsRefused(t *testing.T) {
	engine, _ := newTestEngine(t)
	first := addWave(t, engine, "https://a.example")
	second := addWave(t, engine, "https://b.example")

	peer := testPeer(t, "laptop", "a.wave.example.com", "10.77.0.2", "fd7a:1::2")
	if err := engine.applyNetmap(first, netmapFor(t, "w1", "a.wave.example.com", "10.77.0.1", "fd7a:1::1", peer)); err != nil {
		t.Fatal(err)
	}

	impostor := testPeer(t, "other", "b.wave.example.com", "10.96.0.2", "fd7b:2::2")
	impostor.DiscoKey = peer.DiscoKey
	err := engine.applyNetmap(second, netmapFor(t, "w2", "b.wave.example.com", "10.96.0.1", "fd7b:2::1", impostor))
	if err == nil || !strings.Contains(err.Error(), "disco key") {
		t.Fatalf("got %v", err)
	}
}

// The endpoint line must never carry an address: the magic socket decides the
// path, and a change of path must not touch the WireGuard configuration.
func TestTheUAPIConfigNamesPeersRatherThanAddresses(t *testing.T) {
	peer := waveproto.Peer{
		NodeKey:    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
		AllowedIPs: []string{"10.77.0.2/32", "fd7a:1::2/128"},
	}
	config := uapiConfig(waveproto.Netmap{Peers: []waveproto.Peer{peer}}, nil)

	if !strings.Contains(config, "endpoint=wave://"+peer.NodeKey) {
		t.Fatalf("config:\n%s", config)
	}
	if strings.Contains(config, "replace_peers") {
		t.Fatalf("replace_peers drops every session in the wave:\n%s", config)
	}
	if !strings.Contains(config, "replace_allowed_ips=true") {
		t.Fatalf("a peer's allowed IPs have to be declared whole:\n%s", config)
	}
	for _, allowed := range peer.AllowedIPs {
		if !strings.Contains(config, "allowed_ip="+allowed) {
			t.Fatalf("%s is missing:\n%s", allowed, config)
		}
	}
	// Zero, and said: a phone keeps no idle peer's NAT state alive at the
	// price of its radio, and a device configured before keeps its old value
	// unless the set names it.
	if !strings.Contains(config, "persistent_keepalive_interval=0\n") {
		t.Fatalf("keepalive is not switched off:\n%s", config)
	}
}

func TestStatusIsJSONThePlatformCanRead(t *testing.T) {
	engine, _ := newTestEngine(t)
	entry := addWave(t, engine, "https://a.example")
	if err := engine.applyNetmap(entry, netmapFor(t, "w1", "a.wave.example.com", "10.77.0.1", "fd7a:1::1",
		testPeer(t, "laptop", "a.wave.example.com", "10.77.0.2", "fd7a:1::2"))); err != nil {
		t.Fatal(err)
	}

	var decoded Status
	if err := json.Unmarshal([]byte(engine.StatusJSON()), &decoded); err != nil {
		t.Fatal(err)
	}
	// Named by its DNS suffix once the netmap says it: with several waves at
	// one server, the server's host would name them all alike.
	if len(decoded.Waves) != 1 || decoded.Waves[0].Label != "a.wave.example.com" || decoded.Waves[0].ID != "https://a.example" {
		t.Fatalf("got %+v", decoded)
	}
	if len(decoded.Waves[0].Peers) != 1 || decoded.Waves[0].Peers[0].Hostname != "laptop" {
		t.Fatalf("peers %+v", decoded.Waves[0].Peers)
	}
	// Nothing has been sent to the peer, so it is not probed and nothing is
	// measured -- which is not the same as being down either.
	if decoded.Waves[0].Peers[0].Via != "idle" {
		t.Fatalf("via %q", decoded.Waves[0].Peers[0].Via)
	}
}

func TestStateRoundTrips(t *testing.T) {
	profile, err := NewProfile("https://a.example")
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := State{Version: StateVersion, Profiles: []Profile{profile}}.Encode()
	if err != nil {
		t.Fatal(err)
	}
	state, err := ParseState(encoded)
	if err != nil {
		t.Fatal(err)
	}
	back, found := state.Find("https://a.example")
	if !found || back.MachineKey.PrivateKey != profile.MachineKey.PrivateKey {
		t.Fatal("the keys did not survive the round trip")
	}
	if _, err := ParseState(nil); err != nil {
		t.Fatalf("a device that has never joined anything is not an error: %v", err)
	}
}

// A bare host is what a profile list prints, so it has to be accepted back.
func TestNormaliseControlURL(t *testing.T) {
	for input, want := range map[string]string{
		"wave-mesh-1.robin-lenz.de": "https://wave-mesh-1.robin-lenz.de",
		"https://a.example/":        "https://a.example",
		"http://192.168.1.5:8080":   "http://192.168.1.5:8080",
		"https://a.example:8443/":   "https://a.example:8443",
	} {
		got, ok := NormaliseControlURL(input)
		if !ok || got != want {
			t.Errorf("%q -> %q, %v (want %q)", input, got, ok, want)
		}
	}
	for _, input := range []string{"", "   ", "ftp://a.example", "not a url at all/ /"} {
		if got, ok := NormaliseControlURL(input); ok {
			t.Errorf("%q was accepted as %q", input, got)
		}
	}
}

// Go marshals a nil slice as null, and a Swift decoder with a non-optional
// array refuses one outright -- the status would simply stop updating, with
// nothing to see on either side. So every list is a list, empty included.
func TestTheStatusNeverCarriesANull(t *testing.T) {
	engine, _ := newTestEngine(t)

	// A device in no wave at all, which is what the first run looks like.
	if strings.Contains(engine.StatusJSON(), "null") {
		t.Fatalf("empty status: %s", engine.StatusJSON())
	}

	// And a wave whose netmap has neither peers nor services.
	entry := addWave(t, engine, "https://a.example")
	if err := engine.applyNetmap(entry, netmapFor(t, "w1", "a.wave.example.com", "10.77.0.1", "fd7a:1::1")); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(engine.StatusJSON(), "null") {
		t.Fatalf("status with an empty wave: %s", engine.StatusJSON())
	}
}

// The same rule for the settings, which are the other structure that crosses
// into Swift.
func TestTheSettingsNeverCarryANull(t *testing.T) {
	encoded, err := json.Marshal(wavesettings.Union(nil))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "null") {
		t.Fatalf("settings: %s", encoded)
	}
}

// Where the resolver answers matters more on a phone than on a desktop, because
// the resolver has no socket here: a packet to an address the interface holds
// is delivered locally and answered by nothing, so an on-device lookup needs an
// address that is routed into the tunnel and assigned to nobody.
func TestTheResolverPrefersAReservedAddress(t *testing.T) {
	netmap := netmapFor(t, "w1", "a.wave.example.com", "10.77.0.1", "fd7a:1::1",
		testPeer(t, "laptop", "a.wave.example.com", "10.77.0.2", "fd7a:1::2"))

	// Nothing reserved: our own address, which works for a peer asking us
	// through the tunnel and not for the device itself.
	if got := resolverAddressFor(netmap); got != "10.77.0.1" {
		t.Fatalf("got %q", got)
	}

	// A reservation out of the wave's own block is taken.
	netmap.DNS.ResolverAddress = "10.77.0.53"
	if got := resolverAddressFor(netmap); got != "10.77.0.53" {
		t.Fatalf("got %q", got)
	}

	// A peer's address is not a reservation: routing it to our own resolver
	// would take that peer off the network.
	netmap.DNS.ResolverAddress = "10.77.0.2"
	if got := resolverAddressFor(netmap); got != "10.77.0.1" {
		t.Fatalf("a peer's address was taken as the resolver: %q", got)
	}

	// Nor is an address outside the wave: the device's DNS is not a server's to
	// point anywhere it likes.
	netmap.DNS.ResolverAddress = "8.8.8.8"
	if got := resolverAddressFor(netmap); got != "10.77.0.1" {
		t.Fatalf("an address outside the wave was taken: %q", got)
	}

	// The schema's own default is inside the CGNAT range, which this project
	// does not address into at all (D5) -- and it is outside the wave, so it is
	// refused for that reason alone.
	netmap.DNS.ResolverAddress = "100.100.100.100"
	if got := resolverAddressFor(netmap); got != "10.77.0.1" {
		t.Fatalf("got %q", got)
	}
}

// A reserved address has to be routed into the tunnel and not assigned to it --
// assigned, the kernel would answer it locally, which is the whole problem.
func TestAReservedResolverIsRoutedNotAssigned(t *testing.T) {
	settings := wavesettings.Union([]wavesettings.Wave{{
		Addresses:       []string{"10.77.0.1/32"},
		Routes:          []string{"10.77.0.2/32"},
		Suffix:          "a.wave.example.com",
		ResolverAddress: "10.77.0.53",
	}})

	for _, address := range settings.Addresses {
		if strings.HasPrefix(address, "10.77.0.53") {
			t.Fatalf("the resolver address was assigned to the interface: %v", settings.Addresses)
		}
	}
	routed := false
	for _, route := range settings.Routes {
		if route.CIDR == "10.77.0.53/32" {
			routed = true
			if route.Source != "10.77.0.1" {
				t.Fatalf("the resolver route leaves from %q", route.Source)
			}
		}
	}
	if !routed {
		t.Fatalf("the resolver address is not routed: %+v", settings.Routes)
	}
}
