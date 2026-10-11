package wavemagic

import (
	"errors"
	"fmt"
	"net"
	"net/netip"
	"sort"
	"sync"
	"time"

	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavedisco"
	"github.com/moellenbeck-digital/wave-mesh/mobile/core/waveproto"
	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavestun"
)

// maxDatagram is one WireGuard packet at the largest MTU this ever configures,
// plus its header, rounded up.
const maxDatagram = 2048

// queueDepth is how many packets a wave may have waiting for its WireGuard
// device. Deep enough to ride out a scheduling hiccup, shallow enough that a
// stalled device drops instead of growing memory on a phone.
const queueDepth = 256

// PeerConfig is one peer as a netmap describes it.
type PeerConfig struct {
	WaveID     string
	NodeKey    string
	DiscoKey   string
	Candidates []netip.AddrPort
}

// PeerStatus is what a status view needs.
type PeerStatus struct {
	WaveID   string
	NodeKey  string
	Best     netip.AddrPort
	HasBest  bool
	ViaRelay bool
	RTT      time.Duration
	Paths    []Path
	// Nothing sent to this peer for activeTimeout, so it is not probed and
	// whatever path it had is the last one known, not a measured one.
	Idle bool
}

// Relay is the little this package needs from a relay connection: somewhere to
// send when no direct path works.
type Relay interface {
	Send(toDiscoKey string, payload []byte) bool
	Connected() bool
}

type peerKey struct {
	waveID  string
	nodeKey string
}

type peer struct {
	config PeerConfig
	// Our own disco public key in this peer's wave: the sender key that goes
	// into every packet to it. Held per peer rather than per socket because
	// each enrolment has keys of its own (D10) -- a shared one would be the
	// same key in every netmap, and two waves with a common member could
	// recognise the device.
	senderDiscoKey string
	shared         []byte
	paths          map[string]*Path
	best           string
	probingSince   time.Time
	// When WireGuard last sent this peer anything; see activeTimeout.
	lastSend time.Time
	endpoint *Endpoint
}

// activeAt reports whether WireGuard sent this peer something recently enough
// for its paths to be worth probing.
func (p *peer) activeAt(now time.Time) bool {
	return !p.lastSend.IsZero() && now.Sub(p.lastSend) < activeTimeout
}

func (p *peer) pathList() []*Path {
	out := make([]*Path, 0, len(p.paths))
	for _, path := range p.paths {
		out = append(out, path)
	}
	// Deterministic, so a tie between two paths with no measurement yet does
	// not come down to map order.
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out
}

// discoIdentity is one wave's disco key pair.
type discoIdentity struct {
	publicKey  string
	privateKey string
}

// snapshot is everything the send path needs about a peer, copied out under the
// lock.
//
// Copied rather than followed by pointer, and that is the point: a peer's keys
// are replaced when its netmap changes, and reading them from the data path
// while another goroutine writes them is a race the race detector only finds
// when it happens to be looking. Nothing below the lock reaches back into the
// peer.
type snapshot struct {
	waveID         string
	nodeKey        string
	discoKey       string
	senderDiscoKey string
	shared         []byte
}

func snapshotOf(owner *peer) snapshot {
	return snapshot{
		waveID:         owner.config.WaveID,
		nodeKey:        owner.config.NodeKey,
		discoKey:       owner.config.DiscoKey,
		senderDiscoKey: owner.senderDiscoKey,
		shared:         owner.shared,
	}
}

// target is one path, as much of it as sending needs. Same reason as snapshot:
// a path's measurements are written under the lock.
type target struct {
	key      string
	endpoint netip.AddrPort
	viaRelay bool
}

func targetOf(path *Path) target {
	return target{key: path.Key, endpoint: path.Endpoint, viaRelay: path.ViaRelay}
}

type inflight struct {
	peer   *peer
	path   *Path
	sentAt time.Time
}

// Options configures the socket.
type Options struct {
	// The port to try first. Zero takes whatever the system gives.
	ListenPort int
	// Protect is the platform's escape from its own tunnel. Every socket this
	// opens goes through it, because on Android an unprotected socket of ours
	// is routed into the tunnel it is carrying.
	Protect func(fd uintptr)
	Log     func(string)
	// Logs every probe. Useful when a NAT refuses to cooperate.
	Verbose bool
	// Overridable for tests; defaults to time.Now.
	Now func() time.Time
}

// Sock is the one public UDP socket on this device.
type Sock struct {
	options Options
	log     func(string)
	now     func() time.Time
	// probeKick puts the probe loop back on the fast tick at once, when a
	// fast phase starts while it is ticking slowly.
	probeKick chan struct{}

	mu    sync.Mutex
	conn  *net.UDPConn
	binds map[string]*Bind
	peers map[peerKey]*peer
	// Every peer in every wave, by disco key.
	//
	// Global on purpose, and the reason waveoverlap refuses two waves that
	// share a key: a discovery packet carries its sender's key in the clear,
	// so this is the only thing that can attribute one, and it cannot be
	// narrowed to a wave before the packet has been attributed.
	byDisco map[string]*peer
	// WireGuard traffic can only be attributed by the address it came from,
	// which is why discovery has to happen first.
	byAddress map[netip.AddrPort]*peer
	// One disco identity per wave, keyed the way every wave is keyed here.
	discoIdentities map[string]discoIdentity
	inflight        map[string]inflight
	pendingSTUN     map[string]chan waveproto.Endpoint
	// Our own addresses, with when anything last reported each one.
	reflexive   map[netip.AddrPort]SeenAddress
	stunServers []netip.AddrPort
	// One relay connection per wave, not one per device.
	//
	// The relay routes by disco key and each enrolment has its own, so a peer
	// in wave B addresses frames to our wave-B key -- a single connection made
	// with wave A's key would leave the relay with no session to deliver them
	// to, and relayed traffic in every other wave would simply never arrive.
	// That is the price of the per-enrolment key separation, and it is the
	// trade D10 makes deliberately.
	relays         map[string]Relay
	probingEnabled bool
	closed         bool

	stop chan struct{}
	done sync.WaitGroup
}

// New makes a socket. Start opens it.
func New(options Options) *Sock {
	sock := &Sock{
		options:         options,
		log:             options.Log,
		now:             options.Now,
		binds:           map[string]*Bind{},
		peers:           map[peerKey]*peer{},
		byDisco:         map[string]*peer{},
		byAddress:       map[netip.AddrPort]*peer{},
		discoIdentities: map[string]discoIdentity{},
		reflexive:       map[netip.AddrPort]SeenAddress{},
		inflight:        map[string]inflight{},
		pendingSTUN:     map[string]chan waveproto.Endpoint{},
		relays:          map[string]Relay{},
		stop:            make(chan struct{}),
		probeKick:       make(chan struct{}, 1),
	}
	if sock.log == nil {
		sock.log = func(string) {}
	}
	if sock.now == nil {
		sock.now = time.Now
	}
	return sock
}

// Start opens the socket and begins probing paths.
func (s *Sock) Start() error {
	conn, err := s.bindPublic(s.options.ListenPort)
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.conn = conn
	s.mu.Unlock()

	s.done.Add(2)
	go s.readLoop(conn)
	go s.probeLoop()
	return nil
}

// bindPublic opens the public socket, falling back to an ephemeral port when
// the preferred one is taken -- another mesh VPN may well default to it too.
// Nothing depends on the number: peers learn it from our published candidates,
// which are derived from the port we actually got.
func (s *Sock) bindPublic(port int) (*net.UDPConn, error) {
	conn, err := net.ListenUDP("udp", &net.UDPAddr{Port: port})
	if err != nil && port != 0 {
		s.log(fmt.Sprintf("port %d is already in use; binding an ephemeral port instead", port))
		conn, err = net.ListenUDP("udp", &net.UDPAddr{Port: 0})
	}
	if err != nil {
		return nil, err
	}
	s.protect(conn)
	return conn, nil
}

// protect asks the platform to keep this socket out of the tunnel. Without it
// on Android, the encrypted traffic would be routed into the tunnel carrying
// it -- which looks like a peer that never answers.
func (s *Sock) protect(conn *net.UDPConn) {
	if s.options.Protect == nil {
		return
	}
	raw, err := conn.SyscallConn()
	if err != nil {
		s.log("could not reach the socket to protect it: " + err.Error())
		return
	}
	if err := raw.Control(s.options.Protect); err != nil {
		s.log("could not protect the socket: " + err.Error())
	}
}

// Port is the port peers should be told about.
func (s *Sock) Port() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.conn == nil {
		return s.options.ListenPort
	}
	return s.conn.LocalAddr().(*net.UDPAddr).Port
}

// BindFor returns the conn.Bind for one wave, creating it on first use. Handing
// the same wave two binds would give its device two queues and half its
// packets, so this is the only way to get one.
func (s *Sock) BindFor(waveID string) *Bind {
	s.mu.Lock()
	defer s.mu.Unlock()
	if bind, ok := s.binds[waveID]; ok {
		return bind
	}
	// No queue yet: one is made when WireGuard opens the bind, and there is
	// nobody to read packets before that.
	bind := &Bind{sock: s, waveID: waveID}
	s.binds[waveID] = bind
	return bind
}

// SetDiscoIdentity gives one wave its disco keys. It has to be called before
// that wave's peers are, because the shared secret with every one of them is
// derived from this private half.
func (s *Sock) SetDiscoIdentity(waveID, publicKey, privateKey string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.discoIdentities[waveID] = discoIdentity{publicKey: publicKey, privateKey: privateKey}
}

// RemoveWave drops a wave's bind and its peers. Called when a wave is left, and
// the counterpart of BindFor.
func (s *Sock) RemoveWave(waveID string) {
	s.mu.Lock()
	bind := s.binds[waveID]
	delete(s.binds, waveID)
	delete(s.relays, waveID)
	delete(s.discoIdentities, waveID)
	for key, peer := range s.peers {
		if key.waveID != waveID {
			continue
		}
		s.forget(key, peer)
	}
	s.mu.Unlock()
	if bind != nil {
		bind.retire()
	}
}

// forget removes a peer from every index. The caller holds the lock.
func (s *Sock) forget(key peerKey, gone *peer) {
	delete(s.peers, key)
	if s.byDisco[gone.config.DiscoKey] == gone {
		delete(s.byDisco, gone.config.DiscoKey)
	}
	for address, owner := range s.byAddress {
		if owner == gone {
			delete(s.byAddress, address)
		}
	}
}

// SetRelay attaches one wave's relay, giving its peers a path that works
// without punching. A nil relay takes the path away again.
func (s *Sock) SetRelay(waveID string, relay Relay) {
	s.mu.Lock()
	if relay == nil {
		delete(s.relays, waveID)
		for key, peer := range s.peers {
			if key.waveID == waveID {
				delete(peer.paths, RelayPathKey)
				if peer.best == RelayPathKey {
					peer.best = ""
				}
			}
		}
		s.mu.Unlock()
		return
	}
	s.relays[waveID] = relay
	for key, peer := range s.peers {
		if key.waveID == waveID {
			s.ensureRelayPath(peer)
		}
	}
	s.mu.Unlock()
	s.probeAll()
}

// SetSTUNServers replaces the STUN servers, which normally come from a netmap.
func (s *Sock) SetSTUNServers(servers []netip.AddrPort) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stunServers = servers
}

// SetPeers applies one wave's peer set, keeping the state of peers that stay.
func (s *Sock) SetPeers(waveID string, configs []PeerConfig) error {
	s.mu.Lock()
	identity, known := s.discoIdentities[waveID]
	if !known {
		s.mu.Unlock()
		return fmt.Errorf("wave %s has no disco identity yet", waveID)
	}
	wanted := make(map[string]struct{}, len(configs))
	for _, config := range configs {
		wanted[config.NodeKey] = struct{}{}
	}
	for key, existing := range s.peers {
		if key.waveID != waveID {
			continue
		}
		if _, keep := wanted[key.nodeKey]; !keep {
			s.forget(key, existing)
		}
	}

	var failures []error
	for _, config := range configs {
		config.WaveID = waveID
		key := peerKey{waveID: waveID, nodeKey: config.NodeKey}
		if existing, ok := s.peers[key]; ok {
			if existing.config.DiscoKey != config.DiscoKey {
				// A rotated disco key is a new shared secret and a new index
				// entry; keeping the old one would decrypt nothing.
				delete(s.byDisco, existing.config.DiscoKey)
				shared, err := wavedisco.SharedKey(identity.privateKey, config.DiscoKey)
				if err != nil {
					failures = append(failures, err)
					continue
				}
				existing.shared = shared
				s.byDisco[config.DiscoKey] = existing
			}
			existing.config = config
			existing.senderDiscoKey = identity.publicKey
			s.forgetWithdrawnLocked(existing, config.Candidates)
			s.mergeCandidates(existing, config.Candidates, false)
			s.ensureRelayPath(existing)
			continue
		}

		shared, err := wavedisco.SharedKey(identity.privateKey, config.DiscoKey)
		if err != nil {
			failures = append(failures, fmt.Errorf("peer %s: %w", short(config.NodeKey), err))
			continue
		}
		created := &peer{
			config:         config,
			senderDiscoKey: identity.publicKey,
			shared:         shared,
			paths:          map[string]*Path{},
			probingSince:   s.now(),
			endpoint:       &Endpoint{waveID: waveID, nodeKey: config.NodeKey},
		}
		s.peers[key] = created
		s.byDisco[config.DiscoKey] = created
		s.mergeCandidates(created, config.Candidates, false)
		s.ensureRelayPath(created)
		s.log(fmt.Sprintf("peer %s: %d candidate(s)", short(config.NodeKey), len(config.Candidates)))
	}
	s.mu.Unlock()

	s.probeAll()
	s.kickProbing()
	return errors.Join(failures...)
}

// EnableProbing starts probing.
//
// Probing before our own candidates have been published is actively harmful:
// our packets arrive at the peer's NAT as an unsolicited inbound flow, which
// creates a conntrack entry occupying exactly the tuple the peer needs for its
// own outbound mapping. The peer is then translated to a different port than
// the one STUN reported, and neither side can ever reach the other.
func (s *Sock) EnableProbing() {
	s.mu.Lock()
	already := s.probingEnabled
	s.probingEnabled = true
	s.mu.Unlock()
	if !already {
		s.probeAll()
	}
	s.kickProbing()
}

// PunchNow restarts aggressive probing for one peer, e.g. after the control
// server said to punch.
func (s *Sock) PunchNow(waveID, nodeKey string, candidates []netip.AddrPort) {
	s.mu.Lock()
	target, ok := s.peers[peerKey{waveID: waveID, nodeKey: nodeKey}]
	if !ok || !s.probingEnabled {
		s.mu.Unlock()
		return
	}
	s.mergeCandidates(target, candidates, false)
	target.probingSince = s.now()
	s.mu.Unlock()
	s.probePeer(target)
	s.kickProbing()
}

// HasUnreachablePeers reports whether at least one peer has no usable path.
func (s *Sock) HasUnreachablePeers() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, peer := range s.peers {
		if peer.best == "" {
			return true
		}
	}
	return false
}

// Status is the state of every peer in every wave.
func (s *Sock) Status() []PeerStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]PeerStatus, 0, len(s.peers))
	now := s.now()
	for _, peer := range s.peers {
		status := PeerStatus{
			WaveID: peer.config.WaveID, NodeKey: peer.config.NodeKey,
			Idle: !peer.activeAt(now),
		}
		if best, ok := peer.paths[peer.best]; ok && peer.best != "" {
			status.Best = best.Endpoint
			status.HasBest = best.Endpoint.IsValid()
			status.ViaRelay = best.ViaRelay
			status.RTT = best.RTT
		}
		for _, path := range peer.pathList() {
			status.Paths = append(status.Paths, *path)
		}
		out = append(out, status)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].WaveID != out[j].WaveID {
			return out[i].WaveID < out[j].WaveID
		}
		return out[i].NodeKey < out[j].NodeKey
	})
	return out
}

// Rebind moves the public socket to a fresh port, keeping peers and their paths.
//
// Two things need it. A NAT port collision: an unsolicited inbound packet from
// a peer can create a conntrack entry that occupies exactly the tuple we need,
// after which our NAT translates us to a port nobody knows. On a fresh port we
// get to send first -- the peer cannot have poisoned a port it has never heard
// of -- so the outbound mapping is established cleanly.
//
// And a network change, which on a phone is the normal case rather than the
// exception: WiFi to LTE means every candidate we published is wrong and the
// old socket is bound to an address that no longer exists.
func (s *Sock) Rebind() (int, error) {
	conn, err := s.bindPublic(0)
	if err != nil {
		return 0, err
	}

	s.mu.Lock()
	previous := s.conn
	s.conn = conn
	s.reflexive = map[netip.AddrPort]SeenAddress{}
	// Learned addresses described the old mapping; a peer that answers on the
	// new one will teach us again.
	for _, peer := range s.peers {
		for key, path := range peer.paths {
			if path.Learned {
				delete(peer.paths, key)
			}
		}
		peer.probingSince = s.now()
	}
	s.mu.Unlock()

	if previous != nil {
		_ = previous.Close()
	}
	s.done.Add(1)
	go s.readLoop(conn)
	s.kickProbing()
	s.log(fmt.Sprintf("rebound to port %d", conn.LocalAddr().(*net.UDPAddr).Port))
	s.probeAll()
	return conn.LocalAddr().(*net.UDPAddr).Port, nil
}

// Close shuts the socket and every bind on it.
func (s *Sock) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	conn := s.conn
	binds := make([]*Bind, 0, len(s.binds))
	for _, bind := range s.binds {
		binds = append(binds, bind)
	}
	s.binds = map[string]*Bind{}
	s.peers = map[peerKey]*peer{}
	s.byDisco = map[string]*peer{}
	s.byAddress = map[netip.AddrPort]*peer{}
	s.relays = map[string]Relay{}
	s.mu.Unlock()

	close(s.stop)
	if conn != nil {
		_ = conn.Close()
	}
	for _, bind := range binds {
		bind.retire()
	}
	s.done.Wait()
	return nil
}

// --- receiving --------------------------------------------------------------

func (s *Sock) readLoop(conn *net.UDPConn) {
	defer s.done.Done()
	buffer := make([]byte, maxDatagram)
	for {
		n, from, err := conn.ReadFromUDPAddrPort(buffer)
		if err != nil {
			// A closed socket ends this loop; a rebind has already started the
			// next one. Anything else is an ICMP error the protocol expects --
			// probing a peer's candidates means sending to addresses that are
			// unroutable from here -- and reading on.
			select {
			case <-s.stop:
				return
			default:
			}
			if errors.Is(err, net.ErrClosed) {
				return
			}
			continue
		}
		// Unmapped: a dual-stack socket reports an IPv4 sender as ::ffff:a.b.c.d,
		// and the same peer under two spellings would be two paths.
		s.onWirePacket(buffer[:n], netip.AddrPortFrom(from.Addr().Unmap(), from.Port()))
	}
}

func (s *Sock) onWirePacket(data []byte, from netip.AddrPort) {
	if wavestun.LooksLikeStun(data) {
		txid, mapped, ok := wavestun.ParseBindingResponse(data)
		if !ok {
			return
		}
		s.mu.Lock()
		waiting := s.pendingSTUN[txid]
		delete(s.pendingSTUN, txid)
		s.mu.Unlock()
		if waiting != nil {
			select {
			case waiting <- mapped:
			default:
			}
		}
		return
	}

	if wavedisco.LooksLikeDisco(data) {
		s.mu.Lock()
		decoded, ok := wavedisco.Decode(data, func(sender string) []byte {
			if found, known := s.byDisco[sender]; known {
				return found.shared
			}
			return nil
		})
		if !ok {
			s.mu.Unlock()
			return
		}
		owner := s.byDisco[decoded.SenderDiscoKey]
		if owner == nil {
			s.mu.Unlock()
			return
		}
		// A packet that decrypts proves the sender holds the peer's disco key,
		// so the address it came from is a usable path even if never announced.
		pathKey, learned := s.pathFor(owner, from)
		nodeKey := owner.config.NodeKey
		s.mu.Unlock()
		if learned {
			s.log(fmt.Sprintf("learned %s for %s from an inbound packet", from, short(nodeKey)))
		}
		s.onDisco(owner, pathKey, decoded.Message)
		return
	}

	// Everything else is WireGuard traffic.
	s.mu.Lock()
	owner := s.byAddress[from]
	s.mu.Unlock()
	if owner == nil {
		return
	}
	s.deliverToWireguard(owner, data)
}

// OnRelayPacket feeds a packet that arrived through the relay. The relay routes
// by disco key and knows nothing of waves, so the lookup is the global one.
func (s *Sock) OnRelayPacket(senderDiscoKey string, payload []byte) {
	s.mu.Lock()
	owner := s.byDisco[senderDiscoKey]
	if owner == nil {
		s.mu.Unlock()
		return
	}
	path := s.ensureRelayPath(owner)
	shared := owner.shared
	s.mu.Unlock()
	if path == nil {
		return
	}

	if wavedisco.LooksLikeDisco(payload) {
		if decoded, ok := wavedisco.Decode(payload, func(string) []byte { return shared }); ok {
			s.onDisco(owner, RelayPathKey, decoded.Message)
		}
		return
	}
	s.deliverToWireguard(owner, payload)
}

func (s *Sock) deliverToWireguard(owner *peer, data []byte) {
	s.mu.Lock()
	bind := s.binds[owner.config.WaveID]
	s.mu.Unlock()
	if bind == nil {
		return
	}
	// Copied because the read buffer is reused on the next datagram.
	payload := make([]byte, len(data))
	copy(payload, data)
	bind.deliver(received{payload: payload, endpoint: owner.endpoint})
}

// onDisco handles one decoded discovery message. The peer and the path are
// named rather than held: both are looked up again under the lock, so nothing
// here follows a pointer into state another goroutine is writing.
func (s *Sock) onDisco(owner *peer, pathKey string, message wavedisco.Message) {
	switch message.Type {
	case wavedisco.TypePing:
		s.mu.Lock()
		path, known := owner.paths[pathKey]
		if !known {
			s.mu.Unlock()
			return
		}
		snap, reply := snapshotOf(owner), targetOf(path)
		s.mu.Unlock()

		observed := waveproto.Endpoint{IP: "0.0.0.0", Port: 0}
		if reply.endpoint.IsValid() {
			observed = waveproto.Endpoint{IP: reply.endpoint.Addr().String(), Port: int(reply.endpoint.Port())}
		}
		s.sendDisco(snap, reply, wavedisco.Message{
			Type: wavedisco.TypePong, Txid: message.Txid, Observed: observed,
		})
	case wavedisco.TypePong:
		s.mu.Lock()
		pending, ok := s.inflight[wavedisco.TxidHex(message.Txid)]
		if !ok || pending.peer != owner {
			s.mu.Unlock()
			return
		}
		delete(s.inflight, wavedisco.TxidHex(message.Txid))
		now := s.now()
		// Smoothed, not replaced: a single sample is far noisier than the
		// difference between two paths (see rttAlpha).
		pending.path.RTT = SmoothRTT(pending.path.RTT, now.Sub(pending.sentAt))
		pending.path.LastPongAt = now
		s.selectBestLocked(owner)
		// The peer tells us how it saw us; that is a candidate for our own list.
		if message.Observed.Port != 0 {
			if address, err := netip.ParseAddrPort(message.Observed.String()); err == nil {
				s.rememberReflexiveLocked(address)
			}
		}
		s.mu.Unlock()
	case wavedisco.TypeCallMeMaybe:
		s.mu.Lock()
		s.mergeCandidates(owner, endpointsToAddrPorts(message.Endpoints), false)
		s.mu.Unlock()
	}
}

// --- sending ----------------------------------------------------------------

// sendToPeer is what a wave's Bind calls: the packet goes down the path chosen
// for that peer, or is sprayed while none is confirmed.
func (s *Sock) sendToPeer(waveID, nodeKey string, data []byte) {
	s.mu.Lock()
	owner, ok := s.peers[peerKey{waveID: waveID, nodeKey: nodeKey}]
	if !ok {
		s.mu.Unlock()
		return
	}
	// The first packet after a quiet spell wakes the peer: its paths are a
	// guess by now, so it gets the fast phase a new peer gets.
	now := s.now()
	resumed := !owner.activeAt(now)
	owner.lastSend = now
	if resumed {
		owner.probingSince = now
	}
	snap := snapshotOf(owner)
	best, hasBest := owner.paths[owner.best]
	var chosen target
	if hasBest {
		chosen = targetOf(best)
	}
	spray := make([]target, 0, len(owner.paths))
	if !hasBest {
		for _, path := range owner.pathList() {
			if len(spray) >= maxSpray {
				break
			}
			spray = append(spray, targetOf(path))
		}
	}
	s.mu.Unlock()
	if resumed {
		s.kickProbing()
	}

	if hasBest {
		s.sendVia(snap, chosen, data)
		return
	}
	// No confirmed path yet: spray, so the handshake itself helps punch holes.
	for _, path := range spray {
		s.sendVia(snap, path, data)
	}
}

func (s *Sock) sendVia(snap snapshot, path target, data []byte) bool {
	if path.viaRelay {
		s.mu.Lock()
		relay := s.relays[snap.waveID]
		s.mu.Unlock()
		return relay != nil && relay.Send(snap.discoKey, data)
	}
	if !path.endpoint.IsValid() {
		return false
	}
	s.mu.Lock()
	conn := s.conn
	s.mu.Unlock()
	if conn == nil {
		return false
	}

	// Sending to a candidate that is unreachable is routine -- a peer's LAN
	// address usually is. What is not obvious is that the resulting ICMP error
	// is delivered to the *next* send on this socket, which would otherwise
	// make one dead candidate swallow the probe of a good one. Retrying once
	// gets past the queued error.
	for attempt := 0; attempt < 2; attempt++ {
		if _, err := conn.WriteToUDPAddrPort(data, path.endpoint); err == nil {
			return true
		} else if s.options.Verbose {
			s.log(fmt.Sprintf("send to %s failed: %v", path.key, err))
		}
	}
	return false
}

func (s *Sock) sendDisco(snap snapshot, path target, message wavedisco.Message) {
	packet, err := wavedisco.Encode(snap.senderDiscoKey, snap.shared, message)
	if err != nil {
		return
	}
	s.sendVia(snap, path, packet)
}

// --- probing ----------------------------------------------------------------

// probeLoop ticks every probeFast while some active peer is in its fast phase,
// every probeIdle while some peer is active at all, and every probeDormant
// when none is. Four wake-ups a second for the life of the tunnel cost a phone
// battery for nothing: outside a fast phase no path is owed a probe more often
// than every probeSlow, and a one-second tick meets that within its slack. A
// fast phase that starts -- a punch hint, a rebind, the first packet to an
// idle peer -- kicks the loop back to the fast tick at once.
func (s *Sock) probeLoop() {
	defer s.done.Done()
	timer := time.NewTimer(probeFast)
	defer timer.Stop()
	for {
		select {
		case <-s.stop:
			return
		case <-s.probeKick:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			s.probeAll()
		case <-timer.C:
			s.probeAll()
		}
		timer.Reset(s.probeInterval())
	}
}

// probeIdle is the loop's tick while no peer is in its fast phase.
const probeIdle = time.Second

// probeDormant is the loop's tick while no peer is active. Nothing is owed a
// probe then; the tick only keeps the loop from sleeping for ever if a kick
// were ever lost.
const probeDormant = 30 * time.Second

// activeTimeout is how long after WireGuard last sent a peer something that
// peer is still probed.
//
// Probing every path of every peer every few seconds, whether anything flowed
// or not, was the largest cost of the tunnel on a phone: on cellular each
// packet keeps the radio in its high-power state for seconds after it, so a
// probe every three seconds meant a radio that never slept. A path is only
// worth measuring while something is about to use it. Anything that talks --
// a ping, a TCP connection, even WireGuard answering a handshake -- sends, and
// the first packet after a quiet spell starts a fast phase. 45 seconds is what
// Tailscale settled on for the same trade, and comfortably longer than the
// ten seconds WireGuard waits before a passive keepalive.
//
// Only what we send counts, not what we receive: a peer that keeps its
// tunnel to us alive with keepalives of its own would otherwise keep us
// probing for ever.
const activeTimeout = 45 * time.Second

// probeInterval is how long the probe loop sleeps next.
func (s *Sock) probeInterval() time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.probingEnabled {
		return probeDormant
	}
	now := s.now()
	interval := probeDormant
	for _, peer := range s.peers {
		if !peer.activeAt(now) {
			continue
		}
		if now.Sub(peer.probingSince) < probeFastDuration {
			return probeFast
		}
		interval = probeIdle
	}
	return interval
}

// kickProbing wakes the probe loop for a fast phase that just began.
func (s *Sock) kickProbing() {
	select {
	case s.probeKick <- struct{}{}:
	default:
	}
}

func (s *Sock) probeAll() {
	s.mu.Lock()
	if !s.probingEnabled {
		s.mu.Unlock()
		return
	}
	peers := make([]*peer, 0, len(s.peers))
	for _, peer := range s.peers {
		peers = append(peers, peer)
	}
	s.mu.Unlock()
	for _, peer := range peers {
		s.probePeer(peer)
	}
}

func (s *Sock) probePeer(subject *peer) {
	s.mu.Lock()
	if !s.probingEnabled {
		s.mu.Unlock()
		return
	}
	now := s.now()
	if !subject.activeAt(now) {
		// Left as it was, best path included: the next packet goes there
		// first, and the fast phase it starts finds out whether it still
		// works.
		s.mu.Unlock()
		return
	}
	fast := now.Sub(subject.probingSince) < probeFastDuration
	relay := s.relays[subject.config.WaveID]

	type probe struct {
		where target
		txid  [wavedisco.TxidLength]byte
	}
	var probes []probe
	for _, path := range subject.pathList() {
		if !ProbeDue(path, now, fast) {
			continue
		}
		if path.ViaRelay && (relay == nil || !relay.Connected()) {
			continue
		}
		path.LastPingAt = now
		txid := wavedisco.NewTxid()
		s.inflight[wavedisco.TxidHex(txid)] = inflight{peer: subject, path: path, sentAt: now}
		probes = append(probes, probe{where: targetOf(path), txid: txid})
	}
	snap := snapshotOf(subject)
	s.expireLocked(subject, now)
	s.selectBestLocked(subject)
	s.mu.Unlock()

	for _, p := range probes {
		s.sendDisco(snap, p.where, wavedisco.Message{Type: wavedisco.TypePing, Txid: p.txid})
		if s.options.Verbose {
			s.log(fmt.Sprintf("ping -> %s (%s)", p.where.key, short(snap.nodeKey)))
		}
	}
}

func (s *Sock) expireLocked(target *peer, now time.Time) {
	for _, path := range target.paths {
		if !path.LastPongAt.IsZero() && now.Sub(path.LastPongAt) > pathTimeout {
			path.RTT = 0
			path.LastPongAt = time.Time{}
			if target.best == path.Key {
				target.best = ""
			}
		}
	}
	for txid, pending := range s.inflight {
		if now.Sub(pending.sentAt) > pathTimeout {
			delete(s.inflight, txid)
		}
	}
}

func (s *Sock) selectBestLocked(target *peer) {
	best := ChoosePath(target.pathList(), target.best, s.now())
	key := ""
	if best != nil {
		key = best.Key
	}
	if key == target.best {
		return
	}
	target.best = key
	if best != nil {
		s.log(fmt.Sprintf("path to %s is %s (%.1fms)",
			short(target.config.NodeKey), best.Key, float64(best.RTT.Microseconds())/1000))
		return
	}
	s.log(fmt.Sprintf("no working path to %s", short(target.config.NodeKey)))
}

// --- paths and candidates ---------------------------------------------------

// pathFor returns the key of the path for an address, creating it when a packet
// arrives from somewhere the peer never announced. The caller holds the lock.
func (s *Sock) pathFor(owner *peer, from netip.AddrPort) (string, bool) {
	key := from.String()
	if _, ok := owner.paths[key]; ok {
		s.byAddress[from] = owner
		return key, false
	}
	owner.paths[key] = &Path{Key: key, Endpoint: from, Learned: true}
	s.byAddress[from] = owner
	return key, true
}

func (s *Sock) mergeCandidates(owner *peer, candidates []netip.AddrPort, learned bool) {
	for _, endpoint := range candidates {
		if !endpoint.IsValid() {
			continue
		}
		key := endpoint.String()
		if _, exists := owner.paths[key]; !exists {
			owner.paths[key] = &Path{Key: key, Endpoint: endpoint, Learned: learned}
		}
		s.byAddress[endpoint] = owner
	}
}

// forgetWithdrawnLocked drops the paths a peer no longer announces, unless one
// is still answering. The caller holds the lock.
//
// Merging alone only ever adds, so every address a peer had published since
// this process started stayed a path -- and a path that never answers is due
// for a probe on every tick. A live one is kept: the netmap may lag behind the
// traffic, and dropping the path that carries it would be a stall for nothing;
// it goes with the next netmap once it has stopped answering. Learned paths
// are left alone, they come from authenticated traffic only.
func (s *Sock) forgetWithdrawnLocked(owner *peer, announced []netip.AddrPort) {
	wanted := make(map[string]struct{}, len(announced))
	for _, endpoint := range announced {
		wanted[endpoint.String()] = struct{}{}
	}
	now := s.now()
	for key, path := range owner.paths {
		if path.ViaRelay || path.Learned {
			continue
		}
		if _, keep := wanted[key]; keep {
			continue
		}
		if !path.LastPongAt.IsZero() && now.Sub(path.LastPongAt) <= pathTimeout {
			continue
		}
		delete(owner.paths, key)
		if owner.best == key {
			owner.best = ""
		}
		if s.byAddress[path.Endpoint] == owner {
			delete(s.byAddress, path.Endpoint)
		}
	}
}

// ensureRelayPath gives a peer the relayed path, but only once its wave has a
// relay. The caller holds the lock.
func (s *Sock) ensureRelayPath(owner *peer) *Path {
	if s.relays[owner.config.WaveID] == nil {
		return nil
	}
	if existing, ok := owner.paths[RelayPathKey]; ok {
		return existing
	}
	path := &Path{Key: RelayPathKey, ViaRelay: true}
	owner.paths[RelayPathKey] = path
	return path
}

// --- our own addresses ------------------------------------------------------

// ReflexiveTTL is how long an address of ours stays a candidate after anything
// last reported it.
//
// Behind a NAT that maps every destination to a fresh port, each STUN round
// reports a port nobody will ever reach us on again. Kept forever, a desktop
// connector running two days published 2670 of them, and every peer probed
// every one -- four times a second, each to a new destination port, which is a
// fresh NAT session apiece on the router in front of that peer. Three STUN
// rounds is long enough to ride out one lost answer; a stable mapping is
// re-reported every round and never ages out. The same as on the desktop.
const ReflexiveTTL = 3 * time.Minute

// MaxReflexive is a ceiling on top of the age limit, in case a NAT hands out
// ports faster.
const MaxReflexive = 8

// SeenAddress is what we know about one address of ours: when it was last
// reported, and how many times -- by STUN or by a peer's pong.
type SeenAddress struct {
	SeenAt time.Time
	Rounds int
}

// CurrentReflexive picks the addresses of ours worth publishing: seen
// recently, newest few only, oldest first -- the order an append-only list
// had, which the server relies on when it trims an old client's list.
//
// A port reported only once is held back while another port on the same
// address is around, until it is reported again. Behind a NAT that forgets
// its mapping between rounds -- the SNAT in front of a k3s pod, measured
// 11.10.2026 -- every round names a fresh port, and publishing each one
// changed the list every minute: a netmap for the whole wave every minute,
// each waking every phone in it, for ports nobody ever reached. A NAT that
// keeps its mapping confirms the port a round later; a first address stands
// alone and goes out at once. "Alone", not "first": as the oldest port aged
// out, the next oldest would otherwise count as first, and the list would turn
// over every round again. The same rule as currentReflexive on the desktop.
func CurrentReflexive(seen map[netip.AddrPort]SeenAddress, now time.Time) []netip.AddrPort {
	type entry struct {
		address netip.AddrPort
		seenAt  time.Time
		rounds  int
	}
	recent := make([]entry, 0, len(seen))
	for address, known := range seen {
		if now.Sub(known.SeenAt) <= ReflexiveTTL {
			recent = append(recent, entry{address, known.SeenAt, known.Rounds})
		}
	}
	contested := func(item entry) bool {
		for _, other := range recent {
			if other.address.Addr() == item.address.Addr() && other.address.Port() != item.address.Port() {
				return true
			}
		}
		return false
	}
	fresh := make([]entry, 0, len(recent))
	for _, item := range recent {
		if item.rounds > 1 || !contested(item) {
			fresh = append(fresh, item)
		}
	}
	// Newest first to cut, ties by address so the result is deterministic and
	// the candidate fingerprint does not change for nothing.
	sort.Slice(fresh, func(i, j int) bool {
		if !fresh[i].seenAt.Equal(fresh[j].seenAt) {
			return fresh[i].seenAt.After(fresh[j].seenAt)
		}
		return fresh[i].address.String() < fresh[j].address.String()
	})
	if len(fresh) > MaxReflexive {
		fresh = fresh[:MaxReflexive]
	}
	out := make([]netip.AddrPort, len(fresh))
	for index, item := range fresh {
		out[len(fresh)-1-index] = item.address
	}
	return out
}

func (s *Sock) rememberReflexiveLocked(address netip.AddrPort) {
	now := s.now()
	s.reflexive[address] = SeenAddress{SeenAt: now, Rounds: s.reflexive[address].Rounds + 1}
	// Pruned here as well, not only when read: the map would otherwise grow by
	// one entry a minute for as long as the tunnel runs.
	for known, seen := range s.reflexive {
		if now.Sub(seen.SeenAt) > ReflexiveTTL {
			delete(s.reflexive, known)
		}
	}
}

// ReflexiveCandidates is what STUN and the peers' pongs have recently taught
// us about our own address.
func (s *Sock) ReflexiveCandidates() []netip.AddrPort {
	s.mu.Lock()
	defer s.mu.Unlock()
	return CurrentReflexive(s.reflexive, s.now())
}

// DiscoverReflexive asks every configured STUN server how this socket looks
// from outside, and says what that implies about the NAT in front of us.
func (s *Sock) DiscoverReflexive(timeout time.Duration) ([]waveproto.Endpoint, wavestun.Mapping) {
	s.mu.Lock()
	servers := append([]netip.AddrPort(nil), s.stunServers...)
	s.mu.Unlock()

	var (
		wait   sync.WaitGroup
		mu     sync.Mutex
		mapped []waveproto.Endpoint
	)
	for _, server := range servers {
		wait.Add(1)
		go func(server netip.AddrPort) {
			defer wait.Done()
			if answer, ok := s.stunQuery(server, timeout); ok {
				mu.Lock()
				mapped = append(mapped, answer)
				mu.Unlock()
			}
		}(server)
	}
	wait.Wait()

	// Sorted, so two runs against the same servers produce the same list and
	// the candidate fingerprint does not change for nothing.
	sort.Slice(mapped, func(i, j int) bool { return mapped[i].String() < mapped[j].String() })
	s.mu.Lock()
	for _, entry := range mapped {
		if address, err := netip.ParseAddrPort(entry.String()); err == nil {
			s.rememberReflexiveLocked(address)
		}
	}
	s.mu.Unlock()
	return mapped, wavestun.Classify(mapped)
}

func (s *Sock) stunQuery(server netip.AddrPort, timeout time.Duration) (waveproto.Endpoint, bool) {
	packet, txid := wavestun.BuildBindingRequest()
	answers := make(chan waveproto.Endpoint, 1)

	s.mu.Lock()
	s.pendingSTUN[txid] = answers
	conn := s.conn
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.pendingSTUN, txid)
		s.mu.Unlock()
	}()
	if conn == nil {
		return waveproto.Endpoint{}, false
	}

	send := func() {
		// A STUN server we cannot reach is not fatal.
		_, _ = conn.WriteToUDPAddrPort(packet, server)
	}
	send()
	// One retransmit: the first packet also has to open the NAT.
	retransmit := time.NewTimer(400 * time.Millisecond)
	defer retransmit.Stop()
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()

	for {
		select {
		case answer := <-answers:
			return answer, true
		case <-retransmit.C:
			send()
		case <-deadline.C:
			return waveproto.Endpoint{}, false
		case <-s.stop:
			return waveproto.Endpoint{}, false
		}
	}
}

// LocalCandidates are the addresses of this device's own interfaces.
//
// Other tunnels are left out for the same reason as on the desktop: publishing
// one would build a tunnel through a tunnel. On a phone the list is short and
// changes often, which is why it is gathered fresh rather than cached.
func LocalCandidates(port int) []waveproto.Candidate {
	interfaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	var candidates []waveproto.Candidate
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		if isTunnelInterface(iface.Name) {
			continue
		}
		addresses, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, entry := range addresses {
			prefix, ok := entry.(*net.IPNet)
			if !ok {
				continue
			}
			address, ok := netip.AddrFromSlice(prefix.IP)
			if !ok {
				continue
			}
			address = address.Unmap()
			if !address.Is4() || address.IsLoopback() || address.IsLinkLocalUnicast() {
				continue
			}
			candidates = append(candidates, waveproto.Candidate{
				Kind: "local", IP: address.String(), Port: port,
			})
		}
	}
	return candidates
}

// isTunnelInterface names the interfaces a candidate must never come from.
// "tun" and "utun" cover ours on Android and iOS as well as everyone else's.
func isTunnelInterface(name string) bool {
	for _, prefix := range []string{"wave", "tun", "utun", "tailscale", "wg", "ipsec", "ppp"} {
		if len(name) >= len(prefix) && name[:len(prefix)] == prefix {
			return true
		}
	}
	return false
}

func endpointsToAddrPorts(endpoints []waveproto.Endpoint) []netip.AddrPort {
	out := make([]netip.AddrPort, 0, len(endpoints))
	for _, endpoint := range endpoints {
		if address, err := netip.ParseAddrPort(endpoint.String()); err == nil {
			out = append(out, address)
		}
	}
	return out
}

func short(key string) string {
	if len(key) > 8 {
		return key[:8]
	}
	return key
}
