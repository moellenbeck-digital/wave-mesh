package wavedisco_test

import (
	"bytes"
	"encoding/base64"
	"testing"

	"github.com/pinguin45orga/wave-mesh/mobile/core/internal/fixture"
	"github.com/pinguin45orga/wave-mesh/mobile/core/wavedisco"
	"github.com/pinguin45orga/wave-mesh/mobile/core/waveproto"
)

func TestSharedKeyMatchesTypeScript(t *testing.T) {
	contract := fixture.Load(t)
	// Derived from the other half of the pair than the fixture used: the point
	// of a Diffie-Hellman is that both sides arrive at the same bytes.
	key, err := wavedisco.SharedKey(contract.Keys.DiscoB.PrivateKey, contract.Keys.DiscoA.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	want, err := base64.StdEncoding.DecodeString(contract.Disco.SharedKey)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(key, want) {
		t.Fatalf("shared key differs from the TypeScript one")
	}
}

func TestOpensAPingSealedByTypeScript(t *testing.T) {
	contract := fixture.Load(t)
	key, err := wavedisco.SharedKey(contract.Keys.DiscoB.PrivateKey, contract.Keys.DiscoA.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	packet, err := base64.StdEncoding.DecodeString(contract.Disco.SealedPing)
	if err != nil {
		t.Fatal(err)
	}
	decoded, ok := wavedisco.Decode(packet, func(sender string) []byte {
		if sender != contract.Keys.DiscoA.PublicKey {
			return nil
		}
		return key
	})
	if !ok {
		t.Fatal("a packet sealed by the TypeScript side did not open")
	}
	if decoded.Message.Type != wavedisco.TypePing {
		t.Fatalf("type %d", decoded.Message.Type)
	}
	if decoded.Message.Txid != [8]byte{1, 2, 3, 4, 5, 6, 7, 8} {
		t.Fatalf("txid %v", decoded.Message.Txid)
	}
}

func TestOpensACallMeMaybeWithBothAddressFamilies(t *testing.T) {
	contract := fixture.Load(t)
	key, err := wavedisco.SharedKey(contract.Keys.DiscoB.PrivateKey, contract.Keys.DiscoA.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	packet, err := base64.StdEncoding.DecodeString(contract.Disco.SealedCallMeMaybe)
	if err != nil {
		t.Fatal(err)
	}
	decoded, ok := wavedisco.Decode(packet, func(string) []byte { return key })
	if !ok {
		t.Fatal("did not open")
	}
	want := []waveproto.Endpoint{{IP: "203.0.113.7", Port: 41641}, {IP: "fd7a:1::2", Port: 1024}}
	if len(decoded.Message.Endpoints) != len(want) {
		t.Fatalf("got %v", decoded.Message.Endpoints)
	}
	for i, endpoint := range want {
		if decoded.Message.Endpoints[i] != endpoint {
			t.Fatalf("endpoint %d: got %v, want %v", i, decoded.Message.Endpoints[i], endpoint)
		}
	}
}

func TestRoundTripsEveryMessage(t *testing.T) {
	contract := fixture.Load(t)
	send, err := wavedisco.SharedKey(contract.Keys.DiscoA.PrivateKey, contract.Keys.DiscoB.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	receive, err := wavedisco.SharedKey(contract.Keys.DiscoB.PrivateKey, contract.Keys.DiscoA.PublicKey)
	if err != nil {
		t.Fatal(err)
	}

	messages := []wavedisco.Message{
		{Type: wavedisco.TypePing, Txid: wavedisco.NewTxid()},
		{Type: wavedisco.TypePong, Txid: wavedisco.NewTxid(), Observed: waveproto.Endpoint{IP: "203.0.113.9", Port: 7}},
		{Type: wavedisco.TypeCallMeMaybe, Endpoints: []waveproto.Endpoint{{IP: "192.168.1.5", Port: 41641}}},
	}
	for _, message := range messages {
		packet, err := wavedisco.Encode(contract.Keys.DiscoA.PublicKey, send, message)
		if err != nil {
			t.Fatal(err)
		}
		decoded, ok := wavedisco.Decode(packet, func(string) []byte { return receive })
		if !ok {
			t.Fatalf("type %d did not round-trip", message.Type)
		}
		if decoded.SenderDiscoKey != contract.Keys.DiscoA.PublicKey {
			t.Fatalf("sender %s", decoded.SenderDiscoKey)
		}
		if decoded.Message.Type != message.Type {
			t.Fatalf("type %d became %d", message.Type, decoded.Message.Type)
		}
	}
}

func TestNeverClaimsAWireGuardPacket(t *testing.T) {
	// WireGuard's own message types occupy the first byte with 1..4.
	for _, messageType := range []byte{1, 2, 3, 4} {
		packet := make([]byte, 148)
		packet[0] = messageType
		if wavedisco.LooksLikeDisco(packet) {
			t.Fatalf("type %d was taken for disco", messageType)
		}
	}
}

func TestAForgedPacketIsJustNoise(t *testing.T) {
	contract := fixture.Load(t)
	key, err := wavedisco.SharedKey(contract.Keys.DiscoA.PrivateKey, contract.Keys.DiscoB.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	packet, err := wavedisco.Encode(contract.Keys.DiscoA.PublicKey, key, wavedisco.Message{
		Type: wavedisco.TypePing, Txid: wavedisco.NewTxid(),
	})
	if err != nil {
		t.Fatal(err)
	}
	packet[len(packet)-1] ^= 0xff
	other, err := wavedisco.SharedKey(contract.Keys.DiscoB.PrivateKey, contract.Keys.DiscoA.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := wavedisco.Decode(packet, func(string) []byte { return other }); ok {
		t.Fatal("a tampered packet must not open")
	}
}

func TestAnUnknownSenderIsNotForUs(t *testing.T) {
	contract := fixture.Load(t)
	packet, err := base64.StdEncoding.DecodeString(contract.Disco.SealedPing)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := wavedisco.Decode(packet, func(string) []byte { return nil }); ok {
		t.Fatal("a peer we do not know must not decode")
	}
}
