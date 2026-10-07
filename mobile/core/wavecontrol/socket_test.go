package wavecontrol_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/moellenbeck-digital/wave-mesh/mobile/core/internal/fixture"
	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavecontrol"
	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavecrypto"
	"github.com/moellenbeck-digital/wave-mesh/mobile/core/waveproto"
)

// socketServer accepts control connections and remembers, per connection,
// when it came and what was sent first. dropAfterFirst closes each connection
// as soon as its first message is in -- a server, or a network, that keeps
// going away.
type socketServer struct {
	*httptest.Server
	mu          sync.Mutex
	connections []time.Time
	first       []waveproto.ClientMessage
	dropAfter   bool
}

func newSocketServer(t *testing.T, dropAfterFirst bool) *socketServer {
	t.Helper()
	server := &socketServer{dropAfter: dropAfterFirst}
	server.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer connection.CloseNow()
		server.mu.Lock()
		server.connections = append(server.connections, time.Now())
		server.mu.Unlock()
		_, data, err := connection.Read(r.Context())
		if err != nil {
			return
		}
		var message waveproto.ClientMessage
		_ = json.Unmarshal(data, &message)
		server.mu.Lock()
		server.first = append(server.first, message)
		server.mu.Unlock()
		if server.dropAfter {
			return
		}
		for {
			if _, _, err := connection.Read(r.Context()); err != nil {
				return
			}
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func (s *socketServer) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.connections)
}

func socketFor(t *testing.T, server *socketServer) *wavecontrol.Socket {
	t.Helper()
	contract := fixture.Load(t)
	socket := wavecontrol.NewSocket(wavecontrol.SocketOptions{
		Identity: &wavecontrol.Identity{
			ControlURL: server.URL,
			MachineKey: wavecrypto.KeyPair(contract.Keys.Machine),
			NodeKey:    wavecrypto.KeyPair(contract.Keys.DiscoB),
			DiscoKey:   wavecrypto.KeyPair(contract.Keys.DiscoA),
			Hostname:   "phone",
		},
		Hello:      &waveproto.ClientMessage{Type: "hello", Version: "0.8.0", Platform: "ios"},
		MinBackoff: 200 * time.Millisecond,
		MaxBackoff: 30 * time.Second,
	})
	socket.Connect()
	t.Cleanup(socket.Close)
	return socket
}

func waitFor(t *testing.T, what string, within time.Duration, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if ok() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("%s did not happen within %v", what, within)
}

// Every connection starts with hello, so the server knows the version and
// platform of a phone -- without it the device list says "unknown".
func TestEveryConnectionSaysHelloFirst(t *testing.T) {
	server := newSocketServer(t, true)
	socketFor(t, server)
	waitFor(t, "three connections", 10*time.Second, func() bool { return server.count() >= 3 })
	server.mu.Lock()
	defer server.mu.Unlock()
	for i, message := range server.first {
		if message.Type != "hello" || message.Platform != "ios" || message.Version != "0.8.0" {
			t.Fatalf("connection %d began with %+v", i, message)
		}
	}
}

// A connection that came up resets the wait. Before, the wait only grew: a
// server that drops the connection six times in a row would have the sixth
// attempt wait 6.4 s here (and 30 s with the real minimum after a few network
// changes). Now every attempt after a successful connection waits the minimum.
func TestAConnectionThatCameUpResetsTheWait(t *testing.T) {
	server := newSocketServer(t, true)
	socketFor(t, server)
	waitFor(t, "six connections", 4*time.Second, func() bool { return server.count() >= 6 })
}

// Reconnect dials again at once, for a network change: no waiting for the
// heartbeat to notice that the old path is gone.
func TestReconnectDialsAgainAtOnce(t *testing.T) {
	server := newSocketServer(t, false)
	socket := socketFor(t, server)
	waitFor(t, "the first connection", 5*time.Second, func() bool { return server.count() == 1 })
	waitFor(t, "the socket to be up", 5*time.Second, socket.Connected)
	socket.Reconnect()
	waitFor(t, "a second connection right away", time.Second, func() bool { return server.count() == 2 })
}

// An endpoints message with no candidates says so with [] -- the server's
// schema rejects one without the field, and kept stale candidates.
func TestNoCandidatesIsAnEmptyListNotAMissingOne(t *testing.T) {
	encoded, err := json.Marshal(waveproto.ClientMessage{Type: "endpoints", Candidates: []waveproto.Candidate{}})
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `{"type":"endpoints","candidates":[]}` {
		t.Fatalf("got %s", encoded)
	}
}
