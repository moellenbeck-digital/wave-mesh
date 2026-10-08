import { describe, expect, test } from "bun:test";
import { ProfileStatus } from "@wave/ipc";
import { assessHealth, STALE_AFTER_SECONDS } from "../src/health.ts";

const profile = (overrides: Record<string, unknown>) =>
  ProfileStatus.parse({ controlUrl: "https://wave.example.com", state: "up", ...overrides });
const peer = (lastHandshakeSecondsAgo: number | null) => ({
  hostname: "laptop",
  dnsName: "laptop.wave.example.com",
  ipv4: "10.64.0.2",
  ipv6: "",
  lastHandshakeSecondsAgo,
});

describe("the connector's liveness", () => {
  test("a tunnel with a fresh handshake is healthy", () => {
    expect(assessHealth([profile({ peers: [peer(null), peer(40)] })])).toEqual({ healthy: true });
  });

  test("no peers at all is not a fault", () => {
    expect(assessHealth([profile({ peers: [] })])).toEqual({ healthy: true });
  });

  // The failure this exists for: up, connected to its server, shown online --
  // and nothing getting through to anyone.
  test("peers but no handshake with any of them for ten minutes is not", () => {
    const verdict = assessHealth([profile({ peers: [peer(null), peer(STALE_AFTER_SECONDS + 1)] })]);
    expect(verdict.healthy).toBe(false);
  });

  test("a relay offered but not connected is not", () => {
    const verdict = assessHealth([
      profile({ relay: { url: "wss://relay.example.com/relay", connected: false }, peers: [peer(5)] }),
    ]);
    expect(verdict).toEqual({
      healthy: false,
      reason: "the relay wss://relay.example.com/relay is not connected",
    });
  });

  test("a tunnel that is not up, or no wave at all, is not", () => {
    expect(assessHealth([profile({ state: "failed" })]).healthy).toBe(false);
    expect(assessHealth([]).healthy).toBe(false);
  });
});
