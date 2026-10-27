import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { buildAuthorizationHeader, canonicalJson, generateKeyPair, type KeyPair, verify } from "@wave/crypto";
import { Netmap, SignedNetmap } from "@wave/proto";
import { createApp } from "../src/app.ts";
import { createProviders } from "../src/auth/providers.ts";
import type { Database } from "../src/db/client.ts";
import {
  approveDevice,
  CookieJar,
  createTestDb,
  createWaveAs,
  testConfig,
  testSigningKey,
} from "./helpers.ts";

let db: Database;
let close: () => Promise<void>;
let reset: () => Promise<void>;
let app: ReturnType<typeof createApp>;
let signingKey: KeyPair;

beforeAll(async () => {
  ({ db, close, reset } = await createTestDb());
});

afterAll(() => close());

beforeEach(async () => {
  await reset();
  const config = testConfig();
  signingKey = testSigningKey();
  app = createApp({ db, config, providers: createProviders(config), signingKey });
});

/** A node as the client sees it: three key pairs and nothing else. */
function makeMachine(hostname: string) {
  const machine = generateKeyPair("ed25519");
  const node = generateKeyPair("x25519");
  const disco = generateKeyPair("x25519");
  return {
    hostname,
    machine,
    registerBody: {
      machineKey: machine.publicKey,
      nodeKey: node.publicKey,
      discoKey: disco.publicKey,
      hostname,
      os: "linux" as const,
    },
  };
}

type Machine = ReturnType<typeof makeMachine>;

const signedRequest = (machine: Machine, method: string, path: string, body?: unknown) => {
  const payload = body === undefined ? "" : JSON.stringify(body);
  return app.request(path, {
    method,
    body: method === "GET" ? undefined : payload,
    headers: {
      "content-type": "application/json",
      authorization: buildAuthorizationHeader({
        machineKey: machine.machine.publicKey,
        machinePrivateKey: machine.machine.privateKey,
        method,
        path,
        body: payload,
      }),
    },
  });
};

/** Logs a user in through the dev provider and returns their cookie jar. */
async function login(email: string): Promise<CookieJar> {
  const jar = new CookieJar();
  const start = await app.request("/auth/dev/start");
  jar.absorb(start);
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
  const cb = await app.request(`/auth/dev/callback?code=${encodeURIComponent(email)}&state=${state}`, {
    headers: { cookie: jar.header() },
  });
  jar.absorb(cb);
  // Signing in no longer makes a wave; its DNS suffix is its owner's choice.
  await createWaveAs((path, init) => app.request(path, init), jar, email);
  return jar;
}

/** Registers a machine and approves it in the browser, as a user would. */
async function enrol(machine: Machine, jar: CookieJar) {
  const res = await signedRequest(machine, "POST", "/v1/machine/register", machine.registerBody);
  const pending = (await res.json()) as { status: string; authUrl: string; pollSecret: string };
  expect(pending.status).toBe("pending");

  const requestId = new URL(pending.authUrl).searchParams.get("request") ?? "";
  const form = new FormData();
  form.set("request", requestId);
  const approved = await app.request("/machine/authorize", {
    method: "POST",
    body: form,
    headers: { cookie: jar.header() },
  });
  expect(approved.status).toBe(200);

  const poll = await signedRequest(machine, "POST", "/v1/machine/poll", { pollSecret: pending.pollSecret });
  return (await poll.json()) as {
    status: string;
    nodeId: string;
    netmap: SignedNetmap;
    netmapPublicKey: string;
  };
}

describe("node enrolment", () => {
  test("registers, waits for approval and returns a signed netmap", async () => {
    const jar = await login("robin@example.com");
    const machine = makeMachine("laptop");

    const authorized = await enrol(machine, jar);
    expect(authorized.status).toBe("authorized");
    expect(authorized.netmapPublicKey).toBe(signingKey.publicKey);

    const parsed = SignedNetmap.parse(authorized.netmap);
    expect(verify(signingKey.publicKey, canonicalJson(parsed.netmap), parsed.signature)).toBe(true);
    expect(parsed.netmap.self.ipv4).toBe("10.64.0.1");
    expect(parsed.netmap.self.hostname).toBe("laptop");
    expect(parsed.netmap.self.dnsName).toBe("laptop.robin.wave.internal");
    expect(parsed.netmap.peers).toHaveLength(0);
  });

  test("stays pending until a human approves", async () => {
    const machine = makeMachine("laptop");
    const res = await signedRequest(machine, "POST", "/v1/machine/register", machine.registerBody);
    const pending = (await res.json()) as { pollSecret: string };
    const poll = await signedRequest(machine, "POST", "/v1/machine/poll", { pollSecret: pending.pollSecret });
    expect(await poll.json()).toEqual({ status: "pending" });
  });

  test("two nodes of one user see each other", async () => {
    const jar = await login("robin@example.com");
    const laptop = makeMachine("laptop");
    const phone = makeMachine("phone");

    await enrol(laptop, jar);
    const second = await enrol(phone, jar);

    expect(second.netmap.netmap.self.ipv4).toBe("10.64.0.2");
    expect(second.netmap.netmap.peers.map((p) => p.hostname)).toEqual(["laptop"]);

    const laptopView = await signedRequest(laptop, "GET", "/v1/netmap");
    const netmap = Netmap.parse(((await laptopView.json()) as SignedNetmap).netmap);
    expect(netmap.peers.map((p) => p.hostname)).toEqual(["phone"]);

    const peer = netmap.peers[0];
    expect(peer?.allowedIps).toEqual([`${peer?.ipv4}/32`, `${peer?.ipv6}/128`]);
    expect(peer?.ipv6).toEndWith("::2");
  });

  test("nodes of different users never appear in each other's netmap", async () => {
    const mine = makeMachine("laptop");
    const theirs = makeMachine("laptop");
    await enrol(mine, await login("robin@example.com"));
    await enrol(theirs, await login("someone@elsewhere.example"));

    const view = await signedRequest(mine, "GET", "/v1/netmap");
    const netmap = ((await view.json()) as SignedNetmap).netmap;
    expect(netmap.peers).toHaveLength(0);
  });

  test("re-registering an enrolled machine authorizes immediately", async () => {
    const jar = await login("robin@example.com");
    const machine = makeMachine("laptop");
    const first = await enrol(machine, jar);

    const again = await signedRequest(machine, "POST", "/v1/machine/register", machine.registerBody);
    const body = (await again.json()) as { status: string; nodeId: string };
    expect(body.status).toBe("authorized");
    expect(body.nodeId).toBe(first.nodeId);
  });

  test("a second node keeps its own hostname when it collides", async () => {
    const jar = await login("robin@example.com");
    await enrol(makeMachine("laptop"), jar);
    const twin = await enrol(makeMachine("laptop"), jar);
    expect(twin.netmap.netmap.self.hostname).toBe("laptop-2");
  });
});

describe("browser approval", () => {
  test("the link shows the form, and submitting it connects the device", async () => {
    const jar = await login("robin@example.com");
    const machine = makeMachine("laptop");

    const res = await signedRequest(machine, "POST", "/v1/machine/register", machine.registerBody);
    const pending = (await res.json()) as { authUrl: string; pollSecret: string };
    const path = new URL(pending.authUrl).pathname + new URL(pending.authUrl).search;

    // Opening it is not the approval: a GET carries the session cookie even
    // from a foreign site, and the id in the link is the device's secret, not
    // the user's. machine-approval.test.ts is where that is pinned down.
    const shown = await app.request(path, { headers: { cookie: jar.header() } });
    expect(shown.status).toBe(200);
    expect(await shown.text()).toContain('method="post"');
    const waiting = await signedRequest(machine, "POST", "/v1/machine/poll", {
      pollSecret: pending.pollSecret,
    });
    expect(((await waiting.json()) as { status: string }).status).toBe("pending");

    const approved = await approveDevice((p, init) => app.request(p, init), jar, path);
    expect(approved.status).toBe(200);
    expect(await approved.text()).toContain("is connected");

    const poll = await signedRequest(machine, "POST", "/v1/machine/poll", { pollSecret: pending.pollSecret });
    expect(((await poll.json()) as { status: string }).status).toBe("authorized");
  });

  test("sends an anonymous visitor to the login and back again", async () => {
    const machine = makeMachine("laptop");
    const res = await signedRequest(machine, "POST", "/v1/machine/register", machine.registerBody);
    const { authUrl } = (await res.json()) as { authUrl: string };
    const path = new URL(authUrl).pathname + new URL(authUrl).search;

    const redirected = await app.request(path);
    expect(redirected.status).toBe(302);
    const location = redirected.headers.get("location") ?? "";
    expect(decodeURIComponent(location)).toContain("/machine/authorize?request=");

    // The login carries the target through. A brand-new account has no wave
    // to put the device in, so the form comes first -- and the device link
    // rides along, because nothing else would finish the approval.
    const jar = new CookieJar();
    const start = await app.request(location.replace("/?next=", "/auth/dev/start?next="));
    jar.absorb(start);
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    const callback = await app.request(`/auth/dev/callback?code=robin%40example.com&state=${state}`, {
      headers: { cookie: jar.header() },
    });
    jar.absorb(callback);
    expect(callback.headers.get("location")).toBe(`/waves/new?next=${encodeURIComponent(path)}`);

    const created = await createWaveAs((p, init) => app.request(p, init), jar, "robin@example.com", {
      next: path,
    });
    expect(created.headers.get("location")).toBe(path);
    // Back on the link, now with a wave: the form, and then the device.
    expect((await app.request(path, { headers: { cookie: jar.header() } })).status).toBe(200);
    const approved = await approveDevice((p, init) => app.request(p, init), jar, path);
    expect(await approved.text()).toContain("is connected");
  });

  test("refuses to bounce the user to another site after login", async () => {
    const jar = new CookieJar();
    const start = await app.request("/auth/dev/start?next=https://evil.example/");
    jar.absorb(start);
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    const callback = await app.request(`/auth/dev/callback?code=a%40example.com&state=${state}`, {
      headers: { cookie: jar.header() },
    });
    // The off-site target is dropped; what is left is where a fresh account
    // goes anyway, which is the form for its first wave.
    expect(callback.headers.get("location")).toBe("/waves/new");
  });

  test("an expired request says so instead of failing silently", async () => {
    const jar = await login("robin@example.com");
    const res = await app.request("/machine/authorize?request=ar_missing", {
      headers: { cookie: jar.header() },
    });
    expect(res.status).toBe(410);
  });
});

describe("logout", () => {
  test("removes the node from its wave", async () => {
    const jar = await login("robin@example.com");
    const laptop = makeMachine("laptop");
    const phone = makeMachine("phone");
    await enrol(laptop, jar);
    await enrol(phone, jar);

    const out = await signedRequest(phone, "POST", "/v1/node/logout", {});
    expect(out.status).toBe(200);

    const view = await signedRequest(laptop, "GET", "/v1/netmap");
    expect(((await view.json()) as SignedNetmap).netmap.peers).toHaveLength(0);
  });

  test("the node itself is gone afterwards", async () => {
    const jar = await login("robin@example.com");
    const machine = makeMachine("laptop");
    await enrol(machine, jar);
    await signedRequest(machine, "POST", "/v1/node/logout", {});

    expect((await signedRequest(machine, "GET", "/v1/netmap")).status).toBe(404);
  });

  test("logging out twice is not an error", async () => {
    const jar = await login("robin@example.com");
    const machine = makeMachine("laptop");
    await enrol(machine, jar);
    await signedRequest(machine, "POST", "/v1/node/logout", {});
    expect((await signedRequest(machine, "POST", "/v1/node/logout", {})).status).toBe(200);
  });

  test("needs a signature like everything else", async () => {
    expect((await app.request("/v1/node/logout", { method: "POST" })).status).toBe(401);
  });
});

describe("request signing", () => {
  test("rejects an unsigned request", async () => {
    const res = await app.request("/v1/netmap");
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "missing-signature" });
  });

  test("rejects a body that was tampered with after signing", async () => {
    const machine = makeMachine("laptop");
    const path = "/v1/machine/register";
    const header = buildAuthorizationHeader({
      machineKey: machine.machine.publicKey,
      machinePrivateKey: machine.machine.privateKey,
      method: "POST",
      path,
      body: JSON.stringify(machine.registerBody),
    });
    const res = await app.request(path, {
      method: "POST",
      body: JSON.stringify({ ...machine.registerBody, hostname: "somewhere-else" }),
      headers: { authorization: header, "content-type": "application/json" },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "bad-signature" });
  });

  test("rejects a replayed request", async () => {
    const machine = makeMachine("laptop");
    const path = "/v1/machine/register";
    const payload = JSON.stringify(machine.registerBody);
    const init = {
      method: "POST",
      body: payload,
      headers: {
        "content-type": "application/json",
        authorization: buildAuthorizationHeader({
          machineKey: machine.machine.publicKey,
          machinePrivateKey: machine.machine.privateKey,
          method: "POST",
          path,
          body: payload,
        }),
      },
    };
    expect((await app.request(path, init)).status).toBe(200);
    const replay = await app.request(path, init);
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ error: "replayed-nonce" });
  });

  test("rejects a stale timestamp", async () => {
    const machine = makeMachine("laptop");
    const path = "/v1/netmap";
    const res = await app.request(path, {
      headers: {
        authorization: buildAuthorizationHeader({
          machineKey: machine.machine.publicKey,
          machinePrivateKey: machine.machine.privateKey,
          method: "GET",
          path,
          now: new Date(Date.now() - 3_600_000),
        }),
      },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "clock-skew" });
  });

  test("rejects a body claiming someone else's machine key", async () => {
    const machine = makeMachine("laptop");
    const other = generateKeyPair("ed25519");
    const res = await signedRequest(machine, "POST", "/v1/machine/register", {
      ...machine.registerBody,
      machineKey: other.publicKey,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "machine key mismatch" });
  });

  test("will not let one machine poll another machine's request", async () => {
    const victim = makeMachine("laptop");
    const attacker = makeMachine("attacker");
    const res = await signedRequest(victim, "POST", "/v1/machine/register", victim.registerBody);
    const { pollSecret } = (await res.json()) as { pollSecret: string };

    const stolen = await signedRequest(attacker, "POST", "/v1/machine/poll", { pollSecret });
    expect(await stolen.json()).toEqual({ status: "expired" });
  });
});
