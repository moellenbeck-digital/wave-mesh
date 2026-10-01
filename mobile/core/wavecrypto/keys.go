// Package wavecrypto holds the parts of the wave contract that have to be
// byte-identical on every implementation: key encoding, canonical JSON,
// Ed25519 signatures and the WaveSig request header.
//
// It is the Go half of packages/crypto. Nothing here may be "improved"
// independently -- a nicer encoding on this side is a signature that no longer
// verifies on the other.
package wavecrypto

import (
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"fmt"
)

// KeyLength is the size of every key in this protocol. Curve25519 and Ed25519
// public keys are both 32 raw bytes, carried as standard base64 -- the format
// wg itself prints.
const KeyLength = 32

// KeyPair is one key as it is stored, both halves base64-encoded.
type KeyPair struct {
	PublicKey  string `json:"publicKey"`
	PrivateKey string `json:"privateKey"`
}

// DecodeKey turns the base64 form into raw bytes, refusing anything that is not
// a 32-byte key rather than truncating or padding it.
func DecodeKey(encoded string) ([]byte, error) {
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, fmt.Errorf("key is not base64: %w", err)
	}
	if len(raw) != KeyLength {
		return nil, fmt.Errorf("key must be %d bytes, got %d", KeyLength, len(raw))
	}
	return raw, nil
}

// EncodeKey is the inverse of DecodeKey.
func EncodeKey(raw []byte) string { return base64.StdEncoding.EncodeToString(raw) }

// IsValidKey reports whether a string is a well-formed key, without saying what
// it is a key for.
func IsValidKey(encoded string) bool {
	_, err := DecodeKey(encoded)
	return err == nil
}

// GenerateEd25519 makes a machine key: the long-lived identity a node proves to
// the control server on every request.
func GenerateEd25519() (KeyPair, error) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return KeyPair{}, err
	}
	// Ed25519 private keys are 64 bytes in Go (seed plus public half); the wire
	// format everywhere else in this project is the 32-byte seed.
	return KeyPair{PublicKey: EncodeKey(public), PrivateKey: EncodeKey(private.Seed())}, nil
}

// GenerateX25519 makes a node or disco key. Both are Curve25519: the first is
// WireGuard's own, the second authenticates discovery packets.
func GenerateX25519() (KeyPair, error) {
	private, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return KeyPair{}, err
	}
	return KeyPair{
		PublicKey:  EncodeKey(private.PublicKey().Bytes()),
		PrivateKey: EncodeKey(private.Bytes()),
	}, nil
}

// PublicFromPrivateX25519 derives the public half, as `wg pubkey` does.
func PublicFromPrivateX25519(privateKey string) (string, error) {
	raw, err := DecodeKey(privateKey)
	if err != nil {
		return "", err
	}
	key, err := ecdh.X25519().NewPrivateKey(raw)
	if err != nil {
		return "", err
	}
	return EncodeKey(key.PublicKey().Bytes()), nil
}

// SharedSecret is the raw X25519 agreement between two Curve25519 keys. What
// callers want is almost always the hashed form in wavedisco.SharedKey.
func SharedSecret(privateKey, peerPublicKey string) ([]byte, error) {
	privateRaw, err := DecodeKey(privateKey)
	if err != nil {
		return nil, err
	}
	publicRaw, err := DecodeKey(peerPublicKey)
	if err != nil {
		return nil, err
	}
	private, err := ecdh.X25519().NewPrivateKey(privateRaw)
	if err != nil {
		return nil, err
	}
	public, err := ecdh.X25519().NewPublicKey(publicRaw)
	if err != nil {
		return nil, err
	}
	return private.ECDH(public)
}

// KeyToHex is what WireGuard's UAPI wants; keys travel as base64 everywhere else.
func KeyToHex(encoded string) (string, error) {
	raw, err := DecodeKey(encoded)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", raw), nil
}
