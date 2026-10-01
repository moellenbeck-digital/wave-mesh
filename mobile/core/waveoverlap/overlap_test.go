package waveoverlap_test

import (
	"strings"
	"testing"

	"github.com/pinguin45orga/wave-mesh/mobile/core/waveoverlap"
)

func TestDisjointWavesDoNotConflict(t *testing.T) {
	held := []waveoverlap.Claim{{ControlURL: "https://a.example", CIDRs: []string{"10.64.0.0/16"}}}
	wanted := waveoverlap.Claim{ControlURL: "https://b.example", CIDRs: []string{"10.96.0.0/16"}}
	if conflict := waveoverlap.Find(wanted, held); conflict != nil {
		t.Fatalf("unexpected conflict: %v", conflict)
	}
}

func TestOverlappingRangesAreNamedBoth(t *testing.T) {
	held := []waveoverlap.Claim{{ControlURL: "https://a.example", CIDRs: []string{"10.64.0.0/16"}}}
	wanted := waveoverlap.Claim{ControlURL: "https://b.example", CIDRs: []string{"10.64.5.2/32"}}
	conflict := waveoverlap.Find(wanted, held)
	if conflict == nil {
		t.Fatal("an address inside a held range must conflict")
	}
	message := conflict.Describe("https://b.example")
	if !strings.Contains(message, "https://a.example") || !strings.Contains(message, "10.64.5.2/32") {
		t.Fatalf("the message names neither side: %s", message)
	}
}

// v4 and v6 must never compare equal: the same number in two families is two
// different addresses.
func TestTheTwoFamiliesNeverCollide(t *testing.T) {
	held := []waveoverlap.Claim{{ControlURL: "https://a.example", CIDRs: []string{"fd7a:1::/48"}}}
	wanted := waveoverlap.Claim{ControlURL: "https://b.example", CIDRs: []string{"10.64.0.1/32"}}
	if conflict := waveoverlap.Find(wanted, held); conflict != nil {
		t.Fatalf("unexpected conflict: %v", conflict)
	}
}

// The reason keys are checked at all on a phone: one socket, and a disco packet
// carries its sender's key in the clear.
func TestASharedDiscoKeyIsRefused(t *testing.T) {
	held := []waveoverlap.Claim{{
		ControlURL: "https://a.example",
		CIDRs:      []string{"10.64.0.0/16"},
		DiscoKeys:  []string{"IHKREk4M8oQYBiFwBGJmDmPPd8xQ29HHxUQKfmZWvgQ="},
	}}
	wanted := waveoverlap.Claim{
		ControlURL: "https://b.example",
		CIDRs:      []string{"10.96.0.0/16"},
		DiscoKeys:  []string{"IHKREk4M8oQYBiFwBGJmDmPPd8xQ29HHxUQKfmZWvgQ="},
	}
	conflict := waveoverlap.Find(wanted, held)
	if conflict == nil {
		t.Fatal("two waves must not share a disco key")
	}
	if conflict.Kind != "disco key" {
		t.Fatalf("kind %q", conflict.Kind)
	}
	if !strings.Contains(conflict.Describe("https://b.example"), "https://a.example") {
		t.Fatal("the message must name the wave that keeps running")
	}
}

func TestASharedNodeKeyIsRefused(t *testing.T) {
	key := "jNjBjFZhoUZ0O6Ux8T1rGr3z1zZ6PzkT2GkTqRP4pXM="
	held := []waveoverlap.Claim{{ControlURL: "https://a.example", NodeKeys: []string{key}}}
	wanted := waveoverlap.Claim{ControlURL: "https://b.example", NodeKeys: []string{key}}
	conflict := waveoverlap.Find(wanted, held)
	if conflict == nil || conflict.Kind != "node key" {
		t.Fatalf("got %v", conflict)
	}
}

// A wave being re-applied holds its own addresses and keys; it must not be
// refused for colliding with itself.
func TestAWaveDoesNotConflictWithItself(t *testing.T) {
	claim := waveoverlap.Claim{
		ControlURL: "https://a.example",
		CIDRs:      []string{"10.64.0.0/16"},
		DiscoKeys:  []string{"IHKREk4M8oQYBiFwBGJmDmPPd8xQ29HHxUQKfmZWvgQ="},
	}
	if conflict := waveoverlap.Find(claim, []waveoverlap.Claim{claim}); conflict != nil {
		t.Fatalf("unexpected conflict: %v", conflict)
	}
}

// A range this version cannot read is not a licence to refuse a wave that works.
func TestUnreadableRangesClaimNothing(t *testing.T) {
	held := []waveoverlap.Claim{{ControlURL: "https://a.example", CIDRs: []string{"not-an-address"}}}
	wanted := waveoverlap.Claim{ControlURL: "https://b.example", CIDRs: []string{"10.64.0.1/32", "also-junk"}}
	if conflict := waveoverlap.Find(wanted, held); conflict != nil {
		t.Fatalf("unexpected conflict: %v", conflict)
	}
}
