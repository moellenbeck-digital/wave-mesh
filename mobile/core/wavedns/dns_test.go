package wavedns_test

import (
	"bytes"
	"encoding/base64"
	"testing"

	"github.com/moellenbeck-digital/wave-mesh/mobile/core/internal/fixture"
	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavedns"
)

func queryFor(name string, recordType int) []byte {
	// Built by hand rather than by the encoder under test, so a bug in one
	// cannot hide a bug in the other.
	packet := []byte{0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0}
	for _, label := range splitName(name) {
		packet = append(packet, byte(len(label)))
		packet = append(packet, label...)
	}
	packet = append(packet, 0, byte(recordType>>8), byte(recordType), 0, 1)
	return packet
}

func splitName(name string) []string {
	var labels []string
	start := 0
	for i := 0; i <= len(name); i++ {
		if i == len(name) || name[i] == '.' {
			if i > start {
				labels = append(labels, name[start:i])
			}
			start = i + 1
		}
	}
	return labels
}

func twoWaves() wavedns.Config {
	return wavedns.Config{Zones: []wavedns.Zone{
		{
			ControlURL: "https://a.example",
			Suffix:     "rl.wave.example.com",
			Records: []wavedns.Record{
				{Name: "laptop.rl.wave.example.com", IPv4: "10.77.0.2", IPv6: "fd7a:1::2"},
			},
			Reverse: []string{"77.10.in-addr.arpa"},
			Routes:  []wavedns.Route{{Suffix: "corp.rl.wave.example.com", Nameservers: []string{"10.77.0.9"}}},
		},
		{
			ControlURL: "https://b.example",
			Suffix:     "work.wave.example.com",
			Records: []wavedns.Record{
				{Name: "build.work.wave.example.com", IPv4: "10.96.0.4", IPv6: "fd7b:2::4"},
			},
			Reverse: []string{"96.10.in-addr.arpa"},
		},
	}}
}

// The whole point of one resolver with a suffix table: two waves, one socket,
// and each name answered by the wave it belongs to.
func TestEachWaveAnswersItsOwnZone(t *testing.T) {
	config := twoWaves()
	for name, want := range map[string]string{
		"laptop.rl.wave.example.com":  "10.77.0.2",
		"build.work.wave.example.com": "10.96.0.4",
	} {
		resolution := wavedns.Resolve(queryFor(name, wavedns.TypeA), config)
		if resolution.Packet == nil {
			t.Fatalf("%s was not answered", name)
		}
		if !bytes.Contains(resolution.Packet, mustIPv4(t, want)) {
			t.Fatalf("%s did not answer %s", name, want)
		}
	}
}

func mustIPv4(t *testing.T, address string) []byte {
	t.Helper()
	raw, ok := wavedns.EncodeIPv4(address)
	if !ok {
		t.Fatalf("not an address: %s", address)
	}
	return raw
}

func TestAnUnknownNameInOurZoneIsNXDomain(t *testing.T) {
	resolution := wavedns.Resolve(queryFor("nope.rl.wave.example.com", wavedns.TypeA), twoWaves())
	if resolution.Packet == nil {
		t.Fatal("a name in our zone must be answered, not dropped")
	}
	if resolution.Packet[3]&0x0f != wavedns.CodeNameError {
		t.Fatalf("rcode %d", resolution.Packet[3]&0x0f)
	}
}

// A known name without the requested type answers empty; NXDOMAIN would say the
// name does not exist at all.
func TestAKnownNameWithoutTheTypeAnswersEmpty(t *testing.T) {
	config := twoWaves()
	config.Zones[0].Records[0].IPv6 = ""
	resolution := wavedns.Resolve(queryFor("laptop.rl.wave.example.com", wavedns.TypeAAAA), config)
	if resolution.Packet == nil {
		t.Fatal("dropped")
	}
	if resolution.Packet[3]&0x0f != wavedns.CodeNoError {
		t.Fatal("an empty answer must not be NXDOMAIN")
	}
	if count := int(resolution.Packet[6])<<8 | int(resolution.Packet[7]); count != 0 {
		t.Fatalf("answers %d", count)
	}
}

func TestADelegatedSuffixIsForwarded(t *testing.T) {
	resolution := wavedns.Resolve(queryFor("db.corp.rl.wave.example.com", wavedns.TypeA), twoWaves())
	if len(resolution.Nameservers) != 1 || resolution.Nameservers[0] != "10.77.0.9" {
		t.Fatalf("got %v", resolution)
	}
}

// Without PTR, everything that looks a name up before printing -- ping, ssh,
// traceroute -- waits for a resolver that will never answer.
func TestPTRAnswersFromEitherWave(t *testing.T) {
	resolution := wavedns.Resolve(queryFor("4.0.96.10.in-addr.arpa", wavedns.TypePTR), twoWaves())
	if resolution.Packet == nil {
		t.Fatal("a PTR in our reverse zone must be answered")
	}
	if !bytes.Contains(resolution.Packet, []byte("build")) {
		t.Fatal("the answer does not name the node")
	}
}

func TestPTRForAnEmptyAddressInOurZoneIsNXDomain(t *testing.T) {
	resolution := wavedns.Resolve(queryFor("99.0.77.10.in-addr.arpa", wavedns.TypePTR), twoWaves())
	if resolution.Packet == nil || resolution.Packet[3]&0x0f != wavedns.CodeNameError {
		t.Fatalf("got %v", resolution)
	}
}

// Outside our reverse zones the question is not ours, and with matchDomains it
// should never have arrived.
func TestPTROutsideOurZonesIsDropped(t *testing.T) {
	resolution := wavedns.Resolve(queryFor("1.1.168.192.in-addr.arpa", wavedns.TypePTR), twoWaves())
	if !resolution.Drop {
		t.Fatalf("got %v", resolution)
	}
}

func TestAForeignNameIsDroppedWhereTheSystemFiltersForUs(t *testing.T) {
	if !wavedns.Resolve(queryFor("example.org", wavedns.TypeA), twoWaves()).Drop {
		t.Fatal("a name that is not ours must be dropped on iOS")
	}
}

// Android sends us everything, so dropping would break every other name on the
// phone. There the resolver has to pass the rest on.
func TestAForeignNameIsForwardedWhereWeAreTheSystemResolver(t *testing.T) {
	config := twoWaves()
	config.SystemWide = true
	config.Upstreams = []string{"1.1.1.1"}
	resolution := wavedns.Resolve(queryFor("example.org", wavedns.TypeA), config)
	if len(resolution.Nameservers) != 1 || resolution.Nameservers[0] != "1.1.1.1" {
		t.Fatalf("got %v", resolution)
	}
}

func TestJunkIsDropped(t *testing.T) {
	if !wavedns.Resolve([]byte{1, 2, 3}, twoWaves()).Drop {
		t.Fatal("a malformed packet must not be answered")
	}
}

// The bytes have to be the ones the desktop resolver already produces: the same
// question, answered by two implementations, must look the same on the wire.
func TestResponseBytesMatchTypeScript(t *testing.T) {
	contract := fixture.Load(t)
	query := wavedns.Query{
		ID:               contract.DNS.Query.ID,
		RecursionDesired: contract.DNS.Query.RecursionDesired,
		Question: wavedns.Question{
			Name:  contract.DNS.Query.Question.Name,
			Type:  contract.DNS.Query.Question.Type,
			Class: contract.DNS.Query.Question.Class,
		},
	}
	cases := []struct {
		name    string
		got     []byte
		encoded string
	}{
		{"A", wavedns.EncodeResponse(query, []wavedns.Answer{{
			Name: query.Question.Name, Type: wavedns.TypeA, TTL: 60, Address: "10.77.0.2",
		}}, wavedns.CodeNoError), contract.DNS.A},
		{"NXDOMAIN", wavedns.EncodeResponse(query, nil, wavedns.CodeNameError), contract.DNS.NXDomain},
		{"empty", wavedns.EncodeResponse(query, nil, wavedns.CodeNoError), contract.DNS.Empty},
	}
	for _, testCase := range cases {
		want, err := base64.StdEncoding.DecodeString(testCase.encoded)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(testCase.got, want) {
			t.Errorf("%s:\n got %x\nwant %x", testCase.name, testCase.got, want)
		}
	}
}

func TestReverseZonesFor(t *testing.T) {
	zones := wavedns.ReverseZonesFor([]string{"10.77.0.2/32", "fd7a:8b47:c285::2/128"})
	want := map[string]bool{
		"77.10.in-addr.arpa":               false,
		"5.8.2.c.7.4.b.8.a.7.d.f.ip6.arpa": false,
	}
	for _, zone := range zones {
		if _, known := want[zone]; !known {
			t.Fatalf("unexpected zone %s", zone)
		}
		want[zone] = true
	}
	for zone, found := range want {
		if !found {
			t.Fatalf("missing zone %s (got %v)", zone, zones)
		}
	}
}

func TestDecodeQueryRefusesAResponse(t *testing.T) {
	packet := queryFor("laptop.rl.wave.example.com", wavedns.TypeA)
	packet[2] |= 0x80
	if _, ok := wavedns.DecodeQuery(packet); ok {
		t.Fatal("a response must not parse as a query")
	}
}
