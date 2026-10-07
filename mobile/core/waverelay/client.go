package waverelay

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavedisco"
)

// Client is a connection to a relay, used for peers no direct path reaches.
//
// Authentication is a challenge sealed to our disco key: only its owner can
// read it back, which is enough for the relay to route by that key without
// knowing anything about waves or users.
//
// One per device, not one per wave. The relay routes by disco key and a phone
// has one socket and one set of keys per enrolment, so a second connection
// would only be a second thing to reconnect on every network change.
type Client struct {
	url             string
	discoPublicKey  string
	discoPrivateKey string
	onPacket        func(senderDiscoKey string, payload []byte)
	log             func(string)

	minBackoff time.Duration
	maxBackoff time.Duration
	heartbeat  time.Duration

	mu     sync.Mutex
	socket *websocket.Conn
	ready  bool

	cancel context.CancelFunc
	done   chan struct{}
	// wake cuts a reconnect wait short after a network change.
	wake chan struct{}
}

// Options configures a Client. Everything but the callbacks is required.
type Options struct {
	URL             string
	DiscoPublicKey  string
	DiscoPrivateKey string
	OnPacket        func(senderDiscoKey string, payload []byte)
	Log             func(string)
	MinBackoff      time.Duration
	MaxBackoff      time.Duration
	// How often the relay is asked to echo; one missing answer is a dead
	// socket. Defaults to fifteen seconds, the same as on the desktop.
	Heartbeat time.Duration
}

// echo is what a heartbeat carries. The relay stamps every frame with its
// authenticated sender, so a frame from our own key can only be the echo; the
// byte just has to be there, a frame without payload does not decode.
var echo = []byte{0}

// New makes a client. It does not connect; Start does.
func New(options Options) *Client {
	client := &Client{
		url:             options.URL,
		discoPublicKey:  options.DiscoPublicKey,
		discoPrivateKey: options.DiscoPrivateKey,
		onPacket:        options.OnPacket,
		log:             options.Log,
		minBackoff:      options.MinBackoff,
		maxBackoff:      options.MaxBackoff,
		heartbeat:       options.Heartbeat,
		done:            make(chan struct{}),
		wake:            make(chan struct{}, 1),
	}
	if client.log == nil {
		client.log = func(string) {}
	}
	if client.onPacket == nil {
		client.onPacket = func(string, []byte) {}
	}
	if client.minBackoff == 0 {
		client.minBackoff = 500 * time.Millisecond
	}
	if client.maxBackoff == 0 {
		client.maxBackoff = 30 * time.Second
	}
	if client.heartbeat == 0 {
		client.heartbeat = 15 * time.Second
	}
	return client
}

// URL is the relay this client is for, as the netmap named it.
func (c *Client) URL() string { return c.url }

// Connected reports whether frames sent right now would go anywhere.
func (c *Client) Connected() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ready && c.socket != nil
}

// Start connects and keeps reconnecting until Close.
// Reconnect drops the relay connection and dials again at once: after a
// network change the old connection is bound to a path that may be gone, and
// a peer reachable only through the relay would wait for the heartbeat.
func (c *Client) Reconnect() {
	c.mu.Lock()
	socket := c.socket
	c.mu.Unlock()
	select {
	case c.wake <- struct{}{}:
	default:
	}
	if socket != nil {
		socket.CloseNow()
	}
}

func (c *Client) Start() {
	ctx, cancel := context.WithCancel(context.Background())
	c.cancel = cancel
	go c.run(ctx)
}

func (c *Client) run(ctx context.Context) {
	defer close(c.done)
	backoff := c.minBackoff
	for ctx.Err() == nil {
		reachedReady, err := c.session(ctx)
		if err != nil && ctx.Err() == nil {
			c.log("relay " + c.url + ": " + err.Error())
		}
		// A session that worked starts the count again; otherwise every
		// heartbeat-triggered reconnect would wait twice as long as the last.
		if reachedReady {
			backoff = c.minBackoff
		}
		select {
		case <-ctx.Done():
			return
		case <-c.wake:
			backoff = c.minBackoff
			continue
		case <-time.After(backoff):
		}
		if !reachedReady {
			backoff *= 2
		}
		if backoff > c.maxBackoff {
			backoff = c.maxBackoff
		}
	}
}

// session is one connection, from dial to close. It reports whether the relay
// accepted us, which is what separates a connection that ended from one that
// never started.
func (c *Client) session(parent context.Context) (reachedReady bool, err error) {
	ctx, stop := context.WithCancel(parent)
	defer stop()
	socket, _, err := websocket.Dial(ctx, c.url, nil)
	if err != nil {
		return false, err
	}
	// A relayed WireGuard packet plus the key in front of it; the relay never
	// sends anything larger.
	socket.SetReadLimit(MaxPayload + 1024)
	defer socket.CloseNow()

	c.mu.Lock()
	c.socket, c.ready = socket, false
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		reachedReady = c.ready
		c.socket, c.ready = nil, false
		c.mu.Unlock()
	}()

	// Set on every inbound frame, cleared by each heartbeat that sends an echo.
	var heard atomic.Bool
	heard.Store(true)

	hello, err := json.Marshal(map[string]string{"t": "hello", "discoKey": c.discoPublicKey})
	if err != nil {
		return false, err
	}
	if err := socket.Write(ctx, websocket.MessageText, hello); err != nil {
		return false, err
	}

	for {
		kind, data, err := socket.Read(ctx)
		if err != nil {
			return false, err
		}
		if kind == websocket.MessageBinary {
			sender, payload, err := DecodeFrame(data)
			if err != nil {
				continue
			}
			// Any frame proves the relay still routes to this socket, not just
			// the echo: it only delivers to the session registered for our key.
			heard.Store(true)
			if sender == c.discoPublicKey {
				continue
			}
			c.onPacket(sender, payload)
			continue
		}
		becameReady, err := c.handshake(ctx, socket, data)
		if err != nil {
			return false, err
		}
		if becameReady {
			go c.watch(ctx, socket, &heard)
		}
	}
}

// watch is the heartbeat of one session.
//
// A relay connection can die without either side saying so: after a laptop or
// a phone sleeps through the relay's idle timeout, the relay has long closed
// its end while ours still reads as open, Read blocks for good, Connected stays
// true, and every peer only the relay reaches goes quiet. Measured on the
// desktop on 28.09.2026 after half an hour of suspend; on a phone, sleeping is
// the normal case. So the relay is asked to echo a frame to our own key: it
// answers only if it still routes that key to this very socket, which is
// exactly the property that matters. Closing the socket unblocks Read, and
// the session ends like any other.
func (c *Client) watch(ctx context.Context, socket *websocket.Conn, heard *atomic.Bool) {
	ticker := time.NewTicker(c.heartbeat)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		if !heard.Swap(false) {
			c.log("relay " + c.url + " stopped answering — reconnecting")
			socket.CloseNow()
			return
		}
		frame, err := EncodeFrame(c.discoPublicKey, echo)
		if err != nil {
			return
		}
		write, cancel := context.WithTimeout(ctx, 2*time.Second)
		_ = socket.Write(write, websocket.MessageBinary, frame)
		cancel()
	}
}

type handshakeMessage struct {
	T        string `json:"t"`
	RelayKey string `json:"relayKey"`
	Nonce    string `json:"nonce"`
	Box      string `json:"box"`
	Message  string `json:"message"`
}

// handshake answers one text message and says whether it made us ready.
func (c *Client) handshake(ctx context.Context, socket *websocket.Conn, raw []byte) (bool, error) {
	var message handshakeMessage
	if err := json.Unmarshal(raw, &message); err != nil {
		// Not something we understand; the relay will either go on or hang up.
		return false, nil
	}

	switch message.T {
	case "challenge":
		key, err := wavedisco.SharedKey(c.discoPrivateKey, message.RelayKey)
		if err != nil {
			return false, err
		}
		nonce, err := base64.StdEncoding.DecodeString(message.Nonce)
		if err != nil {
			return false, err
		}
		box, err := base64.StdEncoding.DecodeString(message.Box)
		if err != nil {
			return false, err
		}
		token := wavedisco.Open(key, nonce, box)
		if token == nil {
			// Only the owner of our disco key can read this, so failing to
			// means we are not who the relay is talking to.
			c.log("relay challenge could not be opened")
			return false, socket.Close(websocket.StatusPolicyViolation, "challenge")
		}
		proof, err := json.Marshal(map[string]string{"t": "proof", "token": string(token)})
		if err != nil {
			return false, err
		}
		return false, socket.Write(ctx, websocket.MessageText, proof)
	case "ready":
		c.mu.Lock()
		c.ready = true
		c.mu.Unlock()
		c.log("relay " + c.url + " ready")
		return true, nil
	case "error":
		c.log("relay refused the connection: " + message.Message)
		return false, socket.Close(websocket.StatusNormalClosure, "refused")
	}
	return false, nil
}

// Send returns false when the relay is unavailable, so the caller can fall
// back to a direct path -- or to spraying, which is what happens while no path
// is confirmed at all.
func (c *Client) Send(toDiscoKey string, payload []byte) bool {
	c.mu.Lock()
	socket, ready := c.socket, c.ready
	c.mu.Unlock()
	if socket == nil || !ready {
		return false
	}
	frame, err := EncodeFrame(toDiscoKey, payload)
	if err != nil {
		return false
	}
	// Bounded: a relay that has stopped reading must not block the data path.
	// The packet is lost either way; WireGuard retransmits and disco reprobes.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return socket.Write(ctx, websocket.MessageBinary, frame) == nil
}

// Close stops reconnecting and hangs up.
func (c *Client) Close() {
	if c.cancel != nil {
		c.cancel()
	}
	c.mu.Lock()
	socket := c.socket
	c.mu.Unlock()
	if socket != nil {
		socket.CloseNow()
	}
}
