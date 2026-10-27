import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { buildAuthorizationHeader, generateKeyPair } from "@wave/crypto";
import type { ServerMessage } from "@wave/proto";
import { eq } from "drizzle-orm";
import { setPolicy, setTags } from "../src/acl/store.ts";
import { createApp } from "../src/app.ts";
import { createProviders } from "../src/auth/providers.ts";
import type { Database } from "../src/db/client.ts";
import { nodes } from "../src/db/schema.ts";
import { removeNode } from "../src/waves/nodes.ts";
import { CookieJar, createTestDb, createWaveAs, type TestDb, testConfig, testSigningKey } from "./helpers.ts";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
});

afterAll(() => testDb.close());

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

/** Runs the real app on a real port, because WebSockets need a real server. */
async function startServer() {
  await testDb.reset();
  const { db } = testDb;
  const config = testConfig();
  const app = createApp({ db, config, providers: createProviders(config), signingKey: testSigningKey() });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch, websocket: app.websocket });
  cleanup.push(() => server.stop(true));
  return { db, base: `http://127.0.0.1:${server.port}`, port: server.port };
}

function makeMachine(hostname: string) {
  const machine = generateKeyPair("ed25519");
  return {
    machine,
    body: {
      machineKey: machine.publicKey,
      nodeKey: generateKeyPair("x25519").publicKey,
      discoKey: generateKeyPair("x25519").publicKey,
      hostname,
      os: "linux" as const,
    },
  };
}

const authHeader = (machine: ReturnType<typeof makeMachine>, method: string, path: string, body = "") =>
  buildAuthorizationHeader({
    machineKey: machine.machine.publicKey,
    machinePrivateKey: machine.machine.privateKey,
    method,
    path,
    body,
  });

async function enrol(base: string, machine: ReturnType<typeof makeMachine>, jar: CookieJar) {
  const payload = JSON.stringify(machine.body);
  const res = await fetch(`${base}/v1/machine/register`, {
    method: "POST",
    body: payload,
    headers: {
      "content-type": "application/json",
      authorization: authHeader(machine, "POST", "/v1/machine/register", payload),
    },
  });
  const pending = (await res.json()) as { authUrl: string };
  const form = new FormData();
  form.set("request", new URL(pending.authUrl).searchParams.get("request") ?? "");
  await fetch(`${base}/machine/authorize`, { method: "POST", body: form, headers: { cookie: jar.header() } });
}

async function login(base: string): Promise<CookieJar> {
  const jar = new CookieJar();
  const start = await fetch(`${base}/auth/dev/start`, { redirect: "manual" });
  jar.absorb(start);
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
  jar.absorb(
    await fetch(`${base}/auth/dev/callback?code=a%40example.com&state=${state}`, {
      headers: { cookie: jar.header() },
      redirect: "manual",
    }),
  );
  // Signing in no longer makes a wave; its DNS suffix is its owner's choice.
  await createWaveAs(
    (path, init) => fetch(`${base}${path}`, { ...init, redirect: "manual" }),
    jar,
    "a@example.com",
  );
  return jar;
}

/** Opens the control socket and collects the messages the server pushes. */
function connect(base: string, machine: ReturnType<typeof makeMachine>) {
  const messages: ServerMessage[] = [];
  const socket = new WebSocket(`${base.replace("http", "ws")}/v1/control`, {
    headers: { authorization: authHeader(machine, "GET", "/v1/control") },
  } as never);
  socket.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data))));
  cleanup.push(() => socket.close());
  return { socket, messages };
}

const waitFor = async <T>(predicate: () => T | undefined | false, timeoutMs = 4000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(20);
  }
};

describe("heartbeat", () => {
  test("answers a ping and records that the node is alive", async () => {
    const { db, base } = await startServer();
    const machine = makeMachine("a");
    await enrol(base, machine, await login(base));

    const { socket, messages } = connect(base, machine);
    await waitFor(() => messages.find((m) => m.type === "netmap"));
    await db
      .update(nodes)
      .set({ lastSeenAt: new Date(0) })
      .where(eq(nodes.hostname, "a"));

    socket.send(JSON.stringify({ type: "ping" }));
    await waitFor(() => messages.find((m) => m.type === "pong"));

    const rows = await db.select().from(nodes).where(eq(nodes.hostname, "a"));
    expect(rows[0]?.lastSeenAt?.getTime() ?? 0).toBeGreaterThan(Date.now() - 60_000);
  });
});

describe("a device removed while it is connected", () => {
  /** What the browser route needs to name: the wave and the device in it. */
  async function ids(db: Database, base: string, jar: CookieJar, hostname: string) {
    const me = (await (await fetch(`${base}/api/me`, { headers: { cookie: jar.header() } })).json()) as {
      waves: { id: string }[];
    };
    const rows = await db.select({ id: nodes.id }).from(nodes).where(eq(nodes.hostname, hostname));
    return { waveId: me.waves[0]?.id ?? "", nodeId: rows[0]?.id ?? "" };
  }

  test("is told why and cut off when an administrator removes it", async () => {
    const { db, base } = await startServer();
    const jar = await login(base);
    const machine = makeMachine("a");
    await enrol(base, machine, jar);

    const { socket, messages } = connect(base, machine);
    await waitFor(() => messages.find((m) => m.type === "netmap"));
    const closed = Promise.withResolvers<number>();
    socket.addEventListener("close", (event) => closed.resolve(event.code));

    const { waveId, nodeId } = await ids(db, base, jar, "a");
    const removed = await fetch(`${base}/waves/${waveId}/nodes/${nodeId}/remove`, {
      method: "POST",
      headers: { cookie: jar.header() },
      redirect: "manual",
    });
    expect(removed.status).toBe(303);

    const logout = await waitFor(() => messages.find((m) => m.type === "logout"));
    expect(logout.type === "logout" && logout.reason).toBe("node-removed");
    expect(await closed.promise).toBe(4404);
  });

  test("finds out at its next heartbeat when the shell removed it", async () => {
    const { db, base } = await startServer();
    const jar = await login(base);
    const machine = makeMachine("a");
    await enrol(base, machine, jar);

    const { socket, messages } = connect(base, machine);
    await waitFor(() => messages.find((m) => m.type === "netmap"));
    const closed = Promise.withResolvers<number>();
    socket.addEventListener("close", (event) => closed.resolve(event.code));

    // `admin.ts remove-device` runs in another process: it has no hub, so this
    // socket is only reachable from the node's own side.
    const { waveId, nodeId } = await ids(db, base, jar, "a");
    expect(await removeNode(db, waveId, nodeId)).not.toBeNull();

    socket.send(JSON.stringify({ type: "ping" }));
    const logout = await waitFor(() => messages.find((m) => m.type === "logout"));
    expect(logout.type === "logout" && logout.reason).toBe("node-removed");
    expect(messages.find((m) => m.type === "pong")).toBeUndefined();
    expect(await closed.promise).toBe(4404);
  });
});

describe("control socket", () => {
  test("pushes a netmap as soon as a node connects", async () => {
    const { base } = await startServer();
    const machine = makeMachine("a");
    await enrol(base, machine, await login(base));

    const { messages } = connect(base, machine);
    const netmap = await waitFor(() => messages.find((m) => m.type === "netmap"));
    expect(netmap.type).toBe("netmap");
  });

  test("refuses an unsigned connection", async () => {
    const { base } = await startServer();
    const socket = new WebSocket(`${base.replace("http", "ws")}/v1/control`);
    const closed = Promise.withResolvers<number>();
    socket.addEventListener("close", (event) => closed.resolve(event.code));
    expect(await closed.promise).toBe(4401);
  });

  test("carries published endpoints into the other node's netmap", async () => {
    const { base } = await startServer();
    const jar = await login(base);
    const a = makeMachine("a");
    const b = makeMachine("b");
    await enrol(base, a, jar);
    await enrol(base, b, jar);

    const alice = connect(base, a);
    const bob = connect(base, b);
    await waitFor(() => alice.messages.find((m) => m.type === "netmap"));
    await waitFor(
      () => bob.messages.some((m) => m.type === "netmap") && bob.socket.readyState === WebSocket.OPEN,
    );

    const candidates = [{ kind: "stun", ip: "203.0.113.20", port: 41641 }];
    bob.socket.send(JSON.stringify({ type: "endpoints", candidates }));

    const pushed = await waitFor(() =>
      alice.messages
        .filter((m) => m.type === "netmap")
        .find((m) => m.netmap.netmap.peers[0]?.candidates.length),
    );
    expect(pushed.type === "netmap" && pushed.netmap.netmap.peers[0]?.candidates).toEqual(
      candidates as never,
    );
  });

  test("tells the other node to start punching", async () => {
    const { base } = await startServer();
    const jar = await login(base);
    const a = makeMachine("a");
    const b = makeMachine("b");
    await enrol(base, a, jar);
    await enrol(base, b, jar);

    const alice = connect(base, a);
    const bob = connect(base, b);
    await waitFor(() => alice.messages.find((m) => m.type === "netmap"));
    await waitFor(() => bob.socket.readyState === WebSocket.OPEN);

    bob.socket.send(
      JSON.stringify({ type: "endpoints", candidates: [{ kind: "stun", ip: "203.0.113.20", port: 41641 }] }),
    );
    const hint = await waitFor(() => alice.messages.find((m) => m.type === "disco-hint"));
    expect(hint.type === "disco-hint" && hint.candidates[0]?.ip).toBe("203.0.113.20");
  });
});

describe("under a policy", () => {
  async function waveOf(base: string, jar: CookieJar): Promise<string> {
    const me = (await (await fetch(`${base}/api/me`, { headers: { cookie: jar.header() } })).json()) as {
      waves: { id: string }[];
    };
    return me.waves[0]?.id ?? "";
  }

  test("a policy set on the shell reaches a connected node at its next heartbeat", async () => {
    const { db, base } = await startServer();
    const jar = await login(base);
    const a = makeMachine("a");
    const b = makeMachine("b");
    await enrol(base, a, jar);
    await enrol(base, b, jar);

    const alice = connect(base, a);
    const first = await waitFor(() => alice.messages.find((m) => m.type === "netmap"));
    expect(first.type === "netmap" && first.netmap.netmap.peers.map((p) => p.hostname)).toEqual(["b"]);

    // What `wave-admin set-acl` does: a write in another process, no hub.
    await setPolicy(db, await waveOf(base, jar), { acls: [] }, null);
    alice.socket.send(JSON.stringify({ type: "ping" }));

    const second = await waitFor(() => alice.messages.filter((m) => m.type === "netmap")[1]);
    expect(second.type === "netmap" && second.netmap.netmap.peers).toEqual([]);
    expect(alice.messages.some((m) => m.type === "pong")).toBe(true);
  });

  test("a node's word on its ports is kept with the node", async () => {
    const { db, base } = await startServer();
    const jar = await login(base);
    const a = makeMachine("a");
    await enrol(base, a, jar);
    const alice = connect(base, a);
    await waitFor(() => alice.messages.find((m) => m.type === "netmap"));

    alice.socket.send(
      JSON.stringify({ type: "filter", enforced: false, reason: "ports are not enforced on macOS yet" }),
    );
    // Polled by hand: the check is a query, and waitFor takes a plain value.
    let row: typeof nodes.$inferSelect | undefined;
    for (let tries = 0; tries < 100 && row?.filterEnforced !== false; tries++) {
      [row] = await db.select().from(nodes).where(eq(nodes.hostname, "a"));
      if (row?.filterEnforced !== false) await Bun.sleep(20);
    }
    expect(row?.filterEnforced).toBe(false);
    expect(row?.filterReason).toBe("ports are not enforced on macOS yet");
  });

  test("a node that may not meet another is not told where it is", async () => {
    const { db, base } = await startServer();
    const jar = await login(base);
    const a = makeMachine("a");
    const b = makeMachine("b");
    const c = makeMachine("c");
    for (const machine of [a, b, c]) await enrol(base, machine, jar);
    const waveId = await waveOf(base, jar);
    const rows = await db.select({ id: nodes.id, hostname: nodes.hostname }).from(nodes);
    const idOf = (hostname: string) => rows.find((row) => row.hostname === hostname)?.id ?? "";
    await setTags(db, waveId, idOf("c"), ["tag:lonely"]);
    // a and b meet; c is tagged, and nothing grants it anything.
    await setPolicy(
      db,
      waveId,
      { acls: [{ src: ["user:a@example.com"], dst: ["user:a@example.com"] }] },
      null,
    );

    const alice = connect(base, a);
    const carol = connect(base, c);
    const bob = connect(base, b);
    await waitFor(() => alice.messages.find((m) => m.type === "netmap"));
    await waitFor(() => carol.messages.find((m) => m.type === "netmap"));
    await waitFor(() => bob.socket.readyState === WebSocket.OPEN);

    bob.socket.send(
      JSON.stringify({ type: "endpoints", candidates: [{ kind: "stun", ip: "203.0.113.20", port: 41641 }] }),
    );
    await waitFor(() => alice.messages.find((m) => m.type === "disco-hint"));
    // Given the same moment to arrive, which it had for alice.
    await Bun.sleep(200);
    expect(carol.messages.some((m) => m.type === "disco-hint")).toBe(false);
  });
});
