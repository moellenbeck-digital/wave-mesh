import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { createApp } from "../src/app.ts";
import type { ProviderClaims } from "../src/auth/identity.ts";
import { LoginThrottle } from "../src/auth/password.ts";
import { createProviders, type OAuthProvider } from "../src/auth/providers.ts";
import { createSession } from "../src/auth/session.ts";
import { moveAccounts } from "../src/billing/accounts.ts";
import { creationPolicyOf, waveCreationDenial } from "../src/billing/free-account.ts";
import { accountPlan } from "../src/billing/plan.ts";
import { AccountSeatLimitError } from "../src/billing/seats.ts";
import { applySubscription } from "../src/billing/subscriptions.ts";
import type { Database } from "../src/db/client.ts";
import {
  auditLog,
  customerAccounts,
  identities,
  nodes,
  users,
  waveBilling,
  waveMembers,
  waves,
} from "../src/db/schema.ts";
import { newCreationThrottles } from "../src/routes/waves.ts";
import { createInvite } from "../src/waves/invites.ts";
import { CookieJar, createTestDb, testConfig, testSigningKey } from "./helpers.ts";

/**
 * Ticket #117: the free hosted account.
 *
 * A confirmed user starts a customer account by creating the first wave, without
 * paying. These tests hold what the ticket fixes: who is refused (and with which
 * stable code), that one person never gets a second free account -- not by two
 * simultaneous requests, nor by two simultaneous sign-ins -- the rate limit, the
 * log and audit lines, the account-wide people limit, and what happens when two
 * free accounts meet.
 */

const OIDC = "oidc:https://idp.example";

class FakeProvider implements OAuthProvider {
  readonly id = "oidc";
  readonly label = "Pocket ID";
  readonly usesPkce = false;
  createAuthorizationURL(state: string): URL {
    const url = new URL("https://idp.example/oidc");
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
let config = testConfig();

beforeAll(async () => {
  ({ db, close, reset } = await createTestDb());
});
afterAll(() => close());

function makeApp(overrides: Record<string, string> = {}, creationThrottles = newCreationThrottles()) {
  config = testConfig({ WAVE_BILLING_TOKEN: "x".repeat(32), ...overrides });
  const providers = createProviders(config);
  providers.set("oidc", new FakeProvider());
  app = createApp({ db, config, providers, signingKey: testSigningKey(), creationThrottles });
}

beforeEach(async () => {
  await reset();
  makeApp();
});

async function callback(providerId: string, code: string): Promise<CookieJar> {
  const jar = new CookieJar();
  const start = await app.request(`/auth/${providerId}/start`);
  jar.absorb(start);
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
  jar.absorb(
    await app.request(`/auth/${providerId}/callback?code=${encodeURIComponent(code)}&state=${state}`, {
      headers: { cookie: jar.header() },
    }),
  );
  return jar;
}

/** The dev sign-in vouches for the address, like Google does. */
const dev = (email: string) => callback("dev", email);

const oidc = (subject: string, email: string | null, emailVerified: boolean) =>
  callback(
    "oidc",
    JSON.stringify({
      provider: OIDC,
      subject,
      email,
      emailVerified,
      name: "Robin",
      avatarUrl: null,
    } satisfies ProviderClaims),
  );

const idOf = async (email: string) =>
  (await db.select().from(users).where(eq(users.email, email)))[0]?.id ?? "";

/** What a browser form does; `json` asks for the stable code the way an API client does. */
const create = (jar: CookieJar, name: string, json = false) =>
  app.request("/waves", {
    method: "POST",
    body: new URLSearchParams({ name, suffix: `${name}.wave.internal` }),
    headers: { cookie: jar.header(), ...(json ? { accept: "application/json" } : {}) },
  });

const accounts = () => db.select().from(customerAccounts);
const waveRows = () => db.select().from(waves).orderBy(waves.name);

let logs: { mock: { calls: unknown[][] }; mockRestore: () => void };
const logged = (): string[] => logs.mock.calls.map((call) => String(call[0]));
beforeEach(() => {
  logs?.mockRestore();
  logs = spyOn(console, "log").mockImplementation(() => {});
});

describe("the free start", () => {
  test("a confirmed user's first wave makes their customer account, with an audit entry and a log line", async () => {
    const jar = await dev("anna@acme.example");
    const res = await create(jar, "alpha");
    expect(res.status).toBe(303);

    const [account] = await accounts();
    const [wave] = await waveRows();
    expect(account?.ownerUserId).toBe(await idOf("anna@acme.example"));
    expect(wave?.accountId).toBe(account?.id ?? "");
    expect(await db.select().from(waveBilling)).toHaveLength(0);

    const entries = await db.select().from(auditLog).where(eq(auditLog.action, "free-account.created"));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ waveId: wave?.id, target: account?.id, actor: "anna@acme.example" });
    expect(
      logged().some((line) => line.startsWith("free-account.created ") && line.includes(account?.id ?? "")),
    ).toBe(true);
  });

  test("further waves go into the same account, until the limit of three", async () => {
    const jar = await dev("anna@acme.example");
    for (const name of ["alpha", "beta", "gamma"]) expect((await create(jar, name)).status).toBe(303);
    expect(await accounts()).toHaveLength(1);
    expect(new Set((await waveRows()).map((w) => w.accountId)).size).toBe(1);
    expect(
      await db.select().from(auditLog).where(eq(auditLog.action, "free-account.wave-created")),
    ).toHaveLength(2);

    const refused = await create(jar, "delta", true);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "wave-limit", limit: 3 });
    expect(await waveRows()).toHaveLength(3);
    expect(logged().some((line) => line.startsWith("free-account.denied reason=wave-limit"))).toBe(true);

    // A browser gets a page that carries the same code.
    const page = await create(jar, "delta");
    expect(page.status).toBe(403);
    expect(await page.text()).toContain('data-error="wave-limit"');
  });

  test("the limit is a setting", async () => {
    makeApp({ WAVE_FREE_MAX_WAVES: "1" });
    const jar = await dev("anna@acme.example");
    expect((await create(jar, "alpha")).status).toBe(303);
    expect((await create(jar, "beta", true)).status).toBe(403);
    makeApp({ WAVE_FREE_MAX_WAVES: "" });
    expect((await create(jar, "beta")).status).toBe(303);
  });

  test("an address nobody confirmed gets no wave and no account, with its own code", async () => {
    const jar = await oidc("sub-1", "robin@example.com", false);
    const res = await create(jar, "alpha", true);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "unverified-email" });
    expect(await accounts()).toHaveLength(0);
    expect(await waveRows()).toHaveLength(0);
    expect(logged().some((line) => line.startsWith("free-account.denied reason=unverified-email"))).toBe(
      true,
    );

    // /api/me and the form say the same, before anyone posts.
    const me = (await (await app.request("/api/me", { headers: { cookie: jar.header() } })).json()) as {
      canCreateWave: boolean;
      waveCreation: { allowed: boolean; reason: string | null; limit: number };
    };
    expect(me.canCreateWave).toBe(false);
    expect(me.waveCreation).toEqual({ allowed: false, reason: "unverified-email", limit: 3 });
    const form = await (await app.request("/waves/new", { headers: { cookie: jar.header() } })).text();
    expect(form).toContain('data-error="unverified-email"');
    expect(form).not.toContain('action="/waves"');
  });

  test("a provider account without an address is refused the same way", async () => {
    const jar = await oidc("sub-2", null, false);
    const res = await create(jar, "alpha", true);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("unverified-email");
  });

  test("a placeholder -- the account a payment made -- is refused as one, never gets an account", async () => {
    const id = "u_placeholder";
    await db.insert(users).values({ id, email: "paid@acme.example", emailVerified: false });
    const session = await createSession(db, id, { userAgent: null, ip: null });
    const jar = new CookieJar();
    jar.absorb(new Response(null, { headers: { "set-cookie": `wave_session=${session.token}; Path=/` } }));
    const res = await create(jar, "alpha", true);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "placeholder" });
    expect(await accounts()).toHaveLength(0);
    expect(await waveCreationDenial(db, creationPolicyOf(config), id)).toBe("placeholder");
  });

  test("blocked email domains cannot start a free account; others can", async () => {
    makeApp({ WAVE_FREE_BLOCKED_EMAIL_DOMAINS: " Mailinator.example , trash.test" });
    const blocked = await dev("x@sub.mailinator.example");
    const res = await create(blocked, "alpha", true);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "email-domain" });
    expect(logged().some((line) => line.startsWith("free-account.denied reason=email-domain"))).toBe(true);
    expect(await accounts()).toHaveLength(0);

    const fine = await dev("y@acme.example");
    expect((await create(fine, "alpha")).status).toBe(303);
  });

  test("a self-hosted server asks nothing: no account, no limit, an unconfirmed address may create", async () => {
    makeApp({ WAVE_BILLING_TOKEN: "" });
    const jar = await oidc("sub-3", "robin@example.com", false);
    for (const name of ["a", "b", "c", "d", "e"]) expect((await create(jar, name)).status).toBe(303);
    expect(await accounts()).toHaveLength(0);
    expect((await waveRows()).every((w) => w.accountId === null)).toBe(true);
  });

  test("the same user always has the same account, even with two waves created at once", async () => {
    const jar = await dev("anna@acme.example");
    const results = await Promise.all([create(jar, "one"), create(jar, "two"), create(jar, "three")]);
    expect(results.map((r) => r.status)).toEqual([303, 303, 303]);
    expect(await accounts()).toHaveLength(1);
    expect(new Set((await waveRows()).map((w) => w.accountId)).size).toBe(1);
    // And a fourth, racing with nothing, is the limit.
    expect((await create(jar, "four")).status).toBe(403);
  });

  test("two simultaneous first sign-ins of one Pocket-ID account make one user, and one free account", async () => {
    const code = JSON.stringify({
      provider: OIDC,
      subject: "pocket-1",
      email: "robin@acme.example",
      emailVerified: true,
      name: "Robin",
      avatarUrl: null,
    } satisfies ProviderClaims);
    const [one, two] = await Promise.all([callback("oidc", code), callback("oidc", code)]);
    expect(one.get("wave_session")).toBeTruthy();
    expect(two.get("wave_session")).toBeTruthy();
    expect(await db.select().from(users)).toHaveLength(1);
    expect(await db.select().from(identities)).toHaveLength(1);

    await Promise.all([create(one, "alpha"), create(two, "beta")]);
    expect(await accounts()).toHaveLength(1);
    expect(await waveRows()).toHaveLength(2);
  });

  test("a password sign-in and a provider that vouches for the same address are one person and one account", async () => {
    const first = await dev("robin@acme.example");
    expect((await create(first, "alpha")).status).toBe(303);
    const second = await oidc("pocket-2", "robin@acme.example", true);
    expect((await create(second, "beta")).status).toBe(303);
    expect(await db.select().from(users)).toHaveLength(1);
    expect(await accounts()).toHaveLength(1);
  });
});

describe("the rate limit", () => {
  test("per user: the attempt over the limit is 429 with a stable code and the wait", async () => {
    makeApp({}, { user: new LoginThrottle(2, 3_600_000), ip: new LoginThrottle(1000, 3_600_000) });
    const jar = await dev("anna@acme.example");
    expect((await create(jar, "one")).status).toBe(303);
    expect((await create(jar, "two")).status).toBe(303);

    const res = await create(jar, "three", true);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string; retryAfter: number };
    expect(body.error).toBe("rate-limited");
    expect(body.retryAfter).toBeGreaterThan(0);
    expect(body.retryAfter).toBeLessThanOrEqual(3600);
    expect(res.headers.get("retry-after")).toBe(String(body.retryAfter));
    expect(await waveRows()).toHaveLength(2);
    expect(logged().some((line) => line.startsWith("free-account.denied reason=rate-limit"))).toBe(true);

    // Someone else is not held up by it.
    const other = await dev("ben@acme.example");
    expect((await create(other, "four")).status).toBe(303);
    // The browser's page names the wait as well.
    const page = await create(jar, "three");
    expect(page.status).toBe(429);
    expect(await page.text()).toContain('data-error="rate-limited"');
  });

  test("per address: a third person from the same address is held, whoever they are", async () => {
    makeApp({}, { user: new LoginThrottle(100, 3_600_000), ip: new LoginThrottle(2, 3_600_000) });
    const a = await dev("a@acme.example");
    const b = await dev("b@acme.example");
    const c = await dev("c@acme.example");
    expect((await create(a, "one")).status).toBe(303);
    expect((await create(b, "two")).status).toBe(303);
    const res = await create(c, "three", true);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe("rate-limited");
    expect(await accounts()).toHaveLength(2);
  });

  test("refusals count as attempts, so a refused account cannot be hammered", async () => {
    makeApp({}, { user: new LoginThrottle(2, 3_600_000), ip: new LoginThrottle(1000, 3_600_000) });
    const jar = await oidc("sub-4", "robin@example.com", false);
    expect((await create(jar, "one", true)).status).toBe(403);
    expect((await create(jar, "one", true)).status).toBe(403);
    expect((await create(jar, "one", true)).status).toBe(429);
  });

  test("a self-hosted server is not limited", async () => {
    makeApp(
      { WAVE_BILLING_TOKEN: "" },
      { user: new LoginThrottle(1, 3_600_000), ip: new LoginThrottle(1, 3_600_000) },
    );
    const jar = await dev("anna@acme.example");
    expect((await create(jar, "one")).status).toBe(303);
    expect((await create(jar, "two")).status).toBe(303);
  });
});

/** An account with its owner, waves and members, written the way the code leaves them. */
async function seed(owner: string, accountId: string, waveNames: string[], first: number) {
  await db.insert(users).values({ id: owner, email: `${owner}@x.example`, emailVerified: true });
  await db.insert(customerAccounts).values({ id: accountId, ownerUserId: owner });
  const ids: string[] = [];
  for (const [i, name] of waveNames.entries()) {
    const id = `w_${name}`;
    ids.push(id);
    await db.insert(waves).values({
      id,
      name,
      dnsSuffix: `${name}.wave.example.com`,
      ownerUserId: owner,
      accountId,
      ipv4Prefix: `10.${64 + first + i}.0.0/16`,
      ipv6Prefix: `fd7a:${first}:${i}::/48`,
    });
    await db.insert(waveMembers).values({ waveId: id, userId: owner, role: "owner" });
  }
  return ids;
}

const addPerson = async (waveId: string, id: string) => {
  await db.insert(users).values({ id, email: `${id}@x.example`, emailVerified: true });
  await db.insert(waveMembers).values({ waveId, userId: id, role: "member" });
};

let machine = 0;
const addDevice = async (waveId: string, userId: string, key = `mk-${++machine}`) => {
  machine++;
  await db.insert(nodes).values({
    id: `n-${machine}`,
    waveId,
    userId,
    machineKey: key,
    nodeKey: `nk-${machine}`,
    discoKey: `dk-${machine}`,
    hostname: `h${machine}`,
    os: "linux",
    ipv4: `10.64.${Math.floor(machine / 200)}.${machine % 200}`,
    ipv6: `fd7a:1:2::${machine}`,
    approved: true,
  });
};

const invite = (waveId: string, email: string, by = "u_anna") =>
  createInvite(db, {
    waveId,
    waveName: "w",
    email,
    role: "member",
    invitedByUserId: by,
    baseUrl: "http://localhost",
  });

describe("people in a free account: three, across all its waves", () => {
  test("members and open invitations count together; the fourth is refused with the account's limit", async () => {
    const [w1] = await seed("u_anna", "ca_anna", ["alpha"], 0);
    await invite(w1 ?? "", "b@x.example");
    await invite(w1 ?? "", "c@x.example");
    const error = await invite(w1 ?? "", "d@x.example").catch((e) => e);
    expect(error).toBeInstanceOf(AccountSeatLimitError);
    expect(error).toMatchObject({ accountId: "ca_anna", limit: 3, plan: "free" });
    expect(logged().some((line) => line.startsWith("free-account.denied reason=people-limit"))).toBe(true);
  });

  test("a new invitation for the same address replaces the old one and costs nothing", async () => {
    const [w1] = await seed("u_anna", "ca_anna", ["alpha"], 0);
    await invite(w1 ?? "", "b@x.example");
    await invite(w1 ?? "", "c@x.example");
    await invite(w1 ?? "", "b@x.example");
    await invite(w1 ?? "", "c@x.example");
  });

  test("it is the same people over all the waves: one person in two waves is one place", async () => {
    const [w1, w2] = await seed("u_anna", "ca_anna", ["alpha", "beta"], 0);
    await addPerson(w1 ?? "", "u_ben");
    await invite(w1 ?? "", "c@x.example");
    // Ben is already in the account (second place), and invited into the other wave costs nothing.
    await invite(w2 ?? "", "u_ben@x.example");
    // So does Anna's own address, and an address already invited elsewhere.
    await invite(w2 ?? "", "c@x.example");
    // A genuinely new person is the fourth.
    expect(await invite(w2 ?? "", "d@x.example").catch((e) => e)).toBeInstanceOf(AccountSeatLimitError);
  });

  test("an account of the web form says so: 409 with the limit in the reader's language", async () => {
    const jar = await dev("anna@acme.example");
    await create(jar, "alpha");
    const [wave] = await waveRows();
    for (const email of ["b@x.example", "c@x.example"]) {
      const ok = await app.request(`/waves/${wave?.id}/invites`, {
        method: "POST",
        body: new URLSearchParams({ email }),
        headers: { cookie: jar.header() },
      });
      expect([200, 303]).toContain(ok.status);
    }
    const full = await app.request(`/waves/${wave?.id}/invites`, {
      method: "POST",
      body: new URLSearchParams({ email: "d@x.example" }),
      headers: { cookie: jar.header() },
    });
    expect(full.status).toBe(409);
    expect(await full.text()).toContain("up to 3 people across all its waves");
    const de = await app.request(`/waves/${wave?.id}/invites`, {
      method: "POST",
      body: new URLSearchParams({ email: "d@x.example" }),
      headers: { cookie: jar.header(), "accept-language": "de" },
    });
    expect(await de.text()).toContain("höchstens 3 Personen");
  });

  test("a self-hosted wave has no limit", async () => {
    await db.insert(users).values({ id: "u_anna", email: "anna@x.example", emailVerified: true });
    await db.insert(waves).values({
      id: "w_alpha",
      name: "alpha",
      dnsSuffix: "alpha.wave.example.com",
      ownerUserId: "u_anna",
      ipv4Prefix: "10.64.0.0/16",
      ipv6Prefix: "fd7a:1:1::/48",
    });
    for (const email of ["a", "b", "c", "d", "e"]) await invite("w_alpha", `${email}@x.example`);
  });

  test("an account paid only through wave_billing counts the sum of its seats, memberships plus invitations, in a wave without a row of its own", async () => {
    const jar = await dev("anna@acme.example");
    const anna = await idOf("anna@acme.example");
    const sub = await applySubscription(db, "sub_1", {
      email: "anna@acme.example",
      name: "acme",
      seats: 3,
      state: "active",
    });
    if (sub.kind !== "applied") throw new Error("expected a wave");
    expect((await create(jar, "second")).status).toBe(303);
    const own = (await waveRows()).find((w) => w.name === "second");
    // Anna is in two waves: two memberships of the three seats.
    await invite(own?.id ?? "", "b@x.example", anna);
    expect(await invite(own?.id ?? "", "c@x.example", anna).catch((e) => e)).toBeInstanceOf(
      AccountSeatLimitError,
    );

    // The wave with its own row keeps its own, unchanged check: three seats, Anna and the invitation in the other wave
    // do not count there, its own members and invitations do.
    await invite(sub.view.waveId, "p@x.example", anna);
    await invite(sub.view.waveId, "q@x.example", anna);
    const per = await invite(sub.view.waveId, "r@x.example", anna).catch((e) => e);
    expect(per).toMatchObject({ seats: 3 });
    expect(per).not.toBeInstanceOf(AccountSeatLimitError);
  });

  test("the waves of a paid account have no wave limit, only the capacity", async () => {
    const jar = await dev("anna@acme.example");
    await applySubscription(db, "sub_1", {
      email: "anna@acme.example",
      name: "acme",
      seats: 3,
      state: "active",
    });
    for (const name of ["b", "c", "d", "e"]) expect((await create(jar, name)).status).toBe(303);
    expect(await waveRows()).toHaveLength(5);
  });
});

describe("what happens when two free accounts meet", () => {
  const ownedBy = async (id: string) =>
    (await db.select().from(customerAccounts).where(eq(customerAccounts.ownerUserId, id))).map((a) => a.id);
  const digest = async () => ({
    accounts: await db.select().from(customerAccounts).orderBy(customerAccounts.id),
    waves: (await db.select().from(waves).orderBy(waves.id)).map((w) => [w.id, w.accountId]),
  });
  const LIMITS = { waves: 3, people: 3, devices: 4 };

  test("what fits goes into the first account, the second account row is gone, never two free accounts", async () => {
    await seed("u_a", "ca_a", ["a1"], 0);
    await seed("u_b", "ca_b", ["b1", "b2"], 10);
    const result = await moveAccounts(db, "u_b", "u_a", LIMITS);
    expect(result).toEqual({ ok: true, consolidated: [{ from: "ca_b", into: "ca_a", waves: 2 }] });
    expect(await ownedBy("u_a")).toEqual(["ca_a"]);
    expect((await db.select().from(customerAccounts)).map((a) => a.id)).toEqual(["ca_a"]);
    expect((await db.select().from(waves)).map((w) => w.accountId)).toEqual(["ca_a", "ca_a", "ca_a"]);
  });

  test("too many waves: refused with the number, nothing written", async () => {
    await seed("u_a", "ca_a", ["a1", "a2"], 0);
    await seed("u_b", "ca_b", ["b1", "b2"], 10);
    const before = await digest();
    const result = await moveAccounts(db, "u_b", "u_a", LIMITS);
    expect(result).toEqual({ ok: false, reason: "waves", have: 4, limit: 3, into: "ca_a" });
    expect(await digest()).toEqual(before);
    expect(logged().some((line) => line.startsWith("free-account.denied reason=merge-limit"))).toBe(true);
  });

  test("too many people: the second user becomes the first, so a shared person counts once", async () => {
    const [a1] = await seed("u_a", "ca_a", ["a1"], 0);
    const [b1] = await seed("u_b", "ca_b", ["b1"], 10);
    // a: u_a + p1; b: u_b + p2. Together: u_a (u_b is u_a) + p1 + p2 = 3: fits.
    await addPerson(a1 ?? "", "p1");
    await addPerson(b1 ?? "", "p2");
    const fits = await moveAccounts(db, "u_b", "u_a", LIMITS);
    expect(fits.ok).toBe(true);
  });

  test("too many people: refused", async () => {
    const [a1] = await seed("u_a", "ca_a", ["a1"], 0);
    const [b1] = await seed("u_b", "ca_b", ["b1"], 10);
    await addPerson(a1 ?? "", "p1");
    await addPerson(b1 ?? "", "p2");
    await addPerson(b1 ?? "", "p3");
    const before = await digest();
    expect(await moveAccounts(db, "u_b", "u_a", LIMITS)).toEqual({
      ok: false,
      reason: "people",
      have: 4,
      limit: 3,
      into: "ca_a",
    });
    expect(await digest()).toEqual(before);
  });

  test("an open invitation counts as a person unless the address is a member already", async () => {
    const [a1] = await seed("u_a", "ca_a", ["a1"], 0);
    const [b1] = await seed("u_b", "ca_b", ["b1"], 10);
    await invite(a1 ?? "", "i1@x.example", "u_a");
    await invite(b1 ?? "", "i2@x.example", "u_b");
    // u_a, i1, i2 = 3 (u_b is u_a): fits.
    expect((await moveAccounts(db, "u_b", "u_a", LIMITS)).ok).toBe(true);
  });

  test("too many devices: counted as distinct machines over both accounts", async () => {
    const [a1] = await seed("u_a", "ca_a", ["a1"], 0);
    const [b1] = await seed("u_b", "ca_b", ["b1"], 10);
    await addDevice(a1 ?? "", "u_a", "m1");
    await addDevice(a1 ?? "", "u_a", "m2");
    await addDevice(b1 ?? "", "u_b", "m2"); // the same machine in both: one
    await addDevice(b1 ?? "", "u_b", "m3");
    await addDevice(b1 ?? "", "u_b", "m4");
    expect((await moveAccounts(db, "u_b", "u_a", LIMITS)).ok).toBe(true);

    await reset();
    const [c1] = await seed("u_a", "ca_a", ["a1"], 0);
    const [d1] = await seed("u_b", "ca_b", ["b1"], 10);
    for (const key of ["m1", "m2", "m3"]) await addDevice(c1 ?? "", "u_a", key);
    for (const key of ["m4", "m5"]) await addDevice(d1 ?? "", "u_b", key);
    const before = await digest();
    expect(await moveAccounts(db, "u_b", "u_a", LIMITS)).toEqual({
      ok: false,
      reason: "devices",
      have: 5,
      limit: 4,
      into: "ca_a",
    });
    expect(await digest()).toEqual(before);
  });

  test("a paid account goes over as it is, and a free one beside a paid one is no second free account", async () => {
    await seed("u_a", "ca_a", ["a1"], 0);
    await seed("u_b", "ca_b", ["b1"], 10);
    await db
      .insert(waveBilling)
      .values({ waveId: "w_b1", subscriptionId: "sub_b", seats: 2, state: "active" });
    const result = await moveAccounts(db, "u_b", "u_a", LIMITS);
    expect(result).toEqual({ ok: true, consolidated: [] });
    expect((await ownedBy("u_a")).sort()).toEqual(["ca_a", "ca_b"]);
    expect((await accountPlan(db, "ca_a")).kind).toBe("free");
    expect((await accountPlan(db, "ca_b")).kind).toBe("paid");
  });

  test("when the first user has no free account, the second's simply becomes theirs", async () => {
    await db.insert(users).values({ id: "u_a", email: "a@x.example", emailVerified: true });
    await seed("u_b", "ca_b", ["b1"], 10);
    expect((await moveAccounts(db, "u_b", "u_a", LIMITS)).ok).toBe(true);
    expect(await ownedBy("u_a")).toEqual(["ca_b"]);
  });

  test("an account the first user holds is not touched when the second has none", async () => {
    await seed("u_a", "ca_a", ["a1"], 0);
    await db.insert(users).values({ id: "u_b", email: "b@x.example", emailVerified: true });
    expect(await moveAccounts(db, "u_b", "u_a", LIMITS)).toEqual({ ok: true, consolidated: [] });
    expect(await ownedBy("u_a")).toEqual(["ca_a"]);
  });

  test("the waves a merge moved still belong to the account after the second user is deleted", async () => {
    await seed("u_a", "ca_a", ["a1"], 0);
    await seed("u_b", "ca_b", ["b1"], 10);
    await moveAccounts(db, "u_b", "u_a", LIMITS);
    await db.update(waves).set({ ownerUserId: "u_a" }).where(eq(waves.ownerUserId, "u_b"));
    await db
      .update(waveMembers)
      .set({ userId: "u_a" })
      .where(and(eq(waveMembers.waveId, "w_b1"), eq(waveMembers.userId, "u_b")));
    await db.delete(users).where(eq(users.id, "u_b"));
    expect((await db.select().from(waves).where(eq(waves.id, "w_b1")))[0]?.accountId).toBe("ca_a");
  });
});
