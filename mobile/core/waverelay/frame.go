// Package waverelay is the Go half of the node side of packages/magicsock's
// relay client: the path that works when no amount of punching does.
package waverelay

import (
	"errors"

	"github.com/pinguin45orga/wave-mesh/mobile/core/wavecrypto"
)

// MaxPayload bounds a single frame. The relay enforces the same number.
const MaxPayload = 64 * 1024

// EncodeFrame wraps a payload for the relay.
//
// Data frames are binary and deliberately minimal: one 32-byte disco key plus
// the payload. Outbound the key names the recipient, inbound it names the
// sender, so both directions share one shape. The payload is WireGuard
// ciphertext or a sealed discovery packet -- the relay can read neither.
func EncodeFrame(discoKey string, payload []byte) ([]byte, error) {
	key, err := wavecrypto.DecodeKey(discoKey)
	if err != nil {
		return nil, err
	}
	frame := make([]byte, 0, len(key)+len(payload))
	frame = append(frame, key...)
	return append(frame, payload...), nil
}

// ErrShortFrame means the relay sent something that is not a data frame.
var ErrShortFrame = errors.New("relay frame is too short to carry a payload")

// DecodeFrame splits an inbound frame into sender and payload.
func DecodeFrame(frame []byte) (discoKey string, payload []byte, err error) {
	if len(frame) <= wavecrypto.KeyLength || len(frame) > wavecrypto.KeyLength+MaxPayload {
		return "", nil, ErrShortFrame
	}
	return wavecrypto.EncodeKey(frame[:wavecrypto.KeyLength]), frame[wavecrypto.KeyLength:], nil
}
