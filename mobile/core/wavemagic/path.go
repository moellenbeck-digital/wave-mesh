// Package wavemagic owns the one public UDP socket on the device and
// multiplexes everything that arrives on it.
//
// It is the Go half of packages/magicsock, with the change D10 turns on: there
// is one socket for every wave, not one per wave, and wireguard-go takes it as
// a conn.Bind instead of talking to a loopback socket per peer. The loopback
// trick only ever existed because Bun cannot offer WireGuard a Bind; as a
// library, it can be handed the real thing, and each wave's device gets a view
// of this socket that delivers only its own packets.
//
// The one public port is a simplification rather than a loss: there is one
// candidate list and one reflexive address, published to all N control servers,
// instead of STUNing once per wave.
package wavemagic

import (
	"net/netip"
	"time"
)

// How long a path is usable after the last pong.
const pathTimeout = 15 * time.Second

// Probe aggressively at first: the window where both NATs are open is short.
const (
	probeFast         = 250 * time.Millisecond
	probeSlow         = 3 * time.Second
	probeFastDuration = 5 * time.Second
)

// ProbeDue reports whether a path is owed a probe.
//
// The cadence runs from the last ping, not the last pong. Timed from the pong,
// a candidate that never answers was due on every tick -- four pings a second
// for as long as the peer existed, each one an ICMP rejection on our socket and
// a NAT entry on the router in front of us; on a phone, a radio kept awake for
// nothing. The fast phase is what punching needs, and it still pings everything
// at probeFast; after it, an unanswered candidate is asked as often as a live
// path, which is enough to notice it coming back. The same as on the desktop.
//
// Half a tick of slack: the ticker fires every probeFast, and one that arrives
// a moment early would otherwise skip a tick and halve the fast phase.
func ProbeDue(p *Path, now time.Time, fast bool) bool {
	if p.LastPingAt.IsZero() {
		return true
	}
	interval := probeSlow
	if fast {
		interval = probeFast
	}
	return now.Sub(p.LastPingAt) >= interval-probeFast/2
}

// relayPenalty is how much better a relay has to be before it beats a direct
// path. A relayed path is not equal to a direct one at the same latency: it
// spends someone else's bandwidth and puts a third party in the path.
const relayPenalty = 15 * time.Millisecond

// rttAlpha is the weight of a fresh sample in a path's round-trip time.
//
// One probe every three seconds over WiFi swings by an order of magnitude --
// measured between two of our own nodes: the same direct path reported 14 ms
// and 110 ms within a minute. Deciding on the last sample meant crossing the
// relay's latency again and again, and the path changed on nearly every probe.
// A quarter weight settles in about four samples, which is well inside
// pathTimeout, so a path that genuinely goes bad is still noticed long before
// it is dropped.
//
// A phone makes this worse, not better: it changes network while it is being
// carried, which is exactly the motion this smooths over.
const rttAlpha = 0.25

// switchMargin is how much better a challenger has to be before the current
// path is given up.
//
// Separate from relayPenalty, which says what a relay is worth; this says that
// changing path is not free. Smoothing alone still leaves two paths trading
// places whenever their averages sit within a millisecond of each other, and a
// switch reorders whatever is in flight.
const switchMargin = 10 * time.Millisecond

// switchRatio is the fraction of the incumbent's time at which a challenger
// wins regardless.
//
// The margin alone is absolute, and on a LAN everything is smaller than it:
// after a blip had moved traffic from the LAN (5 ms) onto the round trip
// through the router's public address (13 ms), the LAN could never take it
// back -- eight milliseconds is not ten -- and every packet kept crossing the
// router's NAT for as long as the detour lived. Seen on the desktop on
// 28.09.2026. Half the time is not noise between two smoothed averages; it is
// a different path. The same as on the desktop.
const switchRatio = 0.5

// maxSpray is how many paths a single WireGuard packet may be sprayed to while
// no path is confirmed.
const maxSpray = 8

// RelayPathKey is the path key the relayed path is filed under. A direct path
// uses "ip:port", which can never collide with it.
const RelayPathKey = "relay"

// Path is one way to reach a peer.
type Path struct {
	// "ip:port" for a direct path, RelayPathKey for the relayed one.
	Key      string
	Endpoint netip.AddrPort
	ViaRelay bool
	// Discovered from an inbound packet rather than announced by the peer.
	Learned bool
	// When the last probe went out; the cadence runs from here (see ProbeDue).
	LastPingAt time.Time
	LastPongAt time.Time
	// Zero until the first pong; see Alive.
	RTT time.Duration
}

// Alive reports whether a pong arrived recently enough for this path to carry
// traffic.
func (p *Path) Alive(now time.Time) bool {
	return !p.LastPongAt.IsZero() && now.Sub(p.LastPongAt) <= pathTimeout
}

// SmoothRTT folds a new sample into a path's round-trip time.
//
// Pure and exported because this is where the flapping was decided, and it is
// testable without a network -- unlike everything around it.
func SmoothRTT(previous, sample time.Duration) time.Duration {
	if previous == 0 {
		return sample
	}
	return previous + time.Duration(rttAlpha*float64(sample-previous))
}

// ChoosePath decides which path should carry the traffic.
//
// Lowest round-trip time wins, with a handicap for the relay and a margin for
// whichever path is already carrying the traffic.
//
// Without the handicap the choice would come down to noise whenever the two are
// close. Without the margin it would come down to noise anyway, one step
// further along: two paths whose averages sit a millisecond apart would swap on
// every probe. The incumbent therefore only loses to a clear improvement -- and
// a path that has stopped answering is not an incumbent at all, so falling off
// a dead path stays immediate.
func ChoosePath(paths []*Path, current string, now time.Time) *Path {
	score := func(path *Path) time.Duration {
		value := path.RTT
		if value == 0 {
			value = time.Duration(1<<62 - 1)
		}
		if path.ViaRelay {
			value += relayPenalty
		}
		return value
	}

	var best, incumbent *Path
	for _, path := range paths {
		if !path.Alive(now) {
			continue
		}
		if path.Key == current {
			incumbent = path
		}
		if best == nil || score(path) < score(best) {
			best = path
		}
	}

	if incumbent != nil && best != nil && best.Key != incumbent.Key {
		clearlyBetter := score(best) <= score(incumbent)-switchMargin ||
			float64(score(best)) <= float64(score(incumbent))*switchRatio
		if !clearlyBetter {
			return incumbent
		}
	}
	return best
}
