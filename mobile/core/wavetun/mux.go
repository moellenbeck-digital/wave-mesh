package wavetun

import (
	"errors"
	"net/netip"
	"os"
	"sync"

	"golang.zx2c4.com/wireguard/tun"
)

// queueDepth is how many packets one wave may have waiting. A phone under
// memory pressure is better served by a drop than by a queue that grows.
const queueDepth = 256

// Resolver answers a DNS query, or returns nil for one that is not ours.
//
// An interface because the multiplexer must not know what DNS is: all it does
// is notice that a packet is addressed to a resolver of ours and hand the
// payload over.
type Resolver interface {
	Answer(query []byte) []byte
}

// Route says which wave a destination belongs to.
type Route struct {
	Prefix netip.Prefix
	WaveID string
}

// Multiplexer is one tunnel underneath and one virtual device per wave above.
type Multiplexer struct {
	mtu int
	log func(string)

	mu sync.Mutex
	// The tunnel underneath, which Android replaces on every apply.
	link          Link
	routes        []Route
	waves         map[string]*Virtual
	resolver      Resolver
	resolverAddrs map[netip.Addr]struct{}
	// One per wave with a policy; a wave without one is not filtered at all.
	filters map[string]*Filter
	closed  bool

	stop chan struct{}
	done sync.WaitGroup
}

// New wraps a link.
func New(link Link, mtu int, log func(string)) *Multiplexer {
	if log == nil {
		log = func(string) {}
	}
	return &Multiplexer{
		link:          link,
		mtu:           mtu,
		log:           log,
		waves:         map[string]*Virtual{},
		resolverAddrs: map[netip.Addr]struct{}{},
		filters:       map[string]*Filter{},
		stop:          make(chan struct{}),
	}
}

// Start begins moving packets.
func (m *Multiplexer) Start() {
	m.mu.Lock()
	link := m.link
	m.mu.Unlock()
	m.done.Add(1)
	go m.readLoop(link)
}

// DeviceFor returns the virtual tun.Device for one wave, creating it on first
// use. It is what wireguard-go is handed.
func (m *Multiplexer) DeviceFor(waveID string) *Virtual {
	m.mu.Lock()
	defer m.mu.Unlock()
	if device, ok := m.waves[waveID]; ok {
		return device
	}
	device := &Virtual{
		name:   waveID,
		mtu:    m.mtu,
		mux:    m,
		queue:  make(chan []byte, queueDepth),
		events: make(chan tun.Event, 4),
	}
	// wireguard-go waits for this before it will carry anything.
	device.events <- tun.EventUp
	m.waves[waveID] = device
	return device
}

// SetFilter puts one wave under the port half of its policy, or takes it out
// with nil. Replaced whole, like the routes: the flows this device opened
// under the old rules keep their replies, because they are the same flows.
func (m *Multiplexer) SetFilter(waveID string, filter *Filter) {
	m.mu.Lock()
	defer m.mu.Unlock()
	previous := m.filters[waveID]
	if filter == nil {
		delete(m.filters, waveID)
		return
	}
	if previous != nil {
		previous.mu.Lock()
		for key, at := range previous.flows {
			filter.flows[key] = at
		}
		previous.mu.Unlock()
	}
	m.filters[waveID] = filter
}

func (m *Multiplexer) filterFor(waveID string) *Filter {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.filters[waveID]
}

// RemoveWave closes one wave's device and drops its routes.
func (m *Multiplexer) RemoveWave(waveID string) {
	m.mu.Lock()
	device := m.waves[waveID]
	delete(m.waves, waveID)
	delete(m.filters, waveID)
	kept := m.routes[:0]
	for _, route := range m.routes {
		if route.WaveID != waveID {
			kept = append(kept, route)
		}
	}
	m.routes = kept
	m.mu.Unlock()
	if device != nil {
		_ = device.Close()
	}
}

// SetRoutes replaces the whole table.
//
// Whole rather than incremental, for the reason the operator reports its
// services whole (D11): "these are the routes now" is the only form that cannot
// drift. A missed removal here would send a wave's traffic into a device that
// no longer belongs to it.
func (m *Multiplexer) SetRoutes(routes []Route) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.routes = append([]Route(nil), routes...)
}

// SetResolver says which addresses answer DNS here and who answers it.
func (m *Multiplexer) SetResolver(resolver Resolver, addresses []netip.Addr) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.resolver = resolver
	m.resolverAddrs = make(map[netip.Addr]struct{}, len(addresses))
	for _, address := range addresses {
		m.resolverAddrs[address] = struct{}{}
	}
}

// ReplaceLink swaps the tunnel underneath without disturbing anything above it.
//
// Android needs this and iOS does not, which is the kind of difference that is
// easy to miss: VpnService.Builder.establish() hands back a *new* descriptor
// every time settings are applied and closes the old one, so a core holding the
// first would be reading from a descriptor the system has already taken away.
// setTunnelNetworkSettings on iOS leaves the packet flow alone.
//
// The waves, their devices and their queues all survive: what changes is only
// where the packets come from and go to.
func (m *Multiplexer) ReplaceLink(link Link) {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		_ = link.Close()
		return
	}
	previous := m.link
	m.link = link
	m.mu.Unlock()

	// Closing the old one is what ends its read loop: it is blocked in a read
	// that only an error will return from.
	if previous != nil {
		_ = previous.Close()
	}
	m.done.Add(1)
	go m.readLoop(link)
}

// write sends one packet to whichever link is current. Everything above goes
// through here, so a swap cannot leave a device writing to a closed descriptor.
func (m *Multiplexer) write(packet []byte) error {
	m.mu.Lock()
	link := m.link
	m.mu.Unlock()
	if link == nil {
		return os.ErrClosed
	}
	return link.WritePacket(packet)
}

// Close stops the multiplexer and every device on it. The link is closed too:
// it was handed over, and on a phone the platform expects it back closed.
func (m *Multiplexer) Close() error {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil
	}
	m.closed = true
	link := m.link
	m.link = nil
	devices := make([]*Virtual, 0, len(m.waves))
	for _, device := range m.waves {
		devices = append(devices, device)
	}
	m.waves = map[string]*Virtual{}
	m.mu.Unlock()

	close(m.stop)
	var err error
	if link != nil {
		err = link.Close()
	}
	for _, device := range devices {
		_ = device.Close()
	}
	m.done.Wait()
	return err
}

// readLoop serves one link. A swap starts a second one and closes the first,
// which is how this one learns it is done.
func (m *Multiplexer) readLoop(link Link) {
	defer m.done.Done()
	if link == nil {
		return
	}
	buffer := make([]byte, m.mtu+64)
	for {
		select {
		case <-m.stop:
			return
		default:
		}
		m.mu.Lock()
		superseded := m.link != link
		m.mu.Unlock()
		if superseded {
			return
		}
		n, err := link.ReadPacket(buffer)
		if err != nil {
			if errors.Is(err, os.ErrClosed) {
				return
			}
			select {
			case <-m.stop:
				return
			default:
			}
			continue
		}
		if n == 0 {
			continue
		}
		m.handle(buffer[:n])
	}
}

// handle routes one outbound packet: to the resolver, to a wave, or nowhere.
func (m *Multiplexer) handle(packet []byte) {
	destination, ok := Destination(packet)
	if !ok {
		return
	}

	m.mu.Lock()
	_, isResolver := m.resolverAddrs[destination]
	resolver := m.resolver
	m.mu.Unlock()

	if isResolver && resolver != nil {
		if m.answerDNS(packet, resolver) {
			return
		}
		// Addressed to the resolver but not a question it answers. Dropping is
		// right: the address is ours and nothing else listens on it.
		return
	}

	m.mu.Lock()
	waveID := ""
	best := -1
	for _, route := range m.routes {
		// Longest prefix wins, so a service address inside a wave's block still
		// goes to that wave and a more specific route can never be shadowed.
		if route.Prefix.Contains(destination) && route.Prefix.Bits() > best {
			best, waveID = route.Prefix.Bits(), route.WaveID
		}
	}
	device := m.waves[waveID]
	filter := m.filters[waveID]
	m.mu.Unlock()

	if device == nil {
		return
	}
	if filter != nil {
		filter.Outbound(packet)
	}
	device.enqueue(packet)
}

// answerDNS builds the reply in place of a kernel and a socket. Returns false
// when the packet was not a query this resolver takes.
func (m *Multiplexer) answerDNS(packet []byte, resolver Resolver) bool {
	datagram, ok := ParseUDP(packet)
	if !ok || datagram.Destination.Port() != 53 {
		return false
	}
	answer := resolver.Answer(datagram.Payload)
	if answer == nil {
		return false
	}
	reply := BuildUDPReply(datagram, answer)
	if reply == nil {
		return false
	}
	if err := m.write(reply); err != nil {
		m.log("could not answer a dns query: " + err.Error())
	}
	return true
}

// Virtual is one wave's tun.Device.
//
// Read gives WireGuard the packets the demultiplexer sorted into this wave;
// Write puts what WireGuard decrypted straight onto the shared link, where it
// needs no sorting at all -- it is already addressed to this device.
type Virtual struct {
	name   string
	mtu    int
	mux    *Multiplexer
	queue  chan []byte
	events chan tun.Event

	mu     sync.Mutex
	closed bool
}

var _ tun.Device = (*Virtual)(nil)

func (v *Virtual) File() *os.File { return nil }

func (v *Virtual) Read(bufs [][]byte, sizes []int, offset int) (int, error) {
	packet, ok := <-v.queue
	if !ok {
		return 0, os.ErrClosed
	}
	if len(bufs) == 0 || offset+len(packet) > len(bufs[0]) {
		return 0, nil
	}
	sizes[0] = copy(bufs[0][offset:], packet)
	return 1, nil
}

func (v *Virtual) Write(bufs [][]byte, offset int) (int, error) {
	written := 0
	filter := v.mux.filterFor(v.name)
	for _, buf := range bufs {
		if offset > len(buf) {
			continue
		}
		// Dropped here, counted as written: to WireGuard the packet was
		// delivered, and it is -- to a device whose policy did not want it.
		if filter != nil && !filter.Allow(buf[offset:]) {
			written++
			continue
		}
		if err := v.mux.write(buf[offset:]); err != nil {
			return written, err
		}
		written++
	}
	return written, nil
}

func (v *Virtual) MTU() (int, error) { return v.mtu, nil }

func (v *Virtual) Name() (string, error) { return v.name, nil }

func (v *Virtual) Events() <-chan tun.Event { return v.events }

func (v *Virtual) BatchSize() int { return 1 }

func (v *Virtual) Close() error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.closed {
		return nil
	}
	v.closed = true
	close(v.queue)
	close(v.events)
	return nil
}

// enqueue hands a packet to this wave, dropping when the device is not keeping
// up. Blocking would stop the one loop that serves every wave.
func (v *Virtual) enqueue(packet []byte) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.closed {
		return
	}
	// Copied because the read buffer is reused on the next packet.
	owned := make([]byte, len(packet))
	copy(owned, packet)
	select {
	case v.queue <- owned:
	default:
	}
}
