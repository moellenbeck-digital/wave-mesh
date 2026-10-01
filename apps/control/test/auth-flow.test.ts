import { beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { createProviders } from "../src/auth/providers.ts";
import type { Database } from "../src/db/client.ts";
import { loadConfig } from "../src/env.ts";
import { CookieJar, createTestDb, testConfig, testSigningKey } from "./helpers.ts";

let db: Database;
let close: () => Promise<void>;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  if (close) await close();
  ({ db, close } = await createTestDb());
  const config = testConfig();
  app = createApp({ db, config, providers: createProviders(config), signingKey: testSigningKey() });
});

const req = (path: string, jar?: CookieJar) =>
  app.request(path, jar ? { headers: { cookie: jar.header() } } : undefined);

/** Walks the dev provider end to end and returns the logged-in cookie jar. */
async function login(email: string): Promise<{ jar: CookieJar; location: string }> {
  const jar = new CookieJar();
  const start = await req("/auth/dev/start");
  expect(start.status).toBe(302);
  jar.absorb(start);

  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
  expect(state).toBeTruthy();

  const callback = await req(`/auth/dev/callback?code=${encodeURIComponent(email)}&state=${state}`, jar);
  expect(callback.status).toBe(302);
  jar.absorb(callback);
  expect(jar.get("wave_session")).toBeTruthy();
  return { jar, location: callback.headers.get("location") ?? "" };
}

/** Posts the create form the way the browser does. */
const create = (jar: CookieJar, name: string, suffix: string) =>
  app.request("/waves", {
    method: "POST",
    body: new URLSearchParams({ name, suffix }),
    headers: { cookie: jar.header() },
  });

type Me = {
  user: { email: string };
  waves: { name: string; dnsSuffix: string; role: string }[];
  suggestion: { name: string; dnsSuffix: string };
};

describe("login flow", () => {
  test("a first login makes an account but no wave, and offers the form", async () => {
    const { jar, location } = await login("robin@example.com");
    expect(location).toBe("/waves/new");

    const me = await req("/api/me", jar);
    expect(me.status).toBe(200);
    const body = (await me.json()) as Me;
    expect(body.user.email).toBe("robin@example.com");
    // Nothing was conjured: the suffix every device name hangs under is its
    // owner's choice, and a wave nobody asked for is what that would be.
    expect(body.waves).toHaveLength(0);
    expect(body.suggestion).toEqual({ name: "robin", dnsSuffix: "robin.wave.internal" });
  });

  test("the wave carries the domain its owner typed", async () => {
    const { jar } = await login("robin@example.com");
    const created = await create(jar, "home", "wave.example.com");
    expect(created.status).toBe(303);
    expect(created.headers.get("location")).toBe("/");

    const body = (await (await req("/api/me", jar)).json()) as Me;
    expect(body.waves).toHaveLength(1);
    expect(body.waves[0]?.role).toBe("owner");
    expect(body.waves[0]?.name).toBe("home");
    expect(body.waves[0]?.dnsSuffix).toBe("wave.example.com");
  });

  test("keeping the suggestion leaves the wave under the placeholder", async () => {
    const { jar } = await login("robin@example.com");
    await create(jar, "robin", "robin.wave.internal");
    const body = (await (await req("/api/me", jar)).json()) as Me;
    expect(body.waves[0]?.dnsSuffix).toBe("robin.wave.internal");
  });

  test("a typed domain is normalised, not taken as spelled", async () => {
    const { jar } = await login("robin@example.com");
    await create(jar, "home", "  Wave.Example.COM.  ");
    const body = (await (await req("/api/me", jar)).json()) as Me;
    expect(body.waves[0]?.dnsSuffix).toBe("wave.example.com");
  });

  test("something that is not a domain is refused before anything is made", async () => {
    const { jar } = await login("robin@example.com");
    expect((await create(jar, "home", "not a domain")).status).toBe(400);
    expect((await create(jar, "home", "localhost")).status).toBe(400);
    expect((await (await req("/api/me", jar)).json()) as Me).toMatchObject({ waves: [] });
  });

  test("two waves cannot answer for one zone", async () => {
    const { jar: first } = await login("robin@example.com");
    expect((await create(first, "home", "wave.example.com")).status).toBe(303);

    const { jar: second } = await login("ada@example.com");
    // Not a 500 from the unique index: the person who typed it can fix it.
    expect((await create(second, "hers", "wave.example.com")).status).toBe(409);
    expect((await (await req("/api/me", second)).json()) as Me).toMatchObject({ waves: [] });
  });

  test("the next login goes to the dashboard, not back to the form", async () => {
    const { jar } = await login("robin@example.com");
    await create(jar, "robin", "robin.wave.internal");

    const again = await login("robin@example.com");
    expect(again.location).toBe("/");
    const body = (await (await req("/api/me", again.jar)).json()) as Me;
    expect(body.waves).toHaveLength(1);
  });

  test("the plain form is prefilled and carries the destination on", async () => {
    const { jar } = await login("robin@example.com");
    const form = await req("/waves/new?next=%2Fmachine%2Fauthorize%3Frequest%3Dabc", jar);
    expect(form.status).toBe(200);
    const body = await form.text();
    expect(body).toContain('action="/waves"');
    expect(body).toContain('value="robin.wave.internal"');
    expect(body).toContain("/machine/authorize?request=abc");
  });

  test("the form sends an anonymous visitor to sign in first", async () => {
    const res = await req("/waves/new");
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toBe("/?next=/waves/new");
  });

  test("creating a wave needs a session", async () => {
    expect((await create(new CookieJar(), "home", "wave.example.com")).status).toBe(401);
  });

  test("logout invalidates the session", async () => {
    const { jar } = await login("robin@example.com");
    const out = await app.request("/auth/logout", { method: "POST", headers: { cookie: jar.header() } });
    expect(out.status).toBe(302);
    // The old token must be rejected even if the client keeps sending it.
    expect((await req("/api/me", jar)).status).toBe(401);
  });
});

describe("callback hardening", () => {
  test("rejects a mismatched state", async () => {
    const jar = new CookieJar();
    jar.absorb(await req("/auth/dev/start"));
    const res = await req("/auth/dev/callback?code=robin@example.com&state=forged", jar);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "state mismatch" });
  });

  test("rejects a callback without the state cookie", async () => {
    const res = await req("/auth/dev/callback?code=robin@example.com&state=anything");
    expect(res.status).toBe(400);
  });

  test("rejects a missing code", async () => {
    const jar = new CookieJar();
    const start = await req("/auth/dev/start");
    jar.absorb(start);
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    const res = await req(`/auth/dev/callback?state=${state}`, jar);
    expect(res.status).toBe(400);
  });

  test("consumes the state cookie, so a callback cannot be replayed", async () => {
    const jar = new CookieJar();
    const start = await req("/auth/dev/start");
    jar.absorb(start);
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    const url = `/auth/dev/callback?code=robin@example.com&state=${state}`;

    const first = await req(url, jar);
    jar.absorb(first);
    expect(first.status).toBe(302);
    expect((await req(url, jar)).status).toBe(400);
  });
});

describe("production configuration", () => {
  test("refuses to start without a netmap signing key", () => {
    expect(() => loadConfig({ WAVE_ENV: "production" })).toThrow(/WAVE_NETMAP_SIGNING_KEY/);
  });
});

describe("dev provider exposure", () => {
  test("is unavailable in production even when the flag is set", async () => {
    const config = loadConfig({
      WAVE_ENV: "production",
      WAVE_DEV_AUTH: "1",
      WAVE_NETMAP_SIGNING_KEY: testSigningKey().privateKey,
    });
    expect(config.devAuth).toBe(false);
    const prodApp = createApp({
      db,
      config,
      providers: createProviders(config),
      signingKey: testSigningKey(),
    });
    expect((await prodApp.request("/auth/dev/start")).status).toBe(404);
    expect((await prodApp.request("/auth/dev/login")).status).toBe(404);
  });

  test("unknown providers are rejected", async () => {
    expect((await req("/auth/nope/start")).status).toBe(404);
  });
});
