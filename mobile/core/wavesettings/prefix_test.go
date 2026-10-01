package wavesettings_test

import (
	"strings"
	"testing"

	"github.com/pinguin45orga/wave-mesh/mobile/core/wavesettings"
)

func addressesOf(settings wavesettings.Settings, family string) []string {
	var out []string
	for _, address := range settings.Addresses {
		if strings.Contains(address, ":") == (family == "v6") {
			out = append(out, address)
		}
	}
	return out
}

// The bug this exists for: two waves on one interface, every address a /32, and
// the kernel with no rule to pick a source by. A packet for the second wave
// leaves with the first wave's address and the peer's WireGuard drops it.
func TestTwoWavesWidenToCoverThemselves(t *testing.T) {
	settings := wavesettings.Union([]wavesettings.Wave{
		{
			Addresses: []string{"10.64.0.1/32"},
			Routes:    []string{"10.64.0.2/32", "10.64.9.9/32"},
			Suffix:    "a.example",
		},
		{
			Addresses: []string{"10.96.0.1/32"},
			Routes:    []string{"10.96.0.2/32"},
			Suffix:    "b.example",
		},
	})

	got := addressesOf(settings, "v4")
	// /20, because that is the shortest prefix covering 10.64.0.1, 10.64.0.2
	// and 10.64.9.9 -- tighter than the /16 the wave was handed, and derived
	// rather than assumed. What matters is that it covers every destination
	// this wave routes and nothing another wave holds.
	if !contains(got, "10.64.0.1/20") {
		t.Fatalf("the first wave did not widen: %v", got)
	}
	// The second covers less, and gets exactly what it covers.
	if !contains(got, "10.96.0.1/30") {
		t.Fatalf("the second wave widened wrongly: %v", got)
	}
}

// A wave whose peers are spread across its block widens to the block.
func TestAWholeBlockWidensToTheBlock(t *testing.T) {
	settings := wavesettings.Union([]wavesettings.Wave{{
		Addresses: []string{"10.64.0.1/32"},
		Routes:    []string{"10.64.0.2/32", "10.64.255.254/32"},
	}})
	if !contains(settings.Addresses, "10.64.0.1/16") {
		t.Fatalf("got %v", settings.Addresses)
	}
}

// A single wave has nothing to be ambiguous with, but widening is harmless and
// the rule stays the same -- one code path rather than a special case.
func TestOneWaveStillCoversItsOwnPeers(t *testing.T) {
	settings := wavesettings.Union([]wavesettings.Wave{{
		Addresses: []string{"10.64.0.1/32", "fd7a:1::1/128"},
		Routes:    []string{"10.64.0.2/32", "fd7a:1::2/128"},
	}})
	if !contains(settings.Addresses, "10.64.0.1/30") {
		t.Fatalf("v4: %v", settings.Addresses)
	}
	if !contains(settings.Addresses, "fd7a:1::1/126") {
		t.Fatalf("v6: %v", settings.Addresses)
	}
}

// Disjoint addresses do not make disjoint covers: two servers numbering out of
// the same block produce exactly this. Widening then cannot say which wave a
// destination belongs to, so nothing is widened at all.
func TestOverlappingCoversAreLeftAlone(t *testing.T) {
	settings := wavesettings.Union([]wavesettings.Wave{
		{Addresses: []string{"10.64.0.1/32"}, Routes: []string{"10.64.0.9/32"}},
		{Addresses: []string{"10.64.0.5/32"}, Routes: []string{"10.64.0.6/32"}},
	})
	for _, address := range settings.Addresses {
		if !strings.HasSuffix(address, "/32") {
			t.Fatalf("an ambiguous cover was widened anyway: %v", settings.Addresses)
		}
	}
}

// A wave with no peers yet covers only itself, which is the host prefix -- there
// is nothing to widen to and nothing that needs it.
func TestAWaveWithNoPeersKeepsItsHostPrefix(t *testing.T) {
	settings := wavesettings.Union([]wavesettings.Wave{{Addresses: []string{"10.64.0.1/32"}}})
	if !contains(settings.Addresses, "10.64.0.1/32") {
		t.Fatalf("got %v", settings.Addresses)
	}
}

// A route that is a prefix rather than a host has to be covered whole: a
// subnet router's range is a destination like any other.
func TestARoutedPrefixIsCoveredWhole(t *testing.T) {
	settings := wavesettings.Union([]wavesettings.Wave{{
		Addresses: []string{"10.64.0.1/32"},
		Routes:    []string{"10.64.128.0/17"},
	}})
	if !contains(settings.Addresses, "10.64.0.1/16") {
		t.Fatalf("got %v", settings.Addresses)
	}
}

func TestJunkIsLeftAsItIs(t *testing.T) {
	settings := wavesettings.Union([]wavesettings.Wave{{
		Addresses: []string{"not-an-address", "10.64.0.1/32"},
		Routes:    []string{"10.64.0.2/32"},
	}})
	if !contains(settings.Addresses, "not-an-address") {
		t.Fatalf("an unreadable address must survive rather than vanish: %v", settings.Addresses)
	}
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

// Every route says which of our addresses to leave from. On one interface with
// two waves that is the only thing that distinguishes them before the packet
// reaches WireGuard -- and a packet with the wrong source is dropped by the
// peer, silently and in one direction.
func TestEveryRouteCarriesItsOwnWavesSource(t *testing.T) {
	settings := wavesettings.Union([]wavesettings.Wave{
		{Addresses: []string{"10.64.0.1/32", "fd7a:1::1/128"}, Routes: []string{"10.64.0.2/32", "fd7a:1::2/128"}},
		{Addresses: []string{"10.96.0.1/32", "fd7b:2::1/128"}, Routes: []string{"10.96.0.2/32", "fd7b:2::2/128"}},
	})

	want := map[string]string{
		"10.64.0.2/32":  "10.64.0.1",
		"fd7a:1::2/128": "fd7a:1::1",
		"10.96.0.2/32":  "10.96.0.1",
		"fd7b:2::2/128": "fd7b:2::1",
	}
	if len(settings.Routes) != len(want) {
		t.Fatalf("routes %+v", settings.Routes)
	}
	for _, route := range settings.Routes {
		if want[route.CIDR] != route.Source {
			t.Errorf("%s leaves from %q, want %q", route.CIDR, route.Source, want[route.CIDR])
		}
	}
}

// A wave with only one family has nothing to choose between for the other, and
// must not borrow an address from somewhere else.
func TestARouteWithNoAddressOfItsFamilyHasNoSource(t *testing.T) {
	settings := wavesettings.Union([]wavesettings.Wave{{
		Addresses: []string{"10.64.0.1/32"},
		Routes:    []string{"10.64.0.2/32", "fd7a:1::2/128"},
	}})
	for _, route := range settings.Routes {
		if route.CIDR == "fd7a:1::2/128" && route.Source != "" {
			t.Fatalf("a v6 route borrowed %q", route.Source)
		}
	}
}
