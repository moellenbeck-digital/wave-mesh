package wavecontrol_test

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/moellenbeck-digital/wave-mesh/mobile/core/internal/fixture"
	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavecontrol"
	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavecrypto"
	"github.com/moellenbeck-digital/wave-mesh/mobile/core/waveproto"
)

// What the first connect does when the control server is not there yet. The
// socket reconnects by itself once it has been up (socket_test.go); enrolment
// used to give up at the first refused connection.

func identityAt(t *testing.T, controlURL string) *wavecontrol.Identity {
	t.Helper()
	contract := fixture.Load(t)
	return &wavecontrol.Identity{
		ControlURL: controlURL,
		MachineKey: wavecrypto.KeyPair(contract.Keys.Machine),
		NodeKey:    wavecrypto.KeyPair(contract.Keys.DiscoB),
		DiscoKey:   wavecrypto.KeyPair(contract.Keys.DiscoA),
		Hostname:   "phone",
	}
}

func pending(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("content-type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"status": "pending", "authUrl": "https://control.example/machine/authorize?x=1",
		"pollSecret": "s3cret",
	})
}

// recorded keeps the waits short enough for a test and writes down what was
// said while waiting.
type recorded struct {
	mu        sync.Mutex
	delays    []time.Duration
	recovered int
}

func (r *recorded) options(known bool) wavecontrol.RetryOptions {
	return wavecontrol.RetryOptions{
		KnownAddress: known,
		MinBackoff:   10 * time.Millisecond,
		MaxBackoff:   40 * time.Millisecond,
		OnWait: func(_ error, delay time.Duration) {
			r.mu.Lock()
			defer r.mu.Unlock()
			r.delays = append(r.delays, delay)
		},
		OnRecovered: func() {
			r.mu.Lock()
			defer r.mu.Unlock()
			r.recovered++
		},
	}
}

// A port nobody listens on, and a way to start the server there later.
func lateServer(t *testing.T, handler http.Handler) (string, func()) {
	t.Helper()
	server := httptest.NewUnstartedServer(handler)
	address := server.Listener.Addr().String()
	_ = server.Listener.Close()
	t.Cleanup(server.Close)
	return "http://" + address, func() {
		listener, err := net.Listen("tcp", address)
		if err != nil {
			// Not Fatalf: this runs off the test goroutine.
			t.Errorf("the port was taken in between: %v", err)
			return
		}
		server.Listener = listener
		server.Start()
	}
}

func TestARefusedConnectionIsWaitedOutUntilTheServerIsThere(t *testing.T) {
	controlURL, start := lateServer(t, http.HandlerFunc(pending))
	client := wavecontrol.NewClient(identityAt(t, controlURL), nil)
	said := &recorded{}

	go func() {
		time.Sleep(120 * time.Millisecond)
		start()
	}()
	registration, err := wavecontrol.Retrying(context.Background(), said.options(false),
		func(ctx context.Context) (waveproto.RegisterResponse, error) {
			return client.Register(ctx, "")
		})
	if err != nil {
		t.Fatalf("enrolment gave up on a server that was only late: %v", err)
	}
	if registration.Status != "pending" {
		t.Fatalf("got %+v", registration)
	}
	said.mu.Lock()
	defer said.mu.Unlock()
	if len(said.delays) == 0 {
		t.Fatal("it never waited, so the server cannot have been down")
	}
	if said.recovered != 1 {
		t.Fatalf("recovery was reported %d times", said.recovered)
	}
}

func TestAGatewayErrorIsRetried(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.ReadAll(r.Body)
		// 502, 503, 504: a proxy in front of a control server that is restarting.
		if n := requests.Add(1); n <= 3 {
			http.Error(w, "not yet", []int{502, 503, 504}[n-1])
			return
		}
		pending(w, r)
	}))
	t.Cleanup(server.Close)
	client := wavecontrol.NewClient(identityAt(t, server.URL), nil)

	_, err := wavecontrol.Retrying(context.Background(), (&recorded{}).options(false),
		func(ctx context.Context) (waveproto.RegisterResponse, error) {
			return client.Register(ctx, "")
		})
	if err != nil {
		t.Fatal(err)
	}
	if requests.Load() != 4 {
		t.Fatalf("the server saw %d requests, want 3 refusals and then the answer", requests.Load())
	}
}

func TestARefusalIsReportedAtOnce(t *testing.T) {
	for _, status := range []int{401, 403, 404, 405} {
		var requests atomic.Int32
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.ReadAll(r.Body)
			requests.Add(1)
			http.Error(w, "no", status)
		}))
		client := wavecontrol.NewClient(identityAt(t, server.URL), nil)

		_, err := wavecontrol.Retrying(context.Background(), (&recorded{}).options(true),
			func(ctx context.Context) (waveproto.RegisterResponse, error) {
				return client.Register(ctx, "")
			})
		server.Close()

		var refused *wavecontrol.StatusError
		if !errors.As(err, &refused) || refused.Status != status {
			t.Fatalf("status %d: got %v", status, err)
		}
		if requests.Load() != 1 {
			t.Fatalf("status %d was tried %d times", status, requests.Load())
		}
	}
}

func TestACertificateErrorIsReportedAtOnceEvenForAKnownAddress(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(pending))
	t.Cleanup(server.Close)
	// A plain client: it does not trust the test server's certificate.
	client := wavecontrol.NewClient(identityAt(t, server.URL), &http.Client{Timeout: 5 * time.Second})
	var attempts atomic.Int32

	_, err := wavecontrol.Retrying(context.Background(), (&recorded{}).options(true),
		func(ctx context.Context) (waveproto.RegisterResponse, error) {
			attempts.Add(1)
			return client.Register(ctx, "")
		})
	var unknown x509.UnknownAuthorityError
	if !errors.As(err, &unknown) {
		t.Fatalf("expected the certificate error itself, got %v", err)
	}
	if attempts.Load() != 1 {
		t.Fatalf("a certificate error was tried %d times; waiting does not fix it", attempts.Load())
	}
}

func TestAMissingNameIsRetriedOnlyForAnAddressKnownToBeGood(t *testing.T) {
	missing := &url.Error{Op: "Post", URL: "https://control.example", Err: &net.DNSError{
		Err: "no such host", Name: "control.example", IsNotFound: true,
	}}
	if wavecontrol.Retriable(missing, false) {
		t.Fatal("a name a person just typed that does not resolve was retried; it is most likely a typo")
	}
	if !wavecontrol.Retriable(missing, true) {
		t.Fatal("a known address that does not resolve is the network not being up yet")
	}
	// A resolver that cannot be reached says nothing about the address.
	unreachable := &net.DNSError{Err: "server misbehaving", Name: "control.example"}
	if !wavecontrol.Retriable(unreachable, false) {
		t.Fatal("a resolver that is down was reported as a wrong address")
	}
}

// The desktop's `getaddrinfo ETIMEOUT`: the resolver did not answer in time.
// In Go that is a DNSError that is a timeout, for a known address or not.
func TestAResolverThatTimesOutIsRetriedForEveryAddress(t *testing.T) {
	for _, lookup := range []*net.DNSError{
		{Err: "i/o timeout", Name: "control.example", IsTimeout: true},
		{Err: "server misbehaving", Name: "control.example", IsTemporary: true},
		{Err: "connection refused", Name: "control.example"},
	} {
		err := &url.Error{Op: "Post", URL: "https://control.example", Err: &net.OpError{Op: "dial", Err: lookup}}
		for _, known := range []bool{false, true} {
			if !wavecontrol.Retriable(err, known) {
				t.Errorf("%v was not retried (known address: %v)", lookup, known)
			}
		}
	}
}

func TestEveryConnectionProblemIsRetriable(t *testing.T) {
	for _, err := range []error{
		&net.OpError{Op: "dial", Err: os.NewSyscallError("connect", syscall.ECONNREFUSED)},
		&net.OpError{Op: "read", Err: os.NewSyscallError("read", syscall.ECONNRESET)},
		&net.OpError{Op: "dial", Err: os.NewSyscallError("connect", syscall.EHOSTUNREACH)},
		&net.OpError{Op: "dial", Err: os.NewSyscallError("connect", syscall.ENETUNREACH)},
		&url.Error{Op: "Post", URL: "http://x", Err: io.EOF},
		&url.Error{Op: "Post", URL: "http://x", Err: context.DeadlineExceeded},
	} {
		if !wavecontrol.Retriable(err, false) {
			t.Errorf("%v was not retried", err)
		}
	}
}

func TestWhatIsNotAConnectionProblemIsNotRetried(t *testing.T) {
	for _, err := range []error{
		errors.New("the enrolment request expired -- start again"),
		errors.New("the control server presented a different netmap signing key than the one pinned at enrolment"),
		errors.New("netmap signature does not verify"),
		context.Canceled,
		&wavecontrol.StatusError{Method: "POST", Path: "/v1/machine/register", Status: 400},
	} {
		if wavecontrol.Retriable(err, true) {
			t.Errorf("%v was retried; it would hide the reason behind a wait that never ends", err)
		}
	}
}

func TestTheWaitDoublesUpToTheMaximum(t *testing.T) {
	said := &recorded{}
	var attempts int
	_, err := wavecontrol.Retrying(context.Background(), said.options(false),
		func(context.Context) (struct{}, error) {
			attempts++
			if attempts <= 5 {
				return struct{}{}, os.NewSyscallError("connect", syscall.ECONNREFUSED)
			}
			return struct{}{}, nil
		})
	if err != nil {
		t.Fatal(err)
	}
	want := []time.Duration{10, 20, 40, 40, 40}
	said.mu.Lock()
	defer said.mu.Unlock()
	if len(said.delays) != len(want) {
		t.Fatalf("waited %v", said.delays)
	}
	for i, delay := range said.delays {
		if delay != want[i]*time.Millisecond {
			t.Fatalf("waited %v, want 10, 20, then 40 ms at most", said.delays)
		}
	}
}

func TestTheWaitEndsWithTheContext(t *testing.T) {
	controlURL, _ := lateServer(t, http.HandlerFunc(pending)) // never started
	client := wavecontrol.NewClient(identityAt(t, controlURL), nil)
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(80*time.Millisecond, cancel)

	started := time.Now()
	_, err := wavecontrol.Retrying(ctx, (&recorded{}).options(false),
		func(ctx context.Context) (waveproto.RegisterResponse, error) {
			return client.Register(ctx, "")
		})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("got %v, want the cancellation", err)
	}
	if time.Since(started) > 2*time.Second {
		t.Fatal("the wait outlived its context")
	}
}

func TestRetryingDoesNotMoveTheApprovalDeadline(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.ReadAll(r.Body)
		requests.Add(1)
		http.Error(w, "down", http.StatusServiceUnavailable)
	}))
	t.Cleanup(server.Close)
	client := wavecontrol.NewClient(identityAt(t, server.URL), nil)

	started := time.Now()
	_, err := client.WaitForApproval(context.Background(), "s3cret", 300*time.Millisecond, (&recorded{}).options(false))
	if err == nil || err.Error() != "timed out waiting for approval" {
		t.Fatalf("got %v, want the approval timeout", err)
	}
	if elapsed := time.Since(started); elapsed < 250*time.Millisecond || elapsed > 3*time.Second {
		t.Fatalf("gave up after %v; the 300 ms are the limit, retrying or not", elapsed)
	}
	if requests.Load() < 2 {
		t.Fatalf("the poll was tried %d times; it should have been retried inside the limit", requests.Load())
	}
}
