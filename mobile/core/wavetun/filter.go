package wavetun

import (
	"encoding/binary"
	"net/netip"
	"sync"
	"time"
)

// The protocol numbers the filter distinguishes.
const (
	protoICMP   = 1
	protoTCP    = 6
	protoUDP    = 17
	protoICMPv6 = 58
)

// PortRange is one range a rule opens. Proto is protoTCP, protoUDP or zero for
// both.
type PortRange struct {
	Proto    uint8
	From, To uint16
}

// FilterRule lets in traffic from Src to Dst on Ports (M7, stage two).
type FilterRule struct {
	Src   []netip.Prefix
	Dst   []netip.Prefix
	Ports []PortRange
}

// flowTimeout is how long a flow this device opened keeps its reply path
// open after its last packet. Longer than any keepalive a sane protocol sends
// over a tunnel, short enough that the table does not become a list of every
// connection ever made.
const flowTimeout = 5 * time.Minute

// maxFlows bounds the table. A phone that opens connections faster than they
// expire loses the reply path of the oldest ones -- which the application
// sees as a timeout and retries -- rather than growing memory without end.
const maxFlows = 4096

type flowKey struct {
	proto         uint8
	local, remote netip.AddrPort
}

// Filter is the port half of one wave's policy on a device that has no
// firewall to hand it to.
//
// The desktop hands the same rules to nftables; a phone cannot, but here every
// packet already passes through the multiplexer on its way in and out, so this
// is where it is checked. Inbound is let through when a rule names it, when it
// answers a flow this device opened, or when it is ICMP -- the same three
// cases the nftables chain accepts, in the same order.
type Filter struct {
	rules []FilterRule
	now   func() time.Time

	mu    sync.Mutex
	flows map[flowKey]time.Time
}

// NewFilter makes a filter. Nil rules are a policy that lets in only replies.
func NewFilter(rules []FilterRule, now func() time.Time) *Filter {
	if now == nil {
		now = time.Now
	}
	return &Filter{rules: rules, now: now, flows: map[flowKey]time.Time{}}
}

// packetInfo is what the filter needs from an IP packet.
type packetInfo struct {
	proto        uint8
	src, dst     netip.Addr
	sport, dport uint16
	// A fragment after the first, which carries no transport header at all.
	laterFragment bool
	// Whether the ports could be read: TCP or UDP with a header long enough,
	// and no IPv6 extension header in the way.
	hasPorts bool
}

// transport reads a packet's header.
func transport(packet []byte) (info packetInfo, ok bool) {
	var payload []byte
	switch Version(packet) {
	case 4:
		if len(packet) < ipv4HeaderMin {
			return packetInfo{}, false
		}
		headerLength := int(packet[0]&0x0f) * 4
		if headerLength < ipv4HeaderMin || len(packet) < headerLength {
			return packetInfo{}, false
		}
		info.proto = packet[9]
		info.src = netip.AddrFrom4([4]byte(packet[12:16]))
		info.dst = netip.AddrFrom4([4]byte(packet[16:20]))
		if binary.BigEndian.Uint16(packet[6:8])&0x1fff != 0 {
			info.laterFragment = true
			return info, true
		}
		payload = packet[headerLength:]
	case 6:
		if len(packet) < ipv6Header {
			return packetInfo{}, false
		}
		info.proto = packet[6]
		info.src = netip.AddrFrom16([16]byte(packet[8:24]))
		info.dst = netip.AddrFrom16([16]byte(packet[24:40]))
		payload = packet[ipv6Header:]
	default:
		return packetInfo{}, false
	}
	if (info.proto == protoTCP || info.proto == protoUDP) && len(payload) >= 4 {
		info.sport = binary.BigEndian.Uint16(payload[0:2])
		info.dport = binary.BigEndian.Uint16(payload[2:4])
		info.hasPorts = true
	}
	return info, true
}

// Outbound notes a packet this device sends, so its reply may come back.
func (f *Filter) Outbound(packet []byte) {
	info, ok := transport(packet)
	if !ok || !info.hasPorts {
		return
	}
	key := flowKey{
		proto:  info.proto,
		local:  netip.AddrPortFrom(info.src, info.sport),
		remote: netip.AddrPortFrom(info.dst, info.dport),
	}
	now := f.now()

	f.mu.Lock()
	defer f.mu.Unlock()
	if _, known := f.flows[key]; !known && len(f.flows) >= maxFlows {
		f.evictLocked(now)
	}
	f.flows[key] = now
}

// evictLocked drops the expired flows, and the oldest one if none has.
func (f *Filter) evictLocked(now time.Time) {
	var oldest flowKey
	var oldestAt time.Time
	for key, at := range f.flows {
		if now.Sub(at) > flowTimeout {
			delete(f.flows, key)
			continue
		}
		if oldestAt.IsZero() || at.Before(oldestAt) {
			oldest, oldestAt = key, at
		}
	}
	if len(f.flows) >= maxFlows {
		delete(f.flows, oldest)
	}
}

// Allow says whether an inbound packet may reach this device.
func (f *Filter) Allow(packet []byte) bool {
	info, ok := transport(packet)
	if !ok {
		return false
	}
	// Ping and path MTU discovery are how a tunnel is debugged, and neither
	// opens anything.
	if info.proto == protoICMP || info.proto == protoICMPv6 {
		return true
	}
	// A later fragment has no ports to judge. Letting it pass costs nothing:
	// without its first fragment, which was judged, it reassembles into
	// nothing.
	if info.laterFragment && (info.proto == protoTCP || info.proto == protoUDP) {
		return true
	}
	// Anything else without readable ports -- another protocol, a header cut
	// short, an extension header in the way -- is not something a rule can
	// have named.
	if !info.hasPorts {
		return false
	}

	reply := flowKey{
		proto:  info.proto,
		local:  netip.AddrPortFrom(info.dst, info.dport),
		remote: netip.AddrPortFrom(info.src, info.sport),
	}
	now := f.now()
	f.mu.Lock()
	at, known := f.flows[reply]
	if known && now.Sub(at) <= flowTimeout {
		f.flows[reply] = now
		f.mu.Unlock()
		return true
	}
	f.mu.Unlock()

	for _, rule := range f.rules {
		if matches(rule, info.proto, info.src, info.dst, info.dport) {
			return true
		}
	}
	return false
}

func matches(rule FilterRule, proto uint8, src, dst netip.Addr, dport uint16) bool {
	if !containsAny(rule.Src, src) || !containsAny(rule.Dst, dst) {
		return false
	}
	for _, ports := range rule.Ports {
		if (ports.Proto == 0 || ports.Proto == proto) && dport >= ports.From && dport <= ports.To {
			return true
		}
	}
	return false
}

func containsAny(prefixes []netip.Prefix, addr netip.Addr) bool {
	for _, prefix := range prefixes {
		if prefix.Contains(addr) {
			return true
		}
	}
	return false
}
