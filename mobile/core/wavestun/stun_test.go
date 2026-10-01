package wavestun_test

import (
	"encoding/base64"
	"testing"

	"github.com/moellenbeck-digital/wave-mesh/mobile/core/internal/fixture"
	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavestun"
)

// The response is built by the STUN server this project runs, so the phone is
// parsing the bytes it will actually meet.
func TestParsesAResponseFromOurOwnServer(t *testing.T) {
	contract := fixture.Load(t)
	packet, err := base64.StdEncoding.DecodeString(contract.STUN.Response)
	if err != nil {
		t.Fatal(err)
	}
	txid, mapped, ok := wavestun.ParseBindingResponse(packet)
	if !ok {
		t.Fatal("did not parse")
	}
	if txid != contract.STUN.Txid {
		t.Fatalf("txid %s, want %s", txid, contract.STUN.Txid)
	}
	if mapped.IP != contract.STUN.Mapped.IP || mapped.Port != contract.STUN.Mapped.Port {
		t.Fatalf("mapped %v, want %v", mapped, contract.STUN.Mapped)
	}
}

func TestOurRequestIsRecognisableAsStun(t *testing.T) {
	packet, txid := wavestun.BuildBindingRequest()
	if !wavestun.LooksLikeStun(packet) {
		t.Fatal("our own request is not recognised as STUN")
	}
	if len(txid) != 24 {
		t.Fatalf("txid %q", txid)
	}
	if _, _, ok := wavestun.ParseBindingResponse(packet); ok {
		t.Fatal("a request must not parse as a response")
	}
}

func TestAWireGuardPacketIsNotStun(t *testing.T) {
	packet := make([]byte, 148)
	packet[0] = 1
	if wavestun.LooksLikeStun(packet) {
		t.Fatal("a WireGuard handshake was taken for STUN")
	}
}
