package wavemagic

import (
	"testing"
	"time"
)

func sockAt(now *time.Time) *Sock {
	sock := New(Options{Now: func() time.Time { return *now }})
	sock.probingEnabled = true
	return sock
}

// The probe loop leaves its fast tick once no peer is in a fast phase, and
// returns to it when one begins. Checked on the decision itself: the interval
// with an active peer added just now, and with the same peer five seconds
// later.
func TestTheProbeLoopSlowsDownWhenNothingIsBeingPunched(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	sock := sockAt(&now)
	sock.peers[peerKey{waveID: "w", nodeKey: "k"}] = &peer{probingSince: now, lastSend: now, paths: map[string]*Path{}}
	if got := sock.probeInterval(); got != probeFast {
		t.Fatalf("a peer added just now ticks every %v, want %v", got, probeFast)
	}
	now = now.Add(probeFastDuration + time.Millisecond)
	if got := sock.probeInterval(); got != probeIdle {
		t.Fatalf("still %v after the fast phase ended: the loop would tick four times a second for ever", got)
	}
}

// The battery case: a peer nothing has been sent to is neither probed nor a
// reason for the loop to wake up -- not even in the fast phase a netmap or a
// punch hint starts.
func TestAPeerNothingIsSentToIsNotProbed(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	sock := sockAt(&now)
	idle := &peer{probingSince: now, paths: map[string]*Path{
		"192.0.2.1:41641": {Key: "192.0.2.1:41641"},
	}}
	sock.peers[peerKey{waveID: "w", nodeKey: "k"}] = idle

	if got := sock.probeInterval(); got != probeDormant {
		t.Fatalf("an idle peer in its fast phase ticks every %v, want %v", got, probeDormant)
	}
	sock.probePeer(idle)
	if len(sock.inflight) != 0 {
		t.Fatalf("an idle peer was probed: %d ping(s) in flight", len(sock.inflight))
	}
}

// A peer stops being probed activeTimeout after the last packet to it, and the
// first packet after that starts a fast phase again.
func TestSendingWakesAnIdlePeer(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	sock := sockAt(&now)
	subject := &peer{
		config:       PeerConfig{WaveID: "w", NodeKey: "k"},
		probingSince: now.Add(-time.Hour),
		lastSend:     now.Add(-time.Hour),
		paths:        map[string]*Path{},
	}
	sock.peers[peerKey{waveID: "w", nodeKey: "k"}] = subject

	sock.sendToPeer("w", "k", []byte{1})
	if !subject.activeAt(now) {
		t.Fatal("a packet just sent leaves the peer idle")
	}
	if got := sock.probeInterval(); got != probeFast {
		t.Fatalf("the first packet after a quiet spell ticks every %v, want the fast phase", got)
	}
	select {
	case <-sock.probeKick:
	default:
		t.Fatal("the loop was not woken: it would sleep out its dormant tick first")
	}

	now = now.Add(activeTimeout)
	if subject.activeAt(now) {
		t.Fatalf("still active %v after the last packet", activeTimeout)
	}
}
