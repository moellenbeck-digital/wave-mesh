// Package wavesettings turns the netmaps of every wave on this device into the
// one set of tunnel settings the operating system will accept.
//
// A phone allows exactly one tunnel per app -- one NEPacketTunnelProvider, one
// VpnService -- so where the desktop configures wave0, wave1 and so on
// separately, here there is a single union: addresses and routes added up, MTU
// taken as the smallest, DNS as one resolver with a table of suffixes.
//
// Two consequences run through everything below. Applying is atomic and knows
// no partial failure, so a range that collides has to be caught before this
// point (see waveoverlap) rather than repaired after it. And applying
// interrupts the tunnel briefly, so a netmap that changes nothing must produce
// a union that compares equal -- which is why everything here is sorted and
// deduplicated rather than merely concatenated.
package wavesettings

import (
	"net/netip"
	"sort"
	"strings"
)

// DefaultMTU is the largest size that survives any path, relays included.
const DefaultMTU = 1280

// Settings is what the platform applies to its one tunnel.
//
// It carries JSON tags because this is the one structure that crosses the
// language boundary: gomobile passes strings, not slices of strings, so the
// union travels as JSON and Swift and Kotlin decode the same shape.
type Settings struct {
	// Addresses to configure on the tunnel, as CIDRs.
	Addresses []string `json:"addresses"`
	// Everything that must be routed into the tunnel: every peer's allowed IPs
	// and, with them, the service addresses that belong to no device (D11).
	Routes []Route `json:"routes"`
	// The smallest MTU any wave asks for: one interface cannot have two.
	MTU int `json:"mtu"`
	// Where the operating system should send DNS queries. Always addresses of
	// ours on the tunnel, so the query arrives as a packet we answer inline.
	DNSServers []string `json:"dnsServers"`
	// The suffixes that belong to the waves, including their reverse zones.
	// iOS takes these as matchDomains and leaves the rest of the system alone;
	// Android cannot, and the resolver has to forward the rest itself.
	MatchDomains []string `json:"matchDomains"`
	// What a bare hostname is completed with. One per wave, in the order the
	// waves were added, so the first wave wins a name two of them carry.
	SearchDomains []string `json:"searchDomains"`
}

// Route is one destination that belongs in the tunnel, and which of our
// addresses to send to it from.
//
// The source is there because a phone has one interface for every wave, so the
// kernel's own answer to "which of these addresses should this packet come
// from" is ambiguous -- and a packet leaving with another wave's address is
// dropped by the peer's WireGuard, silently and in one direction only. The
// widened prefixes in prefix.go are the other half of this: a platform with no
// per-route source falls back to matching prefixes, and one that has it, like
// Linux, gets told outright. Measured: without either, a two-wave device
// reaches the first wave and not the second.
type Route struct {
	CIDR string `json:"cidr"`
	// Empty when the wave has no address of that family -- there is then
	// nothing to choose between.
	Source string `json:"source"`
}

// Wave is one enrolment's contribution to the union.
type Wave struct {
	// Addresses of this node in this wave, as CIDRs.
	Addresses []string
	// Everything to route here: the union of every peer's allowed IPs.
	Routes []string
	// The wave's DNS suffix, e.g. "rl.wave.example.com".
	Suffix string
	// Reverse zones covering this wave's addresses.
	ReverseZones []string
	// Suffixes this wave delegates elsewhere; they have to be routed to our
	// resolver too, or the system would answer them itself.
	DelegatedSuffixes []string
	// The address our resolver answers on for this wave.
	//
	// If it is not one of Addresses, it is routed into the tunnel instead of
	// being assigned to it -- and that distinction is the whole trick. A packet
	// to an address the interface holds is delivered locally by the kernel and
	// never reaches the tunnel, so a resolver with no socket of its own would
	// answer an ICMP port-unreachable. Routed and unassigned, the query arrives
	// as a packet like any other and can be answered inline.
	ResolverAddress string
	// This wave's MTU, or zero for the default.
	MTU int
}

// Union folds the waves into one set of settings.
func Union(waves []Wave) Settings {
	// Empty lists rather than nil: Go marshals a nil slice as null, and this
	// structure crosses into Swift, where a non-optional array refuses one.
	settings := Settings{MTU: 0, SearchDomains: []string{}, Routes: []Route{}}
	addresses := newSet()
	servers := newSet()
	match := newSet()
	routes := map[string]Route{}

	// The addresses go on with a prefix that covers their wave, not the host
	// prefix the netmap states: with several waves on one interface that is the
	// only thing that tells the kernel which of our addresses to send from.
	// See prefix.go -- it cost a silent one-way tunnel to find.
	widened := widenAddresses(waves)

	for index, wave := range waves {
		addresses.add(widened[index]...)
		// Each route is tagged with this wave's own address of the same family,
		// which is the whole point: it is the only thing that says which wave
		// the packet belongs to before it reaches WireGuard.
		sourceV4, sourceV6 := sourcesOf(wave.Addresses)

		for _, cidr := range wave.Routes {
			cidr = strings.TrimSpace(cidr)
			if cidr == "" {
				continue
			}
			source := sourceV4
			if strings.Contains(cidr, ":") {
				source = sourceV6
			}
			routes[cidr] = Route{CIDR: cidr, Source: source}
		}
		if wave.ResolverAddress != "" {
			servers.add(wave.ResolverAddress)
			// Routed rather than assigned, unless the wave is using one of its
			// own addresses -- which works where the resolver has a socket, and
			// not here. See the field's comment.
			if resolver, ok := hostOf(wave.ResolverAddress); ok && !holds(wave.Addresses, resolver) {
				cidr := netip.PrefixFrom(resolver, resolver.BitLen()).String()
				source := sourceV4
				if !resolver.Is4() {
					source = sourceV6
				}
				routes[cidr] = Route{CIDR: cidr, Source: source}
			}
		}
		if wave.Suffix != "" {
			match.add(wave.Suffix)
			// A wave's own zone doubles as the search domain, so `ping laptop`
			// works without spelling out the suffix. Unlike the rest of this,
			// order carries meaning here: the first wave answers first.
			settings.SearchDomains = appendUnique(settings.SearchDomains, wave.Suffix)
		}
		// The reverse zones are routed to us as well, or the system resolver
		// would send "what is 10.77.0.2 called?" upstream, where nobody knows
		// and nobody says so -- and anything that looks a name up before
		// printing simply waits.
		match.add(wave.ReverseZones...)
		match.add(wave.DelegatedSuffixes...)

		mtu := wave.MTU
		if mtu == 0 {
			mtu = DefaultMTU
		}
		if settings.MTU == 0 || mtu < settings.MTU {
			settings.MTU = mtu
		}
	}

	if settings.MTU == 0 {
		settings.MTU = DefaultMTU
	}
	settings.Addresses = addresses.sorted()
	settings.Routes = sortedRoutes(routes)
	settings.DNSServers = servers.sorted()
	settings.MatchDomains = match.sorted()
	return settings
}

// Equal reports whether applying `next` would change anything. Applying
// interrupts the tunnel, so this is what keeps a netmap that only bumped its
// version from dropping every connection on the phone.
func (s Settings) Equal(other Settings) bool {
	return s.MTU == other.MTU &&
		sameStrings(s.Addresses, other.Addresses) &&
		sameRoutes(s.Routes, other.Routes) &&
		sameStrings(s.DNSServers, other.DNSServers) &&
		sameStrings(s.MatchDomains, other.MatchDomains) &&
		sameStrings(s.SearchDomains, other.SearchDomains)
}

// sourcesOf picks this wave's own address per family, as the source its routes
// are sent from.
func sourcesOf(addresses []string) (v4, v6 string) {
	for _, address := range addresses {
		host, ok := hostOf(address)
		if !ok {
			continue
		}
		if host.Is4() && v4 == "" {
			v4 = host.String()
		}
		if !host.Is4() && v6 == "" {
			v6 = host.String()
		}
	}
	return v4, v6
}

// holds reports whether one of these CIDRs is this exact address.
func holds(cidrs []string, wanted netip.Addr) bool {
	for _, cidr := range cidrs {
		if host, ok := hostOf(cidr); ok && host == wanted {
			return true
		}
	}
	return false
}

func sortedRoutes(routes map[string]Route) []Route {
	out := make([]Route, 0, len(routes))
	for _, route := range routes {
		out = append(out, route)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CIDR < out[j].CIDR })
	return out
}

func sameRoutes(a, b []Route) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func sameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

type set struct {
	seen map[string]struct{}
}

func newSet() *set { return &set{seen: map[string]struct{}{}} }

func (s *set) add(values ...string) {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			s.seen[value] = struct{}{}
		}
	}
}

func (s *set) sorted() []string {
	out := make([]string, 0, len(s.seen))
	for value := range s.seen {
		out = append(out, value)
	}
	sort.Strings(out)
	return out
}

func appendUnique(list []string, value string) []string {
	for _, existing := range list {
		if existing == value {
			return list
		}
	}
	return append(list, value)
}
