import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { createProviders, type OAuthProvider } from "../src/auth/providers.ts";
import { signupProviders } from "../src/auth/signup.ts";
import { loadConfig } from "../src/env.ts";
import { createTestDb, type TestDb, testConfig, testSigningKey } from "./helpers.ts";

/**
 * The sign-up page (ticket #147): a switch, `WAVE_SIGNUP_ENABLED`, that is off
 * unless it says `true` or `1`. Off: `/signup` is a 404, the login page offers
 * no link and `/api/auth/providers` says `signup: false` (as before, plus the
 * flag). On: the page, the link and the flag with the plan limits.
 */

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(() => testDb.close());

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

/** A provider that never signs anybody in; the page only lists it. */
const oidcStub: OAuthProvider = {
  id: "oidc",
  label: "Pocket ID",
  usesPkce: true,
  createAuthorizationURL: () => new URL("https://id.example.test/authorize"),
  fetchClaims: async () => {
    throw new Error("not used");
  },
};

async function appWith(env: Record<string, string>, providers?: Map<string, OAuthProvider>) {
  await testDb.reset();
  const config = testConfig(env);
  return createApp({
    db: testDb.db,
    config,
    providers: providers ?? new Map([...createProviders(config), ["oidc", oidcStub]]),
    signingKey: testSigningKey(),
  });
}

describe("the switch WAVE_SIGNUP_ENABLED", () => {
  const parse = (value: string | undefined) =>
    loadConfig({ WAVE_ENV: "test", ...(value === undefined ? {} : { WAVE_SIGNUP_ENABLED: value }) })
      .signupEnabled;

  test("is off by default", () => {
    expect(parse(undefined)).toBe(false);
  });

  test("only true or 1 turn it on", () => {
    expect(parse("true")).toBe(true);
    expect(parse("1")).toBe(true);
    expect(parse("TRUE")).toBe(true);
    expect(parse(" true ")).toBe(true);
  });

  test("empty, blank, false, 0 and unknown stay off and never fail", () => {
    for (const value of ["", "  ", "false", "0", "yes", "on", "enabled", "2"]) {
      expect(parse(value)).toBe(false);
    }
  });
});

describe("with the switch off", () => {
  test("/signup is a 404", async () => {
    const app = await appWith({});
    expect((await app.request("/signup")).status).toBe(404);
  });

  test("an empty variable is off, not an error", async () => {
    const app = await appWith({ WAVE_SIGNUP_ENABLED: "" });
    expect((await app.request("/signup")).status).toBe(404);
  });

  test("the login page has no link, and is as it was", async () => {
    const app = await appWith({});
    const body = await (await app.request("/")).text();
    expect(body).not.toContain("/signup");
    expect(body).toContain("/auth/oidc/start");
  });

  test("the providers answer says signup: false and carries no plan", async () => {
    const app = await appWith({});
    const answer = (await (await app.request("/api/auth/providers")).json()) as Record<string, unknown>;
    expect(answer.signup).toBe(false);
    expect(answer).not.toHaveProperty("freePlan");
    expect(answer.providers).toEqual(["dev", "oidc"]);
  });
});

describe("with the switch on", () => {
  test("/signup explains the free plan, the confirmed address and offers the OIDC buttons", async () => {
    const app = await appWith({ WAVE_SIGNUP_ENABLED: "true" });
    const res = await app.request("/signup", { headers: { "accept-language": "en" } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("3 waves, 3 people and 100 devices");
    expect(body).toContain("email_verified");
    expect(body).toContain('href="/auth/oidc/start?next=%2Fwaves%2Fnew"');
    expect(body).toContain("Sign up with Pocket ID");
    // The development login is no registration; no password form either.
    expect(body).not.toContain("/auth/dev/");
    expect(body).not.toContain("/auth/password");
    expect(body).not.toContain("<form");
  });

  test("the numbers follow the configuration", async () => {
    const app = await appWith({
      WAVE_SIGNUP_ENABLED: "1",
      WAVE_FREE_MAX_WAVES: "5",
      WAVE_FREE_DEVICE_LIMIT: "40",
    });
    const body = await (await app.request("/signup", { headers: { "accept-language": "en" } })).text();
    expect(body).toContain("5 waves, 3 people and 40 devices");
  });

  test("German on request", async () => {
    const app = await appWith({ WAVE_SIGNUP_ENABLED: "true" });
    const body = await (await app.request("/signup", { headers: { "accept-language": "de" } })).text();
    expect(body).toContain("Gratis starten");
    expect(body).toContain("3 Waves, 3 Personen und 100 Geräte");
    expect(body).toContain("email_verified");
  });

  test("without a configured provider the page says so instead of offering nothing", async () => {
    const app = await appWith({ WAVE_SIGNUP_ENABLED: "true" }, new Map());
    const res = await app.request("/signup", { headers: { "accept-language": "en" } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('data-signup="no-provider"');
  });

  test("the login page links to it", async () => {
    const app = await appWith({ WAVE_SIGNUP_ENABLED: "true" });
    const body = await (await app.request("/", { headers: { "accept-language": "en" } })).text();
    expect(body).toContain('<a href="/signup">Create account</a>');
  });

  test("the providers answer says signup: true with the limits of the server", async () => {
    const app = await appWith({ WAVE_SIGNUP_ENABLED: "true", WAVE_FREE_MAX_WAVES: "4" });
    const answer = await (await app.request("/api/auth/providers")).json();
    expect(answer).toMatchObject({ signup: true, freePlan: { waves: 4, people: 3, devices: 100 } });
  });

  test("the page creates no account: a visit leaves the user table empty", async () => {
    const app = await appWith({ WAVE_SIGNUP_ENABLED: "true" });
    await app.request("/signup");
    const { users } = await import("../src/db/schema.ts");
    expect(await testDb.db.select().from(users)).toHaveLength(0);
  });
});

describe("with a frontend", () => {
  async function withFrontend(enabled: boolean) {
    const frontend = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => new Response(`next:${new URL(req.url).pathname}`),
    });
    cleanup.push(() => frontend.stop(true));
    await testDb.reset();
    const config = testConfig({
      WAVE_WEB_URL: `http://127.0.0.1:${frontend.port}`,
      ...(enabled ? { WAVE_SIGNUP_ENABLED: "true" } : {}),
    });
    return createApp({
      db: testDb.db,
      config,
      providers: createProviders(config),
      signingKey: testSigningKey(),
    });
  }

  test("on: /signup goes to the page of the frontend", async () => {
    const app = await withFrontend(true);
    expect(await (await app.request("/signup")).text()).toBe("next:/signup");
  });

  test("off: the frontend still answers, and its page is the 404 (it asks /api/auth/providers)", async () => {
    const app = await withFrontend(false);
    expect(await (await app.request("/signup")).text()).toBe("next:/signup");
    const answer = (await (await app.request("/api/auth/providers")).json()) as { signup: boolean };
    expect(answer.signup).toBe(false);
  });
});

describe("who is offered", () => {
  test("the development login is not a registration", () => {
    const providers = new Map<string, OAuthProvider>([
      ["dev", { ...oidcStub, id: "dev", label: "Dev login" }],
      ["oidc", oidcStub],
    ]);
    expect(signupProviders(providers).map((p) => p.id)).toEqual(["oidc"]);
  });
});
