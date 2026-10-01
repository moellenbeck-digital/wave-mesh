package wavedisco

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"net/netip"

	"github.com/pinguin45orga/wave-mesh/mobile/core/wavecrypto"
	"github.com/pinguin45orga/wave-mesh/mobile/core/waveproto"
)

// Wire format:
//
//	magic(6) | version(1) | senderDiscoKey(32) | nonce(24) | ciphertext
//
// The magic prefix is what keeps discovery packets apart from WireGuard's own
// messages, whose first byte is 1..4. The sender's key travels in the clear
// because the receiver needs it to derive the shared secret -- it is a public
// key, and the payload it protects is authenticated.
var Magic = [6]byte{0x77, 0x61, 0x76, 0x65, 0x64, 0x63} // "wavedc"

// Version of the disco framing. One so far.
const Version = 1

// HeaderLength is everything before the ciphertext.
const HeaderLength = len(Magic) + 1 + wavecrypto.KeyLength + NonceLength

// Message types on the wire.
const (
	TypePing        = 1
	TypePong        = 2
	TypeCallMeMaybe = 3
)

// TxidLength is the size of a ping's transaction id, which a pong echoes.
const TxidLength = 8

// Message is one decoded discovery message. Exactly one shape is filled in,
// decided by Type.
type Message struct {
	Type int
	Txid [TxidLength]byte
	// Observed is how the sender of a pong saw us: our own reflexive address,
	// learned without a STUN server.
	Observed waveproto.Endpoint
	// Endpoints of a call-me-maybe.
	Endpoints []waveproto.Endpoint
}

// LooksLikeDisco reports whether a datagram can be a discovery packet. It is
// deliberately a cheap prefix test: everything else on this socket is
// WireGuard, and the answer decides which of the two paths a packet takes.
func LooksLikeDisco(packet []byte) bool {
	if len(packet) < HeaderLength {
		return false
	}
	for i, b := range Magic {
		if packet[i] != b {
			return false
		}
	}
	return true
}

// NewTxid makes a transaction id for a ping.
func NewTxid() [TxidLength]byte {
	var txid [TxidLength]byte
	// A failing random source is not a case worth carrying up: the same call
	// underpins every key in this process, and a zero txid would only cost one
	// probe its measurement.
	_, _ = rand.Read(txid[:])
	return txid
}

// TxidHex is the map key an in-flight probe is filed under.
func TxidHex(txid [TxidLength]byte) string { return hex.EncodeToString(txid[:]) }

func encodeEndpoint(out []byte, endpoint waveproto.Endpoint) []byte {
	address, err := netip.ParseAddr(endpoint.IP)
	if err != nil {
		return out
	}
	if address.Is4() {
		v4 := address.As4()
		out = append(out, 4)
		out = append(out, v4[:]...)
	} else {
		v6 := address.As16()
		out = append(out, 6)
		out = append(out, v6[:]...)
	}
	return binary.BigEndian.AppendUint16(out, uint16(endpoint.Port))
}

func decodeEndpoint(bytes []byte, offset int) (waveproto.Endpoint, int, bool) {
	if offset >= len(bytes) {
		return waveproto.Endpoint{}, 0, false
	}
	var length int
	switch bytes[offset] {
	case 4:
		length = 4
	case 6:
		length = 16
	default:
		return waveproto.Endpoint{}, 0, false
	}
	if offset+1+length+2 > len(bytes) {
		return waveproto.Endpoint{}, 0, false
	}
	address, ok := netip.AddrFromSlice(bytes[offset+1 : offset+1+length])
	if !ok {
		return waveproto.Endpoint{}, 0, false
	}
	port := binary.BigEndian.Uint16(bytes[offset+1+length:])
	return waveproto.Endpoint{IP: address.String(), Port: int(port)}, offset + 1 + length + 2, true
}

func encodeMessage(message Message) []byte {
	switch message.Type {
	case TypePing:
		out := make([]byte, 0, 1+TxidLength)
		out = append(out, TypePing)
		return append(out, message.Txid[:]...)
	case TypePong:
		out := make([]byte, 0, 1+TxidLength+19)
		out = append(out, TypePong)
		out = append(out, message.Txid[:]...)
		return encodeEndpoint(out, message.Observed)
	case TypeCallMeMaybe:
		out := []byte{TypeCallMeMaybe}
		for _, endpoint := range message.Endpoints {
			out = encodeEndpoint(out, endpoint)
		}
		return out
	}
	return nil
}

func decodeMessage(bytes []byte) (Message, bool) {
	if len(bytes) == 0 {
		return Message{}, false
	}
	switch bytes[0] {
	case TypePing:
		if len(bytes) < 1+TxidLength {
			return Message{}, false
		}
		message := Message{Type: TypePing}
		copy(message.Txid[:], bytes[1:])
		return message, true
	case TypePong:
		if len(bytes) < 1+TxidLength {
			return Message{}, false
		}
		message := Message{Type: TypePong}
		copy(message.Txid[:], bytes[1:])
		observed, _, ok := decodeEndpoint(bytes, 1+TxidLength)
		if !ok {
			return Message{}, false
		}
		message.Observed = observed
		return message, true
	case TypeCallMeMaybe:
		message := Message{Type: TypeCallMeMaybe}
		for offset := 1; offset < len(bytes); {
			endpoint, next, ok := decodeEndpoint(bytes, offset)
			if !ok {
				return Message{}, false
			}
			message.Endpoints = append(message.Endpoints, endpoint)
			offset = next
		}
		return message, true
	}
	return Message{}, false
}

// Encode seals one message to a peer.
func Encode(senderDiscoKey string, sharedKey []byte, message Message) ([]byte, error) {
	sender, err := wavecrypto.DecodeKey(senderDiscoKey)
	if err != nil {
		return nil, err
	}
	plaintext := encodeMessage(message)
	if plaintext == nil {
		return nil, errors.New("unknown disco message type")
	}
	nonce, ciphertext, err := Seal(sharedKey, plaintext)
	if err != nil {
		return nil, err
	}
	packet := make([]byte, 0, HeaderLength+len(ciphertext))
	packet = append(packet, Magic[:]...)
	packet = append(packet, Version)
	packet = append(packet, sender...)
	packet = append(packet, nonce...)
	return append(packet, ciphertext...), nil
}

// Decoded is what a packet turned out to be, and from whom.
type Decoded struct {
	SenderDiscoKey string
	Message        Message
}

// Decode opens a packet, given a way to look up the shared key for a sender.
// The lookup returning nil (an unknown peer) and decryption failing are both
// just "not for us".
func Decode(packet []byte, sharedKeyFor func(senderDiscoKey string) []byte) (Decoded, bool) {
	if !LooksLikeDisco(packet) {
		return Decoded{}, false
	}
	offset := len(Magic)
	if packet[offset] != Version {
		return Decoded{}, false
	}
	offset++

	senderDiscoKey := wavecrypto.EncodeKey(packet[offset : offset+wavecrypto.KeyLength])
	offset += wavecrypto.KeyLength
	nonce := packet[offset : offset+NonceLength]
	offset += NonceLength

	key := sharedKeyFor(senderDiscoKey)
	if key == nil {
		return Decoded{}, false
	}
	plaintext := Open(key, nonce, packet[offset:])
	if plaintext == nil {
		return Decoded{}, false
	}
	message, ok := decodeMessage(plaintext)
	if !ok {
		return Decoded{}, false
	}
	return Decoded{SenderDiscoKey: senderDiscoKey, Message: message}, true
}
