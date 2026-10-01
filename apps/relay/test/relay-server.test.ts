import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPair } from "@wave/crypto";
import { decodeFrame, encodeFrame } from "@wave/magicsock";
import { solveChallenge, startRelayServer } from "../src/relay-server.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

async function startServer() {
  const server = await startRelayServer({ port: 0, hostname: "127.0.0.1" });
  cleanup.push(() => server.stop());
  return server;
}

/** A bare relay client, so the test exercises the protocol rather than our client. */
function connect(port: number, keys: { publicKey: string; privateKey: string }) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/relay`);
  socket.binaryType = "arraybuffer";
  const frames: Array<{ discoKey: string; payload: Uint8Array }> = [];
  const errors: string[] = [];
  const ready = Promise.withResolvers<void>();
  cleanup.push(() => socket.close());

  socket.addEventListener("open", () =>
    socket.send(JSON.stringify({ t: "hello", discoKey: keys.publicKey })),
  );
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      const frame = decodeFrame(new Uint8Array(event.data as ArrayBuffer));
      if (frame) frames.push(frame);
      return;
    }
    const message = JSON.parse(event.data);
    if (message.t === "challenge") {
      const token = solveChallenge(keys.privateKey, message);
      socket.send(JSON.stringify({ t: "proof", token }));
      return;
    }
    if (message.t === "ready") ready.resolve();
    if (message.t === "error") {
      errors.push(message.message);
      ready.reject(new Error(message.message));
    }
  });

  return { socket, frames, errors, ready: ready.promise, keys };
}

const waitFor = async <T>(predicate: () => T | undefined | false, timeoutMs = 3000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(10);
  }
};

describe("relay", () => {
  test("forwards a packet between two authenticated clients", async () => {
    const server = await startServer();
    const alice = connect(server.port, generateKeyPair("x25519"));
    const bob = connect(server.port, generateKeyPair("x25519"));
    await Promise.all([alice.ready, bob.ready]);
    expect(server.connections()).toBe(2);

    alice.socket.send(encodeFrame(bob.keys.publicKey, new Uint8Array([1, 2, 3])));

    const frame = await waitFor(() => bob.frames[0]);
    expect(frame.discoKey).toBe(alice.keys.publicKey);
    expect([...frame.payload]).toEqual([1, 2, 3]);
    expect(server.forwarded()).toBe(1);
  });

  /**
   * The phone changing network: the new socket is up before the old one has
   * finished closing. Deleting by disco key alone made the late `close` remove
   * the session that had just replaced it, and the node then sat on a
   * connection the relay would never deliver to.
   */
  test("a reconnect with the same key survives the old socket closing", async () => {
    const server = await startServer();
    const phone = generateKeyPair("x25519");
    const peer = connect(server.port, generateKeyPair("x25519"));

    const first = connect(server.port, phone);
    await Promise.all([peer.ready, first.ready]);

    const second = connect(server.port, phone);
    await second.ready;

    first.socket.close();
    await waitFor(() => first.socket.readyState === WebSocket.CLOSED);

    peer.socket.send(encodeFrame(phone.publicKey, new Uint8Array([7, 8, 9])));
    const frame = await waitFor(() => second.frames[0]);
    expect([...frame.payload]).toEqual([7, 8, 9]);
    expect(server.connections()).toBe(2);
  });

  test("rejects a client that cannot solve the challenge", async () => {
    const server = await startServer();
    const impostor = generateKeyPair("x25519");
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/relay`);
    cleanup.push(() => socket.close());

    const failed = Promise.withResolvers<string>();
    socket.addEventListener("open", () =>
      socket.send(JSON.stringify({ t: "hello", discoKey: impostor.publicKey })),
    );
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      // Claiming someone else's key is easy; reading the challenge is not.
      if (message.t === "challenge") socket.send(JSON.stringify({ t: "proof", token: "guessed" }));
      if (message.t === "error") failed.resolve(message.message);
    });

    expect(await failed.promise).toBe("challenge failed");
    expect(server.connections()).toBe(0);
  });

  test("drops frames from a client that has not authenticated", async () => {
    const server = await startServer();
    const bob = connect(server.port, generateKeyPair("x25519"));
    await bob.ready;

    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/relay`);
    cleanup.push(() => socket.close());
    await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve()));
    socket.send(encodeFrame(bob.keys.publicKey, new Uint8Array([9])));

    await Bun.sleep(150);
    expect(bob.frames).toHaveLength(0);
    expect(server.forwarded()).toBe(0);
  });

  test("silently drops frames for a key that is not connected", async () => {
    const server = await startServer();
    const alice = connect(server.port, generateKeyPair("x25519"));
    await alice.ready;

    alice.socket.send(encodeFrame(generateKeyPair("x25519").publicKey, new Uint8Array([1])));
    await Bun.sleep(150);
    // No error either: the sender must not learn which keys are online.
    expect(alice.errors).toEqual([]);
    expect(server.forwarded()).toBe(0);
  });

  test("forgets a client when it disconnects", async () => {
    const server = await startServer();
    const alice = connect(server.port, generateKeyPair("x25519"));
    await alice.ready;
    expect(server.connections()).toBe(1);

    alice.socket.close();
    await waitFor(() => server.connections() === 0);
  });

  test("serves a health endpoint", async () => {
    const server = await startServer();
    const body = (await (await fetch(`http://127.0.0.1:${server.port}/healthz`)).json()) as {
      ok: boolean;
      publicKey: string;
    };
    expect(body.ok).toBe(true);
    expect(body.publicKey).toBe(server.publicKey);
  });
});

describe("frames", () => {
  test("round-trip", () => {
    const key = generateKeyPair("x25519").publicKey;
    const frame = decodeFrame(encodeFrame(key, new Uint8Array([7, 8])));
    expect(frame?.discoKey).toBe(key);
    expect([...(frame?.payload ?? [])]).toEqual([7, 8]);
  });

  test("rejects a frame without a payload", () => {
    expect(decodeFrame(new Uint8Array(32))).toBeNull();
  });
});
