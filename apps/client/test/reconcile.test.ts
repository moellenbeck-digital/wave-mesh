import { describe, expect, test } from "bun:test";
import { generateKeyPair } from "@wave/crypto";
import { Netmap, Peer } from "@wave/proto";
import { desiredRoutes, KEEPALIVE_SECONDS, planDeviceUpdate } from "../src/reconcile.ts";
import type { WgDeviceState } from "../src/wgctl.ts";

const local = { privateKey: generateKeyPair("x25519").privateKey, listenPort: 41641 };
const peerKey = generateKeyPair("x25519").publicKey;

/** Fixtures go through the real schemas, so they cannot drift from the wire format. */
const peer = (over: Record<string, unknown> = {}): Peer =>
  Peer.parse({
    id: "n_1",
    nodeKey: peerKey,
    discoKey: generateKeyPair("x25519").publicKey,
    hostname: "phone",
    dnsName: "phone.robin.wave.internal",
    ipv4: "100.64.0.2",
    ipv6: "fd7a:1:2::2",
    allowedIps: ["100.64.0.2/32", "fd7a:1:2::2/128"],
    candidates: [{ kind: "local", ip: "192.168.1.20", port: 41641 }],
    online: true,
    keyExpiresAt: null,
    ...over,
  });

const netmap = (peers: Peer[]): Netmap =>
  Netmap.parse({
    version: 1,
    waveId: "w_1",
    self: { ...peer({ id: "n_0", ipv4: "100.64.0.1" }), addresses: ["100.64.0.1/32", "fd7a:1:2::1/128"] },
    peers,
    dns: { suffix: "robin.wave.internal", routes: [] },
    relays: [],
    issuedAt: new Date().toISOString(),
  });

const empty: WgDeviceState = { listenPort: 0, peers: [] };

const configured = (over: Partial<WgDeviceState["peers"][number]> = {}): WgDeviceState => ({
  privateKey: local.privateKey,
  listenPort: local.listenPort,
  peers: [
    {
      publicKey: peerKey,
      endpoint: "192.168.1.20:41641",
      allowedIps: ["100.64.0.2/32", "fd7a:1:2::2/128"],
      persistentKeepalive: KEEPALIVE_SECONDS,
      lastHandshakeSeconds: 0,
      rxBytes: 0,
      txBytes: 0,
      ...over,
    },
  ],
});

describe("planDeviceUpdate", () => {
  test("configures key, port and peers on an empty device", () => {
    const plan = planDeviceUpdate(empty, netmap([peer()]), local);
    expect(plan.privateKey).toBe(local.privateKey);
    expect(plan.listenPort).toBe(41641);
    expect(plan.upsert).toHaveLength(1);
    expect(plan.upsert[0]?.endpoint).toBe("192.168.1.20:41641");
    expect(plan.remove).toEqual([]);
  });

  test("is a no-op when the device already matches", () => {
    const plan = planDeviceUpdate(configured(), netmap([peer()]), local);
    expect(plan).toEqual({ upsert: [], remove: [] });
  });

  test("updates a peer whose endpoint moved", () => {
    const moved = peer({ candidates: [{ kind: "local", ip: "192.168.1.99", port: 41641 }] });
    const plan = planDeviceUpdate(configured(), netmap([moved]), local);
    expect(plan.upsert[0]?.endpoint).toBe("192.168.1.99:41641");
  });

  test("updates a peer whose allowed IPs changed", () => {
    const renumbered = peer({ allowedIps: ["100.64.0.7/32"] });
    const plan = planDeviceUpdate(configured(), netmap([renumbered]), local);
    expect(plan.upsert[0]?.allowedIps).toEqual(["100.64.0.7/32"]);
  });

  test("ignores allowed-IP ordering", () => {
    const reordered = peer({ allowedIps: ["fd7a:1:2::2/128", "100.64.0.2/32"] });
    expect(planDeviceUpdate(configured(), netmap([reordered]), local).upsert).toEqual([]);
  });

  test("removes peers that left the wave", () => {
    const plan = planDeviceUpdate(configured(), netmap([]), local);
    expect(plan.remove).toEqual([peerKey]);
    expect(plan.upsert).toEqual([]);
  });

  test("rewrites the private key if the device carries a different one", () => {
    const foreign = { ...configured(), privateKey: generateKeyPair("x25519").privateKey };
    expect(planDeviceUpdate(foreign, netmap([peer()]), local).privateKey).toBe(local.privateKey);
  });

  test("prefers a STUN candidate over a local one", () => {
    const both = peer({
      candidates: [
        { kind: "local", ip: "192.168.1.20", port: 41641 },
        { kind: "stun", ip: "203.0.113.9", port: 5000 },
      ],
    });
    expect(planDeviceUpdate(empty, netmap([both]), local).upsert[0]?.endpoint).toBe("203.0.113.9:5000");
  });

  test("leaves the endpoint unset when a peer has published none", () => {
    const unreachable = peer({ candidates: [] });
    expect(planDeviceUpdate(empty, netmap([unreachable]), local).upsert[0]?.endpoint).toBeUndefined();
  });
});

describe("desiredRoutes", () => {
  test("covers every address of every peer", () => {
    expect(desiredRoutes(netmap([peer()]))).toEqual(["100.64.0.2/32", "fd7a:1:2::2/128"]);
  });
});
