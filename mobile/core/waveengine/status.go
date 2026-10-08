package waveengine

import (
	"encoding/json"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavecrypto"
	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavemagic"
)

// PeerView is one peer as a user interface shows it.
type PeerView struct {
	Hostname string `json:"hostname"`
	DNSName  string `json:"dnsName"`
	IPv4     string `json:"ipv4"`
	IPv6     string `json:"ipv6"`
	Online   bool   `json:"online"`
	// "relay", an address, "idle" while nothing has been sent to the peer for a
	// while (and so nothing is measured), or empty while no path is confirmed.
	//
	// Empty is not the same as down: without a confirmed path every packet is
	// sprayed at all known candidates, which carries -- it is only wasteful and
	// unmeasured. A view that said "connecting" here would be claiming the
	// tunnel is down while a ping over it answers in 16 ms.
	Via   string `json:"via"`
	RTTMs int    `json:"rttMs"`
	// Seconds since the last WireGuard handshake with this peer, or -1 for
	// none yet. Online in the netmap is the server's view; this is ours.
	LastHandshakeSeconds int `json:"lastHandshakeSeconds"`
}

// ServiceView is a name in the wave that is not a device (D11).
type ServiceView struct {
	Name    string `json:"name"`
	DNSName string `json:"dnsName"`
	IPv4    string `json:"ipv4"`
	// Where to open it; https and the DNS name when the server sent none.
	URL string `json:"url"`
}

// WaveView is one enrolment.
type WaveView struct {
	// ID is the enrolment's key: what the apps pass back to pause, resume or
	// leave this wave. The control server's address for the first enrolment
	// there, an ID of its own for every further one at the same server.
	ID string `json:"id"`
	// The control server this wave is on. Several waves can share one.
	ControlURL string `json:"controlUrl"`
	// The wave's DNS suffix once known, otherwise the server's host.
	Label    string `json:"label"`
	WaveID   string `json:"waveId"`
	Suffix   string `json:"suffix"`
	Hostname string `json:"hostname"`
	DNSName  string `json:"dnsName"`
	IPv4     string `json:"ipv4"`
	IPv6     string `json:"ipv6"`
	// Switched on: false for a wave the person paused, which stays enrolled
	// and shows with nothing else filled in.
	Enabled bool `json:"enabled"`
	// Why this wave is not working, when it is not: "removed" (the server
	// ended the enrolment), "netmap-rejected" (the last netmap did not verify
	// against the pinned key) or "failed" (it did not come up). Empty when
	// fine. Detail is the core's own words, for the log and the curious.
	Problem string `json:"problem"`
	Detail  string `json:"detail"`
	// Whether the control connection is up. A tunnel keeps carrying traffic
	// without it -- the netmap is signed and already here -- so this is a
	// warning, not an outage.
	Connected bool `json:"connected"`
	// The relay this wave is connected to, or empty. One per wave: the relay
	// routes by disco key, and each enrolment has its own.
	Relay string `json:"relay"`
	// Whether the server offers a relay at all. Without one, a peer that
	// neither side can reach directly -- a connector behind a cluster's NAT,
	// a phone behind its carrier's -- stays out of reach, and the app says so
	// rather than showing a peer that simply never answers.
	RelayOffered bool `json:"relayOffered"`
	// Where this wave's resolver answers. The wave's reservation when it has
	// one, and this node's own address otherwise -- which cannot work for a
	// lookup from the device itself, and is logged when it happens.
	Resolver string        `json:"resolver"`
	Peers    []PeerView    `json:"peers"`
	Services []ServiceView `json:"services"`
}

// Status is the whole device.
type Status struct {
	// The one public UDP port, shared by every wave.
	Port    int        `json:"port"`
	Running bool       `json:"running"`
	Waves   []WaveView `json:"waves"`
}

// Status gathers everything a user interface needs, in one pass.
func (e *Engine) Status() Status {
	// In the order the waves were added, from the state -- not from the map of
	// running waves, whose order Go randomises: a list that reshuffles every
	// second is unusable. Enrolments that are paused or did not come up are
	// listed too, so the screen never claims a device is in no wave when it is;
	// one still waiting for its first approval is not a wave yet.
	type listed struct {
		profile Profile
		entry   *wave
	}
	e.mu.Lock()
	entries := make([]listed, 0, len(e.state.Profiles))
	for _, profile := range e.state.Profiles {
		entry := e.waves[profile.Key()]
		if entry == nil && profile.NetmapPublicKey == "" {
			continue
		}
		entries = append(entries, listed{profile: profile, entry: entry})
	}
	// A running wave always has its enrolment in the state; anything else is
	// listed after the rest, sorted, so it cannot reshuffle either.
	extra := []string{}
	for key := range e.waves {
		if !slices.ContainsFunc(entries, func(item listed) bool { return item.entry == e.waves[key] }) {
			extra = append(extra, key)
		}
	}
	slices.Sort(extra)
	for _, key := range extra {
		entries = append(entries, listed{profile: e.waves[key].profile, entry: e.waves[key]})
	}
	running := e.started && !e.stopping
	failures := map[string]string{}
	for url, failure := range e.failures {
		failures[url] = failure
	}
	e.mu.Unlock()

	// Empty lists rather than nil throughout: Go marshals a nil slice as null,
	// and a Swift decoder with a non-optional array refuses that outright --
	// the status would simply stop updating, with nothing to see anywhere.
	status := Status{Running: running, Waves: []WaveView{}}
	if e.sock != nil {
		status.Port = e.sock.Port()
	}

	paths := map[string]wavemagic.PeerStatus{}
	if e.sock != nil {
		for _, peer := range e.sock.Status() {
			paths[peer.WaveID+"|"+peer.NodeKey] = peer
		}
	}

	for _, item := range entries {
		entry := item.entry
		if entry == nil {
			view := WaveView{
				ID:         item.profile.Key(),
				ControlURL: item.profile.ControlURL,
				Label:      labelOf(item.profile),
				Enabled:    item.profile.AutoStart,
				Peers:      []PeerView{},
				Services:   []ServiceView{},
			}
			switch {
			case item.profile.Removed != "":
				view.Problem, view.Detail = "removed", item.profile.Removed
			case item.profile.AutoStart && failures[item.profile.Key()] != "":
				view.Problem, view.Detail = "failed", failures[item.profile.Key()]
			}
			status.Waves = append(status.Waves, view)
			continue
		}
		view := WaveView{
			ID:         entry.key(),
			ControlURL: entry.profile.ControlURL,
			Label:      labelOf(entry.profile),
			Enabled:    true,
			Connected:  entry.socket != nil && entry.socket.Connected(),
			Peers:      []PeerView{},
			Services:   []ServiceView{},
		}
		e.mu.Lock()
		netmap := entry.netmap
		if entry.rejected != "" {
			view.Problem, view.Detail = "netmap-rejected", entry.rejected
		}
		if entry.relay != nil && entry.relay.Connected() {
			view.Relay = entry.relay.URL()
		}
		view.Resolver = entry.resolver
		e.mu.Unlock()
		if netmap != nil {
			if netmap.DNS.Suffix != "" {
				view.Label = netmap.DNS.Suffix
			}
			view.RelayOffered = len(netmap.Relays) > 0
			view.WaveID = netmap.WaveID
			view.Suffix = netmap.DNS.Suffix
			view.Hostname = netmap.Self.Hostname
			view.DNSName = netmap.Self.DNSName
			view.IPv4 = netmap.Self.IPv4
			view.IPv6 = netmap.Self.IPv6
			handshakes := handshakeAges(entry)
			for _, peer := range netmap.Peers {
				peerView := PeerView{
					Hostname: peer.Hostname, DNSName: peer.DNSName,
					IPv4: peer.IPv4, IPv6: peer.IPv6, Online: peer.Online,
					LastHandshakeSeconds: -1,
				}
				if hexKey, err := wavecrypto.KeyToHex(peer.NodeKey); err == nil {
					if age, known := handshakes[hexKey]; known {
						peerView.LastHandshakeSeconds = age
					}
				}
				if path, known := paths[entry.key()+"|"+peer.NodeKey]; known {
					switch {
					case path.Idle:
						// Not probed while nothing is sent to it, so what it
						// had is a memory, not a measurement.
						peerView.Via = "idle"
					case path.ViaRelay:
						peerView.Via = "relay"
					case path.HasBest:
						peerView.Via = path.Best.String()
					}
					if !path.Idle {
						peerView.RTTMs = int(path.RTT / time.Millisecond)
					}
				}
				view.Peers = append(view.Peers, peerView)
			}
			for _, service := range netmap.Services {
				url := service.URL
				if url == "" && service.DNSName != "" {
					url = "https://" + service.DNSName
				}
				view.Services = append(view.Services, ServiceView{
					Name: service.Name, DNSName: service.DNSName, IPv4: service.IPv4, URL: url,
				})
			}
		}
		status.Waves = append(status.Waves, view)
	}
	return status
}

// StatusJSON is what crosses the language boundary. gomobile carries strings
// and numbers, not slices of structs, so the shape above travels as JSON and
// the platform decodes it -- one definition instead of one per language.
func (e *Engine) StatusJSON() string {
	encoded, err := json.Marshal(e.Status())
	if err != nil {
		return `{"running":false,"waves":[]}`
	}
	return string(encoded)
}

// handshakeAges reads, per peer public key in hex, the seconds since the last
// handshake from the wave's WireGuard device. A peer that never shook hands is
// absent.
func handshakeAges(entry *wave) map[string]int {
	ages := map[string]int{}
	if entry.device == nil {
		return ages
	}
	state, err := entry.device.IpcGet()
	if err != nil {
		return ages
	}
	now := time.Now().Unix()
	current := ""
	for _, line := range strings.Split(state, "\n") {
		if key, found := strings.CutPrefix(line, "public_key="); found {
			current = key
			continue
		}
		if seconds, found := strings.CutPrefix(line, "last_handshake_time_sec="); found && current != "" {
			if value, err := strconv.ParseInt(seconds, 10, 64); err == nil && value > 0 {
				ages[current] = int(max(0, now-value))
			}
		}
	}
	return ages
}
