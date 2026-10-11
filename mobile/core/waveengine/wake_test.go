package waveengine

import (
	"strings"
	"testing"
	"time"
)

func (h *fakeHost) count(prefix string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	found := 0
	for _, line := range h.lines {
		if strings.HasPrefix(line, prefix) {
			found++
		}
	}
	return found
}

// The answers to a wake-up's check arrive after iOS has put the phone back to
// sleep, wake it, and come back as the next wake(). Checking each of those
// again kept a phone awake every few seconds; within wakeQuiet they pass.
func TestAWakeUpSoonAfterACheckAsksNothing(t *testing.T) {
	engine, host := newTestEngine(t)
	engine.live = true
	now := time.Date(2026, 10, 11, 3, 0, 0, 0, time.UTC)
	engine.clock = func() time.Time { return now }

	engine.Woke()
	for range 9 {
		now = now.Add(6 * time.Second)
		engine.Woke()
	}
	if checks := host.count("woke up; checking"); checks != 1 {
		t.Fatalf("%d checks in a minute of wake-ups, want 1", checks)
	}

	now = now.Add(wakeQuiet)
	engine.Woke()
	if checks := host.count("woke up; checking"); checks != 2 {
		t.Fatalf("%d checks after a quiet minute, want 2", checks)
	}
	if host.count("woke up; checking connections (9 wake-up(s)") != 1 {
		t.Fatalf("the skipped wake-ups are not counted: %v", host.lines)
	}
}

// A clock set back -- by the network, or by hand -- must not hold the checks
// back until it has caught up again.
func TestAClockSetBackDoesNotSilenceWakeUps(t *testing.T) {
	engine, host := newTestEngine(t)
	engine.live = true
	now := time.Date(2026, 10, 11, 3, 0, 0, 0, time.UTC)
	engine.clock = func() time.Time { return now }

	engine.Woke()
	now = now.Add(-time.Hour)
	engine.Woke()
	if checks := host.count("woke up; checking"); checks != 2 {
		t.Fatalf("%d checks, want 2", checks)
	}
}

// What counts is the wall clock: Go's monotonic reading stops while a Darwin
// device sleeps, and a phone back after a night would look just checked.
func TestTheWakeClockIsTheWallClock(t *testing.T) {
	engine := &Engine{}
	if now := engine.wallNow(); now != now.Round(0) {
		t.Fatal("the wake clock carries a monotonic reading")
	}
}
