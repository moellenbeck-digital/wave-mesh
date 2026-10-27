import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { buildAuthorizationHeader, generateKeyPair } from "@wave/crypto";
import type { SignedNetmap } from "@wave/proto";
import { createApp } from "../src/app.ts";
import { createProviders } from "../src/auth/providers.ts";
import type { Database } from "../src/db/client.ts";
import { CookieJar, createTestDb, createWaveAs, testConfig, testSigningKey } from "./helpers.ts";

let db: Database;
let close: () => Promise<void>;
let reset: () => Promise<void>;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  ({ db, close, reset } = await createTestDb());
});

afterAll(() => close());

beforeEach(async () => {
  await reset();
  const config = testConfig();
  app = createApp({ db, config, providers: createProviders(config), signingKey: testSigningKey() });
});

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

const request = (machine: ReturnType<typeof makeMachine>, method: string, path: string, body?: unknown) => {
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

async function enrol(machine: ReturnType<typeof makeMachine>, jar: CookieJar) {
  const res = await request(machine, "POST", "/v1/machine/register", machine.body);
  const pending = (await res.json()) as { authUrl: string };
  const form = new FormData();
  form.set("request", new URL(pending.authUrl).searchParams.get("request") ?? "");
  await app.request("/machine/authorize", { method: "POST", body: form, headers: { cookie: jar.header() } });
}

async function login(): Promise<CookieJar> {
  const jar = new CookieJar();
  const start = await app.request("/auth/dev/start");
  jar.absorb(start);
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
  jar.absorb(
    await app.request(`/auth/dev/callback?code=a%40example.com&state=${state}`, {
      headers: { cookie: jar.header() },
    }),
  );
  // Signing in no longer makes a wave; its DNS suffix is its owner's choice.
  await createWaveAs((path, init) => app.request(path, init), jar, "a@example.com");
  return jar;
}

describe("endpoint publication", () => {
  test("a peer's candidates reach the other node's netmap", async () => {
    const jar = await login();
    const a = makeMachine("a");
    const b = makeMachine("b");
    await enrol(a, jar);
    await enrol(b, jar);

    const candidates = [
      { kind: "local", ip: "10.2.0.2", port: 41641 },
      { kind: "stun", ip: "203.0.113.20", port: 41641 },
    ];
    const published = await request(b, "POST", "/v1/node/endpoints", { candidates });
    expect(published.status).toBe(200);

    const netmap = ((await (await request(a, "GET", "/v1/netmap")).json()) as SignedNetmap).netmap;
    expect(netmap.peers).toHaveLength(1);
    expect(netmap.peers[0]?.candidates).toEqual(candidates as never);
  });

  test("publishing bumps the netmap version", async () => {
    const jar = await login();
    const a = makeMachine("a");
    await enrol(a, jar);

    const before = ((await (await request(a, "GET", "/v1/netmap")).json()) as SignedNetmap).netmap.version;
    await request(a, "POST", "/v1/node/endpoints", {
      candidates: [{ kind: "stun", ip: "203.0.113.1", port: 1 }],
    });
    const after = ((await (await request(a, "GET", "/v1/netmap")).json()) as SignedNetmap).netmap.version;
    expect(after).toBeGreaterThan(before);
  });

  // Nodes republish on a timer. The same set, in whatever order, must not push
  // a netmap to the whole wave: that was one every eight seconds in a wave of a
  // dozen devices, each waking every phone.
  test("the same candidates again change nothing", async () => {
    const jar = await login();
    const a = makeMachine("a");
    await enrol(a, jar);
    const version = async () =>
      ((await (await request(a, "GET", "/v1/netmap")).json()) as SignedNetmap).netmap.version;

    const set = [
      { kind: "local", ip: "10.2.0.2", port: 41641 },
      { kind: "stun", ip: "203.0.113.1", port: 1 },
    ];
    await request(a, "POST", "/v1/node/endpoints", { candidates: set });
    const first = await version();
    await request(a, "POST", "/v1/node/endpoints", { candidates: [...set].reverse() });
    expect(await version()).toBe(first);

    await request(a, "POST", "/v1/node/endpoints", {
      candidates: [...set, { kind: "stun", ip: "203.0.113.2", port: 2 }],
    });
    expect(await version()).toBeGreaterThan(first);
  });
});
