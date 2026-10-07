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
			ResolverAddress: "10.77.0.53",
		},
		{
			Addresses:       []string{"10.96.0.5/32"},
			Routes:          []string{"10.96.0.0/16"},
			Suffix:          "work.wave.example.com",
			ReverseZones:    []string{"96.10.in-addr.arpa"},
			ResolverAddress: "10.96.0.53",
			MTU:             1200,
		},
	}
}

func TestUnionAddsUpAndTakesTheSmallestMTU(t *testing.T) {
	settings := wavesettings.Union(twoWaves())
	if len(settings.Addresses) != 3 {
		t.Fatalf("addresses %v", settings.Addresses)
	}
	// Each wave's block, and each reserved resolver routed on its own.
	if len(settings.Routes) != 4 {
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
	count := 0
	for _, route := range settings.Routes {
		if route.CIDR == "10.77.0.0/16" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("routes %v", settings.Routes)
	}
}

// A DNS server with no domains to answer for would become the phone's resolver
// for every name. A wave without names gets no resolver at all.
func TestAResolverWithoutNamesIsNotOffered(t *testing.T) {
	settings := wavesettings.Union([]wavesettings.Wave{{
		Addresses:       []string{"10.77.0.2/32"},
		Routes:          []string{"10.77.0.0/16"},
		ResolverAddress: "10.77.0.53",
	}})
	if len(settings.DNSServers) != 0 || len(settings.MatchDomains) != 0 {
		t.Fatalf("servers %v for domains %v", settings.DNSServers, settings.MatchDomains)
	}
}

// A wave whose server reserved no resolver falls back to an address the phone
// itself holds. A query to that never reaches the tunnel -- the kernel delivers
// it locally -- so offering it beside a reserved one sends some lookups into
// nothing: on a phone in two waves, the second's names stopped resolving. The
// one resolver answers every zone on any of its addresses, so the reserved one
// carries both.
func TestAResolverThePhoneHoldsIsNotOffered(t *testing.T) {
	waves := twoWaves()
	waves[1].ResolverAddress = "10.96.0.5"
	settings := wavesettings.Union(waves)
	if len(settings.DNSServers) != 1 || settings.DNSServers[0] != "10.77.0.53" {
		t.Fatalf("dns servers %v", settings.DNSServers)
	}
	for _, zone := range []string{"rl.wave.example.com", "work.wave.example.com", "96.10.in-addr.arpa"} {
		if !contains(settings.MatchDomains, zone) {
			t.Fatalf("%s is no longer sent to the resolver: %v", zone, settings.MatchDomains)
		}
	}
	for _, route := range settings.Routes {
		if route.CIDR == "10.96.0.5/32" {
			t.Fatalf("our own address is routed into the tunnel: %v", settings.Routes)
		}
	}
}

// Held by another wave counts the same: it is one interface.
func TestAResolverAnotherWaveHoldsIsNotOffered(t *testing.T) {
	waves := twoWaves()
	waves[1].ResolverAddress = "10.77.0.2"
	settings := wavesettings.Union(waves)
	if len(settings.DNSServers) != 1 || settings.DNSServers[0] != "10.77.0.53" {
		t.Fatalf("dns servers %v", settings.DNSServers)
	}
}

// With no reservation anywhere there is no address the phone can ask, and no
// DNS is better than DNS that times out: the app then sets none.
func TestOnlyHeldResolversOfferNone(t *testing.T) {
	waves := twoWaves()
	waves[0].ResolverAddress = "10.77.0.2"
	waves[1].ResolverAddress = "10.96.0.5"
	settings := wavesettings.Union(waves)
	if len(settings.DNSServers) != 0 {
		t.Fatalf("dns servers %v", settings.DNSServers)
	}
}
