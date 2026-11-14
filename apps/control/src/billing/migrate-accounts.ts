import { and, asc, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { type Actor, shellActor } from "../audit.ts";
import type { Database } from "../db/client.ts";
import {
  auditLog,
  customerAccounts,
  nodes,
  users,
  waveAuthKeys,
  waveBilling,
  waveMembers,
  waves,
} from "../db/schema.ts";
import { newId } from "../ids.ts";
import { oldestAccountOf } from "./accounts.ts";

/**
 * `wave-admin migrate-accounts [--dry-run]`: puts every existing billed wave
 * under a customer account (`customer_accounts`, see accounts.ts).
 *
 * The customer account is the billing unit; it is not a user and not an OIDC
 * identity. Source: every wave with a `wave_billing` row -- suspended and
 * ended ones too, as long as the wave exists -- that has no account yet.
 * One account per owner user (`waves.owner_user_id`), carrying all of that
 * user's billed waves. `wave_billing`, subscription ids, devices, keys and
 * prefixes are never written: waves are only *assigned*, so no device signs in
 * again and no tunnel is rebuilt.
 *
 * What it does not do is guess. Any wave whose owner is unclear stops the
 * whole run before anything is written (`blocked`), with one line per case;
 * it never merges users or matches by address. The operator sorts the case out
 * (for instance through the account linking) and runs the command again.
 *
 * All or nothing in one transaction, under an advisory lock so two runs cannot
 * interleave, and idempotent: with every billed wave assigned there is nothing
 * to do and nothing is written.
 */

/** Every row count the command looks at, before and after. */
export interface Counts {
  waves: number;
  waveMembers: number;
  nodes: number;
  authKeys: number;
  waveBilling: number;
  customerAccounts: number;
  /** Every wave without an account: all self-hosted ones stay in here for good. */
  wavesWithoutAccount: number;
  /** The billed waves among them; zero once the migration has run. */
  billedWavesWithoutAccount: number;
}

/** Why a wave cannot be assigned without a person looking at it. */
export type ProblemReason =
  /** (a) `waves.owner_user_id` is not the one member with the role owner. */
  | "owner-mismatch"
  /** (b) the owner shares an address with another user (also unverified or placeholder). */
  | "duplicate-address"
  /** (c) the owner has no address. */
  | "no-address"
  /** (d) two billed waves are owned by different users of the same address. */
  | "split-owners";

export interface Problem {
  waveId: string;
  userId: string;
  reason: ProblemReason;
  /** For the operator; ids only, never an address. */
  detail: string;
}

export interface Assignment {
  waveId: string;
  ownerUserId: string;
  /** Null in a dry run when the account would be made by the run. */
  accountId: string | null;
  newAccount: boolean;
}

export type MigrateResult =
  | { kind: "nothing"; counts: Counts }
  | { kind: "blocked"; problems: Problem[]; counts: Counts }
  | {
      kind: "migrated";
      dryRun: boolean;
      before: Counts;
      /** In a dry run what the counts would be, not what they are. */
      after: Counts;
      accountsCreated: number;
      assignments: Assignment[];
    };

/** An unchangeable count moved: the run is rolled back, nothing is kept. */
export class MigrationInvariantError extends Error {
  constructor(
    readonly counter: keyof Counts,
    readonly before: number,
    readonly after: number,
  ) {
    super(`counter ${counter} changed during the migration: ${before} -> ${after}`);
    this.name = "MigrationInvariantError";
  }
}

/** The advisory lock a run takes first; a second run waits for it. */
const LOCK_KEY = "migrate-customer-accounts";

/** The counts that must come out exactly as they went in. */
const UNCHANGEABLE = ["waves", "waveMembers", "nodes", "authKeys", "waveBilling"] as const;

export async function countAll(db: Database): Promise<Counts> {
  const one = async (query: Promise<Array<{ n: number }>>): Promise<number> => (await query)[0]?.n ?? 0;
  const noAccount = isNull(waves.accountId);
  return {
    waves: await one(db.select({ n: count() }).from(waves)),
    waveMembers: await one(db.select({ n: count() }).from(waveMembers)),
    nodes: await one(db.select({ n: count() }).from(nodes)),
    authKeys: await one(db.select({ n: count() }).from(waveAuthKeys)),
    waveBilling: await one(db.select({ n: count() }).from(waveBilling)),
    customerAccounts: await one(db.select({ n: count() }).from(customerAccounts)),
    wavesWithoutAccount: await one(db.select({ n: count() }).from(waves).where(noAccount)),
    billedWavesWithoutAccount: await one(
      db
        .select({ n: count() })
        .from(waves)
        .innerJoin(waveBilling, eq(waveBilling.waveId, waves.id))
        .where(noAccount),
    ),
  };
}

/** Postgres' "could not serialize access", however the driver wraps it. */
function isSerializationFailure(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 4; depth++) {
    if ((e as { code?: string }).code === "40001") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

export interface MigrateOptions {
  dryRun?: boolean;
  actor?: Actor;
}

/**
 * Runs the migration. A run that loses a race with another one (its snapshot
 * is older than what the other committed) starts over on a fresh snapshot --
 * which then usually finds nothing to do.
 */
export async function migrateAccounts(db: Database, options: MigrateOptions = {}): Promise<MigrateResult> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction((tx) => run(tx as unknown as Database, options), {
        // One snapshot for the counts before, the plan and the counts after:
        // a device registering meanwhile must not look like the migration
        // changing something it must not touch.
        isolationLevel: "repeatable read",
      });
    } catch (error) {
      if (attempt < 5 && isSerializationFailure(error)) continue;
      throw error;
    }
  }
}

async function run(tx: Database, options: MigrateOptions): Promise<MigrateResult> {
  const dryRun = options.dryRun === true;
  const actor = options.actor ?? shellActor();

  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${LOCK_KEY}))`);
  const before = await countAll(tx);

  const todo = await tx
    .select({ waveId: waves.id, ownerId: waves.ownerUserId, email: users.email })
    .from(waves)
    .innerJoin(waveBilling, eq(waveBilling.waveId, waves.id))
    .innerJoin(users, eq(users.id, waves.ownerUserId))
    .where(isNull(waves.accountId))
    .orderBy(asc(waves.id));
  if (todo.length === 0) return { kind: "nothing", counts: before };

  const problems = await findProblems(tx, todo);
  if (problems.length > 0) return { kind: "blocked", problems, counts: before };

  // One account per owner, in a fixed order. An owner who already has an
  // account (a wave made after the first run, or two owners merged) gets the
  // waves on their oldest one.
  const owners = [...new Set(todo.map((row) => row.ownerId))].sort();
  const accountOf = new Map<string, { id: string | null; isNew: boolean }>();
  if (!dryRun) {
    await tx
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, owners))
      .orderBy(asc(users.id))
      .for("update");
    await tx
      .select({ id: waves.id })
      .from(waves)
      .where(
        inArray(
          waves.id,
          todo.map((row) => row.waveId),
        ),
      )
      .orderBy(asc(waves.id))
      .for("update");
  }
  for (const ownerId of owners) {
    const existing = await oldestAccountOf(tx, ownerId);
    if (existing) accountOf.set(ownerId, { id: existing, isNew: false });
    else if (dryRun) accountOf.set(ownerId, { id: null, isNew: true });
    else {
      const id = newId("ca");
      await tx.insert(customerAccounts).values({ id, ownerUserId: ownerId });
      accountOf.set(ownerId, { id, isNew: true });
    }
  }

  const assignments: Assignment[] = [];
  const fresh = new Set<string>();
  for (const row of todo) {
    const account = accountOf.get(row.ownerId);
    if (!account) throw new Error(`no account planned for ${row.ownerId}`);
    // The first wave of a new account is the one that "made" it, for the report.
    const newAccount = account.isNew && !fresh.has(row.ownerId);
    fresh.add(row.ownerId);
    assignments.push({ waveId: row.waveId, ownerUserId: row.ownerId, accountId: account.id, newAccount });
  }
  const accountsCreated = owners.filter((id) => accountOf.get(id)?.isNew).length;

  if (dryRun) {
    return {
      kind: "migrated",
      dryRun,
      before,
      after: {
        ...before,
        customerAccounts: before.customerAccounts + accountsCreated,
        wavesWithoutAccount: before.wavesWithoutAccount - assignments.length,
        billedWavesWithoutAccount: 0,
      },
      accountsCreated,
      assignments,
    };
  }

  for (const a of assignments) {
    // Only a wave that still has none: the lock above is what keeps another
    // writer out, this is what makes a repeated run harmless.
    await tx
      .update(waves)
      .set({ accountId: a.accountId })
      .where(and(eq(waves.id, a.waveId), isNull(waves.accountId)));
    // In this transaction and not after it, unlike audit(): an entry that
    // cannot be written must undo the assignment it describes.
    await tx.insert(auditLog).values({
      id: newId("aud"),
      waveId: a.waveId,
      actorUserId: actor.userId,
      actor: actor.label,
      action: "billing.account-assign",
      target: a.accountId,
      detail: { ownerUserId: a.ownerUserId, accountId: a.accountId, created: a.newAccount },
    });
  }

  const after = await countAll(tx);
  for (const key of UNCHANGEABLE) {
    if (after[key] !== before[key]) throw new MigrationInvariantError(key, before[key], after[key]);
  }
  const expected: Pick<Counts, "customerAccounts" | "wavesWithoutAccount" | "billedWavesWithoutAccount"> = {
    customerAccounts: before.customerAccounts + accountsCreated,
    wavesWithoutAccount: before.wavesWithoutAccount - assignments.length,
    billedWavesWithoutAccount: 0,
  };
  for (const key of ["customerAccounts", "wavesWithoutAccount", "billedWavesWithoutAccount"] as const) {
    if (after[key] !== expected[key]) throw new MigrationInvariantError(key, expected[key], after[key]);
  }
  return { kind: "migrated", dryRun, before, after, accountsCreated, assignments };
}

interface TodoRow {
  waveId: string;
  ownerId: string;
  email: string | null;
}

/** The cases a person has to look at; empty means every wave can be assigned. */
async function findProblems(tx: Database, todo: TodoRow[]): Promise<Problem[]> {
  const problems: Problem[] = [];
  const waveIds = todo.map((row) => row.waveId);

  // (a) the owner of the wave is the one and only member with the role owner.
  const ownerRows = await tx
    .select({ waveId: waveMembers.waveId, userId: waveMembers.userId })
    .from(waveMembers)
    .where(and(inArray(waveMembers.waveId, waveIds), eq(waveMembers.role, "owner")))
    .orderBy(asc(waveMembers.userId));
  const ownersOf = new Map<string, string[]>();
  for (const row of ownerRows) ownersOf.set(row.waveId, [...(ownersOf.get(row.waveId) ?? []), row.userId]);

  // (b)/(d) who else holds an owner's address, by lower(email).
  const addressOf = (email: string | null): string | null => {
    const lowered = email?.toLowerCase() ?? "";
    return lowered.trim() === "" ? null : lowered;
  };
  const addresses = [
    ...new Set(todo.map((row) => addressOf(row.email)).filter((a): a is string => a !== null)),
  ];
  const holders =
    addresses.length === 0
      ? []
      : await tx
          .select({ id: users.id, address: sql<string>`lower(${users.email})` })
          .from(users)
          .where(inArray(sql`lower(${users.email})`, addresses));
  const billedOwners = new Set(
    (
      await tx
        .selectDistinct({ ownerId: waves.ownerUserId })
        .from(waves)
        .innerJoin(waveBilling, eq(waveBilling.waveId, waves.id))
    ).map((row) => row.ownerId),
  );

  for (const row of todo) {
    const members = ownersOf.get(row.waveId) ?? [];
    if (members.length !== 1 || members[0] !== row.ownerId) {
      problems.push({
        waveId: row.waveId,
        userId: row.ownerId,
        reason: "owner-mismatch",
        detail: `owner members: ${members.length === 0 ? "none" : members.join(", ")}`,
      });
    }
    const address = addressOf(row.email);
    if (address === null) {
      problems.push({ waveId: row.waveId, userId: row.ownerId, reason: "no-address", detail: "no address" });
      continue;
    }
    const others = holders.filter((h) => h.address === address && h.id !== row.ownerId).map((h) => h.id);
    if (others.length === 0) continue;
    const otherOwners = others.filter((id) => billedOwners.has(id));
    problems.push({
      waveId: row.waveId,
      userId: row.ownerId,
      reason: otherOwners.length > 0 ? "split-owners" : "duplicate-address",
      detail: `same address as ${others.join(", ")}${otherOwners.length > 0 ? ` (owning billed waves: ${otherOwners.join(", ")})` : ""}`,
    });
  }
  return problems;
}
