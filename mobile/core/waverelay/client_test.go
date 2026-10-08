package waverelay_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavecrypto"
	"github.com/moellenbeck-digital/wave-mesh/mobile/core/waverelay"
)

// fakeRelay accepts anyone -- the challenge is not what is under test -- and
// either echoes every frame back to its sender, as the real relay does for a
// frame addressed to the sender's own key, or swallows everything while
// keeping the socket open: what a relay that timed out a sleeping device
// looks like from the device.
func fakeRelay(t *testing.T, echo bool) (url string, sessions *atomic.Int32) {
	t.Helper()
	sessions = &atomic.Int32{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		socket, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer socket.CloseNow()
		ctx := r.Context()
		for {
			kind, data, err := socket.Read(ctx)
			if err != nil {
				return
			}
			if kind == websocket.MessageText {
				sessions.Add(1)
				_ = socket.Write(ctx, websocket.MessageText, []byte(`{"t":"ready"}`))
				continue
			}
			if echo {
				_ = socket.Write(ctx, websocket.MessageBinary, data)
			}
		}
	}))
	t.Cleanup(server.Close)
	return "ws" + strings.TrimPrefix(server.URL, "http"), sessions
}

type lines struct {
	mu  sync.Mutex
	all []string
}

func (l *lines) add(line string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.all = append(l.all, line)
}

func (l *lines) contain(part string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, line := range l.all {
		if strings.Contains(line, part) {
			return true
		}
	}
	return false
}

func startClient(t *testing.T, url string, packets *atomic.Int32, log *lines) *waverelay.Client {
	t.Helper()
	return startClientBeating(t, url, packets, log, 50*time.Millisecond)
}

func startClientBeating(t *testing.T, url string, packets *atomic.Int32, log *lines, heartbeat time.Duration) *waverelay.Client {
	t.Helper()
	keys, err := wavecrypto.GenerateX25519()
	if err != nil {
		t.Fatal(err)
	}
	client := waverelay.New(waverelay.Options{
		URL:             url,
		DiscoPublicKey:  keys.PublicKey,
		DiscoPrivateKey: keys.PrivateKey,
		OnPacket:        func(string, []byte) { packets.Add(1) },
		Log:             log.add,
		MinBackoff:      20 * time.Millisecond,
		Heartbeat:       heartbeat,
	})
	client.Start()
	t.Cleanup(client.Close)
	return client
}

func eventually(t *testing.T, what string, condition func() bool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for !condition() {
		select {
		case <-ctx.Done():
			t.Fatalf("timed out waiting for %s", what)
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func TestAClientReconnectsWhenTheRelayStopsAnswering(t *testing.T) {
	url, sessions := fakeRelay(t, false)
	var packets atomic.Int32
	var log lines
	startClient(t, url, &packets, &log)

	eventually(t, "the heartbeat to notice", func() bool { return log.contain("stopped answering") })
	eventually(t, "a second session", func() bool { return sessions.Load() >= 2 })
}

func TestAClientStaysWhileTheRelayEchoes(t *testing.T) {
	url, sessions := fakeRelay(t, true)
	var packets atomic.Int32
	var log lines
	startClient(t, url, &packets, &log)

	eventually(t, "the first session", func() bool { return sessions.Load() == 1 })
	time.Sleep(500 * time.Millisecond)
	if log.contain("stopped answering") || sessions.Load() != 1 {
		t.Fatalf("a relay that answers was given up on: %d session(s), log %v", sessions.Load(), log.all)
	}
	// The echo is ours; handing it on would look like a relayed packet from
	// ourselves.
	if packets.Load() != 0 {
		t.Fatalf("%d echo(es) reached OnPacket", packets.Load())
	}
}

// After a wake-up the relay is asked, not replaced: one that echoes keeps its
// session. The heartbeat is an hour here, so only Check can decide.
func TestCheckKeepsARelayThatEchoes(t *testing.T) {
	url, sessions := fakeRelay(t, true)
	var packets atomic.Int32
	var log lines
	client := startClientBeating(t, url, &packets, &log, time.Hour)
	eventually(t, "the client to be ready", client.Connected)
	client.Check(200 * time.Millisecond)
	time.Sleep(500 * time.Millisecond)
	if sessions.Load() != 1 || log.contain("did not answer") {
		t.Fatalf("a relay that answers was given up on: %d session(s), log %v", sessions.Load(), log.all)
	}
}

// One that stays silent is replaced at once instead of a heartbeat later.
func TestCheckReplacesARelayThatDoesNotAnswer(t *testing.T) {
	url, sessions := fakeRelay(t, false)
	var packets atomic.Int32
	var log lines
	client := startClientBeating(t, url, &packets, &log, time.Hour)
	eventually(t, "the client to be ready", client.Connected)
	client.Check(100 * time.Millisecond)
	eventually(t, "a second session", func() bool { return sessions.Load() >= 2 })
	if !log.contain("did not answer after waking") {
		t.Fatalf("log %v", log.all)
	}
}
