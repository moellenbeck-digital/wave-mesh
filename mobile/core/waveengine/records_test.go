package waveengine

import (
	"reflect"
	"testing"

	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavedns"
	"github.com/moellenbeck-digital/wave-mesh/mobile/core/waveproto"
)

// A name put out through the pier resolves to its owner's wave address inside
// the wave -- the same answer the desktop resolver gives.
func TestResolverRecordsAnswerPierNamesWithTheOwnersAddress(t *testing.T) {
	netmap := waveproto.Netmap{
		Self:  waveproto.SelfNode{Peer: waveproto.Peer{DNSName: "phone.wave.example.com", IPv4: "10.64.0.1", IPv6: "fd7a::1"}},
		Peers: []waveproto.Peer{{DNSName: "laptop.wave.example.com", IPv4: "10.64.0.2", IPv6: "fd7a::2"}},
		Services: []waveproto.Service{
			{DNSName: "grafana.wave.example.com", IPv4: "10.64.1.1", IPv6: "fd7a::1:1"},
		},
		Piers: []waveproto.Pier{
			{Name: "app", DNSName: "app.pier.wave.example.com", NodeID: "n_2", IPv4: "10.64.0.2", IPv6: "fd7a::2", Port: 443},
		},
	}
	want := []wavedns.Record{
		{Name: "phone.wave.example.com", IPv4: "10.64.0.1", IPv6: "fd7a::1"},
		{Name: "laptop.wave.example.com", IPv4: "10.64.0.2", IPv6: "fd7a::2"},
		{Name: "grafana.wave.example.com", IPv4: "10.64.1.1", IPv6: "fd7a::1:1"},
		{Name: "app.pier.wave.example.com", IPv4: "10.64.0.2", IPv6: "fd7a::2"},
	}
	if got := resolverRecords(netmap); !reflect.DeepEqual(got, want) {
		t.Fatalf("records:\n got %+v\nwant %+v", got, want)
	}
}
