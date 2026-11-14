import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.ts";
import { createProviders } from "../src/auth/providers.ts";
import { ensureDeviceSlot } from "../src/billing/device-limit.ts";
import { accountPlan } from "../src/billing/plan.ts";
import { AccountSeatLimitError } from "../src/billing/seats.ts";
import { applySubscription } from "../src/billing/subscriptions.ts";
import type { Database } from "../src/db/client.ts";
import {
  accountSubscriptions,
  customerAccounts,
  nodes,
  users,
  waveBilling,
  waveMembers,
  waves,
} from "../src/db/schema.ts";
import { createInvite } from "../src/waves/invites.ts";
import { CookieJar, createTestDb, testConfig, testSigningKey } from "./helpers.ts";

/**
 * `PUT /api/billing/account-subscriptions/:id` and the plan it changes
 * (ticket #117, todo 5).
 *
 * The plan is derived: paid with a live account subscription or a `wave_billing`
 * row in the account, free otherwise. So an upgrade writes one row, a
 * cancellation writes one state, and neither touches a wave, key, address or
 * device -- which is what these tests compare.
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
beforeEach(async () => {
  await reset();
  const config = testConfig({ WAVE_BILLING_TOKEN: TOKEN });
  app = createApp({ db, config, providers: createProviders(config), signingKey: testSigningKey() });
});

const put = (id: string, body: unknown, token: string | null = TOKEN) =>
  app.request(`/api/billing/account-subscriptions/${id}`, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
  });

interface View {
  subscriptionId: string;
  accountId: string;
  created: boolean;
  state: string;
  seats: number;
  deleteAfter: string | null;
  waves: number;
  people: number;
}
const apply = async (
  id: string,
  body: unknown,
): Promise<{ status: number; json: View & { error?: string } }> => {
  const res = await put(id, body);
  return { status: res.status, json: (await res.json()) as View & { error?: string } };
};

/** A confirmed user with a customer account and one wave, as the free start leaves them. */
async function freeUser(email = "anna@acme.example") {
  const jar = new CookieJar();
  const start = await app.request("/auth/dev/start");
  jar.absorb(start);
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
  jar.absorb(
    await app.request(`/auth/dev/callback?code=${encodeURIComponent(email)}&state=${state}`, {
      headers: { cookie: jar.header() },
    }),
  );
  const res = await app.request("/waves", {
    method: "POST",
    body: new URLSearchParams({ name: "alpha", suffix: "alpha.wave.internal" }),
    headers: { cookie: jar.header() },
  });
  expect(res.status).toBe(303);
  const [user] = await db.select().from(users).where(eq(users.email, email));
  const [account] = await db
    .select()
    .from(customerAccounts)
    .where(eq(customerAccounts.ownerUserId, user?.id ?? ""));
  const [wave] = await db
    .select()
    .from(waves)
    .where(eq(waves.accountId, account?.id ?? ""));
  return { jar, userId: user?.id ?? "", accountId: account?.id ?? "", waveId: wave?.id ?? "" };
}

/** Whether a statement is refused by the database. */
const fails = async (statement: PromiseLike<unknown>): Promise<boolean> => {
  try {
    await statement;
    return false;
  } catch {
    return true;
  }
};

const invite = (waveId: string, email: string, by: string) =>
  createInvite(db, {
    waveId,
    waveName: "alpha",
    email,
    role: "member",
    invitedByUserId: by,
    baseUrl: "http://localhost",
  });

/** What an upgrade and a cancellation must leave alone. */
const snapshot = async () => ({
  waves: await db.select().from(waves).orderBy(waves.id),
  members: await db.select().from(waveMembers).orderBy(waveMembers.waveId, waveMembers.userId),
  nodes: await db.select().from(nodes).orderBy(nodes.id),
  users: (await db.select().from(users).orderBy(users.id)).map((u) => [u.id, u.email, u.emailVerified]),
  waveBilling: await db.select().from(waveBilling),
});

describe("the API", () => {
  test("is only for the site: no token is a 401, a wrong one too", async () => {
    expect((await put("sub_1", { seats: 5, state: "active" }, null)).status).toBe(401);
    expect((await put("sub_1", { seats: 5, state: "active" }, "x".repeat(32))).status).toBe(401);
  });

  test("does not exist without a billing token", async () => {
    const config = testConfig();
    const bare = createApp({ db, config, providers: createProviders(config), signingKey: testSigningKey() });
    const res = await bare.request("/api/billing/account-subscriptions/sub_1", {
      method: "PUT",
      body: JSON.stringify({ seats: 5, state: "active" }),
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  test("refuses what is not a state: bad JSON, no seats, an unknown state", async () => {
    const raw = await app.request("/api/billing/account-subscriptions/sub_1", {
      method: "PUT",
      body: "{",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(raw.status).toBe(400);
    expect((await put("sub_1", { state: "active" })).status).toBe(400);
    expect((await put("sub_1", { seats: 0, state: "active" })).status).toBe(400);
    expect((await put("sub_1", { seats: 3, state: "paused" })).status).toBe(400);
    expect((await put("sub_1", { email: "not an address", seats: 3, state: "active" })).status).toBe(400);
    expect(await db.select().from(accountSubscriptions)).toHaveLength(0);
  });

  test("a subscription never seen is only created with an address and active", async () => {
    await freeUser();
    expect((await apply("sub_1", { seats: 5, state: "active" })).json.error).toBe("unknown-subscription");
    expect((await apply("sub_1", { email: "anna@acme.example", seats: 5, state: "suspended" })).status).toBe(
      404,
    );
    expect((await apply("sub_1", { email: "anna@acme.example", seats: 5, state: "ended" })).status).toBe(404);
    expect(await db.select().from(accountSubscriptions)).toHaveLength(0);
  });

  test("an address no confirmed user has is unknown-account, and nothing is created", async () => {
    // Nobody at all.
    const none = await apply("sub_1", { email: "nobody@acme.example", seats: 5, state: "active" });
    expect(none.status).toBe(404);
    expect(none.json.error).toBe("unknown-account");
    // An address nobody confirmed (a placeholder or an unverified sign-in).
    await db.insert(users).values({ id: "u_raw", email: "raw@acme.example", emailVerified: false });
    const raw = await apply("sub_2", { email: "raw@acme.example", seats: 5, state: "active" });
    expect(raw.json.error).toBe("unknown-account");
    expect(await db.select().from(accountSubscriptions)).toHaveLength(0);
    expect(await db.select().from(customerAccounts)).toHaveLength(0);
  });

  test("a confirmed user without an account gets one with the subscription", async () => {
    await db.insert(users).values({ id: "u_ben", email: "ben@acme.example", emailVerified: true });
    const { status, json } = await apply("sub_1", { email: "Ben@Acme.example", seats: 4, state: "active" });
    expect(status).toBe(200);
    expect(json).toMatchObject({
      created: true,
      state: "active",
      seats: 4,
      deleteAfter: null,
      waves: 0,
      people: 0,
    });
    const [account] = await db.select().from(customerAccounts);
    expect(account?.ownerUserId).toBe("u_ben");
    expect(json.accountId).toBe(account?.id ?? "");
  });
});

describe("upgrading and falling back, without touching anything", () => {
  test("free -> paid -> free: the same waves, members and devices before, during and after", async () => {
    const { accountId, waveId, userId } = await freeUser();
    await db.insert(nodes).values({
      id: "n1",
      waveId,
      userId,
      machineKey: "mk1",
      nodeKey: "nk1",
      discoKey: "dk1",
      hostname: "laptop",
      os: "linux",
      ipv4: "10.64.0.2",
      ipv6: "fd7a:1:2::2",
      approved: true,
    });
    const before = await snapshot();
    expect((await accountPlan(db, accountId)).kind).toBe("free");

    const up = await apply("sub_1", { email: "anna@acme.example", seats: 10, state: "active", asOf: 100 });
    expect(up.status).toBe(200);
    expect(up.json).toMatchObject({ created: true, accountId, waves: 1, people: 1, seats: 10 });
    expect(await accountPlan(db, accountId)).toMatchObject({ kind: "paid", subscription: { seats: 10 } });
    expect(await snapshot()).toEqual(before);

    const down = await apply("sub_1", { seats: 10, state: "ended", asOf: 200 });
    expect(down.status).toBe(200);
    expect(down.json.state).toBe("ended");
    expect(down.json.deleteAfter).not.toBeNull();
    expect((await accountPlan(db, accountId)).kind).toBe("free");
    expect(await snapshot()).toEqual(before);
    // Nothing is deleted when the date passes: there is no sweep for an account subscription.
    expect(await db.select().from(waves)).toHaveLength(1);
  });

  test("seats raise the people limit, and an ended subscription is the free limit again, over-full or not", async () => {
    const { waveId, userId } = await freeUser();
    await invite(waveId, "b@x.example", userId);
    await invite(waveId, "c@x.example", userId);
    expect(await invite(waveId, "d@x.example", userId).catch((e) => e)).toBeInstanceOf(AccountSeatLimitError);

    await apply("sub_1", { email: "anna@acme.example", seats: 5, state: "active" });
    await invite(waveId, "d@x.example", userId);
    await invite(waveId, "e@x.example", userId);
    const full = await invite(waveId, "f@x.example", userId).catch((e) => e);
    expect(full).toMatchObject({ limit: 5, plan: "paid" });

    // Suspended is not ended: the account stays paid.
    await apply("sub_1", { seats: 5, state: "suspended" });
    expect(await invite(waveId, "f@x.example", userId).catch((e) => e)).toBeInstanceOf(AccountSeatLimitError);
    await apply("sub_1", { seats: 6, state: "active" });
    await invite(waveId, "f@x.example", userId);

    // Cancelled: the invitations stay, nothing new fits.
    await apply("sub_1", { seats: 6, state: "ended" });
    expect(await invite(waveId, "g@x.example", userId).catch((e) => e)).toMatchObject({
      limit: 3,
      plan: "free",
    });
  });

  test("devices are no longer limited while the subscription lives", async () => {
    const { waveId, userId } = await freeUser();
    const slot = (key: string) =>
      db.transaction((tx) =>
        ensureDeviceSlot(tx as unknown as Database, { waveId, machineKey: key, limit: 1 }).then(
          () => "ok",
          (e) => e.name,
        ),
      );
    await db.insert(nodes).values({
      id: "n1",
      waveId,
      userId,
      machineKey: "mk1",
      nodeKey: "nk1",
      discoKey: "dk1",
      hostname: "laptop",
      os: "linux",
      ipv4: "10.64.0.2",
      ipv6: "fd7a:1:2::2",
      approved: true,
    });
    expect(await slot("mk2")).toBe("DeviceLimitError");
    await apply("sub_1", { email: "anna@acme.example", seats: 5, state: "active" });
    expect(await slot("mk2")).toBe("ok");
    await apply("sub_1", { seats: 5, state: "ended" });
    expect(await slot("mk2")).toBe("DeviceLimitError");
  });

  test("a wave with a wave_billing row makes the account paid on its own, ended or not", async () => {
    const { accountId } = await freeUser("anna@acme.example");
    const sub = await applySubscription(db, "wsub_1", {
      email: "anna@acme.example",
      name: "acme",
      seats: 3,
      state: "active",
    });
    if (sub.kind !== "applied") throw new Error("expected a wave");
    expect(await accountPlan(db, accountId)).toMatchObject({
      kind: "paid",
      subscription: null,
      billedWaves: 1,
    });
    await applySubscription(db, "wsub_1", { seats: 3, state: "ended" });
    expect((await accountPlan(db, accountId)).kind).toBe("paid");
  });
});

describe("what the site can rely on, as for the wave subscriptions", () => {
  test("the same state twice is once; a stale read is answered with the current state", async () => {
    await freeUser();
    const first = await apply("sub_1", { email: "anna@acme.example", seats: 5, state: "active", asOf: 100 });
    const again = await apply("sub_1", { email: "anna@acme.example", seats: 5, state: "active", asOf: 100 });
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ ...first.json, created: false });
    expect(await db.select().from(accountSubscriptions)).toHaveLength(1);

    await apply("sub_1", { seats: 8, state: "active", asOf: 300 });
    const stale = await apply("sub_1", { seats: 2, state: "active", asOf: 200 });
    expect(stale.status).toBe(200);
    expect(stale.json.seats).toBe(8);
    expect((await db.select().from(accountSubscriptions))[0]).toMatchObject({ seats: 8, stateAsOf: 300 });
  });

  test("ended stays ended: a later active or suspended is 409, the date is set once and not pushed back", async () => {
    await freeUser();
    await apply("sub_1", { email: "anna@acme.example", seats: 5, state: "active" });
    const ended = await apply("sub_1", { seats: 5, state: "ended" });
    const due = ended.json.deleteAfter;
    expect(due).not.toBeNull();
    expect((await apply("sub_1", { seats: 5, state: "active" })).json.error).toBe("ended");
    expect((await apply("sub_1", { seats: 5, state: "suspended" })).status).toBe(409);
    const repeat = await apply("sub_1", { seats: 5, state: "ended" });
    expect(repeat.json.deleteAfter).toBe(due);
    // The date is only said, never a state: a live one has none.
    const [row] = await db.select().from(accountSubscriptions);
    expect(row?.state).toBe("ended");
  });

  test("the retention is the one of the billing configuration", async () => {
    const config = testConfig({ WAVE_BILLING_TOKEN: TOKEN, WAVE_BILLING_RETENTION_DAYS: "7" });
    app = createApp({ db, config, providers: createProviders(config), signingKey: testSigningKey() });
    await freeUser();
    await apply("sub_1", { email: "anna@acme.example", seats: 5, state: "active" });
    const ended = await apply("sub_1", { seats: 5, state: "ended" });
    const days = (new Date(ended.json.deleteAfter ?? "").getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });

  test("one live subscription per account: a second is a conflict, an ended one makes room", async () => {
    await freeUser();
    await apply("sub_1", { email: "anna@acme.example", seats: 5, state: "active" });
    const second = await apply("sub_2", { email: "anna@acme.example", seats: 9, state: "active" });
    expect(second.status).toBe(409);
    expect(second.json.error).toBe("account-has-subscription");
    expect(await db.select().from(accountSubscriptions)).toHaveLength(1);

    await apply("sub_1", { seats: 5, state: "ended" });
    expect((await apply("sub_2", { email: "anna@acme.example", seats: 9, state: "active" })).status).toBe(
      200,
    );
    expect(await db.select().from(accountSubscriptions)).toHaveLength(2);
  });

  test("the database says it as well: two live rows for one account cannot exist", async () => {
    const { accountId } = await freeUser();
    const row = (id: string, subscriptionId: string, state: "active" | "suspended" | "ended") =>
      db.insert(accountSubscriptions).values({ id, subscriptionId, accountId, seats: 3, state });
    await row("as_1", "s1", "active");
    expect(await fails(row("as_2", "s2", "suspended"))).toBe(true);
    await db.update(accountSubscriptions).set({ state: "ended" }).where(eq(accountSubscriptions.id, "as_1"));
    await row("as_3", "s3", "active");
    // And one id is one row.
    expect(await fails(row("as_4", "s3", "ended"))).toBe(true);
  });

  test("an id that is a wave's subscription is not an account's", async () => {
    await freeUser();
    await applySubscription(db, "wsub_1", {
      email: "ben@acme.example",
      name: "beta",
      seats: 3,
      state: "active",
    });
    const res = await apply("wsub_1", { email: "anna@acme.example", seats: 5, state: "active" });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("wave-subscription");
  });

  test("two deliveries at once make one row and both answer 200", async () => {
    await freeUser();
    const body = { email: "anna@acme.example", seats: 5, state: "active", asOf: 1 };
    const [a, b] = await Promise.all([apply("sub_1", body), apply("sub_1", body)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await db.select().from(accountSubscriptions)).toHaveLength(1);
    expect([a.json.created, b.json.created].filter(Boolean)).toHaveLength(1);
  });

  test("the wave subscriptions keep behaving as before, next to it", async () => {
    await freeUser();
    await apply("sub_1", { email: "anna@acme.example", seats: 5, state: "active" });
    const res = await app.request("/api/billing/subscriptions/wsub_9", {
      method: "PUT",
      body: JSON.stringify({ email: "carl@acme.example", name: "Carl", seats: 2, state: "active" }),
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { created: boolean }).created).toBe(true);
    expect(await db.select().from(waveBilling)).toHaveLength(1);
  });
});
