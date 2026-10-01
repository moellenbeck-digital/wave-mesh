import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPair } from "@wave/crypto";
import { encodeDisco, newTxid, sharedKey } from "@wave/disco";
import { currentReflexive, MAX_REFLEXIVE, MagicSock, REFLEXIVE_TTL_MS } from "./magicsock.ts";
import { buildBindingResponse, isBindingRequest } from "./stun.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function waitFor<T>(predicate: () => T | undefined | false, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(20);
  }
}

/** Stands in for wireguard-go: records what arrives and can inject packets. */
async function fakeWireguard() {
  const received: Uint8Array[] = [];
  const socket = await Bun.udpSocket({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data: (_s, data) => void received.push(new Uint8Array(data)) },
  });
  cleanup.push(() => socket.close());
  return {
    port: socket.port,
    received,
    send(data: Uint8Array, to: { ip: string; port: number }) {
      socket.send(data, to.port, to.ip);
    },
  };
}

async function makeNode() {
  const disco = generateKeyPair("x25519");
  const node = generateKeyPair("x25519");
  const wg = await fakeWireguard();
  const sock = new MagicSock({
    listenPort: 0,
    discoPrivateKey: disco.privateKey,
    discoPublicKey: disco.publicKey,
    wireguardPort: wg.port,
  });
  await sock.start();
  cleanup.push(() => sock.close());
  return { disco, node, wg, sock, config: { nodeKey: node.publicKey, discoKey: disco.publicKey } };
}

const wireguardPacket = (marker: number): Uint8Array => {
  const packet = new Uint8Array(64);
  packet[0] = 1; // WireGuard handshake initiation
  packet[63] = marker;
  return packet;
};

describe("path discovery", () => {
  test("two nodes that know each other's address find a direct path", async () => {
    const a = await makeNode();
    const b = await makeNode();

    await a.sock.setPeers([{ ...b.config, candidates: [{ ip: "127.0.0.1", port: b.sock.port }] }]);
    await b.sock.setPeers([{ ...a.config, candidates: [{ ip: "127.0.0.1", port: a.sock.port }] }]);
    a.sock.enableProbing();
    b.sock.enableProbing();

    const status = await waitFor(() => a.sock.status().find((peer) => peer.best));
    expect(status.best).toEqual({ ip: "127.0.0.1", port: b.sock.port });
    expect(status.rttMs).toBeGreaterThanOrEqual(0);
    expect(status.rttMs).toBeLessThan(1000);
  });

  test("a node learns a peer's address from an inbound packet alone", async () => {
    const a = await makeNode();
    const b = await makeNode();

    // B is told nothing about A -- the one-sided symmetric NAT case, where the
    // only usable address is the one A's packets actually arrive from.
    await b.sock.setPeers([{ ...a.config, candidates: [] }]);
    await a.sock.setPeers([{ ...b.config, candidates: [{ ip: "127.0.0.1", port: b.sock.port }] }]);
    a.sock.enableProbing();
    b.sock.enableProbing();

    const learned = await waitFor(() => b.sock.status().find((peer) => peer.paths.some((p) => p.learned)));
    expect(learned.paths.some((path) => path.endpoint?.port === a.sock.port)).toBe(true);
    await waitFor(() => a.sock.status().find((peer) => peer.best));
  });

  test("stays silent until its own addresses have been published", async () => {
    const a = await makeNode();
    const b = await makeNode();

    // Probing early is not merely useless, it is harmful: the packets arrive at
    // the peer's NAT as an unsolicited inbound flow and can occupy the very
    // mapping the peer needs for its own outbound traffic.
    await a.sock.setPeers([{ ...b.config, candidates: [{ ip: "127.0.0.1", port: b.sock.port }] }]);
    await b.sock.setPeers([{ ...a.config, candidates: [] }]);

    await Bun.sleep(600);
    expect(b.sock.status()[0]?.paths).toHaveLength(0);
    expect(a.sock.status()[0]?.best).toBeUndefined();

    a.sock.enableProbing();
    b.sock.enableProbing();
    await waitFor(() => a.sock.status().find((peer) => peer.best));
  });

  test("forgets peers that left the netmap", async () => {
    const a = await makeNode();
    const b = await makeNode();
    await a.sock.setPeers([{ ...b.config, candidates: [{ ip: "127.0.0.1", port: b.sock.port }] }]);
    expect(a.sock.status()).toHaveLength(1);
    await a.sock.setPeers([]);
    expect(a.sock.status()).toHaveLength(0);
    expect(a.sock.endpointForWireguard(b.config.nodeKey)).toBeUndefined();
  });

  test("forgets candidates a peer no longer announces", async () => {
    const a = await makeNode();
    const b = await makeNode();
    const stale = { ip: "127.0.0.1", port: 9 };
    const current = { ip: "127.0.0.1", port: b.sock.port };

    // Merging only ever added: every address a peer had published since this
    // process started stayed a path, and each one was probed on every tick.
    await a.sock.setPeers([{ ...b.config, candidates: [stale, current] }]);
    expect(a.sock.status()[0]?.paths).toHaveLength(2);
    await a.sock.setPeers([{ ...b.config, candidates: [current] }]);
    expect(a.sock.status()[0]?.paths.map((path) => path.endpoint)).toEqual([current]);
  });

  test("keeps a withdrawn path while it still answers", async () => {
    const a = await makeNode();
    const b = await makeNode();
    await a.sock.setPeers([{ ...b.config, candidates: [{ ip: "127.0.0.1", port: b.sock.port }] }]);
    await b.sock.setPeers([{ ...a.config, candidates: [{ ip: "127.0.0.1", port: a.sock.port }] }]);
    a.sock.enableProbing();
    b.sock.enableProbing();
    await waitFor(() => a.sock.status().find((peer) => peer.best));

    // The netmap can lag behind the traffic; the path carrying it stays.
    await a.sock.setPeers([{ ...b.config, candidates: [] }]);
    expect(a.sock.status()[0]?.best).toEqual({ ip: "127.0.0.1", port: b.sock.port });
  });
});

describe("binding", () => {
  test("falls back to an ephemeral port when the preferred one is taken", async () => {
    const squatter = await Bun.udpSocket({ port: 0, socket: { data: () => {} } });
    cleanup.push(() => squatter.close());

    const disco = generateKeyPair("x25519");
    const wg = await fakeWireguard();
    const messages: string[] = [];
    const sock = new MagicSock({
      listenPort: squatter.port,
      discoPrivateKey: disco.privateKey,
      discoPublicKey: disco.publicKey,
      wireguardPort: wg.port,
      log: (message) => messages.push(message),
    });
    await sock.start();
    cleanup.push(() => sock.close());

    expect(sock.port).not.toBe(squatter.port);
    expect(sock.port).toBeGreaterThan(0);
    expect(messages.some((message) => message.includes("already in use"))).toBe(true);
  });
});

describe("packet forwarding", () => {
  test("carries WireGuard traffic across the confirmed path", async () => {
    const a = await makeNode();
    const b = await makeNode();
    await a.sock.setPeers([{ ...b.config, candidates: [{ ip: "127.0.0.1", port: b.sock.port }] }]);
    await b.sock.setPeers([{ ...a.config, candidates: [{ ip: "127.0.0.1", port: a.sock.port }] }]);
    a.sock.enableProbing();
    b.sock.enableProbing();
    await waitFor(() => a.sock.status().find((peer) => peer.best));

    const endpoint = a.sock.endpointForWireguard(b.config.nodeKey);
    expect(endpoint?.ip).toBe("127.0.0.1");
    a.wg.send(wireguardPacket(42), endpoint as { ip: string; port: number });

    const arrived = await waitFor(() => b.wg.received.find((packet) => packet[63] === 42));
    expect(arrived).toBeDefined();
  });

  test("sprays to every candidate while no path is confirmed", async () => {
    const a = await makeNode();
    const b = await makeNode();
    const decoy = await Bun.udpSocket({ hostname: "127.0.0.1", port: 0, socket: { data: () => {} } });
    cleanup.push(() => decoy.close());

    // B never answers, so nothing is ever confirmed; the packet must still go
    // to both candidates rather than being held back.
    await a.sock.setPeers([
      {
        ...b.config,
        candidates: [
          { ip: "127.0.0.1", port: decoy.port },
          { ip: "127.0.0.1", port: b.sock.port },
        ],
      },
    ]);
    const endpoint = a.sock.endpointForWireguard(b.config.nodeKey);
    a.wg.send(wireguardPacket(7), endpoint as { ip: string; port: number });

    // B's magicsock drops it (unknown source), but it reached B's socket.
    await Bun.sleep(200);
    expect(a.sock.status()[0]?.paths).toHaveLength(2);
  });

  test("drops traffic from an address that belongs to no peer", async () => {
    const a = await makeNode();
    const stranger = await Bun.udpSocket({ hostname: "127.0.0.1", port: 0, socket: { data: () => {} } });
    cleanup.push(() => stranger.close());

    stranger.send(wireguardPacket(9), a.sock.port, "127.0.0.1");
    await Bun.sleep(150);
    expect(a.wg.received).toHaveLength(0);
  });

  test("ignores a disco packet sealed with the wrong key", async () => {
    const a = await makeNode();
    const b = await makeNode();
    const impostor = generateKeyPair("x25519");
    await a.sock.setPeers([{ ...b.config, candidates: [] }]);

    const forged = encodeDisco({
      senderDiscoKey: b.disco.publicKey,
      sharedKey: sharedKey(impostor.privateKey, a.disco.publicKey),
      message: { type: "ping", txid: newTxid() },
    });
    const attacker = await Bun.udpSocket({ hostname: "127.0.0.1", port: 0, socket: { data: () => {} } });
    cleanup.push(() => attacker.close());
    attacker.send(forged, a.sock.port, "127.0.0.1");

    await Bun.sleep(200);
    expect(a.sock.status()[0]?.paths.some((path) => path.endpoint?.port === attacker.port)).toBe(false);
  });
});

describe("STUN", () => {
  test("discovers the reflexive address and classifies the mapping", async () => {
    const servers = await Promise.all(
      [0, 0].map(async () => {
        const server = await Bun.udpSocket({
          hostname: "127.0.0.1",
          port: 0,
          socket: {
            data(socket, data, port, address) {
              if (isBindingRequest(data))
                socket.send(buildBindingResponse(data, { ip: address, port }), port, address);
            },
          },
        });
        cleanup.push(() => server.close());
        return { ip: "127.0.0.1", port: server.port };
      }),
    );

    const disco = generateKeyPair("x25519");
    const wg = await fakeWireguard();
    const sock = new MagicSock({
      listenPort: 0,
      discoPrivateKey: disco.privateKey,
      discoPublicKey: disco.publicKey,
      wireguardPort: wg.port,
      stunServers: servers,
    });
    await sock.start();
    cleanup.push(() => sock.close());

    const result = await sock.discoverReflexive();
    expect(result.mapped).toHaveLength(2);
    expect(result.mapped[0]?.port).toBe(sock.port);
    expect(result.mapping).toBe("endpoint-independent");
    expect(sock.reflexiveCandidates()).toHaveLength(1);
  });

  test("forgets its own addresses behind a NAT that maps every query to a new port", async () => {
    // Stands in for a port-randomising NAT: every answer names a port never
    // seen before. Before the age limit, each round added one for good.
    let next = 20_000;
    const server = await Bun.udpSocket({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket, data, port, address) {
          if (isBindingRequest(data))
            socket.send(buildBindingResponse(data, { ip: "203.0.113.7", port: next++ }), port, address);
        },
      },
    });
    cleanup.push(() => server.close());

    let now = 1_000_000;
    const disco = generateKeyPair("x25519");
    const wg = await fakeWireguard();
    const sock = new MagicSock({
      listenPort: 0,
      discoPrivateKey: disco.privateKey,
      discoPublicKey: disco.publicKey,
      wireguardPort: wg.port,
      stunServers: [{ ip: "127.0.0.1", port: server.port }],
      now: () => now,
    });
    await sock.start();
    cleanup.push(() => sock.close());

    for (let round = 0; round < 20; round++) {
      await sock.discoverReflexive();
      now += 60_000;
    }
    const left = sock.reflexiveCandidates();
    expect(left.length).toBeLessThanOrEqual(3);
    // The newest survive, not the first ones.
    expect(left.at(-1)?.port).toBe(next - 1);
  });
});

describe("own addresses", () => {
  const seen = (port: number, seenAt: number) => ({ mapped: { ip: "203.0.113.7", port }, seenAt });

  test("keeps what was reported recently, oldest first", () => {
    const now = 1_000_000;
    const result = currentReflexive(
      [seen(3, now), seen(1, now - REFLEXIVE_TTL_MS - 1), seen(2, now - 1000)],
      now,
    );
    expect(result.map((m) => m.port)).toEqual([2, 3]);
  });

  test("keeps only the newest few", () => {
    const now = 1_000_000;
    const entries = Array.from({ length: 30 }, (_, index) => seen(index, now - 30 + index));
    const result = currentReflexive(entries, now);
    expect(result).toHaveLength(MAX_REFLEXIVE);
    expect(result.at(-1)?.port).toBe(29);
  });
});

describe("choosing between paths", () => {
  test("prefers a direct path over a relay at similar latency", async () => {
    // Equal round-trip times are the common case on a fast local link, and
    // there the relay must not win: it costs someone else's bandwidth and puts
    // a third party in the path.
    const a = await makeNode();
    const b = await makeNode();
    await a.sock.setPeers([{ ...b.config, candidates: [{ ip: "127.0.0.1", port: b.sock.port }] }]);
    await b.sock.setPeers([{ ...a.config, candidates: [{ ip: "127.0.0.1", port: a.sock.port }] }]);
    a.sock.enableProbing();
    b.sock.enableProbing();

    const status = await waitFor(() => a.sock.status().find((peer) => peer.best));
    expect(status.viaRelay).toBe(false);
  });
});
