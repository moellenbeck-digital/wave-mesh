// Package waveengine is the whole core: N control connections, one socket, one
// tunnel, and the rules that keep them from treading on each other.
package waveengine

import (
	"encoding/json"
	"fmt"

	"github.com/pinguin45orga/wave-mesh/mobile/core/wavecrypto"
)

// StateVersion is the shape of what the platform stores for us. It follows the
// desktop's version 2, because it is the same list of enrolments.
const StateVersion = 2

// Profile is one enrolment: a device can be in more than one wave at once -- a
// personal one and a customer's, say -- and each of those is a separate account
// on a separate server with keys of its own.
//
// Which one is which is decided by ControlURL and nothing else. There is no
// second name to keep in step with it, and none to get wrong: the server is the
// connection. What the desktop also keeps here -- an interface name and a UDP
// port per wave -- has no meaning on a phone, where there is one of each.
type Profile struct {
	ControlURL string             `json:"controlUrl"`
	MachineKey wavecrypto.KeyPair `json:"machineKey"`
	NodeKey    wavecrypto.KeyPair `json:"nodeKey"`
	DiscoKey   wavecrypto.KeyPair `json:"discoKey"`
	NodeID     string             `json:"nodeId"`
	// Pinned at enrolment; every later netmap must verify against it.
	NetmapPublicKey string `json:"netmapPublicKey"`
	AutoStart       bool   `json:"autoStart"`
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

// Find returns the enrolment with this control server.
func (s State) Find(controlURL string) (Profile, bool) {
	for _, profile := range s.Profiles {
		if profile.ControlURL == controlURL {
			return profile, true
		}
	}
	return Profile{}, false
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
