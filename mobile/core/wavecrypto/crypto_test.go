package wavecrypto_test

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"

	"github.com/pinguin45orga/wave-mesh/mobile/core/internal/fixture"
	"github.com/pinguin45orga/wave-mesh/mobile/core/wavecrypto"
)

func TestCanonicalJSONMatchesTypeScript(t *testing.T) {
	for i, want := range fixture.Load(t).Canonical {
		got, err := wavecrypto.CanonicalJSON(want.Value)
		if err != nil {
			t.Fatalf("case %d: %v", i, err)
		}
		if string(got) != want.Encoded {
			t.Errorf("case %d:\n got %s\nwant %s", i, got, want.Encoded)
		}
	}
}

// The property the whole netmap signature rests on: a field this side has never
// heard of still has to come out where the signer put it.
func TestCanonicalJSONKeepsUnknownFields(t *testing.T) {
	contract := fixture.Load(t)
	canonical, err := wavecrypto.CanonicalJSON(contract.Netmap.Document)
	if err != nil {
		t.Fatal(err)
	}
	if !wavecrypto.Verify(contract.Netmap.SigningPublicKey, canonical, contract.Netmap.Signature) {
		t.Fatal("a netmap signed by the TypeScript side does not verify here")
	}
}

func TestVerifyRejectsATamperedDocument(t *testing.T) {
	contract := fixture.Load(t)
	tampered := append([]byte{}, contract.Netmap.Document...)
	tampered = append(tampered[:len(tampered)-1], []byte(`,"extra":1}`)...)
	canonical, err := wavecrypto.CanonicalJSON(tampered)
	if err != nil {
		t.Fatal(err)
	}
	if wavecrypto.Verify(contract.Netmap.SigningPublicKey, canonical, contract.Netmap.Signature) {
		t.Fatal("an added field must break the signature")
	}
}

func TestSignatureMessageAndSignatureMatchTypeScript(t *testing.T) {
	contract := fixture.Load(t)
	message := wavecrypto.SignatureMessage(
		"POST", "/v1/machine/register", 1_790_000_000, "Zm9vYmFyYmF6cXV4",
		wavecrypto.BodyHash(""),
	)
	if message != contract.HTTPSig.Message {
		t.Fatalf("signature message differs:\n got %q\nwant %q", message, contract.HTTPSig.Message)
	}
	signature, err := wavecrypto.Sign(contract.Keys.Machine.PrivateKey, []byte(message))
	if err != nil {
		t.Fatal(err)
	}
	// Ed25519 is deterministic, so the signature itself can be pinned.
	if signature != contract.HTTPSig.Signature {
		t.Fatalf("signature differs:\n got %s\nwant %s", signature, contract.HTTPSig.Signature)
	}
}

func TestBodyHashOfTheEmptyBody(t *testing.T) {
	const sha256OfNothing = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	if got := wavecrypto.BodyHash(""); got != sha256OfNothing {
		t.Fatalf("got %s", got)
	}
}

func TestAuthorizationHeaderIsParseableByTheServer(t *testing.T) {
	contract := fixture.Load(t)
	header, err := wavecrypto.BuildAuthorizationHeader(
		contract.Keys.Machine.PublicKey, contract.Keys.Machine.PrivateKey,
		"GET", "/v1/netmap", "", time.Unix(1_790_000_000, 0),
	)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(header, "WaveSig k="+contract.Keys.Machine.PublicKey+",t=1790000000,n=") {
		t.Fatalf("header is not in the shape the server parses: %q", header)
	}
}

func TestPublicKeyDerivationMatchesTypeScript(t *testing.T) {
	contract := fixture.Load(t)
	got, err := wavecrypto.PublicFromPrivateX25519(contract.Keys.DiscoA.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	if got != contract.Derived.DiscoAPublicFromPrivate {
		t.Fatalf("got %s, want %s", got, contract.Derived.DiscoAPublicFromPrivate)
	}
}

func TestDecodeKeyRefusesTheWrongLength(t *testing.T) {
	short := base64.StdEncoding.EncodeToString(make([]byte, 31))
	if _, err := wavecrypto.DecodeKey(short); err == nil {
		t.Fatal("a 31-byte key must be refused")
	}
	if wavecrypto.IsValidKey("not base64 at all") {
		t.Fatal("junk must not pass as a key")
	}
}
