package wavetun_test

import (
	"bytes"
	"net/netip"
	"sync"
	"testing"
	"time"

	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavetun"
)

// memoryLink stands in for the descriptor a phone hands over. Everything above
// it is the same code that runs there; this is the only piece that is not.
type memoryLink struct {
	inbound chan []byte

	mu      sync.Mutex
	written [][]byte
	closed  bool
}

func newMemoryLink() *memoryLink {
	return &memoryLink{inbound: make(chan []byte, 16)}
}

func (l *memoryLink) ReadPacket(buf []byte) (int, error) {
	packet, ok := <-l.inbound
	if !ok {
		return 0, wavetun.ErrLinkClosed
	}
	return copy(buf, packet), nil
}

func (l *memoryLink) WritePacket(packet []byte) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	owned := make([]byte, len(packet))
	copy(owned, packet)
	l.written = append(l.written, owned)
	return nil
}

func (l *memoryLink) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.closed {
		l.closed = true
		close(l.inbound)
	}
	return nil
}

func (l *memoryLink) sent() [][]byte {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([][]byte(nil), l.written...)
}

func ipv4Packet(source, destination string, protocol byte, body []byte) []byte {
	packet := make([]byte, 20+len(body))
	packet[0] = 0x45
	packet[2] = byte((20 + len(body)) >> 8)
	packet[3] = byte(20 + len(body))
	packet[8] = 64
	packet[9] = protocol
	copy(packet[12:16], netip.MustParseAddr(source).AsSlice())
	copy(packet[16:20], netip.MustParseAddr(destination).AsSlice())
	copy(packet[20:], body)
	return packet
}

func udpBody(sourcePort, destinationPort int, payload []byte) []byte {
	body := make([]byte, 8+len(payload))
	body[0] = byte(sourcePort >> 8)
	body[1] = byte(sourcePort)
	body[2] = byte(destinationPort >> 8)
	body[3] = byte(destinationPort)
	body[4] = byte((8 + len(payload)) >> 8)
	body[5] = byte(8 + len(payload))
	copy(body[8:], payload)
	return body
}

func readOne(t *testing.T, device *wavetun.Virtual, timeout time.Duration) ([]byte, bool) {
	t.Helper()
	result := make(chan []byte, 1)
	go func() {
		bufs := [][]byte{make([]byte, 2048)}
		sizes := make([]int, 1)
		n, err := device.Read(bufs, sizes, 0)
		if err != nil || n == 0 {
			return
		}
		out := make([]byte, sizes[0])
		copy(out, bufs[0][:sizes[0]])
		result <- out
	}()
	select {
	case packet := <-result:
		return packet, true
	case <-time.After(timeout):
		return nil, false
	}
}

// The core of D10: one tunnel, two waves, and a packet sorted by where it is
// going rather than by which interface it came from -- because there is only
// one interface.
func TestPacketsAreSortedByDestinationPrefix(t *testing.T) {
	link := newMemoryLink()
	mux := wavetun.New(link, 1280, func(line string) { t.Log(line) })
	first := mux.DeviceFor("w1")
	second := mux.DeviceFor("w2")
	mux.SetRoutes([]wavetun.Route{
		{Prefix: netip.MustParsePrefix("10.77.0.0/16"), WaveID: "w1"},
		{Prefix: netip.MustParsePrefix("10.96.0.0/16"), WaveID: "w2"},
	})
	mux.Start()
	t.Cleanup(func() { _ = mux.Close() })

	link.inbound <- ipv4Packet("10.77.0.2", "10.77.0.9", 6, []byte("to-w1"))
	link.inbound <- ipv4Packet("10.96.0.5", "10.96.0.7", 6, []byte("to-w2"))

	got, ok := readOne(t, first, 2*time.Second)
	if !ok || !bytes.Contains(got, []byte("to-w1")) {
		t.Fatalf("w1 got %q", got)
	}
	got, ok = readOne(t, second, 2*time.Second)
	if !ok || !bytes.Contains(got, []byte("to-w2")) {
		t.Fatalf("w2 got %q", got)
	}
}

// An address in no wave has nowhere to go. Handing it to the first device would
// send one wave's traffic down another's tunnel.
func TestAnUnroutedPacketGoesNowhere(t *testing.T) {
	link := newMemoryLink()
	mux := wavetun.New(link, 1280, nil)
	device := mux.DeviceFor("w1")
	mux.SetRoutes([]wavetun.Route{{Prefix: netip.MustParsePrefix("10.77.0.0/16"), WaveID: "w1"}})
	mux.Start()
	t.Cleanup(func() { _ = mux.Close() })

	link.inbound <- ipv4Packet("10.77.0.2", "192.0.2.1", 6, []byte("elsewhere"))
	if _, ok := readOne(t, device, 300*time.Millisecond); ok {
		t.Fatal("a packet for no wave was delivered to one")
	}
}

// A more specific route must win, or a service address inside another wave's
// block would follow the shorter prefix.
func TestTheLongestPrefixWins(t *testing.T) {
	link := newMemoryLink()
	mux := wavetun.New(link, 1280, nil)
	wide := mux.DeviceFor("w1")
	narrow := mux.DeviceFor("w2")
	mux.SetRoutes([]wavetun.Route{
		{Prefix: netip.MustParsePrefix("10.0.0.0/8"), WaveID: "w1"},
		{Prefix: netip.MustParsePrefix("10.77.0.0/16"), WaveID: "w2"},
	})
	mux.Start()
	t.Cleanup(func() { _ = mux.Close() })

	link.inbound <- ipv4Packet("10.1.0.2", "10.77.0.9", 6, []byte("specific"))
	if _, ok := readOne(t, wide, 300*time.Millisecond); ok {
		t.Fatal("the shorter prefix took the packet")
	}
	if _, ok := readOne(t, narrow, 2*time.Second); !ok {
		t.Fatal("the longer prefix did not get the packet")
	}
}

type fixedResolver struct{ answer []byte }

func (r fixedResolver) Answer([]byte) []byte { return r.answer }

// The resolver has no socket here: the query is a packet on the tunnel and the
// answer has to be built and written back as one.
func TestADNSQueryIsAnsweredOnTheTunnel(t *testing.T) {
	link := newMemoryLink()
	mux := wavetun.New(link, 1280, nil)
	mux.SetResolver(fixedResolver{answer: []byte("the-answer")}, []netip.Addr{netip.MustParseAddr("10.77.0.2")})
	mux.Start()
	t.Cleanup(func() { _ = mux.Close() })

	link.inbound <- ipv4Packet("10.77.0.2", "10.77.0.2", 17, udpBody(51234, 53, []byte("the-question")))

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		for _, packet := range link.sent() {
			datagram, ok := wavetun.ParseUDP(packet)
			if !ok {
				continue
			}
			if string(datagram.Payload) != "the-answer" {
				continue
			}
			// The answer comes back from the address that was asked, to the
			// port that asked -- anything else and the resolver library on the
			// other side discards it.
			if datagram.Source.Port() != 53 || datagram.Destination.Port() != 51234 {
				t.Fatalf("answer went %s -> %s", datagram.Source, datagram.Destination)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("no answer was written back to the tunnel")
}

// Everything WireGuard decrypts is already addressed to this device; it goes
// straight onto the shared link.
func TestWhatAWaveWritesReachesTheLink(t *testing.T) {
	link := newMemoryLink()
	mux := wavetun.New(link, 1280, nil)
	device := mux.DeviceFor("w1")

	packet := ipv4Packet("10.77.0.9", "10.77.0.2", 6, []byte("inbound"))
	if _, err := device.Write([][]byte{packet}, 0); err != nil {
		t.Fatal(err)
	}
	sent := link.sent()
	if len(sent) != 1 || !bytes.Contains(sent[0], []byte("inbound")) {
		t.Fatalf("link got %v", sent)
	}
}

func TestRemovingAWaveTakesItsRoutes(t *testing.T) {
	link := newMemoryLink()
	mux := wavetun.New(link, 1280, nil)
	device := mux.DeviceFor("w1")
	mux.SetRoutes([]wavetun.Route{{Prefix: netip.MustParsePrefix("10.77.0.0/16"), WaveID: "w1"}})
	mux.Start()
	t.Cleanup(func() { _ = mux.Close() })

	mux.RemoveWave("w1")
	link.inbound <- ipv4Packet("10.77.0.2", "10.77.0.9", 6, []byte("gone"))
	if _, ok := readOne(t, device, 300*time.Millisecond); ok {
		t.Fatal("a removed wave still received a packet")
	}
}

// Android hands back a new descriptor from every establish(), so the tunnel
// underneath has to be replaceable without the waves above noticing.
func TestTheTunnelCanBeSwappedUnderneath(t *testing.T) {
	first := newMemoryLink()
	mux := wavetun.New(first, 1280, nil)
	device := mux.DeviceFor("w1")
	mux.SetRoutes([]wavetun.Route{{Prefix: netip.MustParsePrefix("10.77.0.0/16"), WaveID: "w1"}})
	mux.Start()
	t.Cleanup(func() { _ = mux.Close() })

	first.inbound <- ipv4Packet("10.77.0.2", "10.77.0.9", 6, []byte("before"))
	if got, ok := readOne(t, device, 2*time.Second); !ok || !bytes.Contains(got, []byte("before")) {
		t.Fatalf("got %q", got)
	}

	second := newMemoryLink()
	mux.ReplaceLink(second)

	// The same wave, the same device, the same queue -- a different descriptor.
	second.inbound <- ipv4Packet("10.77.0.2", "10.77.0.9", 6, []byte("after"))
	if got, ok := readOne(t, device, 2*time.Second); !ok || !bytes.Contains(got, []byte("after")) {
		t.Fatalf("got %q", got)
	}

	// And what a wave writes goes to the new one, not the descriptor the system
	// has already taken away.
	if _, err := device.Write([][]byte{ipv4Packet("10.77.0.9", "10.77.0.2", 6, []byte("outbound"))}, 0); err != nil {
		t.Fatal(err)
	}
	if len(second.sent()) != 1 {
		t.Fatalf("the new link received %d packets", len(second.sent()))
	}
}
