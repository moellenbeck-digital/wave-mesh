package wavemagic_test

import (
	"net/netip"
	"testing"
	"time"

	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavemagic"
)

var now = time.Unix(1_790_000_000, 0)

func alive(key string, rtt time.Duration, viaRelay bool) *wavemagic.Path {
	path := &wavemagic.Path{Key: key, ViaRelay: viaRelay, LastPongAt: now, RTT: rtt}
	if !viaRelay {
		path.Endpoint = netip.MustParseAddrPort(key)
	}
	return path
}

func TestTheFirstSampleIsTakenAsItIs(t *testing.T) {
	if got := wavemagic.SmoothRTT(0, 42*time.Millisecond); got != 42*time.Millisecond {
		t.Fatalf("got %v", got)
	}
}

// The measurement that caused the smoothing: a direct path reporting 110 ms in
// between samples of 14 to 21 ms.
func TestASingleOutlierBarelyMovesTheAverage(t *testing.T) {
	rtt := wavemagic.SmoothRTT(20*time.Millisecond, 110*time.Millisecond)
	if rtt >= 45*time.Millisecond {
		t.Fatalf("got %v", rtt)
	}
}

// Slow enough to ignore noise, fast enough that a path which has really gone
// bad is seen long before the timeout drops it.
func TestALastingChangeIsFollowedInsideFourSamples(t *testing.T) {
	rtt := 20 * time.Millisecond
	for i := 0; i < 4; i++ {
		rtt = wavemagic.SmoothRTT(rtt, 200*time.Millisecond)
	}
	if rtt <= 110*time.Millisecond {
		t.Fatalf("got %v", rtt)
	}
}

func TestTakesTheOnlyPathThereIs(t *testing.T) {
	chosen := wavemagic.ChoosePath([]*wavemagic.Path{alive("1.2.3.4:41641", 30*time.Millisecond, false)}, "", now)
	if chosen == nil || chosen.Key != "1.2.3.4:41641" {
		t.Fatalf("got %v", chosen)
	}
}

// 40 + 15 handicap is worse than 50, so the direct path stays.
func TestARelayHasToBeClearlyBetter(t *testing.T) {
	paths := []*wavemagic.Path{
		alive("1.2.3.4:41641", 50*time.Millisecond, false),
		alive("relay", 40*time.Millisecond, true),
	}
	if chosen := wavemagic.ChoosePath(paths, "", now); chosen.Key != "1.2.3.4:41641" {
		t.Fatalf("got %s", chosen.Key)
	}
}

func TestARelayThatReallyIsBetterWins(t *testing.T) {
	paths := []*wavemagic.Path{
		alive("1.2.3.4:41641", 120*time.Millisecond, false),
		alive("relay", 40*time.Millisecond, true),
	}
	if chosen := wavemagic.ChoosePath(paths, "", now); chosen.Key != "relay" {
		t.Fatalf("got %s", chosen.Key)
	}
}

func TestTheIncumbentKeepsTrafficAgainstAHairsBreadth(t *testing.T) {
	paths := []*wavemagic.Path{
		alive("1.2.3.4:41641", 30*time.Millisecond, false),
		alive("5.6.7.8:41641", 28*time.Millisecond, false),
	}
	if chosen := wavemagic.ChoosePath(paths, "1.2.3.4:41641", now); chosen.Key != "1.2.3.4:41641" {
		t.Fatalf("got %s", chosen.Key)
	}
}

func TestButLosesToAClearImprovement(t *testing.T) {
	paths := []*wavemagic.Path{
		alive("1.2.3.4:41641", 30*time.Millisecond, false),
		alive("5.6.7.8:41641", 15*time.Millisecond, false),
	}
	if chosen := wavemagic.ChoosePath(paths, "1.2.3.4:41641", now); chosen.Key != "5.6.7.8:41641" {
		t.Fatalf("got %s", chosen.Key)
	}
}

// Traffic had moved to the round trip through the router's public address
// during a blip; eight milliseconds better is below the margin, and the LAN
// never got it back.
func TestOnALANHalfTheTimeIsAClearImprovementToo(t *testing.T) {
	paths := []*wavemagic.Path{
		alive("87.123.194.79:16070", 13*time.Millisecond, false),
		alive("192.168.178.47:49382", 5*time.Millisecond, false),
	}
	if chosen := wavemagic.ChoosePath(paths, "87.123.194.79:16070", now); chosen.Key != "192.168.178.47:49382" {
		t.Fatalf("got %s", chosen.Key)
	}
}

func TestTwoClosePathsOnALANStillKeepStill(t *testing.T) {
	paths := []*wavemagic.Path{
		alive("192.168.178.47:49382", 5*time.Millisecond, false),
		alive("87.123.194.79:16070", 4*time.Millisecond, false),
	}
	if chosen := wavemagic.ChoosePath(paths, "192.168.178.47:49382", now); chosen.Key != "192.168.178.47:49382" {
		t.Fatalf("got %s", chosen.Key)
	}
}

// Falling off a dead path has to stay immediate; the margin must not protect
// something that is gone.
func TestAPathThatStoppedAnsweringIsNoIncumbent(t *testing.T) {
	dead := alive("1.2.3.4:41641", 5*time.Millisecond, false)
	dead.LastPongAt = now.Add(-20 * time.Second)
	paths := []*wavemagic.Path{dead, alive("relay", 90*time.Millisecond, true)}
	if chosen := wavemagic.ChoosePath(paths, "1.2.3.4:41641", now); chosen.Key != "relay" {
		t.Fatalf("got %s", chosen.Key)
	}
}

func TestNoAnswerFromAnywhereMeansNoPath(t *testing.T) {
	dead := alive("relay", 5*time.Millisecond, true)
	dead.LastPongAt = now.Add(-20 * time.Second)
	if chosen := wavemagic.ChoosePath([]*wavemagic.Path{dead}, "relay", now); chosen != nil {
		t.Fatalf("got %s", chosen.Key)
	}
}

// The samples behind the report: a direct path over WiFi swinging between 14
// and 110 ms against a relay sitting in the middle of that range. Every
// crossing used to be a path change, and there was one on nearly every probe.
func TestTheMeasuredFlappingStops(t *testing.T) {
	directSamples := []int{21, 110, 14, 55, 18, 96, 24, 61, 16, 88, 22, 47}
	relaySamples := []int{92, 46, 42, 38, 51, 44, 40, 49, 43, 39, 47, 41}

	direct := &wavemagic.Path{Key: "1.2.3.4:41641", Endpoint: netip.MustParseAddrPort("1.2.3.4:41641")}
	relay := &wavemagic.Path{Key: "relay", ViaRelay: true}
	current := ""
	switches := 0

	for i := range directSamples {
		at := now.Add(time.Duration(i) * 3 * time.Second)
		direct.RTT = wavemagic.SmoothRTT(direct.RTT, time.Duration(directSamples[i])*time.Millisecond)
		direct.LastPongAt = at
		relay.RTT = wavemagic.SmoothRTT(relay.RTT, time.Duration(relaySamples[i])*time.Millisecond)
		relay.LastPongAt = at

		chosen := wavemagic.ChoosePath([]*wavemagic.Path{direct, relay}, current, at)
		key := ""
		if chosen != nil {
			key = chosen.Key
		}
		if key != current {
			switches++
		}
		current = key
	}

	// One: the first choice. Anything beyond that is the noise coming back.
	if switches != 1 {
		t.Fatalf("%d path changes", switches)
	}
	if current != "1.2.3.4:41641" {
		t.Fatalf("ended on %s", current)
	}

	// And the fixture is adversarial rather than merely calm: the old rule --
	// last sample, no margin -- changes path on most of these.
	naive, naiveSwitches := "", 0
	for i := range directSamples {
		pick := "relay"
		if directSamples[i] <= relaySamples[i]+15 {
			pick = "direct"
		}
		if pick != naive {
			naiveSwitches++
		}
		naive = pick
	}
	if naiveSwitches <= 5 {
		t.Fatalf("the fixture is not adversarial: %d naive changes", naiveSwitches)
	}
}

func TestCurrentReflexiveForgetsWhatNobodyReportsAnyMore(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	address := func(port uint16) netip.AddrPort {
		return netip.AddrPortFrom(netip.MustParseAddr("203.0.113.7"), port)
	}
	got := wavemagic.CurrentReflexive(map[netip.AddrPort]wavemagic.SeenAddress{
		address(3): {FirstSeenAt: now.Add(-time.Minute), SeenAt: now},
		address(1): {FirstSeenAt: now.Add(-time.Hour), SeenAt: now.Add(-wavemagic.ReflexiveTTL - time.Second)},
		address(2): {FirstSeenAt: now.Add(-time.Hour), SeenAt: now.Add(-time.Second)},
	}, now)
	want := []netip.AddrPort{address(2), address(3)}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("got %v, want %v (recent ones, oldest first)", got, want)
	}
}

// A ceiling on top of the age limit; before it, a connector behind a
// port-randomising NAT published 2670 addresses.
func TestCurrentReflexiveKeepsOnlyTheNewestFew(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	seen := map[netip.AddrPort]wavemagic.SeenAddress{}
	for index := 0; index < 30; index++ {
		address := netip.AddrPortFrom(netip.MustParseAddr("203.0.113.7"), uint16(1000+index))
		seen[address] = wavemagic.SeenAddress{FirstSeenAt: now.Add(-time.Hour), SeenAt: now.Add(time.Duration(index-30) * time.Second)}
	}
	got := wavemagic.CurrentReflexive(seen, now)
	if len(got) != wavemagic.MaxReflexive {
		t.Fatalf("kept %d, want %d", len(got), wavemagic.MaxReflexive)
	}
	if got[len(got)-1].Port() != 1029 {
		t.Fatalf("the newest must survive, got %v", got)
	}
}

// Behind a NAT that hands out a fresh port every round, the list must stop
// changing: each change was a netmap for the whole wave, every minute.
func TestCurrentReflexiveHoldsBackAPortThatReplacesAnother(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	address := func(port uint16) netip.AddrPort {
		return netip.AddrPortFrom(netip.MustParseAddr("203.0.113.7"), port)
	}
	first := wavemagic.CurrentReflexive(map[netip.AddrPort]wavemagic.SeenAddress{
		address(1): {FirstSeenAt: now, SeenAt: now},
	}, now)
	if len(first) != 1 {
		t.Fatalf("a first address was held back: %v", first)
	}
	churning := wavemagic.CurrentReflexive(map[netip.AddrPort]wavemagic.SeenAddress{
		address(1): {FirstSeenAt: now.Add(-2 * time.Minute), SeenAt: now.Add(-2 * time.Minute)},
		address(2): {FirstSeenAt: now.Add(-time.Minute), SeenAt: now.Add(-time.Minute)},
		address(3): {FirstSeenAt: now, SeenAt: now},
	}, now)
	if len(churning) != 0 {
		t.Fatalf("ports seen once each were published: %v", churning)
	}
	confirmed := wavemagic.CurrentReflexive(map[netip.AddrPort]wavemagic.SeenAddress{
		address(1): {FirstSeenAt: now.Add(-time.Hour), SeenAt: now.Add(-time.Minute)},
		address(2): {FirstSeenAt: now, SeenAt: now},
	}, now)
	if len(confirmed) != 1 || confirmed[0] != address(1) {
		t.Fatalf("got %v, want only the confirmed port", confirmed)
	}
	// Reported many times within a second -- the pongs of one wake-up's
	// check -- is still one sighting. Behind carrier NAT the mapping is gone
	// after the next sleep, and counting the pongs published every new port.
	burst := wavemagic.CurrentReflexive(map[netip.AddrPort]wavemagic.SeenAddress{
		address(1): {FirstSeenAt: now.Add(-time.Minute), SeenAt: now.Add(-time.Minute)},
		address(2): {FirstSeenAt: now.Add(-time.Second), SeenAt: now},
	}, now)
	if len(burst) != 0 {
		t.Fatalf("a port reported in one burst was published: %v", burst)
	}
}

// The cadence of probing. A candidate that never answers used to be pinged on
// every tick, forever -- and every ping to it is an ICMP error here and a NAT
// entry on the router in front of us.

func TestAPathThatWasNeverPingedIsDueAtOnce(t *testing.T) {
	if !wavemagic.ProbeDue(&wavemagic.Path{}, now, false) {
		t.Fatal("a fresh path waited for its first probe")
	}
}

func TestInTheFastPhaseEveryTickPingsEvenAnEarlyOne(t *testing.T) {
	path := &wavemagic.Path{LastPingAt: now}
	if !wavemagic.ProbeDue(path, now.Add(249*time.Millisecond), true) {
		t.Fatal("a tick that fired a millisecond early was skipped")
	}
	if wavemagic.ProbeDue(path, now.Add(100*time.Millisecond), true) {
		t.Fatal("pinged twice inside one tick")
	}
}

func TestADeadCandidateCostsOnePingPerSlowInterval(t *testing.T) {
	path := &wavemagic.Path{}
	pings := 0
	for elapsed := time.Duration(0); elapsed < time.Minute; elapsed += 250 * time.Millisecond {
		at := now.Add(elapsed)
		if wavemagic.ProbeDue(path, at, false) {
			path.LastPingAt = at
			pings++
		}
	}
	if pings != 20 {
		t.Fatalf("%d pings in a minute to a candidate that never answers, want 20", pings)
	}
}
