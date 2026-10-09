package wavetun

import (
	"bytes"
	"encoding/binary"
	"net/netip"
	"strings"
	"testing"
)

// The two waves of the phone this was found on: ops first, which is the
// address iOS picked for everything.
var (
	ownA   = netip.MustParseAddr("10.160.0.25")
	ownB   = netip.MustParseAddr("10.64.0.8")
	ownA6  = netip.MustParseAddr("fd7a:e10e:f7c5::19")
	ownB6  = netip.MustParseAddr("fd7a:c64e:9f9d::8")
	peerB  = netip.MustParseAddr("10.64.0.4")
	peerB6 = netip.MustParseAddr("fd7a:c64e:9f9d::4")
)

func twoWaves(lines *[]string) *sources {
	s := newSources(func(line string) { *lines = append(*lines, line) })
	s.set(map[string][]netip.Addr{
		"a": {ownA, ownA6},
		"b": {ownB, ownB6},
	})
	return s
}

// buildPacket makes an IP packet with every checksum right, so a test can tell
// a rewrite that kept them right from one that did not.
func buildPacket(src, dst netip.Addr, proto uint8, body []byte) []byte {
	var packet []byte
	if src.Is4() {
		packet = make([]byte, 20+len(body))
		packet[0] = 0x45
		binary.BigEndian.PutUint16(packet[2:], uint16(len(packet)))
		packet[8] = 64
		packet[9] = proto
		copy(packet[12:], src.AsSlice())
		copy(packet[16:], dst.AsSlice())
		binary.BigEndian.PutUint16(packet[10:], checksum(packet[:20]))
		copy(packet[20:], body)
	} else {
		packet = make([]byte, 40+len(body))
		packet[0] = 0x60
		binary.BigEndian.PutUint16(packet[4:], uint16(len(body)))
		packet[6] = proto
		packet[7] = 64
		copy(packet[8:], src.AsSlice())
		copy(packet[24:], dst.AsSlice())
		copy(packet[40:], body)
	}
	offset := transportChecksumOffset(proto)
	if offset >= 0 && (proto != protoICMP) {
		header := len(packet) - len(body)
		binary.BigEndian.PutUint16(packet[header+offset:], pseudoSum(src, dst, proto, packet[header:]))
	} else if proto == protoICMP {
		header := len(packet) - len(body)
		binary.BigEndian.PutUint16(packet[header+2:], checksum(packet[header:]))
	}
	return packet
}

func transportChecksumOffset(proto uint8) int {
	switch proto {
	case protoTCP:
		return 16
	case protoUDP:
		return 6
	case protoICMP, protoICMPv6:
		return 2
	}
	return -1
}

// pseudoSum is the checksum over the pseudo-header and the transport segment,
// with the segment's own checksum field taken as zero.
func pseudoSum(src, dst netip.Addr, proto uint8, segment []byte) uint16 {
	copied := append([]byte(nil), segment...)
	offset := transportChecksumOffset(proto)
	binary.BigEndian.PutUint16(copied[offset:], 0)
	var pseudo []byte
	pseudo = append(pseudo, src.AsSlice()...)
	pseudo = append(pseudo, dst.AsSlice()...)
	if src.Is4() {
		pseudo = append(pseudo, 0, proto)
		pseudo = binary.BigEndian.AppendUint16(pseudo, uint16(len(segment)))
	} else {
		pseudo = binary.BigEndian.AppendUint32(pseudo, uint32(len(segment)))
		pseudo = append(pseudo, 0, 0, 0, proto)
	}
	return checksum(append(pseudo, copied...))
}

// checkSums fails when any checksum in the packet no longer matches.
func checkSums(t *testing.T, packet []byte) {
	t.Helper()
	h, ok := parseHeader(packet)
	if !ok {
		t.Fatal("not a packet")
	}
	if h.v4 {
		if checksum(packet[:20]) != 0 {
			t.Fatal("the IPv4 header checksum is wrong")
		}
	}
	segment := packet[h.transport:]
	if h.proto == protoICMP {
		if checksum(segment) != 0 {
			t.Fatal("the ICMP checksum is wrong")
		}
		return
	}
	offset := transportChecksumOffset(h.proto)
	got := binary.BigEndian.Uint16(segment[offset:])
	if want := pseudoSum(h.src, h.dst, h.proto, segment); got != want {
		t.Fatalf("the transport checksum is %04x, want %04x", got, want)
	}
}

func tcpSegment(sport, dport uint16) []byte {
	segment := make([]byte, 20, 24)
	binary.BigEndian.PutUint16(segment[0:], sport)
	binary.BigEndian.PutUint16(segment[2:], dport)
	segment[12] = 5 << 4
	segment[13] = 0x02 // SYN
	return append(segment, 'w', 'a', 'v', 'e')
}

func udpSegment(sport, dport uint16) []byte {
	segment := make([]byte, 8, 13)
	binary.BigEndian.PutUint16(segment[0:], sport)
	binary.BigEndian.PutUint16(segment[2:], dport)
	segment = append(segment, 'h', 'e', 'l', 'l', 'o')
	binary.BigEndian.PutUint16(segment[4:], uint16(len(segment)))
	return segment
}

func echo(kind byte, id uint16) []byte {
	body := make([]byte, 8)
	body[0] = kind
	binary.BigEndian.PutUint16(body[4:], id)
	return body
}

// The case from the phone: a connection to a service in wave b leaves with
// wave a's address, because that is the one iOS picked. It has to arrive with
// b's, and the reply has to come back to the address the app's socket holds.
func TestAConnectionIntoTheSecondWaveLeavesWithItsAddress(t *testing.T) {
	var lines []string
	s := twoWaves(&lines)

	syn := buildPacket(ownA, peerB, protoTCP, tcpSegment(50000, 80))
	s.outbound("b", syn)
	if src, _ := Source(syn); src != ownB {
		t.Fatalf("left with %s, want %s", src, ownB)
	}
	checkSums(t, syn)
	if len(lines) != 1 || !strings.Contains(lines[0], "rewritten to 10.64.0.8") {
		t.Fatalf("log %q", lines)
	}

	reply := buildPacket(peerB, ownB, protoTCP, tcpSegment(80, 50000))
	s.inbound("b", reply)
	if dst, _ := Destination(reply); dst != ownA {
		t.Fatalf("the reply goes to %s, want %s", dst, ownA)
	}
	checkSums(t, reply)

	// Said once per wave, not once per packet.
	s.outbound("b", buildPacket(ownA, peerB, protoTCP, tcpSegment(50001, 80)))
	if len(lines) != 1 {
		t.Fatalf("logged %d times", len(lines))
	}
}

func TestIPv6AndUDPAreRewrittenTheSameWay(t *testing.T) {
	var lines []string
	s := twoWaves(&lines)

	query := buildPacket(ownA6, peerB6, protoUDP, udpSegment(40000, 53))
	s.outbound("b", query)
	if src, _ := Source(query); src != ownB6 {
		t.Fatalf("left with %s, want %s", src, ownB6)
	}
	checkSums(t, query)

	answer := buildPacket(peerB6, ownB6, protoUDP, udpSegment(53, 40000))
	s.inbound("b", answer)
	if dst, _ := Destination(answer); dst != ownA6 {
		t.Fatalf("the answer goes to %s, want %s", dst, ownA6)
	}
	checkSums(t, answer)
}

// Ping is what anybody tries first, and has no ports: the identifier keys it.
func TestAnEchoIsKeyedByItsIdentifier(t *testing.T) {
	var lines []string
	s := twoWaves(&lines)

	request := buildPacket(ownA, peerB, protoICMP, echo(icmpEchoRequest, 7))
	s.outbound("b", request)
	checkSums(t, request)
	reply := buildPacket(peerB, ownB, protoICMP, echo(icmpEchoReply, 7))
	s.inbound("b", reply)
	if dst, _ := Destination(reply); dst != ownA {
		t.Fatalf("the echo reply goes to %s, want %s", dst, ownA)
	}
	checkSums(t, reply)

	request6 := buildPacket(ownA6, peerB6, protoICMPv6, echo(icmpv6EchoRequest, 9))
	s.outbound("b", request6)
	checkSums(t, request6)
}

// What already carries the right address -- every packet on Linux -- is left
// byte for byte as it was, and so is a reply to nothing rewritten.
func TestTheRightAddressIsLeftAlone(t *testing.T) {
	var lines []string
	s := twoWaves(&lines)

	right := buildPacket(ownB, peerB, protoTCP, tcpSegment(50000, 80))
	before := append([]byte(nil), right...)
	s.outbound("b", right)
	if !bytes.Equal(right, before) {
		t.Fatal("a packet with the wave's own address was changed")
	}

	unasked := buildPacket(peerB, ownB, protoTCP, tcpSegment(22, 60000))
	before = append([]byte(nil), unasked...)
	s.inbound("b", unasked)
	if !bytes.Equal(unasked, before) {
		t.Fatal("an inbound packet of no rewritten flow was changed")
	}

	// A source that is not ours at all is not ours to correct.
	foreign := buildPacket(netip.MustParseAddr("192.168.1.5"), peerB, protoTCP, tcpSegment(1, 80))
	before = append([]byte(nil), foreign...)
	s.outbound("b", foreign)
	if !bytes.Equal(foreign, before) || len(lines) != 0 {
		t.Fatal("a foreign source was rewritten")
	}
}

// A wave that goes, or changes address, takes its flows with it.
func TestFlowsGoWithTheirWave(t *testing.T) {
	var lines []string
	s := twoWaves(&lines)
	s.outbound("b", buildPacket(ownA, peerB, protoTCP, tcpSegment(50000, 80)))
	s.set(map[string][]netip.Addr{"a": {ownA, ownA6}})
	if len(s.flows) != 0 {
		t.Fatalf("%d flow(s) outlived their wave", len(s.flows))
	}
}

// The incremental update agrees with computing the sum from scratch.
func TestAdjustSumMatchesARecomputation(t *testing.T) {
	data := []byte{10, 160, 0, 25, 10, 64, 0, 4, 1, 2, 3, 4}
	before := checksum(data)
	changed := append([]byte(nil), data...)
	copy(changed[0:4], []byte{10, 64, 0, 8})
	if got, want := adjustSum(before, data[0:4], changed[0:4]), checksum(changed); got != want {
		t.Fatalf("adjusted %04x, recomputed %04x", got, want)
	}
}
