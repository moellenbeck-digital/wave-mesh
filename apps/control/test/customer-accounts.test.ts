import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { setPassword } from "../src/auth/password.ts";
import { accountQuota, ensureAccountFor } from "../src/billing/accounts.ts";
import { applySubscription, sweepEndedWaves } from "../src/billing/subscriptions.ts";
import type { Database } from "../src/db/client.ts";
import { customerAccounts, users, waves } from "../src/db/schema.ts";
import { deleteWave, ensureWaveForUser } from "../src/waves/provision.ts";
import { createTestDb } from "./helpers.ts";

/**
 * The customer account (`customer_accounts`): the unit a hosted customer is
 * billed as. Neither a user nor an OIDC identity -- these tests keep those
 * apart: the account only *names* a user as its owner.
 *
 * What is held: a billed wave always has one, in the transaction that makes
 * it; a self-hosted wave never does; and neither deleting a wave nor the sweep
 * nor losing the account row takes a wave or an account with it by accident.
 */
let db: Database;
let close: () => Promise<void>;
let reset: () => Promise<void>;

beforeAll(async () => {
  ({ db, close, reset } = await createTestDb());
});
afterAll(() => close());
beforeEach(() => reset());

const buy = (id: string, email: string, name: string, seats = 3) =>
  applySubscription(db, id, { email, name, seats, state: "active" });

const accountsOf = () => db.select().from(customerAccounts);
const waveRow = async (waveId: string) =>
  (await db.select().from(waves).where(eq(waves.id, waveId)))[0] ?? null;

describe("a billed wave", () => {
  test("is made with the customer account of its owner, in the same transaction", async () => {
    const result = await buy("sub_1", "anna@acme.example", "acme");
    if (result.kind !== "applied") throw new Error("expected a wave");

    const wave = await waveRow(result.view.waveId);
    const accounts = await accountsOf();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.id).toMatch(/^ca_[0-9a-f]{32}$/);
    expect(wave?.accountId).toBe(accounts[0]?.id ?? "");
    // The account names the user who owns the wave -- here the placeholder the payment made.
    expect(accounts[0]?.ownerUserId).toBe(wave?.ownerUserId ?? "");
  });

  test("a second wave of the same owner joins the account, one shared model of the quota", async () => {
    const first = await buy("sub_1", "anna@acme.example", "acme", 3);
    const second = await buy("sub_2", "anna@acme.example", "acme-two", 5);
    if (first.kind !== "applied" || second.kind !== "applied") throw new Error("expected waves");

    const accounts = await accountsOf();
    expect(accounts).toHaveLength(1);
    expect((await waveRow(first.view.waveId))?.accountId).toBe(accounts[0]?.id ?? "");
    expect((await waveRow(second.view.waveId))?.accountId).toBe(accounts[0]?.id ?? "");

    // Derived from the subscription rows, not stored: 3 + 5, two waves, one member each.
    expect(await accountQuota(db, accounts[0]?.id ?? "")).toEqual({
      accountId: accounts[0]?.id ?? "",
      waves: 2,
      seats: 8,
      members: 2,
    });
  });

  test("another owner gets another account", async () => {
    await buy("sub_1", "anna@acme.example", "acme");
    await buy("sub_2", "ben@beta.example", "beta");
    const accounts = await accountsOf();
    expect(accounts).toHaveLength(2);
    expect(new Set(accounts.map((a) => a.ownerUserId)).size).toBe(2);
  });

  test("two payments of one new address at once make one account", async () => {
    await Promise.all([
      buy("sub_1", "anna@acme.example", "acme"),
      buy("sub_2", "anna@acme.example", "acme-two"),
    ]);
    expect(await accountsOf()).toHaveLength(1);
    const rows = await db.select().from(waves);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((w) => w.accountId)).size).toBe(1);
  });

  test("an existing verified user is the owner and holds the account", async () => {
    const { userId } = await setPassword(db, "anna@acme.example", "correct horse battery");
    await buy("sub_1", "anna@acme.example", "acme");
    expect((await accountsOf())[0]?.ownerUserId).toBe(userId);
  });

  test("a repeated event changes nothing and adds no account", async () => {
    await buy("sub_1", "anna@acme.example", "acme");
    await buy("sub_1", "anna@acme.example", "acme");
    expect(await accountsOf()).toHaveLength(1);
  });

  test("with two accounts the oldest takes new waves, and none is merged", async () => {
    const { userId } = await setPassword(db, "anna@acme.example", "correct horse battery");
    await db
      .insert(customerAccounts)
      .values({ id: "ca_young", ownerUserId: userId, createdAt: new Date("2030-01-01") });
    await db
      .insert(customerAccounts)
      .values({ id: "ca_old", ownerUserId: userId, createdAt: new Date("2020-01-01") });
    expect(await ensureAccountFor(db, userId)).toBe("ca_old");
    await buy("sub_1", "anna@acme.example", "acme");
    expect(await accountsOf()).toHaveLength(2);
    expect((await db.select().from(waves))[0]?.accountId).toBe("ca_old");
  });
});

describe("a self-hosted wave", () => {
  test("gets no customer account, from either way a server makes one", async () => {
    const { userId } = await setPassword(db, "robin@example.com", "correct horse battery");
    const made = await ensureWaveForUser(db, userId, "robin@example.com");
    expect(made.waveId).toBeTruthy();
    expect((await waveRow(made.waveId ?? ""))?.accountId).toBeNull();
    expect(await accountsOf()).toEqual([]);
  });
});

describe("what leaves a customer account standing", () => {
  test("deleting a wave leaves the account and the other waves", async () => {
    const one = await buy("sub_1", "anna@acme.example", "acme");
    const two = await buy("sub_2", "anna@acme.example", "acme-two");
    if (one.kind !== "applied" || two.kind !== "applied") throw new Error("expected waves");

    expect(await deleteWave(db, one.view.waveId)).not.toBeNull();
    expect(await accountsOf()).toHaveLength(1);
    expect((await waveRow(two.view.waveId))?.accountId).toBe((await accountsOf())[0]?.id ?? "");
  });

  test("the sweep of an ended subscription leaves the account, even without a wave", async () => {
    const now = new Date("2031-01-01T00:00:00Z");
    const made = await buy("sub_1", "anna@acme.example", "acme");
    if (made.kind !== "applied") throw new Error("expected a wave");
    await applySubscription(db, "sub_1", { seats: 3, state: "ended" }, { retentionDays: 30, now });
    const deleted = await sweepEndedWaves(db, new Date(now.getTime() + 31 * 24 * 60 * 60 * 1000));
    expect(deleted.map((d) => d.waveId)).toEqual([made.view.waveId]);
    expect(await waveRow(made.view.waveId)).toBeNull();
    // The account stays; it is the customer's, not the wave's.
    expect(await accountsOf()).toHaveLength(1);
  });

  test("losing the account row keeps the wave row, unassigned", async () => {
    const made = await buy("sub_1", "anna@acme.example", "acme");
    if (made.kind !== "applied") throw new Error("expected a wave");
    await db.delete(customerAccounts);
    const wave = await waveRow(made.view.waveId);
    expect(wave).not.toBeNull();
    expect(wave?.accountId).toBeNull();
  });

  test("deleting a user takes the account row, never a wave through it", async () => {
    const { userId } = await setPassword(db, "ben@beta.example", "correct horse battery");
    const owner = await setPassword(db, "anna@acme.example", "correct horse battery");
    const made = await buy("sub_1", "anna@acme.example", "acme");
    if (made.kind !== "applied") throw new Error("expected a wave");
    // A different user's account row stays when an unrelated user goes.
    await ensureAccountFor(db, userId);
    await db.delete(users).where(eq(users.id, userId));
    expect((await accountsOf()).map((a) => a.ownerUserId)).toEqual([owner.userId]);
  });
});
