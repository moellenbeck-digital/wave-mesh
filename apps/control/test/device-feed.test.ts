import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { buildAuthorizationHeader, generateKeyPair } from "@wave/crypto";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.ts";
import { createProviders } from "../src/auth/providers.ts";
import { nodes, users } from "../src/db/schema.ts";
import type { FeedMessage } from "../src/routes/device-feed.ts";
import { addMember, removeMember } from "../src/waves/members.ts";
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

/** The real app on a real port: a WebSocket needs a server to upgrade on. */
async function startServer() {
  await testDb.reset();
  const { db } = testDb;
  const config = testConfig();
  const app = createApp({ db, config, providers: createProviders(config), signingKey: testSigningKey() });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch, websocket: app.websocket });
  cleanup.push(() => server.stop(true));
  return { db, base: `http://127.0.0.1:${server.port}` };
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

async function login(base: string, email = "a@example.com"): Promise<CookieJar> {
  const jar = new CookieJar();
  const start = await fetch(`${base}/auth/dev/start`, { redirect: "manual" });
  jar.absorb(start);
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
  jar.absorb(
    await fetch(`${base}/auth/dev/callback?code=${encodeURIComponent(email)}&state=${state}`, {
      headers: { cookie: jar.header() },
      redirect: "manual",
    }),
  );
  await createWaveAs((path, init) => fetch(`${base}${path}`, { ...init, redirect: "manual" }), jar, email);
  return jar;
}

/** Opens the browser feed the way a page does: with the session cookie. */
function watch(base: string, jar: CookieJar) {
  const messages: FeedMessage[] = [];
  const socket = new WebSocket(`${base.replace("http", "ws")}/api/events`, {
    headers: { cookie: jar.header() },
  } as never);
  socket.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data))));
  cleanup.push(() => socket.close());
  const devices = (waveId?: string) =>
    messages.filter((m) => m.type === "devices" && (!waveId || m.waveId === waveId));
  return { socket, messages, devices };
}

/** Connects a node the way `wave up` does, so the hub counts it as online. */
function connectNode(base: string, machine: ReturnType<typeof makeMachine>) {
  const socket = new WebSocket(`${base.replace("http", "ws")}/v1/control`, {
    headers: { authorization: authHeader(machine, "GET", "/v1/control") },
  } as never);
  cleanup.push(() => socket.close());
  return socket;
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

const waveOf = async (base: string, jar: CookieJar): Promise<string> => {
  const me = (await (await fetch(`${base}/api/me`, { headers: { cookie: jar.header() } })).json()) as {
    waves: { id: string }[];
  };
  return me.waves[0]?.id ?? "";
};

/** The devices of the newest push for a wave, or undefined while none came. */
const latest = (feed: ReturnType<typeof watch>, waveId: string) => {
  const pushes = feed.devices(waveId);
  const last = pushes[pushes.length - 1];
  return last?.type === "devices" ? last.nodes : undefined;
};

describe("the device feed", () => {
  test("sends the current list as soon as a browser connects", async () => {
    const { base } = await startServer();
    const jar = await login(base);
    await enrol(base, makeMachine("a"), jar);
    const waveId = await waveOf(base, jar);

    const feed = watch(base, jar);
    const nodes = await waitFor(() => latest(feed, waveId));
    expect(nodes.map((node) => node.hostname)).toEqual(["a"]);
    expect(nodes[0]?.online).toBe(false);
  });

  test("closes a connection that brings no session", async () => {
    const { base } = await startServer();
    const socket = new WebSocket(`${base.replace("http", "ws")}/api/events`);
    const closed = Promise.withResolvers<number>();
    socket.addEventListener("close", (event) => closed.resolve(event.code));
    expect(await closed.promise).toBe(4401);
  });

  test("says when a device comes online and when it goes away again", async () => {
    const { base } = await startServer();
    const jar = await login(base);
    const machine = makeMachine("a");
    await enrol(base, machine, jar);
    const waveId = await waveOf(base, jar);

    const feed = watch(base, jar);
    await waitFor(() => latest(feed, waveId));

    const node = connectNode(base, machine);
    const online = await waitFor(() => latest(feed, waveId)?.find((device) => device.online));
    expect(online.hostname).toBe("a");

    node.close();
    await waitFor(() => latest(feed, waveId)?.every((device) => !device.online));
  });

  test("pushes a device that joins and one that is removed", async () => {
    const { db, base } = await startServer();
    const jar = await login(base);
    await enrol(base, makeMachine("a"), jar);
    const waveId = await waveOf(base, jar);

    const feed = watch(base, jar);
    await waitFor(() => latest(feed, waveId));

    await enrol(base, makeMachine("b"), jar);
    await waitFor(() => latest(feed, waveId)?.length === 2);

    const rows = await db.select({ id: nodes.id }).from(nodes).where(eq(nodes.hostname, "b"));
    const removed = await fetch(`${base}/waves/${waveId}/nodes/${rows[0]?.id}/remove`, {
      method: "POST",
      headers: { cookie: jar.header() },
      redirect: "manual",
    });
    expect(removed.status).toBe(303);

    const left = await waitFor(() => {
      const nodes = latest(feed, waveId);
      return nodes?.length === 1 ? nodes : undefined;
    });
    expect(left.map((device) => device.hostname)).toEqual(["a"]);
  });

  test("pushes the services a connector starts answering for", async () => {
    const { base } = await startServer();
    const jar = await login(base);
    const connector = makeMachine("connector");
    await enrol(base, connector, jar);
    const waveId = await waveOf(base, jar);

    const feed = watch(base, jar);
    await waitFor(() => latest(feed, waveId));

    const payload = JSON.stringify({ names: ["grafana"], secure: ["grafana"] });
    const res = await fetch(`${base}/v1/services`, {
      method: "POST",
      body: payload,
      headers: {
        "content-type": "application/json",
        authorization: authHeader(connector, "POST", "/v1/services", payload),
      },
    });
    expect(res.status).toBe(200);

    const services = await waitFor(() => latest(feed, waveId)?.[0]?.services.length);
    expect(services).toBe(1);
    expect(latest(feed, waveId)?.[0]?.services[0]).toMatchObject({
      name: "grafana",
      url: "https://grafana.a.wave.internal",
    });
  });

  test("stops pushing to somebody who was removed from the wave", async () => {
    const { db, base } = await startServer();
    const owner = await login(base);
    const guest = await login(base, "b@example.com");
    const waveId = await waveOf(base, owner);
    const guestRows = await db.select({ id: users.id }).from(users).where(eq(users.email, "b@example.com"));
    const guestId = guestRows[0]?.id ?? "";
    expect(await addMember(db, waveId, guestId, "member")).toMatchObject({ added: true });

    const theirs = watch(base, guest);
    const feed = watch(base, owner);
    await waitFor(() => latest(theirs, waveId));
    await waitFor(() => latest(feed, waveId));

    // From the shell, so there is no route that could have told the feed --
    // which is the case the check per push exists for.
    expect(await removeMember(db, waveId, "owner", guestId)).toMatchObject({ removedNodes: 0 });
    await enrol(base, makeMachine("a"), owner);

    await waitFor(() => latest(feed, waveId)?.length === 1);
    expect(latest(theirs, waveId)).toEqual([]);
  });

  test("answers a keepalive", async () => {
    const { base } = await startServer();
    const jar = await login(base);
    const feed = watch(base, jar);
    await waitFor(() => feed.socket.readyState === WebSocket.OPEN);

    feed.socket.send(JSON.stringify({ type: "ping" }));
    await waitFor(() => feed.messages.find((m) => m.type === "pong"));
  });
});
