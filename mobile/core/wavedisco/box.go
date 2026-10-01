// Package wavedisco is the Go half of packages/disco: authenticated discovery
// packets between two disco keys.
//
// Discovery packets travel on the same unauthenticated UDP socket as WireGuard
// traffic, and they are what teaches us which address belongs to which peer. If
// they were forgeable, anyone could redirect a peer's traffic to an address of
// their choosing, so every packet is sealed to the recipient's disco key.
package wavedisco

import (
	"crypto/rand"
	"crypto/sha256"

	"golang.org/x/crypto/chacha20poly1305"

	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavecrypto"
)

// NonceLength is XChaCha20-Poly1305's, which is what makes a random nonce safe
// here: there is no counter to keep in step across a reconnect.
const NonceLength = chacha20poly1305.NonceSizeX

const context = "wave-disco-v1"

// SharedKey is the X25519 agreement hashed with a context string. The hash is
// not decoration: the raw agreement is used elsewhere in other protocols, and
// binding it to a context keeps a key from one meaning being usable in another.
func SharedKey(privateKey, peerPublicKey string) ([]byte, error) {
	secret, err := wavecrypto.SharedSecret(privateKey, peerPublicKey)
	if err != nil {
		return nil, err
	}
	hash := sha256.New()
	hash.Write([]byte(context))
	hash.Write(secret)
	return hash.Sum(nil), nil
}

// Seal encrypts with a fresh nonce.
func Seal(key, plaintext []byte) (nonce, ciphertext []byte, err error) {
	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil, nil, err
	}
	nonce = make([]byte, NonceLength)
	if _, err := rand.Read(nonce); err != nil {
		return nil, nil, err
	}
	return nonce, aead.Seal(nil, nonce, plaintext, nil), nil
}

// Open returns nil on any authentication failure -- a forged packet is just
// noise, and telling the caller why would only invite it to act on the reason.
func Open(key, nonce, ciphertext []byte) []byte {
	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil
	}
	plaintext, err := aead.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil
	}
	return plaintext
}
