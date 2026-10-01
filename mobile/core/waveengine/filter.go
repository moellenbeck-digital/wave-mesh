package waveengine

import (
	"fmt"
	"net/netip"

	"github.com/moellenbeck-digital/wave-mesh/mobile/core/waveproto"
	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavetun"
)

// filterFrom turns a netmap's packetFilter into the multiplexer's rules, or
// nil for a wave without a policy -- absent and empty are opposite answers,
// and only the pointer keeps them apart.
//
// An address or a range this version cannot read is left out rather than
// guessed at. Left out, a rule opens less than it says, never more: the
// failure is a port that stays closed, not one that was never meant to open.
func filterFrom(rules *[]waveproto.FilterRule) *wavetun.Filter {
	if rules == nil {
		return nil
	}
	converted := make([]wavetun.FilterRule, 0, len(*rules))
	for _, rule := range *rules {
		entry := wavetun.FilterRule{Src: prefixes(rule.Src), Dst: prefixes(rule.Dst)}
		for _, ports := range rule.Ports {
			proto, known := map[string]uint8{"tcp": 6, "udp": 17, "any": 0}[ports.Proto]
			if !known || ports.From < 1 || ports.To > 65535 || ports.From > ports.To {
				continue
			}
			entry.Ports = append(entry.Ports, wavetun.PortRange{
				Proto: proto, From: uint16(ports.From), To: uint16(ports.To),
			})
		}
		converted = append(converted, entry)
	}
	return wavetun.NewFilter(converted, nil)
}

func prefixes(cidrs []string) []netip.Prefix {
	out := make([]netip.Prefix, 0, len(cidrs))
	for _, cidr := range cidrs {
		if prefix, err := netip.ParsePrefix(cidr); err == nil {
			out = append(out, prefix)
		}
	}
	return out
}

// describeFilter is the one line a change of policy is worth.
func describeFilter(rules *[]waveproto.FilterRule) string {
	if rules == nil {
		return "no policy: every peer may reach every port"
	}
	return fmt.Sprintf("policy enforced: %d rule(s) let traffic in", len(*rules))
}
