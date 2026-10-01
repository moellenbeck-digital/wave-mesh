package waverelay_test

import (
	"bytes"
	"encoding/base64"
	"testing"

	"github.com/moellenbeck-digital/wave-mesh/mobile/core/internal/fixture"
	"github.com/moellenbeck-digital/wave-mesh/mobile/core/waverelay"
)

func TestDecodesAFrameEncodedByTypeScript(t *testing.T) {
	contract := fixture.Load(t)
	frame, err := base64.StdEncoding.DecodeString(contract.Relay.Frame)
	if err != nil {
		t.Fatal(err)
	}
	key, payload, err := waverelay.DecodeFrame(frame)
	if err != nil {
		t.Fatal(err)
	}
	if key != contract.Relay.ToDiscoKey {
		t.Fatalf("key %s, want %s", key, contract.Relay.ToDiscoKey)
	}
	if !bytes.Equal(payload, []byte{9, 8, 7}) {
		t.Fatalf("payload %v", payload)
	}
}

func TestEncodesTheSameBytes(t *testing.T) {
	contract := fixture.Load(t)
	frame, err := waverelay.EncodeFrame(contract.Relay.ToDiscoKey, []byte{9, 8, 7})
	if err != nil {
		t.Fatal(err)
	}
	want, err := base64.StdEncoding.DecodeString(contract.Relay.Frame)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(frame, want) {
		t.Fatal("our frame differs from the TypeScript one")
	}
}

// A frame with nothing behind the key is not a packet; passing it on as an
// empty payload would put a zero-length datagram into WireGuard.
func TestRefusesAFrameWithNoPayload(t *testing.T) {
	if _, _, err := waverelay.DecodeFrame(make([]byte, 32)); err == nil {
		t.Fatal("a frame that is only a key must be refused")
	}
}
