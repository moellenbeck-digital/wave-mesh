import { asc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { customerAccounts, nodes, users, waveBilling, waveMembers, waves } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { logFreeDecision } from "./free-log.ts";
import {
  accountPlan,
  accountRoster,
  accountWaveCount,
  DEFAULT_FREE_LIMITS,
  type FreeLimits,
  isFreePlan,
} from "./plan.ts";

/**
 * The hosted customer account ("Kundenkonto", `customer_accounts`, ids `ca_…`).
 *
 * It is the unit that is billed, and it is **neither** of the two things the
 * word "account" already means here: not a user (`users`, a person who signs
 * in; the account only names one as its owner) and not an OIDC identity
 * (`identities`, one provider login of a user). A self-hosted server -- no
 * `wave_billing` row -- has no customer account and no limit.
 *
 * Which account an owner has, and how the waves reach it, lives here; the
 * one-off migration of existing waves is `billing/migrate-accounts.ts`.
 */

/**
 * The customer account of a user, made if they have none yet.
 *
 * Called inside the transaction that then puts a wave under it. The user's row
 * is locked first: that is what makes "look, then make" one step for two
 * paying events of one owner at once, and for the migration running meanwhile
 * (which takes the same lock). With several accounts -- two owners merged --
 * the oldest is the one new waves go to; quotas are never merged silently.
 */
export async function ensureAccountFor(db: Database, userId: string): Promise<string> {
  await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1).for("update");
  const existing = await oldestAccountOf(db, userId);
  if (existing) return existing;
  const id = newId("ca");
  await db.insert(customerAccounts).values({ id, ownerUserId: userId });
  return id;
}

/** The oldest customer account a user owns, or null. */
export async function oldestAccountOf(db: Database, userId: string): Promise<string | null> {
  const rows = await db
    .select({ id: customerAccounts.id })
    .from(customerAccounts)
    .where(eq(customerAccounts.ownerUserId, userId))
    .orderBy(asc(customerAccounts.createdAt), asc(customerAccounts.id))
    .limit(1);
  return rows[0]?.id ?? null;
}

/** Why two free accounts could not be made one: which limit the waves of the second would break. */
export interface MergeRefusal {
  reason: "waves" | "people" | "devices";
  /** What the one account would hold afterwards. */
  have: number;
  limit: number;
  /** The free account the waves were to go to. */
  into: string;
}

export type MoveAccountsResult =
  | { ok: true; consolidated: Array<{ from: string; into: string; waves: number }> }
  | ({ ok: false } & MergeRefusal);

/**
 * Hands every customer account of a user to another user.
 *
 * For the two places that move a user's waves to another user and then delete
 * the first (`moveTo` in setup-links.ts, `mergeAccounts` in auth/account-link.ts):
 * `customer_accounts.owner_user_id` cascades, so without this the deletion
 * would take the account with it and leave its waves without one.
 *
 * **Never two free accounts for one user** (ticket #117). A paid account goes
 * over as it is. A free one of the first user, when the second user already has
 * a free one, does not: its waves move into the second's if what the two hold
 * together fits the free limits (waves, people, devices), and the emptied
 * account row goes. If they do not fit, nothing is written and the refusal says
 * which limit it was -- the caller refuses the whole link. Never merged
 * silently, never partly.
 *
 * Call it before anything else of the move is written: a refusal leaves no
 * trace. The people of the first user are counted as the second user, who they
 * become.
 */
export async function moveAccounts(
  db: Database,
  fromUserId: string,
  toUserId: string,
  limits: FreeLimits = DEFAULT_FREE_LIMITS,
): Promise<MoveAccountsResult> {
  const fromRows = await db
    .select({ id: customerAccounts.id })
    .from(customerAccounts)
    .where(eq(customerAccounts.ownerUserId, fromUserId))
    .orderBy(asc(customerAccounts.createdAt), asc(customerAccounts.id));
  if (fromRows.length === 0) return { ok: true, consolidated: [] };
  const toRows = await db
    .select({ id: customerAccounts.id })
    .from(customerAccounts)
    .where(eq(customerAccounts.ownerUserId, toUserId))
    .orderBy(asc(customerAccounts.createdAt), asc(customerAccounts.id));

  // Every account involved, in one order, so two merges cannot wait for each other.
  const all = [...fromRows, ...toRows].map((row) => row.id).sort();
  await db
    .select({ id: customerAccounts.id })
    .from(customerAccounts)
    .where(inArray(customerAccounts.id, all))
    .orderBy(asc(customerAccounts.id))
    .for("update");

  let freeTarget: string | null = null;
  for (const row of toRows) {
    if (isFreePlan(await accountPlan(db, row.id))) {
      freeTarget = row.id;
      break;
    }
  }

  const consolidated: Array<{ from: string; into: string; waves: number }> = [];
  for (const row of fromRows) {
    const free = isFreePlan(await accountPlan(db, row.id));
    if (!free || !freeTarget) {
      await db.update(customerAccounts).set({ ownerUserId: toUserId }).where(eq(customerAccounts.id, row.id));
      if (free) freeTarget = row.id;
      continue;
    }
    const refusal = await freeAccountsFit(db, row.id, freeTarget, fromUserId, toUserId, limits);
    if (refusal) {
      logFreeDecision("denied", {
        reason: "merge-limit",
        limit_kind: refusal.reason,
        from: row.id,
        into: freeTarget,
        have: refusal.have,
        limit: refusal.limit,
      });
      return { ok: false, ...refusal };
    }
    const moved = await db
      .update(waves)
      .set({ accountId: freeTarget })
      .where(eq(waves.accountId, row.id))
      .returning({ id: waves.id });
    await db.delete(customerAccounts).where(eq(customerAccounts.id, row.id));
    consolidated.push({ from: row.id, into: freeTarget, waves: moved.length });
  }
  return { ok: true, consolidated };
}

/** Whether what two free accounts hold fits the free limits as one; the first limit broken, else null. */
async function freeAccountsFit(
  db: Database,
  fromAccount: string,
  intoAccount: string,
  fromUserId: string,
  toUserId: string,
  limits: FreeLimits,
): Promise<MergeRefusal | null> {
  const wavesTogether = (await accountWaveCount(db, fromAccount)) + (await accountWaveCount(db, intoAccount));
  if (wavesTogether > limits.waves) {
    return { reason: "waves", have: wavesTogether, limit: limits.waves, into: intoAccount };
  }

  const a = await accountRoster(db, fromAccount);
  const b = await accountRoster(db, intoAccount);
  const people = new Set<string>();
  for (const id of [...a.userIds, ...b.userIds]) people.add(id === fromUserId ? toUserId : id);
  const members = new Set([...a.memberEmails, ...b.memberEmails]);
  const invited = new Set<string>();
  for (const invite of [...a.invites, ...b.invites])
    if (!members.has(invite.email)) invited.add(invite.email);
  const peopleTogether = people.size + invited.size;
  if (peopleTogether > limits.people) {
    return { reason: "people", have: peopleTogether, limit: limits.people, into: intoAccount };
  }

  const [devices] = await db
    .select({ count: sql<number>`count(distinct ${nodes.machineKey})::int` })
    .from(nodes)
    .innerJoin(waves, eq(waves.id, nodes.waveId))
    .where(inArray(waves.accountId, [fromAccount, intoAccount]));
  if ((devices?.count ?? 0) > limits.devices) {
    return { reason: "devices", have: devices?.count ?? 0, limit: limits.devices, into: intoAccount };
  }
  return null;
}

/**
 * What a customer account may hold, as a model.
 *
 * Derived, not stored: the shared quota is the sum of the seats of its waves'
 * subscription rows, so there is no second number that could drift from what
 * Stripe says. Nothing enforces it yet -- `ensureSeatFor` still counts per
 * wave, and what the shared quota will mean for it is a later ticket.
 */
export interface AccountQuota {
  accountId: string;
  waves: number;
  /** The sum of `wave_billing.seats` over the account's waves. */
  seats: number;
  /** People in those waves (a person in two waves counts twice, like a seat). */
  members: number;
}

export async function accountQuota(db: Database, accountId: string): Promise<AccountQuota> {
  const [row] = await db
    .select({
      waves: sql<number>`count(distinct ${waves.id})::int`,
      seats: sql<number>`coalesce(sum(${waveBilling.seats}), 0)::int`,
    })
    .from(waves)
    .leftJoin(waveBilling, eq(waveBilling.waveId, waves.id))
    .where(eq(waves.accountId, accountId));
  const [people] = await db
    .select({ members: sql<number>`count(*)::int` })
    .from(waveMembers)
    .innerJoin(waves, eq(waves.id, waveMembers.waveId))
    .where(eq(waves.accountId, accountId));
  return {
    accountId,
    waves: row?.waves ?? 0,
    seats: row?.seats ?? 0,
    members: people?.members ?? 0,
  };
}
