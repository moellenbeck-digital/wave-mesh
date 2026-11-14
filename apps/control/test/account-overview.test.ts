import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { createProviders } from "../src/auth/providers.ts";
import type { Database } from "../src/db/client.ts";
import {
  accountSubscriptions,
  customerAccounts,
  nodes,
  users,
  waveBilling,
  waveInvites,
  waveMembers,
  waves,
} from "../src/db/schema.ts";
import { CookieJar, createTestDb, testConfig, testSigningKey } from "./helpers.ts";

/**
 * Ticket #117, Nacharbeit: what an account holds against what its plan allows.
 *
 * `GET /api/billing/accounts/:id/downgrade-check` for the site (may this account
 * go back to free as it is?) and plan, limits, usage and overhang in `/api/me`
 * for the owner. Both are reports: nothing is changed, stopped or deleted
 * because a limit is exceeded, which these tests check by comparing the data
 * before and after.
 */

const TOKEN = "t".repeat(32);

let db: Database;
let close: () => Promise<void>;
let reset: () => Promise<void>;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  ({ db, close, reset } = await createTestDb());
});
afterAll(() => close());

function makeApp(overrides: Record<string, string> = {}) {
  const config = testConfig({ WAVE_BILLING_TOKEN: TOKEN, ...overrides });
  app = createApp({ db, config, providers: createProviders(config), signingKey: testSigningKey() });
}
beforeEach(async () => {
  await reset();
  makeApp();
});

const check = (accountId: string, token: string | null = TOKEN) =>
  app.request(`/api/billing/accounts/${accountId}/downgrade-check`, {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });

interface Check {
  allowed: boolean;
  limits: { waves: number; people: number; devices: number };
  usage: { waves: number; people: number; devices: number };
  overhang: { waves: number; people: number; devices: number };
}

/** An account with its owner, waves and the owner as member, written the way the code leaves it. */
async function seed(owner: string, accountId: string, count: number, first = 0) {
  await db.insert(users).values({ id: owner, email: `${owner}@x.example`, emailVerified: true });
  await db.insert(customerAccounts).values({ id: accountId, ownerUserId: owner });
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `w_${accountId}_${i}`;
    ids.push(id);
    await db.insert(waves).values({
      id,
      name: `wave-${i}`,
      dnsSuffix: `${accountId}-${i}.wave.example.com`,
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

let counter = 0;
const addDevice = async (waveId: string, userId: string, key: string, hostname = `host-${++counter}`) => {
  counter++;
  await db.insert(nodes).values({
    id: `n-${counter}`,
    waveId,
    userId,
    machineKey: key,
    nodeKey: `nk-${counter}`,
    discoKey: `dk-${counter}`,
    hostname,
    os: "linux",
    ipv4: `10.64.${Math.floor(counter / 200)}.${counter % 200}`,
    ipv6: `fd7a:1:2::${counter}`,
    approved: true,
  });
};

/**
 * An open invitation, written directly: the free limit refuses a fourth person at `createInvite()`,
 * and overhang is exactly what is above it (a cancelled subscription, an older server).
 */
const invite = async (waveId: string, email: string, by: string) => {
  await db.insert(waveInvites).values({
    id: `wi_${++counter}`,
    waveId,
    email,
    role: "member",
    tokenHash: `hash-${counter}`,
    invitedByUserId: by,
    expiresAt: new Date(Date.now() + 86_400_000),
  });
};

/** A session for a user the seed made, as a browser carries it. */
async function sessionOf(userId: string): Promise<CookieJar> {
  const { createSession } = await import("../src/auth/session.ts");
  const session = await createSession(db, userId, { userAgent: null, ip: null });
  const jar = new CookieJar();
  jar.absorb(new Response(null, { headers: { "set-cookie": `wave_session=${session.token}; Path=/` } }));
  return jar;
}

const meOf = async (jar: CookieJar) =>
  // biome-ignore lint/suspicious/noExplicitAny: the JSON of an API under test, read by path
  (await (await app.request("/api/me", { headers: { cookie: jar.header() } })).json()) as any;

const snapshot = async () => ({
  waves: (await db.select().from(waves)).map((w) => w.id).sort(),
  members: (await db.select().from(waveMembers)).map((m) => `${m.waveId}/${m.userId}`).sort(),
  nodes: (await db.select().from(nodes)).map((n) => n.id).sort(),
  accounts: (await db.select().from(customerAccounts)).map((a) => a.id).sort(),
});

describe("GET /api/billing/accounts/:id/downgrade-check", () => {
  test("is only for the site: no billing token is a 404, no or a wrong token 401", async () => {
    await seed("u_a", "ca_a", 1);
    expect((await check("ca_a", null)).status).toBe(401);
    expect((await check("ca_a", "x".repeat(32))).status).toBe(401);
    const config = testConfig();
    const bare = createApp({ db, config, providers: createProviders(config), signingKey: testSigningKey() });
    const res = await bare.request("/api/billing/accounts/ca_a/downgrade-check", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  test("an id that is no customer account is unknown-account", async () => {
    const res = await check("ca_nobody");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown-account" });
  });

  test("within the limits it is allowed, with the numbers", async () => {
    const [w] = await seed("u_a", "ca_a", 2);
    await addPerson(w ?? "", "u_b");
    await invite(w ?? "", "c@x.example", "u_a");
    await addDevice(w ?? "", "u_a", "m1");
    const res = await check("ca_a");
    expect(res.status).toBe(200);
    expect((await res.json()) as Check).toEqual({
      allowed: true,
      limits: { waves: 3, people: 3, devices: 100 },
      usage: { waves: 2, people: 3, devices: 1 },
      overhang: { waves: 0, people: 0, devices: 0 },
    });
  });

  test("exactly at the limits is still allowed", async () => {
    makeApp({ WAVE_FREE_DEVICE_LIMIT: "2" });
    const ids = await seed("u_a", "ca_a", 3);
    await addPerson(ids[0] ?? "", "u_b");
    await addPerson(ids[1] ?? "", "u_c");
    await addDevice(ids[0] ?? "", "u_a", "m1");
    await addDevice(ids[1] ?? "", "u_a", "m2");
    const body = (await (await check("ca_a")).json()) as Check;
    expect(body.allowed).toBe(true);
    expect(body.usage).toEqual({ waves: 3, people: 3, devices: 2 });
  });

  test("too many waves", async () => {
    await seed("u_a", "ca_a", 5);
    const body = (await (await check("ca_a")).json()) as Check;
    expect(body.allowed).toBe(false);
    expect(body.overhang).toEqual({ waves: 2, people: 0, devices: 0 });
    expect(body.usage.waves).toBe(5);
  });

  test("too many people: distinct users plus open invitations to addresses not involved yet", async () => {
    const [one, two] = await seed("u_a", "ca_a", 2);
    await addPerson(one ?? "", "u_b");
    await addPerson(two ?? "", "u_b2");
    // u_b is a member already: an invitation to their address is not another person.
    await invite(two ?? "", "u_b@x.example", "u_a");
    await invite(two ?? "", "new1@x.example", "u_a");
    await invite(one ?? "", "new1@x.example", "u_a"); // the same address twice is one person
    await invite(one ?? "", "new2@x.example", "u_a");
    const body = (await (await check("ca_a")).json()) as Check;
    // u_a, u_b, u_b2, new1, new2 = 5.
    expect(body.usage.people).toBe(5);
    expect(body.allowed).toBe(false);
    expect(body.overhang).toEqual({ waves: 0, people: 2, devices: 0 });
  });

  test("too many devices: distinct machines over all waves", async () => {
    makeApp({ WAVE_FREE_DEVICE_LIMIT: "3" });
    const [one, two] = await seed("u_a", "ca_a", 2);
    await addDevice(one ?? "", "u_a", "m1");
    await addDevice(two ?? "", "u_a", "m1"); // the same machine in two waves is one device
    await addDevice(one ?? "", "u_a", "m2");
    await addDevice(one ?? "", "u_a", "m3");
    expect(((await (await check("ca_a")).json()) as Check).allowed).toBe(true);
    await addDevice(two ?? "", "u_a", "m4");
    await addDevice(two ?? "", "u_a", "m5");
    const body = (await (await check("ca_a")).json()) as Check;
    expect(body.usage.devices).toBe(5);
    expect(body.limits.devices).toBe(3);
    expect(body).toMatchObject({ allowed: false, overhang: { waves: 0, people: 0, devices: 2 } });
  });

  test("it is the question 'would it fit': a paid account is judged by the free limits as well, and nothing is changed", async () => {
    const ids = await seed("u_a", "ca_a", 4);
    await db.insert(accountSubscriptions).values({
      id: "as_1",
      subscriptionId: "sub_1",
      accountId: "ca_a",
      seats: 50,
      state: "active",
    });
    const before = await snapshot();
    const body = (await (await check("ca_a")).json()) as Check;
    expect(body).toMatchObject({ allowed: false, overhang: { waves: 1 } });
    expect(await snapshot()).toEqual(before);
    expect(ids).toHaveLength(4);
  });

  test("several limits at once name each", async () => {
    makeApp({ WAVE_FREE_DEVICE_LIMIT: "1", WAVE_FREE_MAX_WAVES: "1" });
    const [one, two] = await seed("u_a", "ca_a", 2);
    await addPerson(one ?? "", "u_b");
    await addDevice(one ?? "", "u_a", "m1");
    await addDevice(two ?? "", "u_a", "m2");
    const body = (await (await check("ca_a")).json()) as Check;
    expect(body.limits).toEqual({ waves: 1, people: 3, devices: 1 });
    expect(body.overhang).toEqual({ waves: 1, people: 0, devices: 1 });
  });
});

describe("/api/me: plan, limits, usage and overhang", () => {
  test("a free account within its limits: the numbers, no overhang, the old keys unchanged", async () => {
    const [w] = await seed("u_a", "ca_a", 2);
    await addPerson(w ?? "", "u_b");
    await addDevice(w ?? "", "u_a", "m1");
    const me = await meOf(await sessionOf("u_a"));
    expect(me.account.identities).toEqual([]);
    expect(me.account.linkable).toBe(false);
    expect(me.account).toMatchObject({
      accountId: "ca_a",
      plan: "free",
      limits: { waves: 3, people: 3, devices: 100 },
      usage: { waves: 2, people: 2, devices: 1 },
      overhang: { waves: 0, people: 0, devices: 0, perWave: [] },
    });
  });

  test("a user without an account yet sees the free plan with nothing used", async () => {
    await db.insert(users).values({ id: "u_new", email: "new@x.example", emailVerified: true });
    const me = await meOf(await sessionOf("u_new"));
    expect(me.account).toMatchObject({
      accountId: null,
      plan: "free",
      limits: { waves: 3, people: 3, devices: 100 },
      usage: { waves: 0, people: 0, devices: 0 },
    });
    expect(me.account.overhang.perWave).toEqual([]);
  });

  test("a paid account has no wave or device limit, only its seats", async () => {
    await seed("u_a", "ca_a", 5);
    await db.insert(accountSubscriptions).values({
      id: "as_1",
      subscriptionId: "sub_1",
      accountId: "ca_a",
      seats: 4,
      state: "active",
    });
    const me = await meOf(await sessionOf("u_a"));
    expect(me.account).toMatchObject({
      plan: "paid",
      limits: { waves: null, people: 4, devices: null },
      usage: { waves: 5, people: 1, devices: 0 },
      overhang: { waves: 0, people: 0, devices: 0, perWave: [] },
    });
  });

  test("after a cancellation the account is free again, and the overhang is concrete: numbers, then per wave the people and devices", async () => {
    const [one, two, three, four] = await seed("u_a", "ca_a", 4);
    await addPerson(one ?? "", "u_b");
    await addPerson(two ?? "", "u_c");
    await addPerson(three ?? "", "u_d");
    await invite(four ?? "", "wait@x.example", "u_a");
    await addDevice(one ?? "", "u_a", "m1", "laptop");
    await addDevice(two ?? "", "u_b", "m2", "phone");
    await db.insert(accountSubscriptions).values({
      id: "as_1",
      subscriptionId: "sub_1",
      accountId: "ca_a",
      seats: 10,
      state: "ended",
      deleteAfter: new Date(),
    });
    const before = await snapshot();

    const me = await meOf(await sessionOf("u_a"));
    expect(me.account).toMatchObject({
      plan: "free",
      usage: { waves: 4, people: 5, devices: 2 },
      overhang: { waves: 1, people: 2, devices: 0 },
    });
    const perWave = me.account.overhang.perWave as Array<{
      waveId: string;
      waveName: string;
      people: Array<{ email: string; kind: string }>;
      devices: Array<{ name: string }>;
    }>;
    expect(perWave).toHaveLength(4);
    const first = perWave.find((w) => w.waveId === one);
    expect(first?.people).toEqual([
      { email: "u_a@x.example", kind: "member" },
      { email: "u_b@x.example", kind: "member" },
    ]);
    expect(first?.devices).toEqual([{ name: "laptop" }]);
    expect(perWave.find((w) => w.waveId === two)?.devices).toEqual([{ name: "phone" }]);
    expect(perWave.find((w) => w.waveId === four)?.people).toContainEqual({
      email: "wait@x.example",
      kind: "invitation",
    });
    // A report only: the system deleted and stopped nothing.
    expect(await snapshot()).toEqual(before);
  });

  test("a self-hosted server has no such block, and the rest of the answer is unchanged", async () => {
    makeApp({ WAVE_BILLING_TOKEN: "" });
    await seed("u_a", "ca_a", 1);
    const me = await meOf(await sessionOf("u_a"));
    expect(Object.keys(me.account).sort()).toEqual(["identities", "linkable"]);
    expect(me.user.id).toBe("u_a");
  });
});

describe("/api/me: people and devices as used / allowed (ticket #119)", () => {
  test("hosted, free: waves, people and devices each as used and limit, one rule", async () => {
    const [one, two] = await seed("u_a", "ca_a", 2);
    await addPerson(one ?? "", "u_b");
    await invite(two ?? "", "wait@x.example", "u_a");
    await addDevice(one ?? "", "u_a", "m1");
    await addDevice(two ?? "", "u_a", "m1");
    await addDevice(two ?? "", "u_a", "m2");
    const me = await meOf(await sessionOf("u_a"));
    // People: owner, u_b and one open invitation; devices: distinct machines, m1 once.
    expect(me.account.plan).toBe("free");
    expect(me.account.usage).toEqual({ waves: 2, people: 3, devices: 2 });
    expect(me.account.limits).toEqual({ waves: 3, people: 3, devices: 100 });
  });

  test("hosted, subscription: waves and devices have no limit (null), people have the seats", async () => {
    await seed("u_a", "ca_a", 1);
    await db
      .insert(accountSubscriptions)
      .values({ id: "as_1", subscriptionId: "sub_1", accountId: "ca_a", seats: 7, state: "active" });
    const me = await meOf(await sessionOf("u_a"));
    expect(me.account.plan).toBe("paid");
    expect(me.account.limits).toEqual({ waves: null, people: 7, devices: null });
  });

  test("hosted, paid only through wave_billing: people are counted the way that plan limits them", async () => {
    const [one, two] = await seed("u_a", "ca_a", 2);
    await addPerson(two ?? "", "u_b");
    // u_a (the seed's owner) is in both waves: two memberships of the plan's seats, one distinct person.
    await db
      .insert(waveBilling)
      .values({ waveId: one ?? "", subscriptionId: "sub_w", seats: 5, state: "active" });
    const me = await meOf(await sessionOf("u_a"));
    expect(me.account.plan).toBe("paid");
    expect(me.account.limits.people).toBe(5);
    expect(me.account.usage.people).toBe(3);
    expect(me.account.overhang.people).toBe(0);
  });

  test("the members of a wave carry the plan, limits and usage of its account, for the invitation hint", async () => {
    const [one] = await seed("u_a", "ca_a", 1);
    await addPerson(one ?? "", "u_b");
    await invite(one ?? "", "wait@x.example", "u_a");
    const jar = await sessionOf("u_a");
    const res = await app.request(`/api/waves/${one}/members`, { headers: { cookie: jar.header() } });
    const body = (await res.json()) as { account?: Record<string, unknown> };
    expect(body.account).toEqual({
      plan: "free",
      limits: { waves: 3, people: 3, devices: 100 },
      usage: { waves: 1, people: 3, devices: 0 },
    });
  });

  test("a self-hosted server shows and applies no free limit anywhere: no plan, no hint, no refusal", async () => {
    makeApp({ WAVE_BILLING_TOKEN: "" });
    await db.insert(users).values({ id: "u_a", email: "a@x.example", emailVerified: true });
    const jar = await sessionOf("u_a");
    const createWave = (name: string) =>
      app.request("/waves", {
        method: "POST",
        body: new URLSearchParams({ name, suffix: `${name}.wave.internal` }),
        headers: { cookie: jar.header(), accept: "application/json" },
      });
    // More waves than a free account holds: none is refused, and none gets an account.
    for (const name of ["one", "two", "three", "four"])
      expect([200, 303]).toContain((await createWave(name)).status);
    const made = await db.select().from(waves);
    expect(made).toHaveLength(4);
    expect(made.every((w) => w.accountId === null)).toBe(true);
    const one = made[0]?.id ?? "";

    // /api/me: no plan, no limits, no usage, no overhang -- and nothing that denies a new wave.
    const me = await meOf(jar);
    for (const key of ["plan", "limits", "usage", "overhang", "accountId"]) {
      expect(me.account[key]).toBeUndefined();
    }
    expect(me.canCreateWave).toBe(true);
    expect(me.waveCreation).toMatchObject({ allowed: true, reason: null });

    // The members of a wave: no `account`, so the web app has nothing to hint at.
    const members = (await (
      await app.request(`/api/waves/${one}/members`, { headers: { cookie: jar.header() } })
    ).json()) as Record<string, unknown>;
    expect(members.account).toBeUndefined();

    // More people than three, open invitations included: not refused.
    for (const id of ["u_b", "u_c", "u_d", "u_e"]) await addPerson(one, id);
    for (const email of ["i1", "i2", "i3"]) await invite(one, `${email}@x.example`, "u_a");
    const post = await app.request(`/waves/${one}/invites`, {
      method: "POST",
      body: new URLSearchParams({ email: "more@x.example" }),
      headers: { cookie: jar.header(), accept: "application/json" },
    });
    expect([200, 303]).toContain(post.status);
  });
});
