package wavetun_test

import (
	"net/netip"
	"testing"
	"time"

	"github.com/pinguin45orga/wave-mesh/mobile/core/wavetun"
)

// The port half of a wave's policy on a phone (M7, stage two). The same three
// cases as the nftables chain on the desktop: a rule names it, it answers a
// flow this device opened, or it is ICMP.

const (
	laptop = "10.64.0.1"
	phone  = "10.64.0.9"
	other  = "10.64.0.7"
)

var samba = wavetun.FilterRule{
	Src:   []netip.Prefix{netip.MustParsePrefix(laptop + "/32")},
	Dst:   []netip.Prefix{netip.MustParsePrefix(phone + "/32")},
	Ports: []wavetun.PortRange{{Proto: 6, From: 445, To: 445}, {From: 5000, To: 5001}},
}

func tcp(source, destination string, sourcePort, destinationPort int) []byte {
	// The first four bytes of a TCP header are the ports, laid out as UDP's.
	header := make([]byte, 20)
	copy(header, udpBody(sourcePort, destinationPort, nil)[:4])
	header[12] = 5 << 4 // data offset: twenty bytes
	return ipv4Packet(source, destination, 6, header)
}

func udp(source, destination string, sourcePort, destinationPort int) []byte {
	return ipv4Packet(source, destination, 17, udpBody(sourcePort, destinationPort, nil))
}

func TestARuleLetsInWhatItNamesAndNothingElse(t *testing.T) {
	filter := wavetun.NewFilter([]wavetun.FilterRule{samba}, nil)
	cases := []struct {
		name   string
		packet []byte
		want   bool
	}{
		{"named port", tcp(laptop, phone, 50000, 445), true},
		{"a range for both protocols, as udp", udp(laptop, phone, 50000, 5001), true},
		{"tcp:445 does not open udp", udp(laptop, phone, 50000, 445), false},
		{"another port", tcp(laptop, phone, 50000, 22), false},
		{"another source", tcp(other, phone, 50000, 445), false},
		{"icmp always", ipv4Packet(other, phone, 1, []byte{8, 0, 0, 0}), true},
		{"another protocol", ipv4Packet(laptop, phone, 47, make([]byte, 8)), false},
		{"a header cut short", ipv4Packet(laptop, phone, 6, []byte{0xc3}), false},
	}
	for _, c := range cases {
		if got := filter.Allow(c.packet); got != c.want {
			t.Errorf("%s: allowed %v, want %v", c.name, got, c.want)
		}
	}
}

// A grant from A to B puts each in the other's netmap; without this B could
// open connections to A as well.
func TestOnlyTheGrantedDirectionMayStartAConnection(t *testing.T) {
	filter := wavetun.NewFilter(nil, nil)
	if filter.Allow(tcp(laptop, phone, 445, 50000)) {
		t.Fatal("an unsolicited packet came in under an empty policy")
	}
	filter.Outbound(tcp(phone, laptop, 50000, 445))
	if !filter.Allow(tcp(laptop, phone, 445, 50000)) {
		t.Fatal("the reply to our own connection was dropped")
	}
	if filter.Allow(tcp(laptop, phone, 445, 50001)) {
		t.Fatal("a reply to a connection we never opened came in")
	}
}

func TestARepliesPathExpires(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	filter := wavetun.NewFilter(nil, func() time.Time { return now })
	filter.Outbound(udp(phone, laptop, 50000, 53))
	now = now.Add(6 * time.Minute)
	if filter.Allow(udp(laptop, phone, 53, 50000)) {
		t.Fatal("a reply came in on a flow that had long gone quiet")
	}
}

func TestTheMultiplexerFiltersOnlyTheWaveWithAPolicy(t *testing.T) {
	link := newMemoryLink()
	mux := wavetun.New(link, 1280, nil)
	guarded := mux.DeviceFor("guarded")
	open := mux.DeviceFor("open")
	mux.SetFilter("guarded", wavetun.NewFilter([]wavetun.FilterRule{samba}, nil))

	blocked := tcp(laptop, phone, 50000, 22)
	for _, device := range []*wavetun.Virtual{guarded, open} {
		// Counted as written either way: to WireGuard the packet was delivered.
		if n, err := device.Write([][]byte{blocked}, 0); err != nil || n != 1 {
			t.Fatalf("write answered %d, %v", n, err)
		}
	}
	if sent := link.sent(); len(sent) != 1 {
		t.Fatalf("%d packet(s) reached the link, want only the open wave's", len(sent))
	}

	// Taking the policy away lets everything in again.
	mux.SetFilter("guarded", nil)
	if _, err := guarded.Write([][]byte{blocked}, 0); err != nil {
		t.Fatal(err)
	}
	if sent := link.sent(); len(sent) != 2 {
		t.Fatalf("%d packet(s) reached the link after the policy was removed", len(sent))
	}
}
