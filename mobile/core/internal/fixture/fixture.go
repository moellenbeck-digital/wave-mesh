// Package fixture loads the cross-implementation contract fixtures.
//
// They are produced by the TypeScript side (mobile/fixtures) and read by the
// Go tests, because "both implementations agree" is a claim about bytes and
// cannot be made by either side alone.
package fixture

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

type KeyPair struct {
	PublicKey  string `json:"publicKey"`
	PrivateKey string `json:"privateKey"`
}

type Canonical struct {
	Value   json.RawMessage `json:"value"`
	Encoded string          `json:"encoded"`
}

type Contract struct {
	Keys struct {
		Machine KeyPair `json:"machine"`
		DiscoA  KeyPair `json:"discoA"`
		DiscoB  KeyPair `json:"discoB"`
	} `json:"keys"`
	Canonical []Canonical `json:"canonical"`
	Netmap    struct {
		SigningPublicKey string          `json:"signingPublicKey"`
		Signature        string          `json:"signature"`
		Document         json.RawMessage `json:"document"`
	} `json:"netmap"`
	HTTPSig struct {
		Message   string `json:"message"`
		Signature string `json:"signature"`
	} `json:"httpsig"`
	Disco struct {
		SharedKey         string `json:"sharedKey"`
		SealedPing        string `json:"sealedPing"`
		SealedCallMeMaybe string `json:"sealedCallMeMaybe"`
	} `json:"disco"`
	STUN struct {
		Request  string `json:"request"`
		Txid     string `json:"txid"`
		Response string `json:"response"`
		Mapped   struct {
			IP   string `json:"ip"`
			Port int    `json:"port"`
		} `json:"mapped"`
	} `json:"stun"`
	DNS struct {
		Query struct {
			ID               int  `json:"id"`
			RecursionDesired bool `json:"recursionDesired"`
			Question         struct {
				Name  string `json:"name"`
				Type  int    `json:"type"`
				Class int    `json:"class"`
			} `json:"question"`
		} `json:"query"`
		A        string `json:"a"`
		NXDomain string `json:"nxdomain"`
		Empty    string `json:"empty"`
	} `json:"dns"`
	Relay struct {
		Frame      string `json:"frame"`
		ToDiscoKey string `json:"toDiscoKey"`
	} `json:"relay"`
	Derived struct {
		DiscoAPublicFromPrivate string `json:"discoAPublicFromPrivate"`
	} `json:"derived"`
}

// Load reads the fixture regardless of which package's directory the test runs
// in, which is what the runtime.Caller dance is for.
func Load(t *testing.T) Contract {
	t.Helper()
	_, self, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate the fixture directory")
	}
	path := filepath.Join(filepath.Dir(self), "..", "..", "testdata", "contract.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v (regenerate with: cd mobile/fixtures && bun run generate)", path, err)
	}
	var contract Contract
	if err := json.Unmarshal(raw, &contract); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	return contract
}
