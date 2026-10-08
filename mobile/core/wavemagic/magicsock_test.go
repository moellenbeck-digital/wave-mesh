package wavemagic_test

import (
	"errors"
	"fmt"
	"net"
	"net/netip"
	"testing"
	"time"

	"golang.zx2c4.com/wireguard/conn"

	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavecrypto"
	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavemagic"
)

type node struct {
	sock  *wavemagic.Sock
	disco wavecrypto.KeyPair
	node  wavecrypto.KeyPair
}

func newNode(t *testing.T) *node {
	t.Helper()
	disco, err := wavecrypto.GenerateX25519()
	if err != nil {
		t.Fatal(err)
	}
	nodeKey, err := wavecrypto.GenerateX25519()
	if err != nil {
		t.Fatal(err)
	}
	sock := wavemagic.New(wavemagic.Options{Log: func(line string) { t.Log(line) }})
	if err := sock.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sock.Close() })
	return &node{sock: sock, disco: disco, node: nodeKey}
}

func (n *node) addr(t *testing.T) netip.AddrPort {
	t.Helper()
	return netip.MustParseAddrPort(fmt.Sprintf("127.0.0.1:%d", n.sock.Port()))
}

func (n *node) knows(t *testing.T, waveID string, other *node) {
	t.Helper()
	n.sock.BindFor(waveID)
	// Each wave has disco keys of its own, so the socket has to be told whose
	// they are before it can derive a shared secret with anybody.
	n.sock.SetDiscoIdentity(waveID, n.disco.PublicKey, n.disco.PrivateKey)
	err := n.sock.SetPeers(waveID, []wavemagic.PeerConfig{{
		NodeKey:    other.node.PublicKey,
		DiscoKey:   other.disco.PublicKey,
		Candidates: []netip.AddrPort{other.addr(t)},
	}})
	if err != nil {
		t.Fatal(err)
	}
	n.sock.EnableProbing()
	n.sends(t, waveID, other)
}

// sends puts one packet through the wave's bind, as WireGuard would. A peer
// is only probed while something is sent to it, so without this no path would
// ever be found.
func (n *node) sends(t *testing.T, waveID string, other *node) {
	t.Helper()
	bind := n.sock.BindFor(waveID)
	endpoint, err := bind.ParseEndpoint(wavemagic.FormatEndpoint(other.node.PublicKey))
	if err != nil {
		t.Fatal(err)
	}
	if err := bind.Send([][]byte{{4, 0, 0, 0}}, endpoint); err != nil {
		t.Fatal(err)
	}
}

func waitForPath(t *testing.T, sock *wavemagic.Sock) wavemagic.PeerStatus {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		for _, status := range sock.Status() {
			if status.HasBest {
				return status
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("no path was confirmed within five seconds")
	return wavemagic.PeerStatus{}
}

// Two real sockets, one real ping and pong: the probe that finds a direct path
// has to work before anything above it means anything.
func TestTwoSocketsFindADirectPath(t *testing.T) {
	a, b := newNode(t), newNode(t)
	a.knows(t, "w1", b)
	b.knows(t, "w1", a)

	status := waitForPath(t, a.sock)
	if status.ViaRelay {
		t.Fatal("there is no relay here")
	}
	if status.Best.Port() != uint16(b.sock.Port()) {
		t.Fatalf("path goes to %s, want port %d", status.Best, b.sock.Port())
	}
	if status.RTT <= 0 {
		t.Fatal("a confirmed path must carry a measurement")
	}
}

// The property the whole multiplexing rests on: the two waves share this
// socket, and a packet still only ever reaches the device it belongs to.
func TestAPacketReachesOnlyItsOwnWave(t *testing.T) {
	a, b, c := newNode(t), newNode(t), newNode(t)

	// A is in two waves: with B in one, with C in the other.
	a.knows(t, "w1", b)
	a.knows(t, "w2", c)
	b.knows(t, "w1", a)
	c.knows(t, "w2", a)

	waitForPath(t, b.sock)
	waitForPath(t, c.sock)

	first := a.sock.BindFor("w1")
	second := a.sock.BindFor("w2")
	firstReceive, _, err := first.Open(0)
	if err != nil {
		t.Fatal(err)
	}
	secondReceive, _, err := second.Open(0)
	if err != nil {
		t.Fatal(err)
	}

	// B sends what looks like a WireGuard handshake through its own bind, which
	// is the only way a wave's traffic ever leaves.
	fromB := b.sock.BindFor("w1")
	endpoint, err := fromB.ParseEndpoint(wavemagic.FormatEndpoint(a.node.PublicKey))
	if err != nil {
		t.Fatal(err)
	}
	handshake := make([]byte, 148)
	handshake[0] = 1
	copy(handshake[4:], []byte("from-b"))
	if err := fromB.Send([][]byte{handshake}, endpoint); err != nil {
		t.Fatal(err)
	}

	packet := receiveOne(t, firstReceive[0], 3*time.Second)
	if string(packet.payload[4:10]) != "from-b" {
		t.Fatalf("wave w1 got the wrong packet: %q", packet.payload[4:10])
	}
	if packet.endpoint.(*wavemagic.Endpoint).NodeKey() != b.node.PublicKey {
		t.Fatal("the packet is not attributed to B")
	}

	// And w2 heard nothing: it is a different wave on the same port.
	if _, ok := tryReceive(secondReceive[0], 300*time.Millisecond); ok {
		t.Fatal("a packet for w1 was delivered to w2")
	}
}

type delivery struct {
	payload  []byte
	endpoint conn.Endpoint
}

func receiveOne(t *testing.T, receive conn.ReceiveFunc, timeout time.Duration) delivery {
	t.Helper()
	packet, ok := tryReceive(receive, timeout)
	if !ok {
		t.Fatal("nothing arrived")
	}
	return packet
}

func tryReceive(receive conn.ReceiveFunc, timeout time.Duration) (delivery, bool) {
	result := make(chan delivery, 1)
	go func() {
		buffers := [][]byte{make([]byte, 2048)}
		sizes := make([]int, 1)
		endpoints := make([]conn.Endpoint, 1)
		for {
			n, err := receive(buffers, sizes, endpoints)
			if err != nil {
				return
			}
			if n == 0 {
				continue
			}
			payload := make([]byte, sizes[0])
			copy(payload, buffers[0][:sizes[0]])
			result <- delivery{payload: payload, endpoint: endpoints[0]}
			return
		}
	}()
	select {
	case packet := <-result:
		return packet, true
	case <-time.After(timeout):
		return delivery{}, false
	}
}

// A rebind is the recovery from a NAT port collision and, on a phone, the
// answer to every network change. The paths have to come back on the new port.
func TestARebindFindsThePathAgain(t *testing.T) {
	a, b := newNode(t), newNode(t)
	a.knows(t, "w1", b)
	b.knows(t, "w1", a)
	waitForPath(t, a.sock)

	before := a.sock.Port()
	port, err := a.sock.Rebind()
	if err != nil {
		t.Fatal(err)
	}
	if port == before {
		t.Fatal("a rebind must move to a different port")
	}
	// B still has A's old address, but A sends first from the new port -- which
	// is exactly what makes a rebind a way out of a poisoned mapping.
	waitForPath(t, a.sock)
}

// Leaving a wave has to take its peers with it, or a packet from a peer we no
// longer know would still be attributed and queued.
func TestRemovingAWaveForgetsItsPeers(t *testing.T) {
	a, b := newNode(t), newNode(t)
	a.knows(t, "w1", b)
	b.knows(t, "w1", a)
	waitForPath(t, a.sock)

	a.sock.RemoveWave("w1")
	if len(a.sock.Status()) != 0 {
		t.Fatalf("peers left over: %v", a.sock.Status())
	}
}

func TestSetPeersKeepsTheStateOfPeersThatStay(t *testing.T) {
	a, b := newNode(t), newNode(t)
	a.knows(t, "w1", b)
	b.knows(t, "w1", a)
	before := waitForPath(t, a.sock)

	// The same netmap again, as a heartbeat would bring it.
	a.knows(t, "w1", b)
	after := a.sock.Status()
	if len(after) != 1 {
		t.Fatalf("peers %v", after)
	}
	if !after[0].HasBest || after[0].Best != before.Best {
		t.Fatal("re-applying the same peer set threw the path away")
	}
}

// An unknown endpoint type is the one thing a Bind must refuse: it would mean
// WireGuard talking to a socket that is not this one.
func TestSendRefusesAForeignEndpoint(t *testing.T) {
	a := newNode(t)
	bind := a.sock.BindFor("w1")
	if err := bind.Send([][]byte{{1}}, &foreignEndpoint{}); err == nil {
		t.Fatal("a foreign endpoint must be refused")
	}
	if _, err := bind.ParseEndpoint("1.2.3.4:41641"); err == nil {
		t.Fatal("an address is not a wave endpoint")
	}
}

type foreignEndpoint struct{}

func (foreignEndpoint) ClearSrc()           {}
func (foreignEndpoint) SrcToString() string { return "" }
func (foreignEndpoint) DstToString() string { return "" }
func (foreignEndpoint) DstToBytes() []byte  { return nil }
func (foreignEndpoint) DstIP() netip.Addr   { return netip.Addr{} }
func (foreignEndpoint) SrcIP() netip.Addr   { return netip.Addr{} }

// wireguard-go closes and reopens a Bind as a matter of course: every Up(),
// every Down() and every BindUpdate goes through Close followed by Open. A bind
// that took Close for the end worked exactly once and then answered "bind is
// closed" forever after -- a tunnel that never comes up, reported as something
// that reads like a socket error. Found by running the core against a real TUN.
func TestABindCanBeReopened(t *testing.T) {
	a := newNode(t)
	bind := a.sock.BindFor("w1")

	first, port, err := bind.Open(0)
	if err != nil {
		t.Fatal(err)
	}
	if port != uint16(a.sock.Port()) {
		t.Fatalf("bind reported port %d, socket is on %d", port, a.sock.Port())
	}
	if _, _, err := bind.Open(0); err == nil {
		t.Fatal("opening an already open bind must be refused")
	}

	if err := bind.Close(); err != nil {
		t.Fatal(err)
	}
	// Every function Open returned has to report net.ErrClosed afterwards --
	// that is how wireguard-go ends its receive loops instead of logging them.
	if _, err := first[0](nil, nil, nil); !errors.Is(err, net.ErrClosed) {
		t.Fatalf("a closed bind's receive returned %v", err)
	}

	if _, _, err := bind.Open(0); err != nil {
		t.Fatalf("reopening after Close: %v", err)
	}
}

// Leaving a wave is the one ending there is; after it, the bind stays shut.
func TestARetiredWaveDoesNotReopen(t *testing.T) {
	a := newNode(t)
	bind := a.sock.BindFor("w1")
	if _, _, err := bind.Open(0); err != nil {
		t.Fatal(err)
	}
	a.sock.RemoveWave("w1")
	if _, _, err := bind.Open(0); !errors.Is(err, net.ErrClosed) {
		t.Fatalf("a bind whose wave is gone returned %v", err)
	}
}

// A packet that arrives while the device is down has nobody to read it. It must
// be dropped rather than queued for a reader that may never come.
func TestDeliveryWhileTheDeviceIsDownIsDropped(t *testing.T) {
	a, b := newNode(t), newNode(t)
	a.knows(t, "w1", b)
	b.knows(t, "w1", a)
	waitForPath(t, b.sock)

	fromB := b.sock.BindFor("w1")
	endpoint, err := fromB.ParseEndpoint(wavemagic.FormatEndpoint(a.node.PublicKey))
	if err != nil {
		t.Fatal(err)
	}
	handshake := make([]byte, 148)
	handshake[0] = 1
	if err := fromB.Send([][]byte{handshake}, endpoint); err != nil {
		t.Fatal(err)
	}

	// A's bind was never opened, so nothing is listening. Opening it now must
	// not hand over a packet that arrived before there was a reader.
	time.Sleep(200 * time.Millisecond)
	receive, _, err := a.sock.BindFor("w1").Open(0)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := tryReceive(receive[0], 300*time.Millisecond); ok {
		t.Fatal("a packet from before the device was up was delivered")
	}
}

// A relay attached to a socket that has never had one. Trivial, and it panicked
// on a nil map for a while: every test here ran without a relay, because a flat
// test segment never needs one. Found by the first end-to-end run that had one.
func TestARelayCanBeAttachedToAFreshSocket(t *testing.T) {
	a := newNode(t)
	a.sock.SetRelay("w1", stubRelay{})
	a.sock.SetRelay("w1", nil)
}

type stubRelay struct{}

func (stubRelay) Send(string, []byte) bool { return false }
func (stubRelay) Connected() bool          { return false }

// Merging only ever added: every address a peer had published since the tunnel
// came up stayed a path, and each one was probed on every tick.
func TestSetPeersForgetsCandidatesThatWereWithdrawn(t *testing.T) {
	a, b := newNode(t), newNode(t)
	a.sock.BindFor("w1")
	a.sock.SetDiscoIdentity("w1", a.disco.PublicKey, a.disco.PrivateKey)
	stale := netip.MustParseAddrPort("127.0.0.1:9")
	apply := func(candidates ...netip.AddrPort) {
		t.Helper()
		err := a.sock.SetPeers("w1", []wavemagic.PeerConfig{{
			NodeKey: b.node.PublicKey, DiscoKey: b.disco.PublicKey, Candidates: candidates,
		}})
		if err != nil {
			t.Fatal(err)
		}
	}

	apply(stale, b.addr(t))
	if paths := a.sock.Status()[0].Paths; len(paths) != 2 {
		t.Fatalf("paths %v", paths)
	}
	apply(b.addr(t))
	paths := a.sock.Status()[0].Paths
	if len(paths) != 1 || paths[0].Endpoint != b.addr(t) {
		t.Fatalf("the withdrawn candidate is still a path: %v", paths)
	}
}

// The netmap can lag behind the traffic; the path carrying it stays.
func TestSetPeersKeepsAWithdrawnPathThatStillAnswers(t *testing.T) {
	a, b := newNode(t), newNode(t)
	a.knows(t, "w1", b)
	b.knows(t, "w1", a)
	before := waitForPath(t, a.sock)

	if err := a.sock.SetPeers("w1", []wavemagic.PeerConfig{{
		NodeKey: b.node.PublicKey, DiscoKey: b.disco.PublicKey,
	}}); err != nil {
		t.Fatal(err)
	}
	after := a.sock.Status()
	if len(after) != 1 || !after[0].HasBest || after[0].Best != before.Best {
		t.Fatalf("a live path was dropped: %v", after)
	}
}
