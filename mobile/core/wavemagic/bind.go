package wavemagic

import (
	"errors"
	"net"
	"net/netip"
	"sync"

	"golang.zx2c4.com/wireguard/conn"
)

// Endpoint is what WireGuard thinks a peer's address is.
//
// On the desktop that is a loopback address, one socket per peer, and the
// indirection exists only because Bun cannot give WireGuard a conn.Bind. Here
// it is the peer itself: a name, not an address. WireGuard hands it back on
// every send and this package decides which path the packet actually takes, so
// a change of path still never touches the WireGuard configuration.
type Endpoint struct {
	waveID  string
	nodeKey string
	// Only for display and for mac2 cookies -- never for routing, which goes
	// by the peer this endpoint names.
	dst netip.AddrPort
}

var _ conn.Endpoint = (*Endpoint)(nil)

// NodeKey is the peer this endpoint stands for.
func (e *Endpoint) NodeKey() string { return e.nodeKey }

// ClearSrc does nothing: there is one socket and one source address, and
// WireGuard's reason for clearing (a route that changed underneath) is handled
// here by probing rather than by forgetting.
func (e *Endpoint) ClearSrc() {}

func (e *Endpoint) SrcToString() string { return "" }

// DstToString is what shows up in WireGuard's own log lines, so it says which
// peer rather than pretending to be an address.
func (e *Endpoint) DstToString() string { return "wave:" + e.waveID + ":" + e.nodeKey }

// DstToBytes feeds the mac2 cookie calculation, which needs something stable
// and distinct per peer. The key is exactly that.
func (e *Endpoint) DstToBytes() []byte { return []byte(e.nodeKey) }

func (e *Endpoint) DstIP() netip.Addr { return e.dst.Addr() }

func (e *Endpoint) SrcIP() netip.Addr { return netip.Addr{} }

// received is one datagram on its way into a wave's WireGuard device.
type received struct {
	payload  []byte
	endpoint *Endpoint
}

// Bind is one wave's view of the shared socket.
//
// WireGuard opens it like any other Bind and never learns that it is sharing
// anything: the queue only ever carries packets that decrypted as this wave's,
// and Send goes back out through the one port every wave publishes.
type Bind struct {
	sock   *Sock
	waveID string

	mu sync.Mutex
	// The queue of the current session, or nil while the device is down.
	//
	// Per session rather than per bind, because wireguard-go closes and reopens
	// a Bind as a matter of course: every device.Up(), every Down() and every
	// BindUpdate goes through Close followed by Open. A bind that treated Close
	// as final worked exactly once and then answered "bind is closed" for the
	// rest of the process -- which is a tunnel that never comes up, reported as
	// something that reads like a socket error.
	queue chan received
	// The wave is gone for good, as opposed to merely down.
	gone bool
}

var _ conn.Bind = (*Bind)(nil)

// Open puts the bind into a listening state. The port is the socket's, which is
// shared -- WireGuard is told the real number so its own logging is not a lie,
// but it never binds anything itself.
func (b *Bind) Open(uint16) ([]conn.ReceiveFunc, uint16, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.gone {
		return nil, 0, net.ErrClosed
	}
	if b.queue != nil {
		return nil, 0, conn.ErrBindAlreadyOpen
	}
	queue := make(chan received, queueDepth)
	b.queue = queue
	// The receive function holds its own session's queue, so a Close and a
	// later Open cannot leave a reader waiting on the wrong one.
	return []conn.ReceiveFunc{func(packets [][]byte, sizes []int, endpoints []conn.Endpoint) (int, error) {
		return receiveFrom(queue, packets, sizes, endpoints)
	}}, uint16(b.sock.Port()), nil
}

func receiveFrom(queue chan received, packets [][]byte, sizes []int, endpoints []conn.Endpoint) (int, error) {
	packet, ok := <-queue
	if !ok {
		// The contract: every function Open returned reports net.ErrClosed
		// once the bind is closed, and that is how wireguard-go ends its
		// receive loops rather than logging them as failures.
		return 0, net.ErrClosed
	}
	// One at a time. Batching would only pay off against a syscall per packet,
	// and there is none here: the read already happened on the shared socket.
	if len(packets) == 0 || len(packet.payload) > len(packets[0]) {
		return 0, nil
	}
	sizes[0] = copy(packets[0], packet.payload)
	endpoints[0] = packet.endpoint
	return 1, nil
}

// Close ends the current session. The socket stays open -- the other waves are
// still using it -- and so does this bind: WireGuard may open it again.
func (b *Bind) Close() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.queue != nil {
		close(b.queue)
		b.queue = nil
	}
	return nil
}

// retire closes the bind for good, which is what leaving a wave means. Only
// this side ever calls it; WireGuard's own Close is a pause, not an end.
func (b *Bind) retire() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.gone = true
	if b.queue != nil {
		close(b.queue)
		b.queue = nil
	}
}

// SetMark is a Linux socket option with no meaning on a phone, and the socket
// is not this bind's to configure in any case.
func (b *Bind) SetMark(uint32) error { return nil }

// Send hands a packet to the path chosen for the peer this endpoint names.
func (b *Bind) Send(bufs [][]byte, endpoint conn.Endpoint) error {
	peerEndpoint, ok := endpoint.(*Endpoint)
	if !ok {
		return conn.ErrWrongEndpointType
	}
	for _, buf := range bufs {
		b.sock.sendToPeer(b.waveID, peerEndpoint.nodeKey, buf)
	}
	return nil
}

// ParseEndpoint reads the endpoint string from a UAPI configuration. It is our
// own format, because our endpoints are peers rather than addresses; the string
// is what configure() writes and nothing else ever produces it.
func (b *Bind) ParseEndpoint(s string) (conn.Endpoint, error) {
	nodeKey, ok := parseWaveEndpoint(s)
	if !ok {
		return nil, errors.New("not a wave endpoint: " + s)
	}
	return &Endpoint{waveID: b.waveID, nodeKey: nodeKey}, nil
}

// BatchSize is one for the same reason receive takes one packet at a time.
func (b *Bind) BatchSize() int { return 1 }

// FormatEndpoint is what goes into a peer's endpoint= line. Exported because
// the engine writes the UAPI configuration.
func FormatEndpoint(nodeKey string) string { return "wave://" + nodeKey }

func parseWaveEndpoint(s string) (string, bool) {
	const prefix = "wave://"
	if len(s) <= len(prefix) || s[:len(prefix)] != prefix {
		return "", false
	}
	return s[len(prefix):], true
}

// deliver queues a packet for this wave's WireGuard device. A full queue drops,
// which is what a UDP socket does under pressure anyway -- and blocking here
// would stall the one read loop that serves every wave. So does a device that
// is down: there is nobody to read it.
func (b *Bind) deliver(packet received) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.queue == nil {
		return false
	}
	select {
	case b.queue <- packet:
		return true
	default:
		return false
	}
}
