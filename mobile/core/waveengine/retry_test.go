package waveengine

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavecontrol"
)

// What the first connect does when the control server is not there yet: a
// login, and the registration refresh a known wave makes on every start. The
// rule itself (which errors are retried) is tested in wavecontrol.

func newClientFor(entry *wave) *wavecontrol.Client {
	return wavecontrol.NewClient(identityOf(entry.profile, "phone"), nil)
}

func said(host *fakeHost, fragment string) int {
	host.mu.Lock()
	defer host.mu.Unlock()
	count := 0
	for _, line := range host.lines {
		if strings.Contains(line, fragment) {
			count++
		}
	}
	return count
}

func TestALoginToAServerThatIsNotThereWaitsAndSaysSo(t *testing.T) {
	host := &fakeHost{}
	engine := New(Options{Host: host, RetryMin: 10 * time.Millisecond})
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()

	err := engine.Login(ctx, unreachableControlURL(t), "")
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("got %v; the wait should end only with the context", err)
	}
	if said(host, "control server not reachable") < 2 {
		t.Fatalf("the waiting was not in the log: %q", host.lines)
	}
	if said(host, "retrying in") < 2 {
		t.Fatalf("the log did not say when it tries next: %q", host.lines)
	}
}

func TestALoginGetsThroughOnceTheServerIsUp(t *testing.T) {
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.ReadAll(r.Body)
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"status":"pending","authUrl":"https://control.example/authorize","pollSecret":"s3cret"}`))
	}))
	address := server.Listener.Addr().String()
	_ = server.Listener.Close()
	t.Cleanup(server.Close)

	host := &fakeHost{}
	engine := New(Options{Host: host, RetryMin: 10 * time.Millisecond})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- engine.Login(ctx, "http://"+address, "") }()

	time.Sleep(100 * time.Millisecond)
	listener, err := net.Listen("tcp", address)
	if err != nil {
		t.Fatalf("the port was taken in between: %v", err)
	}
	server.Listener = listener
	server.Start()

	// The approval link only comes once the registration got through.
	deadline := time.Now().Add(5 * time.Second)
	for {
		host.mu.Lock()
		links := len(host.authURLs)
		host.mu.Unlock()
		if links > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the login never reached the server that came up")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if said(host, "control server not reachable") == 0 || said(host, "control server reachable again") != 1 {
		t.Fatalf("the log does not tell the wait and the recovery: %q", host.lines)
	}

	// Waiting for approval now; the person gives up.
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("got %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cancelling did not end the login")
	}
}

func TestOnlyAnApprovedEnrolmentKnowsItsAddress(t *testing.T) {
	engine := New(Options{})
	fresh, err := NewProfile("https://control.example")
	if err != nil {
		t.Fatal(err)
	}
	if engine.retryFor(fresh).KnownAddress {
		t.Fatal("an address nobody has been approved at is known to be good")
	}
	fresh.NetmapPublicKey = testKey(t)
	if !engine.retryFor(fresh).KnownAddress {
		t.Fatal("an approved enrolment does not know its own address")
	}
}

func TestAKnownWaveRetriesItsRegistrationRefresh(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.ReadAll(r.Body)
		if requests.Add(1) <= 2 {
			http.Error(w, "starting up", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"status":"authorized"}`))
	}))
	t.Cleanup(server.Close)
	engine, host := newTestEngine(t)
	engine.options.RetryMin = 5 * time.Millisecond
	entry := addWave(t, engine, server.URL)
	entry.client = newClientFor(entry)

	engine.refreshRegistration(context.Background(), entry)

	if requests.Load() != 3 {
		t.Fatalf("the server saw %d requests, want two refusals and then the answer", requests.Load())
	}
	if said(host, "could not refresh") != 0 {
		t.Fatalf("it gave up: %q", host.lines)
	}
	if said(host, "retrying in") != 2 {
		t.Fatalf("the two waits were not logged: %q", host.lines)
	}
}

func TestTheRefreshEndsWithItsWave(t *testing.T) {
	engine, host := newTestEngine(t)
	engine.options.RetryMin = 5 * time.Millisecond
	entry := addWave(t, engine, unreachableControlURL(t))
	entry.client = newClientFor(entry)
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(80*time.Millisecond, cancel)

	finished := make(chan struct{})
	go func() {
		engine.refreshRegistration(ctx, entry)
		close(finished)
	}()
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		t.Fatal("the refresh kept retrying after its wave went down")
	}
	if said(host, "could not refresh") != 0 {
		t.Fatalf("a wave that went down was reported as a failed refresh: %q", host.lines)
	}
}
