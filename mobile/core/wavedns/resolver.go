package wavedns

import (
	"fmt"
	"net/netip"
	"strconv"
	"strings"
)

// Record is one name in a wave: a device, or a service that is not a device.
type Record struct {
	Name string
	IPv4 string
	IPv6 string
}

// Route is a suffix handed to another nameserver, e.g. an internal corporate
// zone the wave delegates.
type Route struct {
	Suffix      string
	Nameservers []string
}

// Zone is everything one wave answers for.
type Zone struct {
	// The wave, named by its control server -- so a log line can say which of
	// several waves answered.
	ControlURL string
	Suffix     string
	Records    []Record
	Routes     []Route
	// The in-addr.arpa and ip6.arpa zones covering this wave's addresses.
	// Inside them an unknown address is NXDOMAIN; outside, the query is not
	// ours.
	Reverse []string
	// How many of Records are services rather than devices -- only so a log
	// line about a name that is missing can say what the wave does hold.
	Services int
}

// Config is the whole resolver: every wave on the device at once.
//
// One table rather than one resolver per wave, because a phone has one tunnel
// and the queries all arrive on it. Which wave answers is decided by the name,
// and a name in two waves is answered by the first -- the same ambiguity a
// search path produces on the desktop, and a property rather than a fault.
type Config struct {
	Zones []Zone
	// Where to send everything that is not ours.
	//
	// On iOS this stays empty: matchDomains means only our own names ever
	// reach us. Android has no such thing -- VpnService.Builder.addDnsServer
	// is device-wide -- so there the invariant "never take over the system
	// resolver" cannot be kept, and passing the rest on becomes a duty rather
	// than an option. Dropping instead would break every other name on the
	// phone.
	Upstreams []string
	// True where the resolver is device-wide, which is what makes Upstreams
	// mandatory rather than optional.
	SystemWide bool
}

// Resolution is what to do with one query.
type Resolution struct {
	// Exactly one of these is set.
	Packet      []byte
	Nameservers []string
	Drop        bool
}

// Resolve decides what to do with one query. Pure, so the policy can be tested
// without a network -- which on a phone is the only way it can be tested at all.
func Resolve(packet []byte, config Config) Resolution {
	query, ok := DecodeQuery(packet)
	// Not a question we understand: staying silent is better than guessing.
	if !ok {
		return Resolution{Drop: true}
	}
	name := NormalizeName(query.Question.Name)

	if query.Question.Type == TypePTR {
		return resolvePTR(query, name, config)
	}

	// A delegated suffix wins over the wave zone, so a route can carve out a
	// subdomain of it.
	for _, zone := range config.Zones {
		for _, route := range zone.Routes {
			if IsWithinZone(name, route.Suffix) && len(route.Nameservers) > 0 {
				return Resolution{Nameservers: route.Nameservers}
			}
		}
	}

	// The closest zone answers, not the first: with one wave's zone inside
	// another's (ops.example.com and team.ops.example.com), the outer one
	// would otherwise say "no such name" for every device of the inner.
	var best *Zone
	for index := range config.Zones {
		zone := &config.Zones[index]
		if zone.Suffix == "" || !IsWithinZone(name, zone.Suffix) {
			continue
		}
		if best == nil || len(NormalizeName(zone.Suffix)) > len(NormalizeName(best.Suffix)) {
			best = zone
		}
	}
	if best != nil {
		zone := best
		record, found := findRecord(zone.Records, name)
		if !found {
			return Resolution{Packet: EncodeResponse(query, nil, CodeNameError)}
		}
		// A known name without the requested type answers empty, not "no such
		// name": NXDOMAIN would tell the client the name does not exist at all.
		return Resolution{Packet: EncodeResponse(query, answersFor(record, query), CodeNoError)}
	}

	return notOurs(config)
}

func resolvePTR(query Query, name string, config Config) Resolution {
	bytes, ok := addressFromPTRName(name)
	if ok {
		for _, zone := range config.Zones {
			for _, record := range zone.Records {
				address := record.IPv4
				if len(bytes) == 16 {
					address = record.IPv6
				}
				if sameAddress(bytes, address) {
					answers := []Answer{{
						Name: query.Question.Name, Type: TypePTR, TTL: ttlSeconds, Target: record.Name,
					}}
					return Resolution{Packet: EncodeResponse(query, answers, CodeNoError)}
				}
			}
		}
	}
	// Ours to answer for, but nobody holds that address: say so rather than
	// leaving the caller waiting.
	for _, zone := range config.Zones {
		for _, reverse := range zone.Reverse {
			if IsWithinZone(name, reverse) {
				return Resolution{Packet: EncodeResponse(query, nil, CodeNameError)}
			}
		}
	}
	return notOurs(config)
}

// notOurs is where the two platforms part. Dropping is right when the system
// only sends us our own names; forwarding is the only honest answer when it
// sends us everything.
func notOurs(config Config) Resolution {
	if config.SystemWide && len(config.Upstreams) > 0 {
		return Resolution{Nameservers: config.Upstreams}
	}
	return Resolution{Drop: true}
}

func findRecord(records []Record, name string) (Record, bool) {
	for _, record := range records {
		if NormalizeName(record.Name) == name {
			return record, true
		}
	}
	return Record{}, false
}

func answersFor(record Record, query Query) []Answer {
	var answers []Answer
	if query.Question.Type == TypeA && record.IPv4 != "" {
		answers = append(answers, Answer{Name: query.Question.Name, Type: TypeA, TTL: ttlSeconds, Address: record.IPv4})
	}
	if query.Question.Type == TypeAAAA && record.IPv6 != "" {
		answers = append(answers, Answer{Name: query.Question.Name, Type: TypeAAAA, TTL: ttlSeconds, Address: record.IPv6})
	}
	return answers
}

// addressFromPTRName reads the address a PTR question asks about, as bytes --
// 4 for in-addr.arpa, 16 for ip6.arpa. Bytes rather than text because the same
// address has many spellings: a record says fd7a:8b47:c285::2, the question
// spells out every nibble.
func addressFromPTRName(name string) ([]byte, bool) {
	labels := strings.Split(NormalizeName(name), ".")
	if len(labels) < 3 {
		return nil, false
	}
	suffix := strings.Join(labels[len(labels)-2:], ".")
	body := labels[:len(labels)-2]
	// Reversed: a PTR name spells the address least significant label first.
	for i, j := 0, len(body)-1; i < j; i, j = i+1, j-1 {
		body[i], body[j] = body[j], body[i]
	}

	switch suffix {
	case "in-addr.arpa":
		if len(body) != 4 {
			return nil, false
		}
		out := make([]byte, 4)
		for i, label := range body {
			octet, err := strconv.Atoi(label)
			if err != nil || octet < 0 || octet > 255 {
				return nil, false
			}
			out[i] = byte(octet)
		}
		return out, true
	case "ip6.arpa":
		if len(body) != 32 {
			return nil, false
		}
		out := make([]byte, 16)
		for i := 0; i < 16; i++ {
			value, err := strconv.ParseUint(body[i*2]+body[i*2+1], 16, 8)
			if err != nil {
				return nil, false
			}
			out[i] = byte(value)
		}
		return out, true
	}
	return nil, false
}

func sameAddress(bytes []byte, address string) bool {
	if address == "" {
		return false
	}
	parsed, err := netip.ParseAddr(address)
	if err != nil {
		return false
	}
	if len(bytes) == 4 {
		if !parsed.Is4() {
			return false
		}
		raw := parsed.As4()
		return string(raw[:]) == string(bytes)
	}
	if parsed.Is4() {
		return false
	}
	raw := parsed.As16()
	return string(raw[:]) == string(bytes)
}

// ReverseZonesFor derives the reverse zones a wave covers. Each wave gets a /16
// of IPv4 and a /48 of IPv6 (D5), so the zone is the same for every address in
// it -- which is what makes it derivable from our own without the netmap
// carrying prefixes.
func ReverseZonesFor(addresses []string) []string {
	var zones []string
	seen := map[string]struct{}{}
	add := func(zone string) {
		if _, done := seen[zone]; done {
			return
		}
		seen[zone] = struct{}{}
		zones = append(zones, zone)
	}

	for _, entry := range addresses {
		address := entry
		if slash := strings.IndexByte(address, '/'); slash >= 0 {
			address = address[:slash]
		}
		parsed, err := netip.ParseAddr(address)
		if err != nil {
			continue // not an address we can reverse; nothing to route
		}
		if parsed.Is4() {
			raw := parsed.As4()
			add(fmt.Sprintf("%d.%d.in-addr.arpa", raw[1], raw[0]))
			continue
		}
		raw := parsed.As16()
		nibbles := make([]string, 0, 12)
		// The first 48 bits, one nibble per label, most significant last.
		for i := 0; i < 6; i++ {
			nibbles = append(nibbles, fmt.Sprintf("%x", raw[i]>>4), fmt.Sprintf("%x", raw[i]&0xf))
		}
		for i, j := 0, len(nibbles)-1; i < j; i, j = i+1, j-1 {
			nibbles[i], nibbles[j] = nibbles[j], nibbles[i]
		}
		add(strings.Join(nibbles, ".") + ".ip6.arpa")
	}
	return zones
}
