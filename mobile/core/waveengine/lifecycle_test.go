package waveengine

import (
	"context"
	"net"
	"testing"
	"time"
)

// A login that never got approved used to leave its enrolment in the state,
// and the next start then failed on it. Both halves are checked here: the
// failed first login forgets the enrolment, and a start with a broken one
// still comes up.

func unreachableControlURL(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	_ = listener.Close()
	return "http://" + address
}

func TestAFailedFirstLoginLeavesNoEnrolmentBehind(t *testing.T) {
	host := &fakeHost{}
	engine := New(Options{Host: host})
	err := engine.Login(context.Background(), unreachableControlURL(t), "")
	if err == nil {
		t.Fatal("a login to nobody succeeded")
	}
	if len(engine.state.Profiles) != 0 {
		t.Fatalf("the failed login left %d enrolments behind", len(engine.state.Profiles))
	}
	saved, err := ParseState(host.saved)
	if err != nil {
		t.Fatal(err)
	}
	if len(saved.Profiles) != 0 {
		t.Fatalf("the saved state still has %d enrolments", len(saved.Profiles))
	}
}

func TestAFailedLoginKeepsAnEnrolmentThatWasApprovedBefore(t *testing.T) {
	host := &fakeHost{}
	controlURL := unreachableControlURL(t)
	profile, err := NewProfile(controlURL)
	if err != nil {
		t.Fatal(err)
	}
	profile.NetmapPublicKey = testKey(t)
	engine := New(Options{Host: host, State: State{Version: StateVersion, Profiles: []Profile{profile}}})
	if err := engine.Login(context.Background(), controlURL, ""); err == nil {
		t.Fatal("a login to nobody succeeded")
	}
	if len(engine.state.Profiles) != 1 {
		t.Fatalf("an approved enrolment was dropped on a failed re-login")
	}
}

func TestANeverApprovedLeftoverIsForgottenAtStart(t *testing.T) {
	host := &fakeHost{}
	broken, err := NewProfile("https://never-approved.example")
	if err != nil {
		t.Fatal(err)
	}
	engine := New(Options{Host: host, State: State{Version: StateVersion, Profiles: []Profile{broken}}})
	if err := engine.Start(newMemoryLink(), 1280); err != nil {
		t.Fatalf("start failed because of a leftover: %v", err)
	}
	t.Cleanup(engine.Stop)
	saved, err := ParseState(host.saved)
	if err != nil {
		t.Fatal(err)
	}
	if len(saved.Profiles) != 0 {
		t.Fatalf("the leftover is still saved: %+v", saved.Profiles)
	}
}

func TestTheStatusKeepsTheOrderTheWavesWereAddedIn(t *testing.T) {
	engine, _ := newTestEngine(t)
	for _, url := range []string{"https://c.example", "https://a.example", "https://b.example"} {
		entry := addWave(t, engine, url)
		engine.mu.Lock()
		engine.state.Profiles = append(engine.state.Profiles, entry.profile)
		engine.mu.Unlock()
	}
	for i := 0; i < 20; i++ {
		waves := engine.Status().Waves
		if len(waves) != 3 || waves[0].Label != "c.example" || waves[1].Label != "a.example" || waves[2].Label != "b.example" {
			t.Fatalf("order changed: %+v", waves)
		}
	}
}

func TestAPausedWaveStaysListedAndEnrolled(t *testing.T) {
	engine, host := newTestEngine(t)
	entry := addWave(t, engine, "https://a.example")
	engine.mu.Lock()
	engine.state.Profiles = append(engine.state.Profiles, entry.profile)
	engine.mu.Unlock()

	if err := engine.SetEnabled("a.example", false); err != nil {
		t.Fatal(err)
	}
	engine.mu.Lock()
	_, running := engine.waves["https://a.example"]
	engine.mu.Unlock()
	if running {
		t.Fatal("the paused wave is still running")
	}
	waves := engine.Status().Waves
	if len(waves) != 1 || waves[0].Enabled {
		t.Fatalf("status %+v", waves)
	}
	saved, err := ParseState(host.saved)
	if err != nil {
		t.Fatal(err)
	}
	if len(saved.Profiles) != 1 || saved.Profiles[0].AutoStart {
		t.Fatalf("the pause was not kept: %+v", saved.Profiles)
	}
}

func TestANameChangeAppliesToTheNextEnrolment(t *testing.T) {
	engine := New(Options{Hostname: "iPhone"})
	engine.SetHostname("  Max iPhone ")
	if engine.hostname() != "Max iPhone" {
		t.Fatalf("hostname %q", engine.hostname())
	}
}

// Build 4 locked the engine's mutex in bringUp and then asked for the
// hostname, which locks it again: every approved wave hung its login and every
// later start, forever. No test brought up an approved wave, so this one does --
// against a control server that is not there, which fails fast instead of
// hanging the test on the network.
func TestAnApprovedWaveComesUpWithoutHanging(t *testing.T) {
	host := &fakeHost{}
	profile, err := NewProfile(unreachableControlURL(t))
	if err != nil {
		t.Fatal(err)
	}
	profile.NetmapPublicKey = testKey(t)
	engine := New(Options{Host: host, Hostname: "phone", State: State{Version: StateVersion, Profiles: []Profile{profile}}})

	started := make(chan error, 1)
	go func() { started <- engine.Start(newMemoryLink(), 1280) }()
	select {
	case err := <-started:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Start hung on an approved wave")
	}
	t.Cleanup(engine.Stop)

	status := make(chan Status, 1)
	go func() { status <- engine.Status() }()
	select {
	case got := <-status:
		if len(got.Waves) != 1 || !got.Waves[0].Enabled {
			t.Fatalf("status %+v", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Status hung after the wave came up")
	}
}
