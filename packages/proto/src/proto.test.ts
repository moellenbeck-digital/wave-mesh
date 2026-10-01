import { describe, expect, test } from "bun:test";
import { ClientMessage, ServerMessage } from "./control.ts";
import { DISCO_MAGIC, isDiscoPacket } from "./disco.ts";
import { NodeKey, PublicKey32 } from "./keys.ts";
import { formatEndpoint, parseEndpoint } from "./net.ts";
import { DnsConfig, Netmap } from "./netmap.ts";

const key = (c: string) => c.repeat(43) + "=";

const peer = {
  id: "n_1",
  nodeKey: key("A"),
  discoKey: key("B"),
  hostname: "laptop",
  dnsName: "laptop.wave.example.com",
  ipv4: "100.64.0.2",
  ipv6: "fd7a:1::2",
  allowedIps: ["100.64.0.2/32", "fd7a:1::2/128"],
  candidates: [{ kind: "stun", ip: "203.0.113.7", port: 41641 }],
  online: true,
  keyExpiresAt: "2026-12-01T00:00:00.000Z",
};

const netmap = {
  version: 1,
  waveId: "w_1",
  self: { ...peer, id: "n_0", ipv4: "100.64.0.1", ipv6: "fd7a:1::1", addresses: ["100.64.0.1/32"] },
  peers: [peer],
  dns: { suffix: "wave.example.com", routes: [] },
  relays: [{ id: "r_fsn", region: "fsn", url: "https://relay.example.com" }],
  issuedAt: "2026-09-13T12:00:00.000Z",
};

describe("keys", () => {
  test("accepts a base64-encoded 32-byte key", () => {
    expect(PublicKey32.parse(key("A"))).toBe(key("A"));
  });

  test("rejects keys of the wrong length", () => {
    expect(NodeKey.safeParse("too-short").success).toBe(false);
    expect(NodeKey.safeParse(key("A").slice(0, -1)).success).toBe(false);
  });
});

describe("endpoints", () => {
  test("round-trips IPv4", () => {
    const e = { ip: "203.0.113.7", port: 41641 };
    expect(parseEndpoint(formatEndpoint(e))).toEqual(e);
  });

  test("round-trips IPv6 with brackets", () => {
    const e = { ip: "fd7a:1::2", port: 41641 };
    expect(formatEndpoint(e)).toBe("[fd7a:1::2]:41641");
    expect(parseEndpoint("[fd7a:1::2]:41641")).toEqual(e);
  });

  test("rejects junk instead of throwing", () => {
    expect(parseEndpoint("not-an-endpoint")).toBeNull();
    expect(parseEndpoint("203.0.113.7:99999")).toBeNull();
  });
});

describe("netmap", () => {
  test("parses a complete netmap", () => {
    const parsed = Netmap.parse(netmap);
    expect(parsed.peers[0]?.dnsName).toBe("laptop.wave.example.com");
  });

  // Nothing inside a netmap may have a default. The signature covers the
  // canonical encoding of what the server sent, so inventing a field the server
  // left out would canonicalise something else and report a good netmap as
  // forged -- the same failure, from the other direction, that made every
  // schema below Netmap a looseObject.
  test("invents no resolver address when the server sent none", () => {
    const parsed = DnsConfig.parse({ suffix: "wave.example.com", routes: [] });
    expect(parsed.resolverAddress).toBeUndefined();
    expect("resolverAddress" in parsed).toBe(false);
  });

  // Stated as "the same keys came back", because that is what canonicalisation
  // sees. Comparing the encodings themselves would mean depending on
  // @wave/crypto from here, and the contract has no business depending on the
  // thing that signs it.
  test("parsing a netmap adds no field the server did not send", () => {
    const sent = { ...netmap, dns: { suffix: "wave.example.com", routes: [] } };
    const parsed = Netmap.parse(sent);
    expect(Object.keys(parsed.dns).sort()).toEqual(Object.keys(sent.dns).sort());
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(sent).sort());
  });

  test("rejects a peer without allowed IPs", () => {
    const broken = { ...netmap, peers: [{ ...peer, allowedIps: [] }] };
    expect(Netmap.safeParse(broken).success).toBe(false);
  });

  test("rejects a malformed address", () => {
    const broken = { ...netmap, peers: [{ ...peer, ipv4: "100.64.0.300" }] };
    expect(Netmap.safeParse(broken).success).toBe(false);
  });
});

describe("control messages", () => {
  test("parses a hello", () => {
    const msg = {
      type: "hello",
      version: "0.1.0",
      platform: "linux-amd64",
      channel: "insiders",
      autoUpdate: true,
    };
    expect(ClientMessage.parse(msg).type).toBe("hello");
    // The channel is optional -- leaving it to the servers is the default --
    // but not free text: a typo must not reach the server as a wish.
    expect(ClientMessage.safeParse({ ...msg, channel: undefined }).success).toBe(true);
    expect(ClientMessage.safeParse({ ...msg, channel: "beta" }).success).toBe(false);
  });

  test("rejects an unknown message type", () => {
    expect(ClientMessage.safeParse({ type: "nope" }).success).toBe(false);
  });

  test("parses a disco hint", () => {
    const msg = {
      type: "disco-hint",
      nodeId: "n_1",
      candidates: [{ kind: "learned", ip: "203.0.113.7", port: 1024 }],
    };
    expect(ServerMessage.parse(msg).type).toBe("disco-hint");
  });
});

describe("disco framing", () => {
  test("recognises its own packets", () => {
    expect(isDiscoPacket(new Uint8Array([...DISCO_MAGIC, 1, 1]))).toBe(true);
  });

  test("never claims a WireGuard packet", () => {
    // WireGuard message types 1..4 in the first byte, zero-padded header.
    for (const type of [1, 2, 3, 4]) {
      expect(isDiscoPacket(new Uint8Array([type, 0, 0, 0, 0, 0, 0, 0]))).toBe(false);
    }
  });
});
