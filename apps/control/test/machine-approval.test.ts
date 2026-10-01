import { beforeEach, describe, expect, test } from "bun:test";
import { buildAuthorizationHeader, generateKeyPair, type KeyPair } from "@wave/crypto";
import { createApp } from "../src/app.ts";
import { createProviders } from "../src/auth/providers.ts";
import type { Database } from "../src/db/client.ts";
import { nodes } from "../src/db/schema.ts";
import { CookieJar, createTestDb, createWaveAs, testConfig, testSigningKey } from "./helpers.ts";

let db: Database;
let close: () => Promise<void>;
let app: ReturnType<typeof createApp>;
let signingKey: KeyPair;

beforeEach(async () => {
  if (close) await close();
  ({ db, close } = await createTestDb());
  const config = testConfig();
  signingKey = testSigningKey();
  app = createApp({ db, config, providers: createProviders(config), signingKey });
});

async function login(email: string, options: { wave?: boolean } = {}): Promise<CookieJar> {
  const jar = new CookieJar();
  const start = await app.request("/auth/dev/start");
  jar.absorb(start);
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
  const cb = await app.request(`/auth/dev/callback?code=${encodeURIComponent(email)}&state=${state}`, {
    headers: { cookie: jar.header() },
  });
  jar.absorb(cb);
  if (options.wave !== false) await createWaveAs((path, init) => app.request(path, init), jar, email);
  return jar;
}

/**
 * Enrolment as anyone can start it: the machine key is made on the spot, so
 * this needs no account on the server -- which is the whole point below.
 */
async function askToJoin(hostname: string): Promise<{ id: string; machineKey: string }> {
  const machine = generateKeyPair("ed25519");
  const body = JSON.stringify({
    machineKey: machine.publicKey,
    nodeKey: generateKeyPair("x25519").publicKey,
    discoKey: generateKeyPair("x25519").publicKey,
    hostname,
    os: "linux" as const,
  });
  const res = await app.request("/v1/machine/register", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      authorization: buildAuthorizationHeader({
        machineKey: machine.publicKey,
        machinePrivateKey: machine.privateKey,
        method: "POST",
        path: "/v1/machine/register",
        body,
      }),
    },
  });
  const pending = (await res.json()) as { status: string; authUrl: string };
  expect(pending.status).toBe("pending");
  return {
    id: new URL(pending.authUrl).searchParams.get("request") ?? "",
    machineKey: machine.publicKey,
  };
}

describe("approving a device", () => {
  /**
   * The attack this guards against: the request id is the *attacker's* secret,
   * not the victim's -- they get one by registering their own machine, which
   * needs no account. If opening the link were the approval, luring a signed-in
   * member into a top-level navigation would be enough, because `SameSite=Lax`
   * sends the session cookie on exactly that.
   */
  test("opening the link does not add the device", async () => {
    const victim = await login("opfer@example.com");
    const request = await askToJoin("attacker-laptop");

    const res = await app.request(`/machine/authorize?request=${request.id}`, {
      headers: {
        cookie: victim.header(),
        referer: "https://elsewhere.example/",
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
      },
    });

    expect(res.status).toBe(200);
    expect(await db.select().from(nodes)).toHaveLength(0);
  });

  test("the page it shows is the form that would", async () => {
    const jar = await login("robin@example.com");
    const request = await askToJoin("laptop");

    const res = await app.request(`/machine/authorize?request=${request.id}`, {
      headers: { cookie: jar.header() },
    });
    const body = await res.text();

    expect(body).toContain('method="post"');
    expect(body).toContain('action="/machine/authorize"');
    expect(body).toContain(request.id);
    expect(body).toContain("laptop");
  });

  test("posting the form adds the device", async () => {
    const jar = await login("robin@example.com");
    const request = await askToJoin("laptop");

    const form = new FormData();
    form.set("request", request.id);
    const res = await app.request("/machine/authorize", {
      method: "POST",
      body: form,
      headers: { cookie: jar.header() },
    });

    expect(res.status).toBe(200);
    const rows = await db.select().from(nodes);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.machineKey).toBe(request.machineKey);
  });

  /** No wave yet: the form that makes one, with the device link riding along. */
  test("an account without a wave is sent to make one", async () => {
    const jar = await login("neu@example.com", { wave: false });
    const request = await askToJoin("laptop");

    const res = await app.request(`/machine/authorize?request=${request.id}`, {
      headers: { cookie: jar.header() },
      redirect: "manual",
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/waves/new");
    expect(await db.select().from(nodes)).toHaveLength(0);
  });
});
