import { asc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { customerAccounts, users, waveBilling, waveMembers, waves } from "../db/schema.ts";
import { newId } from "../ids.ts";

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

/**
 * Hands every customer account of a user to another user.
 *
 * For the two places that move a user's waves to another user and then delete
 * the first (`moveTo` in setup-links.ts, `mergeAccounts` in auth/account-link.ts):
 * `customer_accounts.owner_user_id` cascades, so without this the deletion
 * would take the account with it and leave its waves without one.
 */
export async function moveAccounts(db: Database, fromUserId: string, toUserId: string): Promise<void> {
  await db
    .update(customerAccounts)
    .set({ ownerUserId: toUserId })
    .where(eq(customerAccounts.ownerUserId, fromUserId));
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
