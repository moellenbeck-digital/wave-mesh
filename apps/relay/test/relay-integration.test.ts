import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPair } from "@wave/crypto";
import { MagicSock, RelayClient } from "@wave/magicsock";
import { solveChallenge, startRelayServer } from "../src/relay-server.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function waitFor<T>(predicate: () => T | undefined | false, timeoutMs = 5000): Promise<T> {
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

async function makeNode(relayPort: number) {
  const disco = generateKeyPair("x25519");
  const node = generateKeyPair("x25519");
  const wg = await fakeWireguard();
  const sock = new MagicSock({
    listenPort: 0,
    discoPrivateKey: disco.privateKey,
    discoPublicKey: disco.publicKey,
    wireguardPort: wg.port,
    log:
      process.env.DEBUG_RELAY === "1"
        ? (m) => console.log(`[${disco.publicKey.slice(0, 4)}] ${m}`)
        : undefined,
    verbose: process.env.DEBUG_RELAY === "1",
  });
  await sock.start();
  cleanup.push(() => sock.close());

  const relay = new RelayClient({
    url: `ws://127.0.0.1:${relayPort}/relay`,
    discoPublicKey: disco.publicKey,
    discoPrivateKey: disco.privateKey,
    onPacket: (sender, payload) => sock.onRelayPacket(sender, payload),
  });
  relay.connect();
  cleanup.push(() => relay.close());
  sock.setRelay(relay);

  return { disco, wg, sock, relay, config: { nodeKey: node.publicKey, discoKey: disco.publicKey } };
}

const wireguardPacket = (marker: number): Uint8Array => {
  const packet = new Uint8Array(64);
  packet[0] = 1; // WireGuard handshake initiation
  packet[63] = marker;
  return packet;
};

/** A port nothing listens on, standing in for a candidate that cannot work. */
const DEAD_CANDIDATE = { ip: "127.0.0.1", port: 9 };

describe("relay fallback", () => {
  test("carries traffic between peers that have no working direct path", async () => {
    const server = await startRelayServer({ port: 0, hostname: "127.0.0.1" });
    cleanup.push(() => server.stop());

    const a = await makeNode(server.port);
    const b = await makeNode(server.port);
    await waitFor(() => a.relay.connected && b.relay.connected);

    await a.sock.setPeers([{ ...b.config, candidates: [DEAD_CANDIDATE] }]);
    await b.sock.setPeers([{ ...a.config, candidates: [DEAD_CANDIDATE] }]);
    a.sock.enableProbing();
    b.sock.enableProbing();

    const status = await waitFor(() =>
      a.sock.status().find((peer) => peer.best !== undefined || peer.viaRelay),
    );
    expect(status.viaRelay).toBe(true);

    const endpoint = a.sock.endpointForWireguard(b.config.nodeKey);
    a.wg.send(wireguardPacket(21), endpoint as { ip: string; port: number });

    const arrived = await waitFor(() => b.wg.received.find((packet) => packet[63] === 21));
    expect(arrived).toBeDefined();
    expect(server.forwarded()).toBeGreaterThan(0);
  });

  test("switches to a direct path as soon as one answers, without reconfiguring WireGuard", async () => {
    const server = await startRelayServer({ port: 0, hostname: "127.0.0.1" });
    cleanup.push(() => server.stop());

    const a = await makeNode(server.port);
    const b = await makeNode(server.port);
    await waitFor(() => a.relay.connected && b.relay.connected);

    await a.sock.setPeers([{ ...b.config, candidates: [DEAD_CANDIDATE] }]);
    await b.sock.setPeers([{ ...a.config, candidates: [DEAD_CANDIDATE] }]);
    a.sock.enableProbing();
    b.sock.enableProbing();
    await waitFor(() => a.sock.status().find((peer) => peer.viaRelay));

    const before = a.sock.endpointForWireguard(b.config.nodeKey);

    // The peers learn each other's real addresses, as a netmap update would do.
    await a.sock.setPeers([
      { ...b.config, candidates: [DEAD_CANDIDATE, { ip: "127.0.0.1", port: b.sock.port }] },
    ]);
    await b.sock.setPeers([
      { ...a.config, candidates: [DEAD_CANDIDATE, { ip: "127.0.0.1", port: a.sock.port }] },
    ]);

    const direct = await waitFor(() => {
      const peer = a.sock.status()[0];
      return peer && !peer.viaRelay && peer.best ? peer : undefined;
    });
    expect(direct.best?.port).toBe(b.sock.port);

    // WireGuard's endpoint is unchanged: the switch is invisible to it.
    expect(a.sock.endpointForWireguard(b.config.nodeKey)).toEqual(before as { ip: string; port: number });

    const forwardedBefore = server.forwarded();
    a.wg.send(wireguardPacket(22), before as { ip: string; port: number });
    const arrived = await waitFor(() => b.wg.received.find((packet) => packet[63] === 22));
    expect(arrived).toBeDefined();
    // The payload took the direct path, so the relay did not see it.
    expect(server.forwarded()).toBe(forwardedBefore);
  });

  test("keeps working when the relay goes away and a direct path exists", async () => {
    const server = await startRelayServer({ port: 0, hostname: "127.0.0.1" });
    cleanup.push(() => server.stop());

    const a = await makeNode(server.port);
    const b = await makeNode(server.port);
    await waitFor(() => a.relay.connected && b.relay.connected);

    await a.sock.setPeers([{ ...b.config, candidates: [{ ip: "127.0.0.1", port: b.sock.port }] }]);
    await b.sock.setPeers([{ ...a.config, candidates: [{ ip: "127.0.0.1", port: a.sock.port }] }]);
    a.sock.enableProbing();
    b.sock.enableProbing();
    await waitFor(() => a.sock.status().find((peer) => peer.best && !peer.viaRelay));

    server.stop();
    await waitFor(() => !a.relay.connected);

    const endpoint = a.sock.endpointForWireguard(b.config.nodeKey);
    a.wg.send(wireguardPacket(23), endpoint as { ip: string; port: number });
    expect(await waitFor(() => b.wg.received.find((packet) => packet[63] === 23))).toBeDefined();
  });
});

describe("relay heartbeat", () => {
  /** Registers a second session under someone else's key, the way a reconnect does. */
  async function displace(port: number, disco: { publicKey: string; privateKey: string }) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/relay`);
    cleanup.push(() => socket.close());
    await new Promise((resolve) => socket.addEventListener("open", resolve));
    const ready = new Promise<void>((resolve) =>
      socket.addEventListener("message", (event) => {
        // The first client's echoes land here now; that is the point.
        if (typeof event.data !== "string") return;
        const message = JSON.parse(event.data);
        if (message.t === "challenge") {
          socket.send(JSON.stringify({ t: "proof", token: solveChallenge(disco.privateKey, message) }));
        }
        if (message.t === "ready") resolve();
      }),
    );
    socket.send(JSON.stringify({ t: "hello", discoKey: disco.publicKey }));
    await ready;
  }

  function client(port: number, disco: { publicKey: string; privateKey: string }, heartbeatMs: number) {
    const lines: string[] = [];
    const packets: string[] = [];
    const relay = new RelayClient({
      url: `ws://127.0.0.1:${port}/relay`,
      discoPublicKey: disco.publicKey,
      discoPrivateKey: disco.privateKey,
      onPacket: (sender) => void packets.push(sender),
      log: (line) => void lines.push(line),
      heartbeatMs,
    });
    relay.connect();
    cleanup.push(() => relay.close());
    return { relay, lines, packets };
  }

  test("reconnects when the relay no longer routes to this socket", async () => {
    const server = await startRelayServer({ port: 0, hostname: "127.0.0.1", log: () => {} });
    cleanup.push(() => server.stop());
    const disco = generateKeyPair("x25519");
    const { relay, lines } = client(server.port, disco, 100);
    await waitFor(() => relay.connected);

    // The socket stays open, but frames for our key now go elsewhere -- what a
    // relay that has timed out a sleeping laptop looks like from the laptop.
    await displace(server.port, disco);
    await waitFor(() => lines.some((line) => line.includes("stopped answering")));
    await waitFor(() => lines.filter((line) => line.endsWith("ready")).length >= 2);
  });

  test("stays up while the relay answers, and keeps its echoes to itself", async () => {
    const server = await startRelayServer({ port: 0, hostname: "127.0.0.1", log: () => {} });
    cleanup.push(() => server.stop());
    const { relay, lines, packets } = client(server.port, generateKeyPair("x25519"), 50);
    await waitFor(() => relay.connected);

    await Bun.sleep(500);
    expect(lines.some((line) => line.includes("stopped answering"))).toBe(false);
    expect(packets).toHaveLength(0);
    expect(relay.connected).toBe(true);
  });
});
