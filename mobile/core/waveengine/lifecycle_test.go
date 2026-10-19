package waveengine

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavecrypto"
	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavetun"
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

// A server that cannot be reached is no longer an error to a login but a wait,
// so these tests give up the way a person does: by ending the context.
func givingUpSoon(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	t.Cleanup(cancel)
	return ctx
}

func TestAFailedFirstLoginLeavesNoEnrolmentBehind(t *testing.T) {
	host := &fakeHost{}
	engine := New(Options{Host: host, RetryMin: 10 * time.Millisecond})
	err := engine.Login(givingUpSoon(t), unreachableControlURL(t), "")
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
	engine := New(Options{Host: host, RetryMin: 10 * time.Millisecond, State: State{Version: StateVersion, Profiles: []Profile{profile}}})
	if err := engine.Login(givingUpSoon(t), controlURL, ""); err == nil {
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

// A netmap that adds a peer must not touch the others: their sessions, and
// so their traffic, carry on. Checked on a real wireguard-go device, by key
// and by the handshake state the device reports.
func TestANewNetmapKeepsThePeersThatStay(t *testing.T) {
	engine, _ := newTestEngine(t)
	entry := addWave(t, engine, "https://a.example")
	stays := testPeer(t, "laptop", "a.wave.example.com", "10.77.0.2", "fd7a:1::2")
	leaves := testPeer(t, "old", "a.wave.example.com", "10.77.0.3", "fd7a:1::3")
	joins := testPeer(t, "new", "a.wave.example.com", "10.77.0.4", "fd7a:1::4")

	if err := engine.applyNetmap(entry, netmapFor(t, "w1", "a.wave.example.com", "10.77.0.1", "fd7a:1::1", stays, leaves)); err != nil {
		t.Fatal(err)
	}
	// Mark the staying peer the way a handshake would: if it is re-created,
	// this is gone.
	stayKey, _ := wavecrypto.KeyToHex(stays.NodeKey)
	if err := entry.device.IpcSet("public_key=" + stayKey + "\npreshared_key=" + strings.Repeat("ab", 32) + "\n"); err != nil {
		t.Fatal(err)
	}

	if err := engine.applyNetmap(entry, netmapFor(t, "w1", "a.wave.example.com", "10.77.0.1", "fd7a:1::1", stays, joins)); err != nil {
		t.Fatal(err)
	}
	state, err := entry.device.IpcGet()
	if err != nil {
		t.Fatal(err)
	}
	keys := configuredPeers(state)
	leaveKey, _ := wavecrypto.KeyToHex(leaves.NodeKey)
	joinKey, _ := wavecrypto.KeyToHex(joins.NodeKey)
	if !slices.Contains(keys, stayKey) || !slices.Contains(keys, joinKey) || slices.Contains(keys, leaveKey) {
		t.Fatalf("peers after the second netmap: %v", keys)
	}
	if !strings.Contains(state, "preshared_key="+strings.Repeat("ab", 32)) {
		t.Fatal("the staying peer was re-created, and with it its session")
	}
}

// The server removing the device used to be a log line: the phone kept its
// last netmap and reconnected forever, refused every time, while the screen
// said "not connected". Now the wave comes down, stays listed as removed,
// and only a new login brings it back.
func TestTheServerEndingAnEnrolmentTakesTheWaveDown(t *testing.T) {
	engine, host := newTestEngine(t)
	entry := addWave(t, engine, "https://a.example")
	engine.mu.Lock()
	engine.state.Profiles = append(engine.state.Profiles, entry.profile)
	engine.mu.Unlock()

	engine.endedByServer("https://a.example", "node-removed")

	engine.mu.Lock()
	_, running := engine.waves["https://a.example"]
	engine.mu.Unlock()
	if running {
		t.Fatal("the removed wave is still running")
	}
	waves := engine.Status().Waves
	if len(waves) != 1 || waves[0].Problem != "removed" || waves[0].Enabled {
		t.Fatalf("status %+v", waves)
	}
	saved, err := ParseState(host.saved)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Profiles[0].Removed != "node-removed" || saved.Profiles[0].AutoStart {
		t.Fatalf("not kept: %+v", saved.Profiles[0])
	}
	if err := engine.SetEnabled("https://a.example", true); err == nil {
		t.Fatal("a removed wave was switched back on without a login")
	}
}

// Leaving a wave that is not running -- paused, or it did not come up --
// still tells the server, or the device stays there as a ghost.
func TestLeavingAPausedWaveTellsTheServer(t *testing.T) {
	var mu sync.Mutex
	var seen []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.Method+" "+r.URL.Path)
		mu.Unlock()
		_, _ = w.Write([]byte("{}"))
	}))
	defer server.Close()

	profile, err := NewProfile(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	profile.NetmapPublicKey = testKey(t)
	profile.AutoStart = false
	engine := New(Options{Host: &fakeHost{}, State: State{Version: StateVersion, Profiles: []Profile{profile}}})
	engine.mux = wavetun.New(newMemoryLink(), 1280, func(string) {})
	if err := engine.Logout(context.Background(), server.URL); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if !slices.Contains(seen, "POST /v1/node/logout") {
		t.Fatalf("the server was not told: %v", seen)
	}
}

// Settings the platform refused are not remembered as applied, and are
// offered again by themselves.
func TestRefusedSettingsAreOfferedAgain(t *testing.T) {
	previous := applyRetry
	applyRetry = 100 * time.Millisecond
	t.Cleanup(func() { applyRetry = previous })

	engine, host := newTestEngine(t)
	host.mu.Lock()
	host.refuse = 1
	host.mu.Unlock()
	entry := addWave(t, engine, "https://a.example")
	if err := engine.applyNetmap(entry, netmapFor(t, "w1", "a.wave.example.com", "10.77.0.1", "fd7a:1::1")); err == nil {
		t.Fatal("the refusal was not reported")
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if len(host.applications()) == 1 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("the refused settings were never offered again")
}

func TestHelloSaysWhatThePlatformIs(t *testing.T) {
	if New(Options{}).hello() != nil {
		t.Fatal("a hello without a platform")
	}
	hello := New(Options{Platform: "ios", Version: "0.8.0"}).hello()
	if hello == nil || hello.Type != "hello" || hello.Platform != "ios" || hello.Version != "0.8.0" {
		t.Fatalf("hello %+v", hello)
	}
}

// An older netmap verifies as well as a newer one; applied over it, it would
// bring back a peer the server has removed since. It is refused.
func TestAnOlderNetmapIsNotAppliedOverANewerOne(t *testing.T) {
	engine, _ := newTestEngine(t)
	entry := addWave(t, engine, "https://a.example")
	laptop := testPeer(t, "laptop", "a.wave.example.com", "10.77.0.2", "fd7a:1::2")

	older := netmapFor(t, "w1", "a.wave.example.com", "10.77.0.1", "fd7a:1::1", laptop)
	older.IssuedAt = "2026-10-07T10:00:00Z"
	newer := netmapFor(t, "w1", "a.wave.example.com", "10.77.0.1", "fd7a:1::1")
	newer.IssuedAt = "2026-10-07T10:05:00Z"

	if err := engine.applyNetmap(entry, newer); err != nil {
		t.Fatal(err)
	}
	if err := engine.applyNetmap(entry, older); err == nil {
		t.Fatal("an older netmap was applied over a newer one")
	}
	if peers := engine.Status().Waves[0].Peers; len(peers) != 0 {
		t.Fatalf("the removed peer came back: %+v", peers)
	}
	// A newer one still goes through.
	newest := netmapFor(t, "w1", "a.wave.example.com", "10.77.0.1", "fd7a:1::1", laptop)
	newest.IssuedAt = "2026-10-07T10:10:00Z"
	if err := engine.applyNetmap(entry, newest); err != nil {
		t.Fatal(err)
	}
}

// Two waves at one server -- two projects, kept apart on purpose -- are two
// enrolments with keys of their own, and everything addresses them by key:
// pausing or leaving one leaves the other alone, and the server's address
// alone still means the first, as it did for apps that only knew addresses.
func TestTwoWavesAtOneServerStayApart(t *testing.T) {
	engine, _ := newTestEngine(t)
	first := addWave(t, engine, "https://wave.example")
	extra, err := NewAdditionalProfile("https://wave.example")
	if err != nil {
		t.Fatal(err)
	}
	second := addProfile(t, engine, extra)
	if first.key() == second.key() {
		t.Fatalf("both enrolments are filed as %s", first.key())
	}
	engine.mu.Lock()
	engine.state.Profiles = append(engine.state.Profiles, first.profile, second.profile)
	engine.mu.Unlock()
	if err := engine.applyNetmap(first, netmapFor(t, "w1", "project-a.example", "10.77.0.1", "fd7a:1::1")); err != nil {
		t.Fatal(err)
	}
	if err := engine.applyNetmap(second, netmapFor(t, "w2", "project-b.example", "10.96.0.1", "fd7a:2::1")); err != nil {
		t.Fatal(err)
	}

	waves := engine.Status().Waves
	if len(waves) != 2 || waves[0].Label != "project-a.example" || waves[1].Label != "project-b.example" {
		t.Fatalf("status %+v", waves)
	}
	if waves[0].ControlURL != waves[1].ControlURL || waves[0].ID == waves[1].ID {
		t.Fatalf("ids %q and %q at %q and %q", waves[0].ID, waves[1].ID, waves[0].ControlURL, waves[1].ControlURL)
	}

	if err := engine.SetEnabled(second.key(), false); err != nil {
		t.Fatal(err)
	}
	waves = engine.Status().Waves
	if !waves[0].Enabled || waves[1].Enabled {
		t.Fatalf("pausing the second touched the first: %+v", waves)
	}
	// The address alone means the first enrolment there.
	if key, ok := engine.resolve("wave.example"); !ok || key != first.key() {
		t.Fatalf("the address resolved to %q", key)
	}
	if err := engine.Logout(context.Background(), second.key()); err != nil {
		t.Fatal(err)
	}
	waves = engine.Status().Waves
	if len(waves) != 1 || waves[0].ID != first.key() {
		t.Fatalf("leaving the second took the first with it: %+v", waves)
	}
}

// AddWave with nothing at that server yet is a plain login: there is nothing
// to add to.
func TestAddingAWaveWhereThereIsNoneIsALogin(t *testing.T) {
	host := &fakeHost{}
	engine := New(Options{Host: host, RetryMin: 10 * time.Millisecond})
	if err := engine.AddWave(givingUpSoon(t), unreachableControlURL(t), ""); err == nil {
		t.Fatal("joined nobody")
	}
	if len(engine.state.Profiles) != 0 {
		t.Fatalf("left %d enrolments behind", len(engine.state.Profiles))
	}
}

// iOS starts the core on its own thread and can report a wake or a path
// change before that is through. There is no socket to rebind then, and the
// nil one used to take the whole tunnel down.
func TestANetworkChangeBeforeStartIsIgnored(t *testing.T) {
	engine := New(Options{Host: &fakeHost{}})
	engine.NetworkChanged()
}
