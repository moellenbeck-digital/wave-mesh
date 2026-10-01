// Package wavecontrol talks to one control server: enrolment over REST, and
// then a socket that carries netmaps and the signal to start punching.
//
// N-fold and unchanged, which is the one layer D10 leaves exactly as it was: a
// device in three waves has three of these, with three machine keys and three
// pinned signing keys. Nothing about them is shared, and that is the point --
// the waves know nothing of each other.
package wavecontrol

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavecrypto"
	"github.com/moellenbeck-digital/wave-mesh/mobile/core/waveproto"
)

// Identity is everything one enrolment needs to prove who it is.
//
// The three private keys live in the caller's state and nowhere else; they are
// never sent to the control server.
type Identity struct {
	ControlURL string
	MachineKey wavecrypto.KeyPair
	NodeKey    wavecrypto.KeyPair
	DiscoKey   wavecrypto.KeyPair
	// Pinned at enrolment; every later netmap must verify against it.
	NetmapPublicKey string
	NodeID          string
	Hostname        string
}

// Client is the REST half.
type Client struct {
	identity *Identity
	http     *http.Client
	now      func() time.Time
}

// NewClient makes a client. A nil httpClient takes a sensible default; a phone
// passes one whose dialer the platform has protected, or its own requests would
// go into the tunnel it is trying to build.
func NewClient(identity *Identity, httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}
	return &Client{identity: identity, http: httpClient, now: time.Now}
}

func (c *Client) request(ctx context.Context, method, path string, body any) ([]byte, error) {
	payload := ""
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		payload = string(encoded)
	}

	target, err := url.JoinPath(c.identity.ControlURL, path)
	if err != nil {
		return nil, err
	}
	var reader io.Reader
	if method != http.MethodGet {
		reader = strings.NewReader(payload)
	}
	request, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return nil, err
	}

	authorization, err := wavecrypto.BuildAuthorizationHeader(
		c.identity.MachineKey.PublicKey, c.identity.MachineKey.PrivateKey,
		method, path, payload, c.now())
	if err != nil {
		return nil, err
	}
	request.Header.Set("content-type", "application/json")
	request.Header.Set("authorization", authorization)

	response, err := c.http.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	text, err := io.ReadAll(io.LimitReader(response.Body, 8<<20))
	if err != nil {
		return nil, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		snippet := string(text)
		if len(snippet) > 200 {
			snippet = snippet[:200]
		}
		return nil, fmt.Errorf("%s %s failed: %d %s", method, path, response.StatusCode, snippet)
	}
	return text, nil
}

// Register enrols this device. With a pre-auth key it is enrolled straight
// away -- the key is an approval given in advance, for machines that have no
// browser and nobody to sit at one.
func (c *Client) Register(ctx context.Context, authKey string) (waveproto.RegisterResponse, error) {
	var parsed waveproto.RegisterResponse
	body := waveproto.RegisterRequest{
		MachineKey: c.identity.MachineKey.PublicKey,
		NodeKey:    c.identity.NodeKey.PublicKey,
		DiscoKey:   c.identity.DiscoKey.PublicKey,
		Hostname:   c.identity.Hostname,
		OS:         "other",
		AuthKey:    authKey,
	}
	raw, err := c.request(ctx, http.MethodPost, "/v1/machine/register", body)
	if err != nil {
		return parsed, err
	}
	return parsed, json.Unmarshal(raw, &parsed)
}

// Poll asks whether somebody has approved this device yet.
func (c *Client) Poll(ctx context.Context, pollSecret string) (waveproto.PollResponse, error) {
	var parsed waveproto.PollResponse
	raw, err := c.request(ctx, http.MethodPost, "/v1/machine/poll", map[string]string{"pollSecret": pollSecret})
	if err != nil {
		return parsed, err
	}
	return parsed, json.Unmarshal(raw, &parsed)
}

// Netmap fetches the current netmap. The socket normally pushes it; this is for
// the start, and for after a long sleep.
func (c *Client) Netmap(ctx context.Context) (waveproto.SignedNetmap, error) {
	var signed waveproto.SignedNetmap
	raw, err := c.request(ctx, http.MethodGet, "/v1/netmap", nil)
	if err != nil {
		return signed, err
	}
	return signed, json.Unmarshal(raw, &signed)
}

// PublishEndpoints tells the server where this device can be reached.
func (c *Client) PublishEndpoints(ctx context.Context, candidates []waveproto.Candidate) error {
	_, err := c.request(ctx, http.MethodPost, "/v1/node/endpoints",
		map[string]any{"candidates": candidates})
	return err
}

// Logout removes this node from its wave.
//
// Best effort, and bounded: the local enrolment is cleared either way, so a
// server that cannot be reached must not hold the command open. Unbounded, it
// outlived the caller's own timeout and a logout that had worked locally
// reported that nothing had answered.
func (c *Client) Logout(ctx context.Context) error {
	bounded, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, err := c.request(bounded, http.MethodPost, "/v1/node/logout", map[string]any{})
	return err
}

// WaitForApproval polls until somebody opens the link, or the deadline passes.
func (c *Client) WaitForApproval(ctx context.Context, pollSecret string, deadline time.Duration) (waveproto.PollResponse, error) {
	stop := time.Now().Add(deadline)
	for time.Now().Before(stop) {
		poll, err := c.Poll(ctx, pollSecret)
		if err != nil {
			return poll, err
		}
		switch poll.Status {
		case "authorized":
			return poll, nil
		case "expired":
			return poll, fmt.Errorf("the enrolment request expired -- start again")
		}
		// The browser approval is one click, so poll often enough to feel
		// instant.
		select {
		case <-ctx.Done():
			return poll, ctx.Err()
		case <-time.After(time.Second):
		}
	}
	return waveproto.PollResponse{}, fmt.Errorf("timed out waiting for approval")
}

// signedRequestHeader is what the socket needs too: the same scheme, over a
// GET of the socket path.
func signedRequestHeader(identity *Identity, method, path string, now time.Time) (string, error) {
	return wavecrypto.BuildAuthorizationHeader(
		identity.MachineKey.PublicKey, identity.MachineKey.PrivateKey, method, path, "", now)
}
