package wavesettings

import (
	"net/netip"
	"strings"
)

// widenAddresses gives each wave's own addresses a prefix that covers the wave,
// instead of the /32 and /128 the netmap states.
//
// This is not cosmetic, and it is the one thing about the single-interface model
// that a desktop never has to think about. With two waves on one interface,
// every address of ours is a candidate source for every packet -- and with
// nothing but host prefixes there is no rule that could tell them apart, so the
// kernel takes the first address on the interface. A packet to the second wave
// then leaves with the first wave's source address, and the peer's WireGuard
// drops it: that address is not in its allowed IPs. The tunnel looks up on both
// sides and carries nothing in one direction.
//
// Measured exactly that way by test/e2e/mobile-core.sh: pinging the peer in the
// first wave worked and the second did not, from one interface, with both paths
// confirmed.
//
// Widening fixes it with the rule every platform already has: pick the source
// whose prefix matches the destination. It also needs no per-route API, which
// matters because iOS and Android have none -- NEIPv4Settings and
// VpnService.Builder take an address and a prefix length, and this is what
// belongs in it.
//
// The prefix is derived rather than assumed. Each wave gets the shortest one
// that covers everything it routes, which is exactly the set of destinations
// the source has to be chosen for. D5 makes that a /16 and a /48 in practice,
// but nothing here depends on that.
func widenAddresses(waves []Wave) [][]string {
	widened := make([][]string, len(waves))
	covers := make([]map[bool]netip.Prefix, len(waves))
	for i, wave := range waves {
		widened[i] = wave.Addresses
		covers[i] = coversOf(append(append([]string{}, wave.Addresses...), wave.Routes...))
	}

	// Two waves whose covers overlap cannot both widen: the wider prefixes
	// would no longer say which wave a destination belongs to, and that is the
	// one question this whole layer answers. Disjoint addresses do not make
	// disjoint covers -- two servers numbering out of the same block would
	// produce exactly this -- so it is checked rather than reasoned about, and
	// the answer is to leave every address as the netmap stated it.
	for i := range covers {
		for j := i + 1; j < len(covers); j++ {
			for family, mine := range covers[i] {
				theirs, ok := covers[j][family]
				if ok && mine.Overlaps(theirs) {
					return widened
				}
			}
		}
	}

	for i, wave := range waves {
		for index, address := range wave.Addresses {
			host, ok := hostOf(address)
			if !ok {
				continue
			}
			cover, ok := covers[i][host.Is4()]
			if !ok || cover.Bits() >= host.BitLen() {
				continue
			}
			if index == 0 {
				widened[i] = make([]string, len(wave.Addresses))
				copy(widened[i], wave.Addresses)
			}
			widened[i][index] = netip.PrefixFrom(host, cover.Bits()).String()
		}
	}
	return widened
}

// coversOf is the shortest prefix covering every address given, per family.
func coversOf(cidrs []string) map[bool]netip.Prefix {
	addresses := map[bool][]netip.Addr{}
	for _, cidr := range cidrs {
		if host, ok := hostOf(cidr); ok {
			addresses[host.Is4()] = append(addresses[host.Is4()], host)
		}
		// A route may be a prefix rather than a host, and then its own network
		// address has to be covered as well as everything inside it.
		if prefix, err := netip.ParsePrefix(cidr); err == nil {
			masked := prefix.Masked()
			addresses[masked.Addr().Is4()] = append(addresses[masked.Addr().Is4()], masked.Addr(), lastOf(masked))
		}
	}

	covers := map[bool]netip.Prefix{}
	for family, group := range addresses {
		if cover, ok := commonPrefix(group); ok {
			covers[family] = cover
		}
	}
	return covers
}

// commonPrefix is the longest prefix every address shares, which is also the
// shortest prefix that covers them all.
func commonPrefix(addresses []netip.Addr) (netip.Prefix, bool) {
	if len(addresses) == 0 {
		return netip.Prefix{}, false
	}
	first := addresses[0]
	bits := first.BitLen()
	firstBytes := first.AsSlice()

	for _, address := range addresses[1:] {
		if address.Is4() != first.Is4() {
			continue
		}
		other := address.AsSlice()
		shared := 0
		for index := range firstBytes {
			difference := firstBytes[index] ^ other[index]
			if difference == 0 {
				shared += 8
				continue
			}
			for mask := byte(0x80); mask != 0 && difference&mask == 0; mask >>= 1 {
				shared++
			}
			break
		}
		if shared < bits {
			bits = shared
		}
	}
	return netip.PrefixFrom(first, bits).Masked(), true
}

// lastOf is the highest address in a prefix -- the far end of what it covers.
func lastOf(prefix netip.Prefix) netip.Addr {
	raw := prefix.Addr().AsSlice()
	for index := prefix.Bits(); index < len(raw)*8; index++ {
		raw[index/8] |= 0x80 >> (index % 8)
	}
	address, _ := netip.AddrFromSlice(raw)
	return address
}

// hostOf reads the address out of a CIDR, or out of a bare address.
func hostOf(cidr string) (netip.Addr, bool) {
	text := cidr
	if slash := strings.IndexByte(text, '/'); slash >= 0 {
		text = text[:slash]
	}
	address, err := netip.ParseAddr(text)
	if err != nil {
		return netip.Addr{}, false
	}
	return address.Unmap(), true
}
