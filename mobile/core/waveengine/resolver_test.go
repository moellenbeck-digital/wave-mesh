package waveengine

import (
	"fmt"
	"strings"
	"testing"

	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavedns"
)

func dnsQuery(name string, recordType int) []byte {
	packet := []byte{0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0}
	for _, label := range strings.Split(name, ".") {
		packet = append(packet, byte(len(label)))
		packet = append(packet, label...)
	}
	return append(packet, 0, byte(recordType>>8), byte(recordType), 0, 1)
}

func loggingResolver() (*resolver, *[]string) {
	var lines []string
	r := newResolver(nil)
	r.log = func(line string) { lines = append(lines, line) }
	r.update(wavedns.Config{Zones: []wavedns.Zone{{
		ControlURL: "https://a.example",
		Suffix:     "ops.example.com",
		Records: []wavedns.Record{
			{Name: "laptop.ops.example.com", IPv4: "10.160.0.20"},
			{Name: "grafana.ops.example.com", IPv4: "10.160.0.3"},
		},
		Reverse:  []string{"160.10.in-addr.arpa"},
		Services: 1,
	}}})
	return r, &lines
}

// A name the netmap does not have is said once, with the wave it was asked
// of and what that wave holds -- the line that tells "the server never sent
// it" apart from "the question never arrived".
func TestAMissingNameIsLoggedOnceWithItsWave(t *testing.T) {
	r, lines := loggingResolver()
	r.Answer(dnsQuery("argocd.ops.example.com", wavedns.TypeA))
	r.Answer(dnsQuery("argocd.ops.example.com", wavedns.TypeAAAA))
	if len(*lines) != 1 {
		t.Fatalf("lines %q", *lines)
	}
	want := "dns: argocd.ops.example.com is not in the netmap of ops.example.com (2 names there, 1 of them services)"
	if (*lines)[0] != want {
		t.Fatalf("got %q", (*lines)[0])
	}
}

func TestAKnownNameAndAReverseLookupAreNotLogged(t *testing.T) {
	r, lines := loggingResolver()
	r.Answer(dnsQuery("grafana.ops.example.com", wavedns.TypeA))
	r.Answer(dnsQuery("99.0.160.10.in-addr.arpa", wavedns.TypePTR))
	if len(*lines) != 0 {
		t.Fatalf("lines %q", *lines)
	}
}

// An app retrying in a loop must not fill the log, which is trimmed and would
// lose everything else in it.
func TestTheLogTakesAFewLinesAMinuteAtMost(t *testing.T) {
	r, lines := loggingResolver()
	for i := 0; i < 50; i++ {
		r.Answer(dnsQuery(fmt.Sprintf("missing%d.ops.example.com", i), wavedns.TypeA))
	}
	if len(*lines) != notesPerMinute {
		t.Fatalf("%d lines", len(*lines))
	}
}
