package wavetun

import (
	"encoding/binary"
	"fmt"
	"net/netip"
	"sync"
	"time"
)

// sourceIdle is how long a rewritten flow is remembered without a packet.
// Longer than the filter's flows: a connection an app keeps open and quiet --
// a chat socket, an SSH session -- has to find its way back when it speaks
// again, and a forgotten one is a connection that hangs for no visible reason.
const sourceIdle = 30 * time.Minute

// maxSourceFlows bounds the table. Past it the oldest flow goes, which to that
// connection looks like a reset network -- better than memory without end in
// an extension iOS ends at 50 MB.
const maxSourceFlows = 4096

// sourceKey names one flow the way its replies will name it: the wave, the
// protocol, this device's address in that wave with its port, and the peer.
// For an ICMP echo the identifier stands in for both ports.
type sourceKey struct {
	wave          string
	proto         uint8
	local, remote netip.AddrPort
}

type sourceFlow struct {
	original netip.Addr
	seen     time.Time
}

// sources puts every packet into a wave with that wave's own address.
//
// Two waves share one tunnel interface, and the system picks one source
// address for everything that leaves through it. On iOS that is the first
// address of the interface, whatever the destination: the prefixes of the
// addresses (prefix.go) are what the API accepts, and the system does not
// choose by them. So with two waves up, a connection to a service in the
// second went out with the first wave's address, the peer's WireGuard dropped
// it -- the address is not in that device's allowed IPs -- and the service was
// simply unreachable, while it worked the moment the first wave was paused.
// Pings from the other side still worked, because a reply leaves from the
// address that was pinged, which made it look like anything but an address
// problem.
//
// So the multiplexer, which sees every packet on its way into a wave anyway,
// rewrites a source that belongs to another wave to this wave's own address,
// and remembers the flow so the reply gets its original destination back. A
// packet that already carries the right address -- every packet on Linux,
// which chooses by route -- is not touched.
type sources struct {
	now func() time.Time
	log func(string)

	mu    sync.Mutex
	own   map[string][]netip.Addr
	ours  map[netip.Addr]bool
	flows map[sourceKey]sourceFlow
	// Which waves have been said to need this, so the log says it once.
	noted map[string]bool
}

func newSources(log func(string)) *sources {
	return &sources{
		now:   time.Now,
		log:   log,
		own:   map[string][]netip.Addr{},
		ours:  map[netip.Addr]bool{},
		flows: map[sourceKey]sourceFlow{},
		noted: map[string]bool{},
	}
}

// set replaces which addresses each wave holds.
func (s *sources) set(own map[string][]netip.Addr) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.own = map[string][]netip.Addr{}
	s.ours = map[netip.Addr]bool{}
	for wave, addresses := range own {
		s.own[wave] = append([]netip.Addr(nil), addresses...)
		for _, address := range addresses {
			s.ours[address] = true
		}
	}
	// A flow into a wave that is gone, or whose address changed, would only
	// ever map replies that cannot arrive.
	for key := range s.flows {
		if !contains(s.own[key.wave], key.local.Addr()) {
			delete(s.flows, key)
		}
	}
}

func contains(addresses []netip.Addr, address netip.Addr) bool {
	for _, candidate := range addresses {
		if candidate == address {
			return true
		}
	}
	return false
}

// ownLocked is the wave's address in the family of the one given.
func (s *sources) ownLocked(wave string, like netip.Addr) (netip.Addr, bool) {
	for _, address := range s.own[wave] {
		if address.Is4() == like.Is4() {
			return address, true
		}
	}
	return netip.Addr{}, false
}

// outbound rewrites, in place, a packet into wave whose source is another
// wave's address.
func (s *sources) outbound(wave string, packet []byte) {
	header, ok := parseHeader(packet)
	if !ok {
		return
	}
	s.mu.Lock()
	wanted, has := s.ownLocked(wave, header.src)
	if !has || header.src == wanted || !s.ours[header.src] {
		// The right address already, or one that is not ours to correct.
		s.mu.Unlock()
		return
	}
	local, remote, keyed := header.endpoints(wanted, header.dst)
	if !keyed {
		// Without ports there is no telling replies apart: a later fragment,
		// or a protocol this does not know. Left as it was, it fails the way
		// it always did instead of being misdelivered.
		s.mu.Unlock()
		return
	}
	now := s.now()
	key := sourceKey{wave: wave, proto: header.proto, local: local, remote: remote}
	if _, known := s.flows[key]; !known && len(s.flows) >= maxSourceFlows {
		s.evictLocked(now)
	}
	s.flows[key] = sourceFlow{original: header.src, seen: now}
	first := !s.noted[wave]
	s.noted[wave] = true
	s.mu.Unlock()

	header.rewrite(packet, header.srcOffset, header.src, wanted)
	if first {
		s.log(fmt.Sprintf("[%s] the system sent with %s, another wave's address; "+
			"rewritten to %s so the peer accepts it", wave, header.src, wanted))
	}
}

// inbound gives a reply into a rewritten flow its original destination back.
func (s *sources) inbound(wave string, packet []byte) {
	header, ok := parseHeader(packet)
	if !ok {
		return
	}
	// Seen from our side: the destination is local, the source the peer.
	local, remote, keyed := header.endpointsReversed()
	if !keyed {
		return
	}
	key := sourceKey{wave: wave, proto: header.proto, local: local, remote: remote}
	s.mu.Lock()
	flow, known := s.flows[key]
	if known {
		flow.seen = s.now()
		s.flows[key] = flow
	}
	s.mu.Unlock()
	if !known {
		return
	}
	header.rewrite(packet, header.dstOffset, header.dst, flow.original)
}

func (s *sources) evictLocked(now time.Time) {
	var oldest sourceKey
	var oldestAt time.Time
	for key, flow := range s.flows {
		if now.Sub(flow.seen) > sourceIdle {
			delete(s.flows, key)
			continue
		}
		if oldestAt.IsZero() || flow.seen.Before(oldestAt) {
			oldest, oldestAt = key, flow.seen
		}
	}
	if len(s.flows) >= maxSourceFlows {
		delete(s.flows, oldest)
	}
}

// header is what rewriting needs from a packet: where the addresses and the
// checksums are.
type header struct {
	v4                   bool
	proto                uint8
	src, dst             netip.Addr
	srcOffset, dstOffset int
	// Where the transport header starts, or -1 when it cannot be read: a later
	// fragment, or an IPv6 extension header in the way.
	transport int
	// The ports, or an echo's identifier for both; keyed says they were read.
	sport, dport uint16
	keyed        bool
}

const (
	icmpEchoRequest   = 8
	icmpEchoReply     = 0
	icmpv6EchoRequest = 128
	icmpv6EchoReply   = 129
)

func parseHeader(packet []byte) (header, bool) {
	var h header
	switch Version(packet) {
	case 4:
		if len(packet) < ipv4HeaderMin {
			return h, false
		}
		length := int(packet[0]&0x0f) * 4
		if length < ipv4HeaderMin || len(packet) < length {
			return h, false
		}
		h.v4 = true
		h.proto = packet[9]
		h.srcOffset, h.dstOffset = 12, 16
		h.src = netip.AddrFrom4([4]byte(packet[12:16]))
		h.dst = netip.AddrFrom4([4]byte(packet[16:20]))
		h.transport = length
		if binary.BigEndian.Uint16(packet[6:8])&0x1fff != 0 {
			h.transport = -1
		}
	case 6:
		if len(packet) < ipv6Header {
			return h, false
		}
		h.proto = packet[6]
		h.srcOffset, h.dstOffset = 8, 24
		h.src = netip.AddrFrom16([16]byte(packet[8:24]))
		h.dst = netip.AddrFrom16([16]byte(packet[24:40]))
		h.transport = ipv6Header
	default:
		return h, false
	}
	if h.transport >= 0 && len(packet) < h.transport+h.minTransport() {
		h.transport = -1
	}
	h.sport, h.dport, h.keyed = h.ports(packet)
	return h, true
}

// minTransport is how much of the transport header has to be there to read
// its ports and reach its checksum.
func (h header) minTransport() int {
	switch h.proto {
	case protoTCP:
		return 18
	case protoUDP:
		return 8
	case protoICMP, protoICMPv6:
		return 8
	}
	return 0
}

// ports reads the source and destination port, or an echo's identifier for
// both.
func (h header) ports(packet []byte) (source, destination uint16, ok bool) {
	if h.transport < 0 {
		return 0, 0, false
	}
	body := packet[h.transport:]
	switch h.proto {
	case protoTCP, protoUDP:
		return binary.BigEndian.Uint16(body[0:2]), binary.BigEndian.Uint16(body[2:4]), true
	case protoICMP:
		if body[0] == icmpEchoRequest || body[0] == icmpEchoReply {
			id := binary.BigEndian.Uint16(body[4:6])
			return id, id, true
		}
	case protoICMPv6:
		if !h.v4 && (body[0] == icmpv6EchoRequest || body[0] == icmpv6EchoReply) {
			id := binary.BigEndian.Uint16(body[4:6])
			return id, id, true
		}
	}
	return 0, 0, false
}

// endpoints is an outbound packet's flow as its replies will name it, with
// local standing in for the source it is about to get.
func (h header) endpoints(local, remote netip.Addr) (netip.AddrPort, netip.AddrPort, bool) {
	return netip.AddrPortFrom(local, h.sport), netip.AddrPortFrom(remote, h.dport), h.keyed
}

// endpointsReversed is an inbound packet's flow, seen from this device.
func (h header) endpointsReversed() (netip.AddrPort, netip.AddrPort, bool) {
	return netip.AddrPortFrom(h.dst, h.dport), netip.AddrPortFrom(h.src, h.sport), h.keyed
}

// rewrite replaces the address at offset and fixes every checksum it is in.
func (h header) rewrite(packet []byte, offset int, from, to netip.Addr) {
	old := from.AsSlice()
	replacement := to.AsSlice()
	if h.v4 {
		putSum(packet[10:12], adjustSum(binary.BigEndian.Uint16(packet[10:12]), old, replacement))
	}
	if h.transport >= 0 {
		body := packet[h.transport:]
		switch {
		case h.proto == protoTCP:
			putSum(body[16:18], adjustSum(binary.BigEndian.Uint16(body[16:18]), old, replacement))
		case h.proto == protoUDP:
			current := binary.BigEndian.Uint16(body[6:8])
			// Zero over IPv4 means "no checksum", and stays that way.
			if !(h.v4 && current == 0) {
				sum := adjustSum(current, old, replacement)
				if sum == 0 {
					sum = 0xffff
				}
				putSum(body[6:8], sum)
			}
		case h.proto == protoICMPv6 && !h.v4:
			// ICMPv6 covers the pseudo-header; ICMPv4 does not.
			putSum(body[2:4], adjustSum(binary.BigEndian.Uint16(body[2:4]), old, replacement))
		}
	}
	copy(packet[offset:], replacement)
}

func putSum(field []byte, sum uint16) { binary.BigEndian.PutUint16(field, sum) }

// adjustSum updates a one's complement checksum for bytes that changed, the
// incremental way RFC 1624 describes (eqn. 3): HC' = ~(~HC + ~m + m').
func adjustSum(sum uint16, old, replacement []byte) uint16 {
	acc := uint32(^sum)
	for i := 0; i+1 < len(old); i += 2 {
		acc += uint32(^binary.BigEndian.Uint16(old[i:]))
		acc += uint32(binary.BigEndian.Uint16(replacement[i:]))
	}
	for acc>>16 != 0 {
		acc = acc&0xffff + acc>>16
	}
	return ^uint16(acc)
}
