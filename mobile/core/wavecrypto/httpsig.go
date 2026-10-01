package wavecrypto

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"strings"
	"time"
)

// SignatureScheme names the one authorization scheme a node uses. It has no
// password and no bearer token: it proves possession of its machine key on
// every request.
const SignatureScheme = "WaveSig"

// BodyHash is the hex SHA-256 of a request body, empty string included.
func BodyHash(body string) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(body)))
}

// SignatureMessage is the string that gets signed. Method, path, timestamp,
// nonce and a hash of the body mean a captured request cannot be replayed
// against a different endpoint, and cannot be replayed at all once the
// timestamp window has passed.
func SignatureMessage(method, path string, timestamp int64, nonce, bodyHash string) string {
	return strings.Join([]string{
		"wave-sig-v1",
		strings.ToUpper(method),
		path,
		fmt.Sprintf("%d", timestamp),
		nonce,
		bodyHash,
	}, "\n")
}

// BuildAuthorizationHeader signs one request with the machine key.
func BuildAuthorizationHeader(machineKey, machinePrivateKey, method, path, body string, now time.Time) (string, error) {
	nonceBytes := make([]byte, 12)
	if _, err := rand.Read(nonceBytes); err != nil {
		return "", err
	}
	nonce := base64.RawURLEncoding.EncodeToString(nonceBytes)
	timestamp := now.Unix()
	signature, err := Sign(machinePrivateKey, []byte(SignatureMessage(method, path, timestamp, nonce, BodyHash(body))))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%s k=%s,t=%d,n=%s,s=%s", SignatureScheme, machineKey, timestamp, nonce, signature), nil
}
