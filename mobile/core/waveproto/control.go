package waveproto

import "encoding/json"

// --- REST -------------------------------------------------------------------

type RegisterRequest struct {
	MachineKey string `json:"machineKey"`
	NodeKey    string `json:"nodeKey"`
	DiscoKey   string `json:"discoKey"`
	Hostname   string `json:"hostname"`
	// "linux", "darwin", "windows" or "other". A phone says "other": the server
	// only shows it, and inventing a value an older server does not know would
	// fail its schema rather than its display.
	OS      string `json:"os"`
	AuthKey string `json:"authKey,omitempty"`
}

// RegisterResponse is the union of "you are in" and "ask a human first".
type RegisterResponse struct {
	Status          string       `json:"status"`
	NodeID          string       `json:"nodeId"`
	Netmap          SignedNetmap `json:"netmap"`
	NetmapPublicKey string       `json:"netmapPublicKey"`
	AuthURL         string       `json:"authUrl"`
	PollSecret      string       `json:"pollSecret"`
}

type PollResponse struct {
	Status          string       `json:"status"`
	NodeID          string       `json:"nodeId"`
	Netmap          SignedNetmap `json:"netmap"`
	NetmapPublicKey string       `json:"netmapPublicKey"`
}

// --- WebSocket /v1/control --------------------------------------------------

// ClientMessage is what a node sends on the control socket.
type ClientMessage struct {
	Type       string      `json:"type"`
	MachineKey string      `json:"machineKey,omitempty"`
	NodeKey    string      `json:"nodeKey,omitempty"`
	DiscoKey   string      `json:"discoKey,omitempty"`
	Version    string      `json:"version,omitempty"`
	// For "hello": what this device is. Free text on the server, which is why
	// the phones say "ios" or "android" here while registering as "other".
	Platform string `json:"platform,omitempty"`
	// Not omitempty: an "endpoints" message with no candidates must say so
	// with [], which the server accepts and an absent field it does not.
	// The other message types carry it as null, which the server ignores.
	Candidates []Candidate `json:"candidates"`
	// For "filter": whether the ports of the wave's policy hold here. A pointer
	// so false is sent and not dropped by omitempty.
	Enforced *bool  `json:"enforced,omitempty"`
	Reason   string `json:"reason,omitempty"`
}

// PeerChange is one entry of a netmap delta.
type PeerChange struct {
	Op     string `json:"op"`
	Peer   Peer   `json:"peer"`
	NodeID string `json:"nodeId"`
}

// ServerMessage is what the control server sends.
//
// Parsed leniently on purpose: an unknown type is ignored rather than treated
// as a broken connection, so a newer server can add one without this client
// reconnecting in a loop.
type ServerMessage struct {
	Type       string          `json:"type"`
	Netmap     SignedNetmap    `json:"netmap"`
	Version    int             `json:"version"`
	Changes    []PeerChange    `json:"changes"`
	NodeID     string          `json:"nodeId"`
	Candidates []Candidate     `json:"candidates"`
	Reason     string          `json:"reason"`
	Raw        json.RawMessage `json:"-"`
}

// ParseServerMessage keeps the original bytes, because a netmap has to be
// verified against what arrived rather than against a re-encoding of it.
func ParseServerMessage(raw []byte) (ServerMessage, error) {
	var message ServerMessage
	if err := json.Unmarshal(raw, &message); err != nil {
		return message, err
	}
	message.Raw = append(json.RawMessage(nil), raw...)
	return message, nil
}
