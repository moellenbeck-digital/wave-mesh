import { describe, expect, test } from "bun:test";
import { choosePath, IgnoredErrors, type PathState, probeDue, smoothRtt } from "./magicsock.ts";

const NOW = 100_000;

const path = (key: string, rttMs: number, viaRelay = false): PathState => ({
  key,
  viaRelay,
  learned: false,
  lastPongAt: NOW,
  rttMs,
});

describe("smoothing a path's round-trip time", () => {
  test("the first sample is taken as it is", () => {
    expect(smoothRtt(undefined, 42)).toBe(42);
  });

  test("a single outlier barely moves the average", () => {
    // The measurement that caused this: a direct path reporting 110 ms in
    // between samples of 14 to 21 ms.
    let rtt = 20;
    rtt = smoothRtt(rtt, 110);
    expect(rtt).toBeLessThan(45);
  });

  test("a lasting change is followed inside four samples", () => {
    // Slow enough to ignore noise, fast enough that a path which has really
    // gone bad is seen long before PATH_TIMEOUT_MS drops it.
    let rtt = 20;
    for (let i = 0; i < 4; i++) rtt = smoothRtt(rtt, 200);
    expect(rtt).toBeGreaterThan(110);
  });
});

describe("choosing a path", () => {
  test("takes the only one there is", () => {
    expect(choosePath([path("1.2.3.4:41641", 30)], undefined, NOW)?.key).toBe("1.2.3.4:41641");
  });

  test("a relay has to be clearly better, not merely better", () => {
    const direct = path("1.2.3.4:41641", 50);
    const relay = path("relay", 40, true);
    // 40 + 15 handicap is worse than 50, so the direct path stays.
    expect(choosePath([direct, relay], undefined, NOW)?.key).toBe("1.2.3.4:41641");
  });

  test("a relay that really is better wins", () => {
    const direct = path("1.2.3.4:41641", 120);
    const relay = path("relay", 40, true);
    expect(choosePath([direct, relay], undefined, NOW)?.key).toBe("relay");
  });

  test("the path already carrying traffic keeps it against a hair's breadth", () => {
    const direct = path("1.2.3.4:41641", 30);
    const other = path("5.6.7.8:41641", 28);
    expect(choosePath([direct, other], "1.2.3.4:41641", NOW)?.key).toBe("1.2.3.4:41641");
  });

  test("but loses to a clear improvement", () => {
    const direct = path("1.2.3.4:41641", 30);
    const other = path("5.6.7.8:41641", 15);
    expect(choosePath([direct, other], "1.2.3.4:41641", NOW)?.key).toBe("5.6.7.8:41641");
  });

  test("and on a LAN, half the time is a clear improvement too", () => {
    // Traffic had moved to the round trip through the router's public
    // address during a blip; eight milliseconds better is below the margin,
    // and the LAN never got it back.
    const detour = path("87.123.194.79:16070", 13);
    const lan = path("192.168.178.47:49382", 5);
    expect(choosePath([detour, lan], detour.key, NOW)?.key).toBe(lan.key);
  });

  test("while two close paths on a LAN still keep still", () => {
    const one = path("192.168.178.47:49382", 5);
    const other = path("87.123.194.79:16070", 4);
    expect(choosePath([one, other], one.key, NOW)?.key).toBe(one.key);
  });

  test("a path that stopped answering is no incumbent", () => {
    // Falling off a dead path has to stay immediate; the margin must not
    // protect something that is gone.
    const dead: PathState = {
      key: "1.2.3.4:41641",
      viaRelay: false,
      learned: false,
      lastPongAt: NOW - 20_000,
      rttMs: 5,
    };
    const relay = path("relay", 90, true);
    expect(choosePath([dead, relay], "1.2.3.4:41641", NOW)?.key).toBe("relay");
  });

  test("no answer from anywhere means no path", () => {
    const dead: PathState = {
      key: "relay",
      viaRelay: true,
      learned: false,
      lastPongAt: NOW - 20_000,
      rttMs: 5,
    };
    expect(choosePath([dead], "relay", NOW)).toBeUndefined();
  });

  test("the measured flapping stops", () => {
    // The samples behind the report: a direct path over WiFi swinging between
    // 14 and 110 ms against a relay sitting in the middle of that range. Every
    // crossing used to be a path change, and there was one on nearly every
    // probe.
    const directSamples = [21, 110, 14, 55, 18, 96, 24, 61, 16, 88, 22, 47];
    const relaySamples = [92, 46, 42, 38, 51, 44, 40, 49, 43, 39, 47, 41];

    const direct: PathState = { key: "1.2.3.4:41641", viaRelay: false, learned: false };
    const relay: PathState = { key: "relay", viaRelay: true, learned: false };
    let current: string | undefined;
    let switches = 0;

    for (let i = 0; i < directSamples.length; i++) {
      const at = NOW + i * 3_000;
      direct.rttMs = smoothRtt(direct.rttMs, directSamples[i] as number);
      direct.lastPongAt = at;
      relay.rttMs = smoothRtt(relay.rttMs, relaySamples[i] as number);
      relay.lastPongAt = at;

      const chosen = choosePath([direct, relay], current, at);
      if (chosen?.key !== current) switches++;
      current = chosen?.key;
    }

    // One: the first choice. Anything beyond that is the noise coming back.
    expect(switches).toBe(1);
    expect(current).toBe("1.2.3.4:41641");

    // And the fixture is adversarial rather than merely calm: the old rule --
    // last sample, no margin -- changes path on most of these.
    let naiveSwitches = 0;
    let naive: string | undefined;
    for (let i = 0; i < directSamples.length; i++) {
      const pick = (directSamples[i] as number) <= (relaySamples[i] as number) + 15 ? "direct" : "relay";
      if (pick !== naive) naiveSwitches++;
      naive = pick;
    }
    expect(naiveSwitches).toBeGreaterThan(5);
  });
});

/**
 * The errors a probing socket is supposed to get: a peer publishes a candidate
 * that is unroutable from here, we send to it, ICMP comes back. They used to be
 * one log line each, saying "unknown" -- and eight of those are the whole event
 * list a daemon keeps per enrolment.
 */
describe("the socket errors that are expected", () => {
  test("a trickle is collected instead of printed", () => {
    const ignored = new IgnoredErrors();
    expect(ignored.note(0)).toBeNull();
    expect(ignored.note(1_000)).toBeNull();
    expect(ignored.note(59_999)).toBeNull();
  });

  test("and named once the window is full", () => {
    const ignored = new IgnoredErrors();
    for (let i = 0; i < 120; i++) expect(ignored.note(i * 500)).toBeNull();
    const line = ignored.note(60_000);
    expect(line).toContain("121 socket error(s) ignored in 60s");
  });

  // A storm says something a trickle does not, so the count has to start over
  // rather than keep growing into a number nobody can read.
  test("the next window counts from zero", () => {
    const ignored = new IgnoredErrors();
    ignored.note(0);
    expect(ignored.note(60_000)).toContain("2 socket error(s)");
    expect(ignored.note(90_000)).toBeNull();
    expect(ignored.note(120_001)).toContain("2 socket error(s)");
  });
});

/**
 * The cadence of probing. A candidate that never answers used to be pinged on
 * every tick, forever -- and every ping to it is an ICMP error here and a NAT
 * entry on the router in front of us.
 */
describe("when a path is probed", () => {
  test("a path that was never pinged is due at once", () => {
    expect(probeDue({}, 0, false)).toBe(true);
  });

  test("in the fast phase every tick pings, even one that fires a little early", () => {
    expect(probeDue({ lastPingAt: 1_000 }, 1_249, true)).toBe(true);
    expect(probeDue({ lastPingAt: 1_000 }, 1_100, true)).toBe(false);
  });

  test("after it, a candidate that never answered waits as long as a live path", () => {
    const silent = { lastPingAt: 10_000 };
    expect(probeDue(silent, 10_250, false)).toBe(false);
    expect(probeDue(silent, 12_000, false)).toBe(false);
    expect(probeDue(silent, 13_000, false)).toBe(true);
  });

  test("so a dead candidate costs one ping per slow interval, not four a second", () => {
    const path: { lastPingAt?: number } = {};
    let pings = 0;
    for (let now = 0; now < 60_000; now += 250) {
      if (probeDue(path, now, false)) {
        path.lastPingAt = now;
        pings++;
      }
    }
    expect(pings).toBe(20);
  });
});
