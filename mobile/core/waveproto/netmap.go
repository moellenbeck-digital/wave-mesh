// Package waveproto is the Go half of packages/proto: the documents a node and
// a control server exchange.
//
// Only the netmap is security-critical, and it is handled differently from
// everything else here: it is kept as the bytes that were signed and verified
// against those, then read into these structs. Reading it first and
// re-encoding would mean re-encoding a document this version may not fully
// understand.
package waveproto

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavecrypto"
)

// Endpoint is a UDP address as it appears on the wire.
type Endpoint struct {
	IP   string `json:"ip"`
	Port int    `json:"port"`
}

func (e Endpoint) String() string {
	if isIPv6(e.IP) {
		return fmt.Sprintf("[%s]:%d", e.IP, e.Port)
	}
	return fmt.Sprintf("%s:%d", e.IP, e.Port)
}

// Candidate is one address a peer might be reachable at. Order carries no
// meaning.
type Candidate struct {
	Kind string `json:"kind"`
	IP   string `json:"ip"`
	Port int    `json:"port"`
}

// Endpoint drops the kind, which only matters when candidates are published.
func (c Candidate) Endpoint() Endpoint { return Endpoint{IP: c.IP, Port: c.Port} }

type Relay struct {
	ID     string    `json:"id"`
	Region string    `json:"region"`
	URL    string    `json:"url"`
	STUN   *Endpoint `json:"stun,omitempty"`
}

type Peer struct {
	ID           string      `json:"id"`
	NodeKey      string      `json:"nodeKey"`
	DiscoKey     string      `json:"discoKey"`
	Hostname     string      `json:"hostname"`
	DNSName      string      `json:"dnsName"`
	IPv4         string      `json:"ipv4"`
	IPv6         string      `json:"ipv6"`
	AllowedIPs   []string    `json:"allowedIps"`
	Candidates   []Candidate `json:"candidates"`
	HomeRelayID  string      `json:"homeRelayId,omitempty"`
	Online       bool        `json:"online"`
	KeyExpiresAt *string     `json:"keyExpiresAt"`
}

type SelfNode struct {
	Peer
	// Addresses configured on the tunnel interface. On a phone they are one
	// part of the union that goes to the single tunnel the OS allows.
	Addresses []string `json:"addresses"`
}

// Service is a name in the wave that is not a device (D11). It has no keys and
// is no WireGuard peer: it is reachable because its address sits in the
// allowedIps of the node named here.
type Service struct {
	Name      string `json:"name"`
	DNSName   string `json:"dnsName"`
	IPv4      string `json:"ipv4"`
	IPv6      string `json:"ipv6"`
	ViaNodeID string `json:"viaNodeId"`
	// Where the service is opened, e.g. "https://grafana.ops.example". The
	// server builds it; an older server sends none, and the client falls back
	// to https and the DNS name, like the desktop.
	URL string `json:"url,omitempty"`
}

type DNSRoute struct {
	Suffix      string   `json:"suffix"`
	Nameservers []string `json:"nameservers"`
}

type DNSConfig struct {
	Suffix          string     `json:"suffix"`
	ResolverAddress string     `json:"resolverAddress"`
	Routes          []DNSRoute `json:"routes"`
	Upstream        []string   `json:"upstream"`
}

// FilterPorts is one range of ports a filter rule opens: "tcp", "udp" or
// "any" for both.
type FilterPorts struct {
	Proto string `json:"proto"`
	From  int    `json:"from"`
	To    int    `json:"to"`
}

// FilterRule is traffic a node lets in (M7, stage two): from these addresses,
// to these of its own, on these ports.
type FilterRule struct {
	Src   []string      `json:"src"`
	Dst   []string      `json:"dst"`
	Ports []FilterPorts `json:"ports"`
}

// Netmap is the complete view of one wave as one node sees it.
type Netmap struct {
	Version  int       `json:"version"`
	WaveID   string    `json:"waveId"`
	Self     SelfNode  `json:"self"`
	Peers    []Peer    `json:"peers"`
	Services []Service `json:"services,omitempty"`
	// A pointer, because absent and empty mean opposite things: absent is no
	// policy and lets everything in, empty is a policy that lets in nothing but
	// replies. Only a pointer keeps them apart after decoding.
	PacketFilter *[]FilterRule `json:"packetFilter,omitempty"`
	DNS          DNSConfig     `json:"dns"`
	Relays       []Relay       `json:"relays"`
	IssuedAt     string        `json:"issuedAt"`
}

// SignedNetmap keeps the netmap as it arrived. The raw form is what gets
// verified; Netmap is only ever the reading of it.
type SignedNetmap struct {
	Netmap    json.RawMessage `json:"netmap"`
	Signature string          `json:"signature"`
	KeyID     string          `json:"keyId"`
}

var (
	// ErrUnexpectedSigner means the server presented a different signing key
	// than the one pinned at enrolment -- a different server, or a wave that
	// has been taken over.
	ErrUnexpectedSigner = errors.New("netmap signed by an unexpected key")
	// ErrBadSignature is the one case worth shouting about.
	ErrBadSignature = errors.New("netmap signature does not verify")
)

// Verify checks a netmap against the key pinned at enrolment and returns what
// it says. Without this, anything that can answer HTTP could hand us
// fabricated peer keys.
func (s SignedNetmap) Verify(pinnedPublicKey string) (Netmap, error) {
	var netmap Netmap
	if s.KeyID != pinnedPublicKey {
		return netmap, fmt.Errorf("%w (%s)", ErrUnexpectedSigner, s.KeyID)
	}
	canonical, err := wavecrypto.CanonicalJSON(s.Netmap)
	if err != nil {
		return netmap, fmt.Errorf("%w: %v", ErrBadSignature, err)
	}
	if !wavecrypto.Verify(pinnedPublicKey, canonical, s.Signature) {
		return netmap, ErrBadSignature
	}
	if err := json.Unmarshal(s.Netmap, &netmap); err != nil {
		return netmap, err
	}
	return netmap, nil
}

func isIPv6(ip string) bool {
	for i := 0; i < len(ip); i++ {
		if ip[i] == ':' {
			return true
		}
	}
	return false
}
