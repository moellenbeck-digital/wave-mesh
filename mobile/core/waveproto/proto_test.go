package waveproto_test

import (
	"encoding/json"
	"testing"

	"github.com/moellenbeck-digital/wave-mesh/mobile/core/internal/fixture"
	"github.com/moellenbeck-digital/wave-mesh/mobile/core/waveproto"
)

func signedFromFixture(t *testing.T) (waveproto.SignedNetmap, string) {
	t.Helper()
	contract := fixture.Load(t)
	return waveproto.SignedNetmap{
		Netmap:    contract.Netmap.Document,
		Signature: contract.Netmap.Signature,
		KeyID:     contract.Netmap.SigningPublicKey,
	}, contract.Netmap.SigningPublicKey
}

func TestVerifyReadsANetmapSignedElsewhere(t *testing.T) {
	signed, pinned := signedFromFixture(t)
	netmap, err := signed.Verify(pinned)
	if err != nil {
		t.Fatal(err)
	}
	if netmap.Version != 7 || netmap.Self.Hostname != "phone" {
		t.Fatalf("read the wrong document: %+v", netmap.Self)
	}
	if netmap.DNS.Suffix != "wave.example.com" {
		t.Fatalf("dns suffix: %q", netmap.DNS.Suffix)
	}
}

// A field this version has never heard of must not disturb verification --
// the failure that made every schema below Netmap a looseObject.
func TestVerifySurvivesAnUnknownField(t *testing.T) {
	signed, pinned := signedFromFixture(t)
	var document map[string]any
	if err := json.Unmarshal(signed.Netmap, &document); err != nil {
		t.Fatal(err)
	}
	if _, ok := document["futureField"]; !ok {
		t.Fatal("the fixture is supposed to carry a field no schema knows")
	}
	if _, err := signed.Verify(pinned); err != nil {
		t.Fatalf("an unknown field broke verification: %v", err)
	}
}

func TestVerifyRefusesAnotherSigner(t *testing.T) {
	signed, _ := signedFromFixture(t)
	other := fixture.Load(t).Keys.Machine.PublicKey
	if _, err := signed.Verify(other); err == nil {
		t.Fatal("a netmap from a different key must be refused")
	}
}

func TestEndpointFormatting(t *testing.T) {
	if got := (waveproto.Endpoint{IP: "203.0.113.7", Port: 41641}).String(); got != "203.0.113.7:41641" {
		t.Fatalf("got %q", got)
	}
	if got := (waveproto.Endpoint{IP: "fd7a:1::2", Port: 41641}).String(); got != "[fd7a:1::2]:41641" {
		t.Fatalf("got %q", got)
	}
}
