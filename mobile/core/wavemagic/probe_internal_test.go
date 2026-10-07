package wavemagic

import (
	"testing"
	"time"
)

// The probe loop leaves its fast tick once no peer is in a fast phase, and
// returns to it when one begins. Checked on the decision itself: anyFastPhase
// with a peer added just now, and with the same peer five seconds later.
func TestTheProbeLoopSlowsDownWhenNothingIsBeingPunched(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	sock := New(Options{Now: func() time.Time { return now }})
	sock.mu.Lock()
	sock.probingEnabled = true
	sock.peers[peerKey{waveID: "w", nodeKey: "k"}] = &peer{probingSince: now, paths: map[string]*Path{}}
	sock.mu.Unlock()
	if !sock.anyFastPhase() {
		t.Fatal("a peer added just now is not in its fast phase")
	}
	now = now.Add(probeFastDuration + time.Millisecond)
	if sock.anyFastPhase() {
		t.Fatal("still fast after the fast phase ended: the loop would tick four times a second for ever")
	}
}
