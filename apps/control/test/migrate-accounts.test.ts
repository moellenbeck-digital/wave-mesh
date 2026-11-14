import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import type { Actor } from "../src/audit.ts";
import {
  countAll,
  type MigrateResult,
  MigrationInvariantError,
  migrateAccounts,
} from "../src/billing/migrate-accounts.ts";
import type { Database } from "../src/db/client.ts";
import {
  auditLog,
  customerAccounts,
  nodes,
  users,
  waveAuthKeys,
  waveBilling,
  waveMembers,
  waves,
} from "../src/db/schema.ts";
import { createWave } from "../src/waves/provision.ts";
import { createTestDb } from "./helpers.ts";

/**
 * `wave-admin migrate-accounts`: puts every booked wave under a customer
 * account (a billing unit; not a user, not an OIDC identity).
 *
 * The waves here are made the way the previous version made them -- no
 * account -- by createWave() without one plus a billing row. What is held:
 * one account per owner, nothing but the assignment written, all or nothing,
 * a second run finds nothing, and nothing is ever guessed by address.
 */
let db: Database;
let close: () => Promise<void>;
let reset: () => Promise<void>;
let nth = 0;

beforeAll(async () => {
  ({ db, close, reset } = await createTestDb());
});
afterAll(() => close());
beforeEach(async () => {
  await reset();
  nth = 0;
});

const operator: Actor = { userId: null, label: "shell:test" };

async function makeUser(id: string, email: string | null, verified = true): Promise<string> {
  await db.insert(users).values({ id, email, emailVerified: verified });
  return id;
}

/** A wave as it was before accounts existed; `state` null is a self-hosted one. */
async function legacyWave(
  ownerId: string,
  state: "active" | "suspended" | "ended" | null,
  name = `w${++nth}`,
): Promise<string> {
  const made = await createWave(db, { userId: ownerId, name, dnsSuffix: `${name}.wave.example.com` });
  if (!("waveId" in made)) throw new Error("expected a wave");
  if (state) {
    await db.insert(waveBilling).values({
      waveId: made.waveId,
      subscriptionId: `sub_${name}`,
      seats: 3,
      state,
      ...(state === "ended" ? { deleteAfter: new Date("2031-01-01T00:00:00Z") } : {}),
    });
  }
  return made.waveId;
}

async function snapshot() {
  return {
    waves: (await db.select().from(waves).orderBy(waves.id)).map(({ accountId: _skip, ...rest }) => rest),
    members: await db.select().from(waveMembers).orderBy(waveMembers.waveId, waveMembers.userId),
    nodes: await db.select().from(nodes).orderBy(nodes.id),
    keys: await db.select().from(waveAuthKeys).orderBy(waveAuthKeys.id),
    billing: await db.select().from(waveBilling).orderBy(waveBilling.waveId),
  };
}

const accountOf = async (waveId: string) =>
  (await db.select({ a: waves.accountId }).from(waves).where(eq(waves.id, waveId)))[0]?.a ?? null;

const migrated = (result: MigrateResult) => {
  if (result.kind !== "migrated") throw new Error(`expected migrated, got ${result.kind}`);
  return result;
};

const blocked = (result: MigrateResult) => {
  if (result.kind !== "blocked") throw new Error(`expected blocked, got ${result.kind}`);
  return result;
};

describe("the migration", () => {
  test("gives each owner one account over all their booked waves, suspended and ended included", async () => {
    const anna = await makeUser("u_anna", "anna@acme.example");
    const ben = await makeUser("u_ben", "ben@beta.example");
    const a1 = await legacyWave(anna, "active");
    const a2 = await legacyWave(anna, "suspended");
    const a3 = await legacyWave(anna, "ended");
    const b1 = await legacyWave(ben, "active");
    const selfHosted = await legacyWave(ben, null);
    const before = await snapshot();

    const result = migrated(await migrateAccounts(db, { actor: operator }));

    expect(result.accountsCreated).toBe(2);
    expect(result.assignments.map((a) => a.waveId).sort()).toEqual([a1, a2, a3, b1].sort());
    const accounts = await db.select().from(customerAccounts);
    expect(accounts.map((a) => a.ownerUserId).sort()).toEqual([anna, ben]);
    expect(accounts.every((a) => /^ca_[0-9a-f]{32}$/.test(a.id))).toBe(true);
    const ofAnna = accounts.find((a) => a.ownerUserId === anna)?.id ?? "";
    const ofBen = accounts.find((a) => a.ownerUserId === ben)?.id ?? "";
    expect([await accountOf(a1), await accountOf(a2), await accountOf(a3)]).toEqual([ofAnna, ofAnna, ofAnna]);
    expect(await accountOf(b1)).toBe(ofBen);
    // A self-hosted server has no customer account and stays unlimited.
    expect(await accountOf(selfHosted)).toBeNull();

    // Billing, members, devices, keys and prefixes: exactly as they were.
    expect(await snapshot()).toEqual(before);
    // Before and after, on stdout of the command.
    expect(result.before).toMatchObject({
      waves: 5,
      waveMembers: 5,
      nodes: 0,
      authKeys: 0,
      waveBilling: 4,
      customerAccounts: 0,
      wavesWithoutAccount: 5,
      billedWavesWithoutAccount: 4,
    });
    expect(result.after).toMatchObject({
      waves: 5,
      waveMembers: 5,
      waveBilling: 4,
      customerAccounts: 2,
      wavesWithoutAccount: 1,
      billedWavesWithoutAccount: 0,
    });
    expect(result.after).toEqual(await countAll(db));
  });

  test("writes one audit entry per assigned wave, and none for a self-hosted one", async () => {
    const anna = await makeUser("u_anna", "anna@acme.example");
    const a1 = await legacyWave(anna, "active");
    const a2 = await legacyWave(anna, "active");
    const own = await legacyWave(anna, null);
    await migrateAccounts(db, { actor: operator });

    const entries = await db.select().from(auditLog).where(eq(auditLog.action, "billing.account-assign"));
    expect(entries.map((e) => e.waveId).sort()).toEqual([a1, a2].sort());
    expect(entries.every((e) => e.actor === "shell:test")).toBe(true);
    expect(entries.find((e) => e.waveId === a1)?.target).toBe(await accountOf(a1));
    expect(entries.some((e) => e.waveId === own)).toBe(false);
  });

  test("a dry run says what it would do and writes nothing", async () => {
    const anna = await makeUser("u_anna", "anna@acme.example");
    await legacyWave(anna, "active");
    await legacyWave(anna, "ended");
    const audits = (await db.select().from(auditLog)).length;

    const result = migrated(await migrateAccounts(db, { dryRun: true }));
    expect(result.dryRun).toBe(true);
    expect(result.accountsCreated).toBe(1);
    expect(result.assignments).toHaveLength(2);
    expect(result.after).toMatchObject({ customerAccounts: 1, billedWavesWithoutAccount: 0 });

    expect(await db.select().from(customerAccounts)).toEqual([]);
    expect((await db.select().from(waves)).every((w) => w.accountId === null)).toBe(true);
    expect((await db.select().from(auditLog)).length).toBe(audits);
    // Nothing happened, so the real run still has all the work.
    expect(migrated(await migrateAccounts(db)).assignments).toHaveLength(2);
  });

  test("is idempotent: the second run writes nothing and says so", async () => {
    const anna = await makeUser("u_anna", "anna@acme.example");
    await legacyWave(anna, "active");
    await legacyWave(anna, "suspended");
    await migrateAccounts(db);
    const accounts = await db.select().from(customerAccounts);
    const assigned = await db.select({ id: waves.id, a: waves.accountId }).from(waves);
    const audits = (await db.select().from(auditLog)).length;

    const again = await migrateAccounts(db);
    expect(again.kind).toBe("nothing");
    expect(await db.select().from(customerAccounts)).toEqual(accounts);
    expect(await db.select({ id: waves.id, a: waves.accountId }).from(waves)).toEqual(assigned);
    expect((await db.select().from(auditLog)).length).toBe(audits);
  });

  test("a dry run on a finished system also finds nothing to do", async () => {
    const anna = await makeUser("u_anna", "anna@acme.example");
    await legacyWave(anna, "active");
    await migrateAccounts(db);
    expect((await migrateAccounts(db, { dryRun: true })).kind).toBe("nothing");
  });

  test("an aborted run is repeatable: waves already assigned stay, the rest join the same account", async () => {
    const anna = await makeUser("u_anna", "anna@acme.example");
    const first = await legacyWave(anna, "active");
    const second = await legacyWave(anna, "suspended");
    // What an earlier run (or a new billed wave) left behind: one wave assigned.
    await db.insert(customerAccounts).values({ id: "ca_existing", ownerUserId: anna });
    await db.update(waves).set({ accountId: "ca_existing" }).where(eq(waves.id, first));

    const result = migrated(await migrateAccounts(db));
    expect(result.accountsCreated).toBe(0);
    expect(result.assignments.map((a) => a.waveId)).toEqual([second]);
    expect(await accountOf(first)).toBe("ca_existing");
    expect(await accountOf(second)).toBe("ca_existing");
    expect(await db.select().from(customerAccounts)).toHaveLength(1);
  });

  test("two runs at once: one does the work, the other finds nothing", async () => {
    const anna = await makeUser("u_anna", "anna@acme.example");
    await legacyWave(anna, "active");
    await legacyWave(anna, "active");
    const results = await Promise.all([migrateAccounts(db), migrateAccounts(db)]);
    expect(results.map((r) => r.kind).sort()).toEqual(["migrated", "nothing"]);
    expect(await db.select().from(customerAccounts)).toHaveLength(1);
    expect(
      await db.select().from(auditLog).where(eq(auditLog.action, "billing.account-assign")),
    ).toHaveLength(2);
  });

  test("a wave made by the previous version after a run is picked up by the next one", async () => {
    const anna = await makeUser("u_anna", "anna@acme.example");
    await legacyWave(anna, "active");
    await migrateAccounts(db);
    const late = await legacyWave(anna, "active");
    const result = migrated(await migrateAccounts(db));
    expect(result.accountsCreated).toBe(0);
    expect(await accountOf(late)).toBe((await db.select().from(customerAccounts))[0]?.id ?? "");
  });

  test("a self-hosted server alone has nothing to do and gets no account", async () => {
    const robin = await makeUser("u_robin", "robin@example.com");
    await legacyWave(robin, null);
    expect((await migrateAccounts(db)).kind).toBe("nothing");
    expect(await db.select().from(customerAccounts)).toEqual([]);
  });
});

describe("unclear cases stop the whole run without writing anything", () => {
  /** A clean owner next to the unclear case: even they must stay untouched. */
  async function cleanOwner() {
    const clean = await makeUser("u_clean", "clean@example.com");
    return legacyWave(clean, "active");
  }

  async function expectUntouched(cleanWave: string) {
    expect(await db.select().from(customerAccounts)).toEqual([]);
    expect(await accountOf(cleanWave)).toBeNull();
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "billing.account-assign"))).toEqual([]);
  }

  test("(a) the owner is not a member with the role owner", async () => {
    const clean = await cleanOwner();
    const anna = await makeUser("u_anna", "anna@acme.example");
    const w = await legacyWave(anna, "active");
    await db.delete(waveMembers).where(eq(waveMembers.waveId, w));

    const result = blocked(await migrateAccounts(db));
    expect(result.problems).toEqual([
      expect.objectContaining({ waveId: w, userId: anna, reason: "owner-mismatch" }),
    ]);
    await expectUntouched(clean);
  });

  test("(a) the owner is a member with another role", async () => {
    const clean = await cleanOwner();
    const anna = await makeUser("u_anna", "anna@acme.example");
    const w = await legacyWave(anna, "active");
    await db.update(waveMembers).set({ role: "admin" }).where(eq(waveMembers.waveId, w));
    expect(blocked(await migrateAccounts(db)).problems.map((p) => p.reason)).toEqual(["owner-mismatch"]);
    await expectUntouched(clean);
  });

  test("(a) several owner members", async () => {
    const clean = await cleanOwner();
    const anna = await makeUser("u_anna", "anna@acme.example");
    const ben = await makeUser("u_ben", "ben@beta.example");
    const w = await legacyWave(anna, "active");
    await db.insert(waveMembers).values({ waveId: w, userId: ben, role: "owner" });
    expect(blocked(await migrateAccounts(db)).problems).toEqual([
      expect.objectContaining({ waveId: w, userId: anna, reason: "owner-mismatch" }),
    ]);
    await expectUntouched(clean);
  });

  test("(a) the one owner member is somebody else than waves.owner_user_id", async () => {
    const clean = await cleanOwner();
    const anna = await makeUser("u_anna", "anna@acme.example");
    const ben = await makeUser("u_ben", "ben@beta.example");
    const w = await legacyWave(anna, "active");
    await db.update(waves).set({ ownerUserId: ben }).where(eq(waves.id, w));
    expect(blocked(await migrateAccounts(db)).problems).toEqual([
      expect.objectContaining({ waveId: w, userId: ben, reason: "owner-mismatch" }),
    ]);
    await expectUntouched(clean);
  });

  test("(b) the owner shares an address with another user, unverified or placeholder too", async () => {
    const clean = await cleanOwner();
    const anna = await makeUser("u_anna", "anna@acme.example");
    await makeUser("u_double", "ANNA@acme.example", false);
    const w = await legacyWave(anna, "active");

    const result = blocked(await migrateAccounts(db));
    expect(result.problems).toEqual([
      expect.objectContaining({ waveId: w, userId: anna, reason: "duplicate-address" }),
    ]);
    expect(result.problems[0]?.detail).toContain("u_double");
    await expectUntouched(clean);
  });

  test("(c) the owner has no address", async () => {
    const clean = await cleanOwner();
    const nobody = await makeUser("u_nobody", null);
    const w = await legacyWave(nobody, "suspended");
    expect(blocked(await migrateAccounts(db)).problems).toEqual([
      expect.objectContaining({ waveId: w, userId: nobody, reason: "no-address" }),
    ]);
    await expectUntouched(clean);
  });

  test("(d) two booked waves owned by different users of one address are told apart from (b)", async () => {
    const clean = await cleanOwner();
    const one = await makeUser("u_one", "anna@acme.example");
    const two = await makeUser("u_two", "anna@acme.example", false);
    const w1 = await legacyWave(one, "active");
    const w2 = await legacyWave(two, "active");

    const result = blocked(await migrateAccounts(db));
    expect(result.problems.map((p) => [p.waveId, p.userId, p.reason]).sort()).toEqual(
      [
        [w1, one, "split-owners"],
        [w2, two, "split-owners"],
      ].sort(),
    );
    await expectUntouched(clean);
  });

  test("never merges: nothing about users, identities or members changes", async () => {
    const one = await makeUser("u_one", "anna@acme.example");
    const two = await makeUser("u_two", "anna@acme.example", false);
    await legacyWave(one, "active");
    await legacyWave(two, "active");
    const usersBefore = await db.select().from(users);
    const before = await snapshot();
    blocked(await migrateAccounts(db));
    expect(await db.select().from(users)).toEqual(usersBefore);
    expect(await snapshot()).toEqual(before);
  });

  test("once the operator has cleared the case, the same command goes through", async () => {
    const one = await makeUser("u_one", "anna@acme.example");
    const two = await makeUser("u_two", "anna@acme.example", false);
    await legacyWave(one, "active");
    await legacyWave(two, "active");
    blocked(await migrateAccounts(db));
    // What the account linking does: B is gone, its waves are A's.
    await db.update(waves).set({ ownerUserId: one }).where(eq(waves.ownerUserId, two));
    await db.update(waveMembers).set({ userId: one }).where(eq(waveMembers.userId, two));
    await db.delete(users).where(eq(users.id, two));
    const result = migrated(await migrateAccounts(db));
    expect(result.accountsCreated).toBe(1);
  });
});

describe("the unchangeable counts", () => {
  test("a change in one of them rolls the whole run back", async () => {
    const anna = await makeUser("u_anna", "anna@acme.example");
    const w = await legacyWave(anna, "active");
    await db.insert(nodes).values({
      id: "n_1",
      waveId: w,
      userId: anna,
      machineKey: "mk",
      nodeKey: "nk",
      discoKey: "dk",
      hostname: "laptop",
      os: "linux",
      ipv4: "10.64.0.10",
      ipv6: "fd7a:1:2::10",
      approved: true,
    });
    // A defect in the run, simulated: whatever writes an audit entry also drops a device.
    await db.execute(sql`
      create function break_nodes_fn() returns trigger language plpgsql as
      $$ begin delete from nodes; return new; end $$`);
    await db.execute(sql`
      create trigger break_nodes after insert on audit_log
      for each row execute function break_nodes_fn()`);
    try {
      await expect(migrateAccounts(db)).rejects.toBeInstanceOf(MigrationInvariantError);
    } finally {
      await db.execute(sql`drop trigger break_nodes on audit_log`);
      await db.execute(sql`drop function break_nodes_fn()`);
    }
    // Rolled back: the device is there, no account, no assignment, no audit entry.
    expect(await db.select().from(nodes)).toHaveLength(1);
    expect(await db.select().from(customerAccounts)).toEqual([]);
    expect(await accountOf(w)).toBeNull();
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "billing.account-assign"))).toEqual([]);
  });
});
