package wavecontrol

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/moellenbeck-digital/wave-mesh/mobile/core/waveproto"
)

// SocketOptions configures the long-lived connection.
type SocketOptions struct {
	Identity *Identity
	// OnNetmap is called with a netmap that has already been verified against
	// the pinned key. A netmap that does not verify never gets here.
	OnNetmap func(waveproto.Netmap)
	// OnRejectedNetmap is a netmap that did not verify against the pinned key:
	// the wave stays on its last one, and the person should be told.
	OnRejectedNetmap func(error)
	// OnDiscoHint is the signal to start punching at a particular peer.
	OnDiscoHint func(nodeID string, candidates []waveproto.Candidate)
	// OnLogout is the server saying this node is no longer in the wave.
	OnLogout func(reason string)
	// Hello is sent first on every connection, when set: the version and
	// platform the server shows next to the device. Without it a phone is
	// "unknown, version unknown" in the device list.
	Hello *waveproto.ClientMessage
	Log   func(string)
	// HTTPClient carries the dial; a phone passes a protected one.
	HTTPClient  *http.Client
	MinBackoff  time.Duration
	MaxBackoff  time.Duration
	HeartbeatMS time.Duration
}

// Socket is the long-lived connection to one control server.
//
// It carries netmap updates and, more importantly, the signal to start
// punching: both peers must send at the same moment, which is something only
// the server can coordinate.
type Socket struct {
	options SocketOptions
	log     func(string)

	mu            sync.Mutex
	socket        *websocket.Conn
	lastEndpoints []waveproto.Candidate
	lastFilter    *waveproto.ClientMessage
	awaitingPong  bool
	// When anything last arrived from the server; see Check.
	lastHeard time.Time

	cancel context.CancelFunc
	done   chan struct{}
	// wake cuts a reconnect wait short: the network changed, so waiting out a
	// backoff that was chosen for the old one helps nobody.
	wake chan struct{}
}

// NewSocket makes a socket. Connect starts it.
func NewSocket(options SocketOptions) *Socket {
	socket := &Socket{options: options, log: options.Log, done: make(chan struct{}), wake: make(chan struct{}, 1)}
	if socket.log == nil {
		socket.log = func(string) {}
	}
	if socket.options.MinBackoff == 0 {
		socket.options.MinBackoff = 500 * time.Millisecond
	}
	if socket.options.MaxBackoff == 0 {
		socket.options.MaxBackoff = 30 * time.Second
	}
	if socket.options.HeartbeatMS == 0 {
		socket.options.HeartbeatMS = 30 * time.Second
	}
	return socket
}

// Connect opens the socket and keeps reconnecting until Close.
func (s *Socket) Connect() {
	ctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel
	go s.run(ctx)
}

func (s *Socket) run(ctx context.Context) {
	defer close(s.done)
	backoff := s.options.MinBackoff
	for ctx.Err() == nil {
		connected, err := s.session(ctx)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			s.log("control disconnected: " + err.Error())
		}
		// A connection that came up proves the server is there: the next
		// attempt starts from the shortest wait again. Without this the wait
		// only ever grew, and after a few network changes every reconnect of
		// a phone took the full 30 seconds.
		if connected {
			backoff = s.options.MinBackoff
		}
		select {
		case <-ctx.Done():
			return
		case <-s.wake:
			backoff = s.options.MinBackoff
			continue
		case <-time.After(backoff):
		}
		backoff *= 2
		if backoff > s.options.MaxBackoff {
			backoff = s.options.MaxBackoff
		}
	}
}

// Check asks the server for a pong now and drops the connection if nothing at
// all arrives within wait. For a phone that woke up: the connection may have
// died while it slept, or may be perfectly fine, and only asking tells which.
// Reconnecting regardless cost a TLS handshake per wave on every wake-up;
// waiting for the heartbeat leaves a dead one unnoticed for up to a minute.
func (s *Socket) Check(wait time.Duration) {
	s.mu.Lock()
	socket := s.socket
	s.mu.Unlock()
	if socket == nil {
		return // already between connections; the dial is the check
	}
	asked := time.Now()
	// Not on the caller's goroutine: a write to a dead connection can sit out
	// its whole timeout.
	go s.send(context.Background(), waveproto.ClientMessage{Type: "ping"})
	time.AfterFunc(wait, func() {
		s.mu.Lock()
		silent := s.socket == socket && s.lastHeard.Before(asked)
		s.mu.Unlock()
		if silent {
			s.log("control connection did not answer after waking -- reconnecting")
			socket.CloseNow()
		}
	})
}

// Reconnect drops the connection and dials again at once. For a network
// change: the old connection is bound to a path that may be gone, and waiting
// for the heartbeat to notice takes up to a minute.
func (s *Socket) Reconnect() {
	s.mu.Lock()
	socket := s.socket
	s.mu.Unlock()
	select {
	case s.wake <- struct{}{}:
	default:
	}
	if socket != nil {
		socket.CloseNow()
	}
}

func (s *Socket) session(ctx context.Context) (connected bool, err error) {
	target := strings.TrimSuffix(s.options.Identity.ControlURL, "/") + "/v1/control"
	target = strings.Replace(strings.Replace(target, "https://", "wss://", 1), "http://", "ws://", 1)

	authorization, err := signedRequestHeader(s.options.Identity, http.MethodGet, "/v1/control", time.Now())
	if err != nil {
		return false, err
	}
	socket, _, err := websocket.Dial(ctx, target, &websocket.DialOptions{
		HTTPClient: s.options.HTTPClient,
		HTTPHeader: http.Header{"Authorization": []string{authorization}},
	})
	if err != nil {
		return false, err
	}
	// A netmap of a large wave is the biggest thing that ever arrives here.
	socket.SetReadLimit(8 << 20)
	defer socket.CloseNow()

	s.mu.Lock()
	s.socket = socket
	s.awaitingPong = false
	endpoints := s.lastEndpoints
	filter := s.lastFilter
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.socket = nil
		s.mu.Unlock()
	}()

	s.log("control connected")
	if s.options.Hello != nil {
		s.send(ctx, *s.options.Hello)
	}
	// Candidates are published before the socket is necessarily open, and after
	// a reconnect the server needs them again, so re-send what we have.
	if endpoints != nil {
		s.send(ctx, waveproto.ClientMessage{Type: "endpoints", Candidates: endpoints})
	}
	if filter != nil {
		s.send(ctx, *filter)
	}

	sessionCtx, stopHeartbeat := context.WithCancel(ctx)
	defer stopHeartbeat()
	go s.heartbeat(sessionCtx, socket)

	for {
		_, data, err := socket.Read(ctx)
		if err != nil {
			return true, err
		}
		s.onMessage(data)
	}
}

// heartbeat is what notices a connection that died without either side saying
// so -- a NAT dropping the idle flow, or the server going away mid-flight.
// Without it the client keeps a tunnel running against a netmap that silently
// stops being updated, which is indistinguishable from everything being fine.
//
// On a phone it is the common case rather than the exception: a sleeping radio
// drops the flow every time the screen goes off.
func (s *Socket) heartbeat(ctx context.Context, socket *websocket.Conn) {
	ticker := time.NewTicker(s.options.HeartbeatMS)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.mu.Lock()
			missed := s.awaitingPong
			s.awaitingPong = true
			s.mu.Unlock()
			if missed {
				s.log("control connection stopped answering -- reconnecting")
				socket.CloseNow()
				return
			}
			s.send(ctx, waveproto.ClientMessage{Type: "ping"})
		}
	}
}

func (s *Socket) onMessage(raw []byte) {
	s.mu.Lock()
	s.lastHeard = time.Now()
	s.mu.Unlock()
	message, err := waveproto.ParseServerMessage(raw)
	if err != nil {
		return
	}

	switch message.Type {
	case "pong":
		s.mu.Lock()
		s.awaitingPong = false
		s.mu.Unlock()
	case "netmap":
		pinned := s.options.Identity.NetmapPublicKey
		if pinned == "" {
			return
		}
		netmap, err := message.Netmap.Verify(pinned)
		if err != nil {
			// A netmap that does not verify is the one case worth shouting
			// about.
			s.log("rejected netmap: " + err.Error())
			if s.options.OnRejectedNetmap != nil {
				s.options.OnRejectedNetmap(err)
			}
			return
		}
		if s.options.OnNetmap != nil {
			s.options.OnNetmap(netmap)
		}
	case "disco-hint":
		if s.options.OnDiscoHint != nil {
			s.options.OnDiscoHint(message.NodeID, message.Candidates)
		}
	case "logout":
		s.log("control asked this node to re-authenticate: " + message.Reason)
		if s.options.OnLogout != nil {
			s.options.OnLogout(message.Reason)
		}
	}
}

func (s *Socket) send(ctx context.Context, message waveproto.ClientMessage) {
	s.mu.Lock()
	socket := s.socket
	s.mu.Unlock()
	if socket == nil {
		return
	}
	encoded, err := json.Marshal(message)
	if err != nil {
		return
	}
	bounded, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	_ = socket.Write(bounded, websocket.MessageText, encoded)
}

// PublishEndpoints sends our candidates and remembers them for the next
// reconnect.
func (s *Socket) PublishEndpoints(candidates []waveproto.Candidate) {
	if candidates == nil {
		candidates = []waveproto.Candidate{}
	}
	s.mu.Lock()
	s.lastEndpoints = candidates
	s.mu.Unlock()
	s.send(context.Background(), waveproto.ClientMessage{Type: "endpoints", Candidates: candidates})
}

// ReportFilter says whether this device enforces the ports of its wave's
// policy, and remembers it for the next reconnect.
func (s *Socket) ReportFilter(enforced bool, reason string) {
	message := waveproto.ClientMessage{Type: "filter", Enforced: &enforced, Reason: reason}
	s.mu.Lock()
	s.lastFilter = &message
	s.mu.Unlock()
	s.send(context.Background(), message)
}

// Connected reports whether the socket is up right now.
func (s *Socket) Connected() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.socket != nil
}

// Close stops reconnecting and hangs up.
func (s *Socket) Close() {
	if s.cancel != nil {
		s.cancel()
	}
	s.mu.Lock()
	socket := s.socket
	s.mu.Unlock()
	if socket != nil {
		socket.CloseNow()
	}
}
