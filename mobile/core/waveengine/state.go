// Package waveengine is the whole core: N control connections, one socket, one
// tunnel, and the rules that keep them from treading on each other.
package waveengine

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"

	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavecrypto"
)

// StateVersion is the shape of what the platform stores for us. It follows the
// desktop's version 2, because it is the same list of enrolments.
const StateVersion = 2

// Profile is one enrolment: a device can be in more than one wave at once -- a
// personal one and a customer's, say -- and each of those is a separate account
// on a separate server with keys of its own.
//
// Which one is which is decided by Key: the control server's address for the
// first enrolment there, and an ID of its own for every further one. One
// server can run many waves -- one per project or customer, kept apart on
// purpose -- and a device that has to be in several of them needs an
// enrolment, with keys of its own, in each. What the desktop also keeps here
// -- an interface name and a UDP port per wave -- has no meaning on a phone,
// where there is one of each.
type Profile struct {
	ControlURL string `json:"controlUrl"`
	// ID tells apart further enrolments at the same server. Empty for the
	// first, whose key stays its address -- every state written before there
	// could be several keeps working unchanged.
	ID         string             `json:"id,omitempty"`
	MachineKey wavecrypto.KeyPair `json:"machineKey"`
	NodeKey    wavecrypto.KeyPair `json:"nodeKey"`
	DiscoKey   wavecrypto.KeyPair `json:"discoKey"`
	NodeID     string             `json:"nodeId"`
	// Pinned at enrolment; every later netmap must verify against it.
	NetmapPublicKey string `json:"netmapPublicKey"`
	AutoStart       bool   `json:"autoStart"`
	// Removed is why the server ended this enrolment ("node-removed"), when it
	// did. The wave stays listed so the person sees what happened, and comes
	// back only through a new login.
	Removed string `json:"removed,omitempty"`
	// Label is the wave's DNS suffix, kept from its last netmap, so a wave
	// that is not running can still be named: with several at one server, the
	// server's name says nothing about which is which.
	Label string `json:"label,omitempty"`
}

// Key is how an enrolment is filed everywhere: the address for the first one
// at a server, its own ID for any further one.
func (p Profile) Key() string {
	if p.ID != "" {
		return p.ID
	}
	return p.ControlURL
}

// State is everything worth surviving a restart. The three private keys per
// profile live here and nowhere else.
type State struct {
	Version  int       `json:"version"`
	Profiles []Profile `json:"profiles"`
}

// ParseState reads what the platform stored. An empty input is a device that
// has never joined anything, which is not an error.
func ParseState(raw []byte) (State, error) {
	if len(raw) == 0 {
		return State{Version: StateVersion}, nil
	}
	var state State
	if err := json.Unmarshal(raw, &state); err != nil {
		return State{}, err
	}
	if state.Version != StateVersion {
		return State{}, fmt.Errorf("state version %d is not %d", state.Version, StateVersion)
	}
	return state, nil
}

// Encode is what the platform stores. It contains private keys, so it belongs
// in the keychain or the encrypted shared preferences and nowhere else.
func (s State) Encode() ([]byte, error) {
	s.Version = StateVersion
	return json.Marshal(s)
}

// Find returns the first enrolment with this control server: the one a plain
// login resumes. Further enrolments there are only reached by their key.
func (s State) Find(controlURL string) (Profile, bool) {
	for _, profile := range s.Profiles {
		if profile.ControlURL == controlURL && profile.ID == "" {
			return profile, true
		}
	}
	for _, profile := range s.Profiles {
		if profile.ControlURL == controlURL {
			return profile, true
		}
	}
	return Profile{}, false
}

// NewAdditionalProfile makes a further enrolment at a server the device is
// already enrolled at: fresh keys, so the server sees a new device and asks
// which wave it goes to, and an ID so the two never mix.
func NewAdditionalProfile(controlURL string) (Profile, error) {
	profile, err := NewProfile(controlURL)
	if err != nil {
		return Profile{}, err
	}
	suffix := make([]byte, 4)
	if _, err := rand.Read(suffix); err != nil {
		return Profile{}, err
	}
	profile.ID = controlURL + "#" + hex.EncodeToString(suffix)
	return profile, nil
}

// NewProfile makes an enrolment with fresh keys.
func NewProfile(controlURL string) (Profile, error) {
	machine, err := wavecrypto.GenerateEd25519()
	if err != nil {
		return Profile{}, err
	}
	node, err := wavecrypto.GenerateX25519()
	if err != nil {
		return Profile{}, err
	}
	disco, err := wavecrypto.GenerateX25519()
	if err != nil {
		return Profile{}, err
	}
	return Profile{
		ControlURL: controlURL,
		MachineKey: machine,
		NodeKey:    node,
		DiscoKey:   disco,
		AutoStart:  true,
	}, nil
}
