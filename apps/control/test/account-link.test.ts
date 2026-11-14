import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.ts";
import { LINK_TTL_MS } from "../src/auth/account-link.ts";
import { type ProviderClaims, resolveUser } from "../src/auth/identity.ts";
import { setPassword } from "../src/auth/password.ts";
import type { OAuthProvider } from "../src/auth/providers.ts";
import { totp } from "../src/auth/totp.ts";
import { beginSetup, confirmSetup } from "../src/auth/two-factor.ts";
import type { Database } from "../src/db/client.ts";
import {
  accountLinks,
  auditLog,
  customerAccounts,
  identities,
  nodes,
  sessions,
  users,
  waveBilling,
  waveMembers,
  waves,
} from "../src/db/schema.ts";
import {
  CookieJar,
  createTestDb,
  createWaveAs,
  type Requester,
  testConfig,
  testSigningKey,
} from "./helpers.ts";

/**
 * The guided link of an account a provider login split off (B) into the
 * verified account that holds its address (A). What matters is what it
 * refuses, in which order, and that a refusal leaves everything where it was.
 */

const ISSUER = "https://idp.example";
const OIDC = `oidc:${ISSUER}`;
const EMAIL = "robin@example.com";
const PASSWORD = "correct horse battery staple";

/** A provider whose "code" is the claims, so a test decides what the provider says. */
class FakeProvider implements OAuthProvider {
  readonly usesPkce = false;
  readonly fresh: boolean[] = [];
  constructor(
    readonly id: string,
    readonly label: string,
  ) {}
  createAuthorizationURL(state: string, _verifier: string, options?: { fresh?: boolean }): URL {
    this.fresh.push(options?.fresh === true);
    const url = new URL(`https://idp.example/${this.id}`);
    url.searchParams.set("state", state);
    return url;
  }
  async fetchClaims(code: string): Promise<ProviderClaims> {
    return JSON.parse(code) as ProviderClaims;
  }
}

let db: Database;
let close: () => Promise<void>;
let reset: () => Promise<void>;
let app: ReturnType<typeof createApp>;
let oidc: FakeProvider;

// biome-ignore lint/suspicious/noExplicitAny: the JSON of an API under test, read by path
type Json = any;

beforeAll(async () => {
  ({ db, close, reset } = await createTestDb());
});
afterAll(() => close());

beforeEach(async () => {
  await reset();
  oidc = new FakeProvider("oidc", "Pocket ID");
  const other = new FakeProvider("other", "Other ID");
  app = createApp({
    db,
    config: testConfig(),
    providers: new Map<string, OAuthProvider>([
      ["oidc", oidc],
      ["other", other],
    ]),
    signingKey: testSigningKey(),
  });
});

const claimsOf = (over: Partial<ProviderClaims> = {}): ProviderClaims => ({
  provider: OIDC,
  subject: "b-sub",
  email: EMAIL,
  emailVerified: false,
  name: "Robin",
  avatarUrl: null,
  ...over,
});

const raw: Requester = (path, init) => app.request(path, init);

const request = (path: string, jar?: CookieJar, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { ...(jar ? { cookie: jar.header() } : {}), ...init.headers } });

async function post(path: string, jar: CookieJar, fields: Record<string, string> = {}): Promise<Response> {
  const res = await request(path, jar, { method: "POST", body: new URLSearchParams(fields) });
  jar.absorb(res);
  return res;
}

/** A provider sign-in as a browser does it: start, then the callback with these claims. */
async function providerLogin(providerId: string, claims: ProviderClaims): Promise<CookieJar> {
  const jar = new CookieJar();
  const start = await request(`/auth/${providerId}/start`, jar);
  jar.absorb(start);
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
  const callback = await request(
    `/auth/${providerId}/callback?code=${encodeURIComponent(JSON.stringify(claims))}&state=${state}`,
    jar,
  );
  jar.absorb(callback);
  expect(jar.get("wave_session")).toBeTruthy();
  return jar;
}

async function passwordLogin(email = EMAIL): Promise<CookieJar> {
  const jar = new CookieJar();
  const res = await request("/auth/password/login", jar, {
    method: "POST",
    body: new URLSearchParams({ email, password: PASSWORD }),
  });
  jar.absorb(res);
  expect(jar.get("wave_session")).toBeTruthy();
  return jar;
}

const idOf = async (email: string, verified: boolean) =>
  (await db.select().from(users)).find((u) => u.email === email && u.emailVerified === verified)?.id ?? "";

interface Scenario {
  a: string;
  b: string;
  jarA: CookieJar;
  jarB: CookieJar;
}

/** A: verified, with a password and a wave of its own. B: split off by a provider that did not vouch. */
async function scenario(): Promise<Scenario> {
  await setPassword(db, EMAIL, PASSWORD);
  const jarA = await passwordLogin();
  await createWaveAs(raw, jarA, EMAIL, { suffix: "a.wave.example.com" });
  const jarB = await providerLogin("oidc", claimsOf());
  const a = await idOf(EMAIL, true);
  const b = await idOf(EMAIL, false);
  expect(a).not.toBe("");
  expect(b).not.toBe("");
  expect(a).not.toBe(b);
  return { a, b, jarA, jarB };
}

const state = async (jar: CookieJar) => (await (await request("/api/account/link", jar)).json()) as Json;

/** The browser's way through step one: POST the start, then the provider's answer. */
async function proveAddressAs(jar: CookieJar, claims: ProviderClaims): Promise<Response> {
  const start = await post("/account/link/start", jar, { provider: "oidc" });
  expect(start.status).toBe(303);
  const flow = new URL(start.headers.get("location") ?? "").searchParams.get("state");
  const callback = await request(
    `/auth/oidc/callback?code=${encodeURIComponent(JSON.stringify(claims))}&state=${flow}`,
    jar,
  );
  jar.absorb(callback);
  return callback;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);
const verifiedNow = (over: Partial<ProviderClaims> = {}) =>
  claimsOf({ emailVerified: true, authTime: nowSeconds(), ...over });

const locationOf = (res: Response) => res.headers.get("location") ?? "";

/** Steps one and two with A's password: the request stands at the confirmation. */
async function reachConfirmation(jarB: CookieJar): Promise<void> {
  expect(locationOf(await proveAddressAs(jarB, verifiedNow()))).toBe("/account/link");
  expect(locationOf(await post("/account/link/control/password", jarB, { password: PASSWORD }))).toBe(
    "/account/link",
  );
  expect((await state(jarB)).state).toBe("confirm");
}

const countOf = async (userId: string) => ({
  identities: (await db.select().from(identities).where(eq(identities.userId, userId))).length,
  owned: (await db.select().from(waves).where(eq(waves.ownerUserId, userId))).length,
  members: (await db.select().from(waveMembers).where(eq(waveMembers.userId, userId))).length,
  nodes: (await db.select().from(nodes).where(eq(nodes.userId, userId))).length,
});

async function addDevice(waveId: string, userId: string, name: string, last: number) {
  await db.insert(nodes).values({
    id: `n-${name}`,
    waveId,
    userId,
    machineKey: `mk-${name}`,
    nodeKey: `nk-${name}`,
    discoKey: `dk-${name}`,
    hostname: name,
    os: "linux",
    ipv4: `10.64.0.${last}`,
    ipv6: `fd7a:1:2::${last}`,
    approved: true,
  });
}

describe("the starting point", () => {
  test("an unverified address is offered the link, a verified one is not, and nobody learns whether the other account exists", async () => {
    const { jarA, jarB } = await scenario();
    const b = (await (await request("/api/me", jarB)).json()) as Json;
    expect(b.account.linkable).toBe(true);
    expect(b.account.identities).toEqual([{ provider: OIDC, label: "Pocket ID" }]);
    const a = (await (await request("/api/me", jarA)).json()) as Json;
    expect(a.account.linkable).toBe(false);
    // No A-side facts before the provider has vouched for the address.
    const none = await state(jarB);
    expect(none.state).toBe("none");
    expect(JSON.stringify(none)).not.toContain("a.wave.example.com");
  });

  test("unverified addresses still never link by themselves", async () => {
    const { a, b } = await scenario();
    // The same identity again, now vouched for: a known identity returns at once, B stays B.
    const again = await providerLogin("oidc", claimsOf({ emailVerified: true }));
    expect(((await (await request("/api/me", again)).json()) as Json).user.id).toBe(b);
    expect(b).not.toBe(a);
    expect((await db.select().from(users)).length).toBe(2);
  });

  test("it needs a session and is refused to someone else's request", async () => {
    await scenario();
    expect((await request("/api/account/link")).status).toBe(401);
    expect(
      locationOf(
        await request("/account/link/start", undefined, {
          method: "POST",
          body: new URLSearchParams({ provider: "oidc" }),
        }),
      ),
    ).toBe("/");
  });
});

describe("step one: a fresh proof of the confirmed address", () => {
  test("asks the provider to sign in again, and a vouched address with B's identity names A", async () => {
    const { jarB } = await scenario();
    const callback = await proveAddressAs(jarB, verifiedNow());
    expect(locationOf(callback)).toBe("/account/link");
    expect(oidc.fresh).toContain(true);
    const s = await state(jarB);
    expect(s.state).toBe("control");
    expect(s.address).toBe(EMAIL);
    expect(s.control).toEqual({ password: true, providers: [], needsCode: false });
  });

  test("an address the provider does not vouch for changes nothing", async () => {
    const { jarB } = await scenario();
    const callback = await proveAddressAs(jarB, claimsOf({ emailVerified: false, authTime: nowSeconds() }));
    expect(locationOf(callback)).toBe("/account/link?error=unverified");
    expect((await state(jarB)).state).toBe("address");
  });

  test("a login that names another identity than B's is refused", async () => {
    const { jarB } = await scenario();
    const callback = await proveAddressAs(jarB, verifiedNow({ subject: "someone-else" }));
    expect(locationOf(callback)).toBe("/account/link?error=foreign-identity");
    expect((await state(jarB)).state).toBe("address");
  });

  test("a login that is A's own identity is not B's either", async () => {
    const { a, jarB } = await scenario();
    await db
      .insert(identities)
      .values({ id: "i_a_oidc", userId: a, provider: OIDC, subject: "a-sub", email: EMAIL });
    const callback = await proveAddressAs(jarB, verifiedNow({ subject: "a-sub" }));
    expect(locationOf(callback)).toBe("/account/link?error=foreign-identity");
  });

  test("an old session of the provider is not a fresh login", async () => {
    const { jarB } = await scenario();
    const callback = await proveAddressAs(jarB, verifiedNow({ authTime: nowSeconds() - 3600 }));
    expect(locationOf(callback)).toBe("/account/link?error=stale");
    expect((await state(jarB)).state).toBe("address");
  });

  test("without a verified account that holds the address there is nothing to link, and nothing changes", async () => {
    const jarB = await providerLogin("oidc", claimsOf());
    const callback = await proveAddressAs(jarB, verifiedNow());
    expect(locationOf(callback)).toBe("/account/link?error=no-target");
    expect((await db.select().from(users)).length).toBe(1);
  });

  test("two accounts with the address are not guessed between", async () => {
    await scenario();
    await db.insert(users).values({ id: "u_dup", email: EMAIL, emailVerified: true });
    const jarB = await providerLogin("oidc", claimsOf());
    const callback = await proveAddressAs(jarB, verifiedNow());
    expect(locationOf(callback)).toBe("/account/link?error=ambiguous");
  });

  test("the callback of a link flow without the request's token does nothing", async () => {
    const { jarB } = await scenario();
    const start = await post("/account/link/start", jarB, { provider: "oidc" });
    const flow = new URL(locationOf(start)).searchParams.get("state");
    jarB.absorb(new Response(null, { headers: { "set-cookie": "wave_link=; Max-Age=0; Path=/" } }));
    const callback = await request(
      `/auth/oidc/callback?code=${encodeURIComponent(JSON.stringify(verifiedNow()))}&state=${flow}`,
      jarB,
    );
    expect(locationOf(callback)).toBe("/account/link?error=expired");
  });

  test("a plain sign-in after a started link is a plain sign-in", async () => {
    const { b, jarB } = await scenario();
    await post("/account/link/start", jarB, { provider: "oidc" });
    // The stale flow cookie is cleared by the next plain start.
    const again = await request("/auth/oidc/start", jarB);
    jarB.absorb(again);
    const flow = new URL(locationOf(again)).searchParams.get("state");
    const callback = await request(
      `/auth/oidc/callback?code=${encodeURIComponent(JSON.stringify(claimsOf()))}&state=${flow}`,
      jarB,
    );
    expect(locationOf(callback)).not.toContain("/account/link");
    expect((await state(jarB)).state === "address" || (await state(jarB)).state === "none").toBe(true);
    expect(await idOf(EMAIL, false)).toBe(b);
  });
});

describe("step two: control of A, without a session", () => {
  test("A's password counts, and B stays signed in as B", async () => {
    const { b, jarB } = await scenario();
    await proveAddressAs(jarB, verifiedNow());
    const sessionBefore = jarB.get("wave_session");
    const res = await post("/account/link/control/password", jarB, { password: PASSWORD });
    expect(locationOf(res)).toBe("/account/link");
    expect(jarB.get("wave_session")).toBe(sessionBefore);
    expect(((await (await request("/api/me", jarB)).json()) as Json).user.id).toBe(b);
    expect((await state(jarB)).state).toBe("confirm");
  });

  test("a wrong password does not count and is throttled", async () => {
    const { jarB } = await scenario();
    await proveAddressAs(jarB, verifiedNow());
    for (let i = 0; i < 10; i++) {
      expect(locationOf(await post("/account/link/control/password", jarB, { password: "nope" }))).toBe(
        "/account/link?error=wrong-password",
      );
    }
    expect(locationOf(await post("/account/link/control/password", jarB, { password: PASSWORD }))).toBe(
      "/account/link?error=throttled",
    );
    expect((await state(jarB)).state).toBe("control");
  });

  test("B's own password is not A's", async () => {
    const { b, jarB } = await scenario();
    await setPassword(db, "elsewhere@example.com", "another password entirely");
    await proveAddressAs(jarB, verifiedNow());
    expect(
      locationOf(
        await post("/account/link/control/password", jarB, { password: "another password entirely" }),
      ),
    ).toBe("/account/link?error=wrong-password");
    expect(b).not.toBe("");
  });

  test("with a second factor the password is half the proof, and the code comes only after it", async () => {
    const { a, jarB } = await scenario();
    const setup = await beginSetup(db, a, EMAIL);
    await confirmSetup(db, a, totp(setup?.secret ?? "", Date.now()));
    await proveAddressAs(jarB, verifiedNow());

    // A code without the password step is not accepted, whatever it is.
    expect(locationOf(await post("/account/link/control/code", jarB, { code: "000000" }))).toBe(
      "/account/link?error=password-needed",
    );
    expect(locationOf(await post("/account/link/control/password", jarB, { password: PASSWORD }))).toBe(
      "/account/link",
    );
    expect((await state(jarB)).control.needsCode).toBe(true);
    expect((await state(jarB)).state).toBe("control");

    expect(locationOf(await post("/account/link/control/code", jarB, { code: "000000" }))).toBe(
      "/account/link?error=wrong-code",
    );
    const next = totp(setup?.secret ?? "", Date.now() + 30_000);
    expect(locationOf(await post("/account/link/control/code", jarB, { code: next }))).toBe("/account/link");
    expect((await state(jarB)).state).toBe("confirm");
  });

  test("five wrong codes send the person back to the password", async () => {
    const { a, jarB } = await scenario();
    const setup = await beginSetup(db, a, EMAIL);
    await confirmSetup(db, a, totp(setup?.secret ?? "", Date.now()));
    await proveAddressAs(jarB, verifiedNow());
    await post("/account/link/control/password", jarB, { password: PASSWORD });
    for (let i = 0; i < 5; i++) await post("/account/link/control/code", jarB, { code: "000000" });
    expect(
      locationOf(
        await post("/account/link/control/code", jarB, {
          code: totp(setup?.secret ?? "", Date.now() + 30_000),
        }),
      ),
    ).toBe("/account/link?error=password-needed");
    expect((await state(jarB)).control.needsCode).toBe(false);
  });

  test("another provider counts if A owns that identity -- and never the one being linked", async () => {
    const { a, b, jarB } = await scenario();
    await db
      .insert(identities)
      .values({ id: "i_a_other", userId: a, provider: "other", subject: "a-other", email: EMAIL });
    await proveAddressAs(jarB, verifiedNow());
    const s = await state(jarB);
    expect(s.control.providers).toEqual([{ id: "other", label: "Other ID" }]);

    // The provider being linked is not offered and not accepted.
    expect(locationOf(await post("/account/link/control/provider", jarB, { provider: "oidc" }))).toBe(
      "/account/link?error=not-target",
    );

    const sessionBefore = jarB.get("wave_session");
    const start = await post("/account/link/control/provider", jarB, { provider: "other" });
    const flow = new URL(locationOf(start)).searchParams.get("state");
    const callback = await request(
      `/auth/other/callback?code=${encodeURIComponent(JSON.stringify({ ...claimsOf(), provider: "other", subject: "a-other" }))}&state=${flow}`,
      jarB,
    );
    jarB.absorb(callback);
    expect(locationOf(callback)).toBe("/account/link");
    // No session was made for A, B is still B.
    expect(jarB.get("wave_session")).toBe(sessionBefore);
    expect(((await (await request("/api/me", jarB)).json()) as Json).user.id).toBe(b);
    expect((await state(jarB)).state).toBe("confirm");
  });

  test("a provider login that is not A's does not count", async () => {
    const { a, jarB } = await scenario();
    await db
      .insert(identities)
      .values({ id: "i_a_other", userId: a, provider: "other", subject: "a-other", email: EMAIL });
    await proveAddressAs(jarB, verifiedNow());
    const start = await post("/account/link/control/provider", jarB, { provider: "other" });
    const flow = new URL(locationOf(start)).searchParams.get("state");
    const callback = await request(
      `/auth/other/callback?code=${encodeURIComponent(JSON.stringify({ ...claimsOf(), provider: "other", subject: "stranger" }))}&state=${flow}`,
      jarB,
    );
    expect(locationOf(callback)).toBe("/account/link?error=not-target");
    expect((await state(jarB)).state).toBe("control");
  });

  test("an A without any way in is said so and nothing changes", async () => {
    const { a, jarB } = await scenario();
    await db.update(users).set({ passwordHash: null }).where(eq(users.id, a));
    await proveAddressAs(jarB, verifiedNow());
    const s = await state(jarB);
    expect(s.control).toEqual({ password: false, providers: [], needsCode: false });
    expect(locationOf(await post("/account/link/confirm", jarB))).toBe("/account/link?error=no-way");
    expect((await db.select().from(users)).length).toBe(2);
  });

  test("step two before step one is refused", async () => {
    const { jarB } = await scenario();
    await post("/account/link/start", jarB, { provider: "oidc" });
    expect(locationOf(await post("/account/link/control/password", jarB, { password: PASSWORD }))).toBe(
      "/account/link?error=expired",
    );
  });
});

describe("step three: the summary and the POST", () => {
  test("a GET never changes anything, and the confirmation is unreachable before the proofs", async () => {
    const { a, b, jarB } = await scenario();
    const before = { a: await countOf(a), b: await countOf(b) };
    await request("/account/link", jarB);
    await request("/account/link/done", jarB);
    await request("/account/link/confirm", jarB);
    expect(locationOf(await post("/account/link/confirm", jarB))).toBe("/account/link?error=expired");
    await proveAddressAs(jarB, verifiedNow());
    expect(locationOf(await post("/account/link/confirm", jarB))).toBe("/account/link?error=no-way");
    expect({ a: await countOf(a), b: await countOf(b) }).toEqual(before);
  });

  test("names what moves, with numbers and names, before anything does", async () => {
    const { a, b, jarA, jarB } = await scenario();
    await createWaveAs(raw, jarB, EMAIL, { suffix: "b.wave.example.com" });
    const waveOfB = (await db.select().from(waves).where(eq(waves.ownerUserId, b)))[0];
    const waveOfA = (await db.select().from(waves).where(eq(waves.ownerUserId, a)))[0];
    if (!waveOfB || !waveOfA) throw new Error("both were expected to own a wave");
    await db
      .insert(waveBilling)
      .values({ waveId: waveOfB.id, subscriptionId: "sub_b", seats: 3, state: "active" });
    // B is a plain member of A's wave: A is the owner there, so its role stays and B's row goes.
    await db.insert(waveMembers).values({ waveId: waveOfA.id, userId: b, role: "member" });
    await addDevice(waveOfB.id, b, "laptop", 10);
    await addDevice(waveOfA.id, b, "phone", 11);
    expect(jarA.get("wave_session")).toBeTruthy();

    await reachConfirmation(jarB);
    const s = (await state(jarB)) as Json;
    expect(s.summary.identities).toEqual([{ provider: OIDC, label: "Pocket ID" }]);
    expect(s.summary.ownedWaves).toEqual([
      { id: waveOfB.id, name: waveOfB.name, billing: "active", targetWasMember: false },
    ]);
    expect(s.summary.memberships).toEqual([
      {
        waveId: waveOfA.id,
        name: waveOfA.name,
        role: "member",
        targetRole: "owner",
        outcome: "keeps-target-role",
      },
    ]);
    expect(s.summary.devices.map((d: { hostname: string }) => d.hostname).sort()).toEqual([
      "laptop",
      "phone",
    ]);
    expect(s.summary.sessions).toBe(1);
  });

  test("moves everything, ends B's sessions, signs in A, and the provider now leads to A", async () => {
    const { a, b, jarB } = await scenario();
    await createWaveAs(raw, jarB, EMAIL, { suffix: "b.wave.example.com" });
    const waveOfB = (await db.select().from(waves).where(eq(waves.ownerUserId, b)))[0];
    const waveOfA = (await db.select().from(waves).where(eq(waves.ownerUserId, a)))[0];
    if (!waveOfB || !waveOfA) throw new Error("both were expected to own a wave");
    await db
      .insert(waveBilling)
      .values({ waveId: waveOfB.id, subscriptionId: "sub_b", seats: 3, state: "active" });
    // B owns a customer account (a billing unit, not a user) with the wave under it.
    await db.insert(customerAccounts).values({ id: "ca_b", ownerUserId: b });
    await db.update(waves).set({ accountId: "ca_b" }).where(eq(waves.id, waveOfB.id));
    await db.insert(waveMembers).values({ waveId: waveOfA.id, userId: b, role: "member" });
    await addDevice(waveOfB.id, b, "laptop", 10);
    const oldSession = jarB.get("wave_session");

    await reachConfirmation(jarB);
    const res = await post("/account/link/confirm", jarB);
    expect(locationOf(res)).toBe("/account/link/done?waves=1&devices=1");

    // A is signed in, in a session made now.
    expect(jarB.get("wave_session")).not.toBe(oldSession);
    const me = (await (await request("/api/me", jarB)).json()) as Json;
    expect(me.user.id).toBe(a);
    expect(me.waves.map((w: { id: string }) => w.id).sort()).toEqual([waveOfA.id, waveOfB.id].sort());
    expect(me.waves.find((w: { id: string }) => w.id === waveOfB.id).role).toBe("owner");
    // A's role in A's own wave stayed; B's membership there is gone.
    expect(
      (await db.select().from(waveMembers).where(eq(waveMembers.waveId, waveOfA.id))).map((m) => [
        m.userId,
        m.role,
      ]),
    ).toEqual([[a, "owner"]]);
    // Billing stayed on the wave.
    expect((await db.select().from(waveBilling).where(eq(waveBilling.waveId, waveOfB.id)))[0]?.state).toBe(
      "active",
    );
    // The customer account went to A with the wave; deleting B did not take it along.
    expect(await db.select().from(customerAccounts)).toEqual([
      expect.objectContaining({ id: "ca_b", ownerUserId: a }),
    ]);
    expect((await db.select().from(waves).where(eq(waves.id, waveOfB.id)))[0]?.accountId).toBe("ca_b");
    // The device is A's, in the same wave, with the same name and address.
    const device = (await db.select().from(nodes))[0];
    expect([device?.userId, device?.waveId, device?.hostname, device?.ipv4]).toEqual([
      a,
      waveOfB.id,
      "laptop",
      "10.64.0.10",
    ]);
    // B is gone, with its sessions, and its old token opens nothing.
    expect((await db.select().from(users).where(eq(users.id, b))).length).toBe(0);
    expect((await db.select().from(sessions).where(eq(sessions.userId, b))).length).toBe(0);
    const stale = new CookieJar();
    stale.absorb(new Response(null, { headers: { "set-cookie": `wave_session=${oldSession}; Path=/` } }));
    expect((await request("/api/me", stale)).status).toBe(401);
    expect((await db.select().from(accountLinks)).length).toBe(0);

    // The provider login leads to A now, with no new account.
    const again = await providerLogin("oidc", claimsOf());
    expect(((await (await request("/api/me", again)).json()) as Json).user.id).toBe(a);
    expect((await db.select().from(users)).length).toBe(1);
    expect(
      (await db.select().from(identities).where(eq(identities.userId, a))).map((i) => i.provider).sort(),
    ).toEqual([OIDC, "password"].sort());
    // The wave's log says it.
    expect((await db.select().from(auditLog)).some((e) => e.action === "account.link")).toBe(true);
  });

  test("a wave B owns, with A a plain member in it, ends with A as its owner -- and the page says so first", async () => {
    const { a, b, jarB } = await scenario();
    await createWaveAs(raw, jarB, EMAIL, { suffix: "b.wave.example.com" });
    const waveOfB = (await db.select().from(waves).where(eq(waves.ownerUserId, b)))[0];
    if (!waveOfB) throw new Error("B was expected to own a wave");
    await db.insert(waveMembers).values({ waveId: waveOfB.id, userId: a, role: "member" });

    await reachConfirmation(jarB);
    expect(((await state(jarB)) as Json).summary.ownedWaves[0].targetWasMember).toBe(true);
    await post("/account/link/confirm", jarB);
    expect((await db.select().from(waves).where(eq(waves.id, waveOfB.id)))[0]?.ownerUserId).toBe(a);
    expect(
      (await db.select().from(waveMembers).where(eq(waveMembers.waveId, waveOfB.id))).map((m) => [
        m.userId,
        m.role,
      ]),
    ).toEqual([[a, "owner"]]);
  });

  test("the request works once", async () => {
    const { jarB } = await scenario();
    await reachConfirmation(jarB);
    const [first, second] = await Promise.all([
      post("/account/link/confirm", jarB),
      post("/account/link/confirm", jarB),
    ]);
    const answers = [locationOf(first), locationOf(second)].sort();
    expect(answers.filter((a) => a.startsWith("/account/link/done"))).toHaveLength(1);
    expect((await db.select().from(users)).length).toBe(1);
  });

  test("an expired request moves nothing", async () => {
    const { a, b, jarB } = await scenario();
    await reachConfirmation(jarB);
    await db.update(accountLinks).set({ expiresAt: new Date(Date.now() - 1000) });
    expect(locationOf(await post("/account/link/confirm", jarB))).toBe("/account/link?error=expired");
    expect((await db.select().from(users)).length).toBe(2);
    expect((await countOf(a)).identities + (await countOf(b)).identities).toBe(2);
    expect(LINK_TTL_MS).toBe(10 * 60 * 1000);
  });

  test("a cancelled request cannot be used again", async () => {
    const { jarB } = await scenario();
    await reachConfirmation(jarB);
    const token = jarB.get("wave_link") ?? "";
    await post("/account/link/cancel", jarB);
    // Even with the old token back in the jar.
    jarB.absorb(new Response(null, { headers: { "set-cookie": `wave_link=${token}; Path=/` } }));
    expect(locationOf(await post("/account/link/confirm", jarB))).toBe("/account/link?error=expired");
    expect((await db.select().from(users)).length).toBe(2);
  });

  test("a second start replaces the first: only the newest token works", async () => {
    const { jarB } = await scenario();
    await reachConfirmation(jarB);
    const oldToken = jarB.get("wave_link") ?? "";
    await post("/account/link/start", jarB, { provider: "oidc" });
    const stale = new CookieJar();
    stale.absorb(
      new Response(null, {
        headers: {
          "set-cookie": [
            `wave_link=${oldToken}; Path=/`,
            `wave_session=${jarB.get("wave_session")}; Path=/`,
          ].join(", "),
        },
      }),
    );
    stale.absorb(
      new Response(null, { headers: { "set-cookie": `wave_session=${jarB.get("wave_session")}; Path=/` } }),
    );
    expect(locationOf(await post("/account/link/confirm", stale))).toBe("/account/link?error=expired");
  });

  test("somebody else's session cannot continue B's request", async () => {
    const { jarB } = await scenario();
    await reachConfirmation(jarB);
    const intruder = await providerLogin("other", {
      provider: "other",
      subject: "c-sub",
      email: "mallory@example.com",
      emailVerified: true,
      name: "Mallory",
      avatarUrl: null,
    });
    // Mallory somehow has B's request token, but not B's session.
    intruder.absorb(
      new Response(null, { headers: { "set-cookie": `wave_link=${jarB.get("wave_link")}; Path=/` } }),
    );
    expect(locationOf(await post("/account/link/confirm", intruder))).toBe("/account/link?error=expired");
    expect((await db.select().from(users)).length).toBe(3);
  });

  test("everything is checked again at the POST: A no longer holding the address verified moves nothing", async () => {
    const { a, b, jarB } = await scenario();
    await reachConfirmation(jarB);
    await db.update(users).set({ emailVerified: false }).where(eq(users.id, a));
    expect(locationOf(await post("/account/link/confirm", jarB))).toBe("/account/link?error=changed");
    expect((await countOf(b)).identities).toBe(1);
    expect((await db.select().from(users).where(eq(users.id, b))).length).toBe(1);
  });

  test("another account appearing with the address verified moves nothing", async () => {
    const { jarB } = await scenario();
    await reachConfirmation(jarB);
    await db.insert(users).values({ id: "u_second", email: EMAIL, emailVerified: true });
    expect(locationOf(await post("/account/link/confirm", jarB))).toBe("/account/link?error=changed");
    expect((await db.select().from(users)).length).toBe(3);
  });

  test("B's identity no longer being B's moves nothing", async () => {
    const { a, jarB } = await scenario();
    await reachConfirmation(jarB);
    await db.update(identities).set({ userId: a }).where(eq(identities.provider, OIDC));
    expect(locationOf(await post("/account/link/confirm", jarB))).toBe("/account/link?error=changed");
    expect((await db.select().from(users)).length).toBe(2);
  });

  test("a restart of step one takes the later proofs back", async () => {
    const { jarB } = await scenario();
    await reachConfirmation(jarB);
    await proveAddressAs(jarB, verifiedNow());
    expect((await state(jarB)).state).toBe("control");
    expect(locationOf(await post("/account/link/confirm", jarB))).toBe("/account/link?error=no-way");
  });
});

describe("what the guided link does not touch", () => {
  test("resolveUser still never links an unverified address", async () => {
    const first = await resolveUser(db, claimsOf({ emailVerified: true, provider: "google", subject: "g" }));
    const other = await resolveUser(db, claimsOf({ emailVerified: false }));
    expect(other.userId).not.toBe(first.userId);
    expect(other.isNewUser).toBe(true);
  });
});
