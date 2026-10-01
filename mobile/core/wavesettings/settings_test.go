package wavesettings_test

import (
	"testing"

	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavesettings"
)

func twoWaves() []wavesettings.Wave {
	return []wavesettings.Wave{
		{
			Addresses:       []string{"10.77.0.2/32", "fd7a:1::2/128"},
			Routes:          []string{"10.77.0.0/16"},
			Suffix:          "rl.wave.example.com",
			ReverseZones:    []string{"77.10.in-addr.arpa"},
			ResolverAddress: "10.77.0.2",
		},
		{
			Addresses:       []string{"10.96.0.5/32"},
			Routes:          []string{"10.96.0.0/16"},
			Suffix:          "work.wave.example.com",
			ReverseZones:    []string{"96.10.in-addr.arpa"},
			ResolverAddress: "10.96.0.5",
			MTU:             1200,
		},
	}
}

func TestUnionAddsUpAndTakesTheSmallestMTU(t *testing.T) {
	settings := wavesettings.Union(twoWaves())
	if len(settings.Addresses) != 3 {
		t.Fatalf("addresses %v", settings.Addresses)
	}
	if len(settings.Routes) != 2 {
		t.Fatalf("routes %v", settings.Routes)
	}
	// One interface cannot have two MTUs, and the smaller is the one that gets
	// through both paths.
	if settings.MTU != 1200 {
		t.Fatalf("mtu %d", settings.MTU)
	}
	if len(settings.DNSServers) != 2 {
		t.Fatalf("dns servers %v", settings.DNSServers)
	}
}

func TestDefaultMTUWhenNobodyAsks(t *testing.T) {
	settings := wavesettings.Union([]wavesettings.Wave{{Addresses: []string{"10.77.0.2/32"}}})
	if settings.MTU != wavesettings.DefaultMTU {
		t.Fatalf("mtu %d", settings.MTU)
	}
}

func TestEmptyStaysUsable(t *testing.T) {
	settings := wavesettings.Union(nil)
	if settings.MTU != wavesettings.DefaultMTU || len(settings.Addresses) != 0 {
		t.Fatalf("got %+v", settings)
	}
}

// The reverse zones have to be routed to us as well, or a name lookup for an
// address goes upstream and waits.
func TestReverseZonesAreMatched(t *testing.T) {
	settings := wavesettings.Union(twoWaves())
	found := 0
	for _, domain := range settings.MatchDomains {
		if domain == "77.10.in-addr.arpa" || domain == "96.10.in-addr.arpa" {
			found++
		}
	}
	if found != 2 {
		t.Fatalf("match domains %v", settings.MatchDomains)
	}
}

// Applying interrupts the tunnel, so the same input must compare equal however
// the netmaps happened to be ordered.
func TestOrderDoesNotCountAsAChange(t *testing.T) {
	first := wavesettings.Union(twoWaves())
	shuffled := twoWaves()
	shuffled[0].Addresses = []string{"fd7a:1::2/128", "10.77.0.2/32"}
	if !first.Equal(wavesettings.Union(shuffled)) {
		t.Fatal("a reordered netmap must not look like a change")
	}
}

func TestARealChangeIsNoticed(t *testing.T) {
	first := wavesettings.Union(twoWaves())
	changed := twoWaves()
	changed[1].Routes = append(changed[1].Routes, "10.98.0.0/16")
	if first.Equal(wavesettings.Union(changed)) {
		t.Fatal("a new route has to be applied")
	}
}

// The search domains are the one ordered list: the first wave answers a bare
// name first, and which wave that is has to stay predictable.
func TestSearchDomainsKeepWaveOrder(t *testing.T) {
	settings := wavesettings.Union(twoWaves())
	if len(settings.SearchDomains) != 2 || settings.SearchDomains[0] != "rl.wave.example.com" {
		t.Fatalf("search domains %v", settings.SearchDomains)
	}
}

func TestADuplicateRouteIsNotTwoRoutes(t *testing.T) {
	waves := twoWaves()
	waves[1].Routes = []string{"10.77.0.0/16"}
	settings := wavesettings.Union(waves)
	if len(settings.Routes) != 1 {
		t.Fatalf("routes %v", settings.Routes)
	}
}
