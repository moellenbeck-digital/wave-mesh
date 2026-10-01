package wavecontrol_test

import (
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/moellenbeck-digital/wave-mesh/mobile/core/internal/fixture"
	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavecontrol"
	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavecrypto"
)

// maxClockSkew is the server's window, repeated here because this test is the
// server: a phone with a clock five minutes out is refused, and that is worth
// knowing on this side of the wire.
const maxClockSkew = 300

// verifySignedRequest is the control server's own check, reimplemented from
// packages/crypto/src/httpsig.ts. Reimplemented rather than mocked away,
// because "the phone can authenticate" is a claim about the exact bytes the
// server parses -- a test that accepted any header would prove nothing.
func verifySignedRequest(t *testing.T, request *http.Request, body string) string {
	t.Helper()
	header := request.Header.Get("authorization")
	const scheme = "WaveSig "
	if !strings.HasPrefix(header, scheme) {
		t.Fatalf("no signature: %q", header)
	}
	fields := map[string]string{}
	for _, part := range strings.Split(header[len(scheme):], ",") {
		if equals := strings.Index(part, "="); equals >= 0 {
			fields[strings.TrimSpace(part[:equals])] = strings.TrimSpace(part[equals+1:])
		}
	}
	timestamp, err := strconv.ParseInt(fields["t"], 10, 64)
	if err != nil {
		t.Fatalf("timestamp %q", fields["t"])
	}
	if math.Abs(float64(time.Now().Unix()-timestamp)) > maxClockSkew {
		t.Fatalf("clock skew of %d seconds", time.Now().Unix()-timestamp)
	}
	message := wavecrypto.SignatureMessage(
		request.Method, request.URL.Path, timestamp, fields["n"], wavecrypto.BodyHash(body))
	if !wavecrypto.Verify(fields["k"], []byte(message), fields["s"]) {
		t.Fatalf("signature does not verify for %s %s", request.Method, request.URL.Path)
	}
	return fields["k"]
}

type fakeServer struct {
	*httptest.Server
	contract fixture.Contract

	mu       sync.Mutex
	approved bool
	nonces   map[string]bool
	seen     []string
}

func newFakeServer(t *testing.T) *fakeServer {
	t.Helper()
	server := &fakeServer{contract: fixture.Load(t), nonces: map[string]bool{}}
	server.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		machineKey := verifySignedRequest(t, r, string(body))

		server.mu.Lock()
		server.seen = append(server.seen, r.Method+" "+r.URL.Path)
		// The server claims the nonce only after the signature checks out, so
		// an attacker cannot burn nonces on behalf of a node.
		nonce := machineKey + ":" + r.Header.Get("authorization")
		if server.nonces[nonce] {
			server.mu.Unlock()
			http.Error(w, "replayed nonce", http.StatusUnauthorized)
			return
		}
		server.nonces[nonce] = true
		approved := server.approved
		server.mu.Unlock()

		w.Header().Set("content-type", "application/json")
		switch r.URL.Path {
		case "/v1/machine/register":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"status": "pending", "authUrl": "https://control.example/machine/authorize?x=1",
				"pollSecret": "s3cret",
			})
		case "/v1/machine/poll":
			if !approved {
				_ = json.NewEncoder(w).Encode(map[string]any{"status": "pending"})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"status": "authorized",
				"nodeId": "n_7",
				"netmap": map[string]any{
					"netmap":    json.RawMessage(server.contract.Netmap.Document),
					"signature": server.contract.Netmap.Signature,
					"keyId":     server.contract.Netmap.SigningPublicKey,
				},
				"netmapPublicKey": server.contract.Netmap.SigningPublicKey,
			})
		case "/v1/node/endpoints", "/v1/node/logout":
			_, _ = w.Write([]byte("{}"))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func identityFor(t *testing.T, server *fakeServer) *wavecontrol.Identity {
	t.Helper()
	contract := fixture.Load(t)
	return &wavecontrol.Identity{
		ControlURL: server.URL,
		MachineKey: wavecrypto.KeyPair(contract.Keys.Machine),
		NodeKey:    wavecrypto.KeyPair(contract.Keys.DiscoB),
		DiscoKey:   wavecrypto.KeyPair(contract.Keys.DiscoA),
		Hostname:   "phone",
	}
}

// The whole enrolment, against a server that checks the signature the way the
// real one does: register, wait for a human, and come back with a netmap that
// verifies against the key pinned in the same answer.
func TestEnrolmentRoundTrip(t *testing.T) {
	server := newFakeServer(t)
	identity := identityFor(t, server)
	client := wavecontrol.NewClient(identity, server.Client())

	registration, err := client.Register(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	if registration.Status != "pending" || registration.AuthURL == "" {
		t.Fatalf("got %+v", registration)
	}

	// The browser gets opened somewhere between these two lines.
	server.mu.Lock()
	server.approved = true
	server.mu.Unlock()

	poll, err := client.WaitForApproval(context.Background(), registration.PollSecret, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if poll.NodeID != "n_7" {
		t.Fatalf("node id %q", poll.NodeID)
	}
	netmap, err := poll.Netmap.Verify(poll.NetmapPublicKey)
	if err != nil {
		t.Fatalf("the netmap the server sent does not verify: %v", err)
	}
	if netmap.Self.Hostname != "phone" {
		t.Fatalf("self %+v", netmap.Self)
	}
}

// Every request is signed, including the ones with no body -- the body hash of
// an empty body is part of the message, not an exemption from it.
func TestEveryRequestIsSigned(t *testing.T) {
	server := newFakeServer(t)
	client := wavecontrol.NewClient(identityFor(t, server), server.Client())

	if err := client.PublishEndpoints(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if err := client.Logout(context.Background()); err != nil {
		t.Fatal(err)
	}
	server.mu.Lock()
	defer server.mu.Unlock()
	if len(server.seen) != 2 {
		t.Fatalf("the server saw %v", server.seen)
	}
}

// A netmap signed by anyone else is refused before it is read, which is the
// only thing standing between a phone and fabricated peer keys.
func TestANetmapFromTheWrongKeyIsRefused(t *testing.T) {
	server := newFakeServer(t)
	server.mu.Lock()
	server.approved = true
	server.mu.Unlock()

	client := wavecontrol.NewClient(identityFor(t, server), server.Client())
	poll, err := client.Poll(context.Background(), "s3cret")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := poll.Netmap.Verify(fixture.Load(t).Keys.Machine.PublicKey); err == nil {
		t.Fatal("a netmap signed by another key must be refused")
	}
}
