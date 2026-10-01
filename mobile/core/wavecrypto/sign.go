package wavecrypto

import (
	"crypto/ed25519"
	"encoding/base64"
)

// Sign produces an Ed25519 signature over arbitrary bytes, base64-encoded.
//
// The private key is the 32-byte seed, which is what the state file holds;
// Go's own ed25519.PrivateKey is the 64-byte expanded form.
func Sign(privateKey string, message []byte) (string, error) {
	seed, err := DecodeKey(privateKey)
	if err != nil {
		return "", err
	}
	signature := ed25519.Sign(ed25519.NewKeyFromSeed(seed), message)
	return base64.StdEncoding.EncodeToString(signature), nil
}

// Verify reports whether a signature is good. A malformed key or signature is
// a failed verification, not an error worth distinguishing: both mean the same
// thing to every caller here.
func Verify(publicKey string, message []byte, signature string) bool {
	raw, err := DecodeKey(publicKey)
	if err != nil {
		return false
	}
	decoded, err := base64.StdEncoding.DecodeString(signature)
	if err != nil {
		return false
	}
	return ed25519.Verify(ed25519.PublicKey(raw), message, decoded)
}
