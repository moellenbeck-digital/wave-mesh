import { and, eq, gt, isNull, ne, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { waveBilling, waveInvites, waveMembers, waves } from "../db/schema.ts";
import { normaliseEmail } from "../email.ts";
import { logFreeDecision } from "./free-log.ts";
import {
  accountPlan,
  accountRoster,
  countPeople,
  DEFAULT_FREE_LIMITS,
  lockAccount,
  seatCost,
  seatRule,
} from "./plan.ts";

/**
 * A billed wave that has no seat left for another person.
 *
 * Its own class, like InvalidInputError: the web route says it in the reader's
 * language and wave-admin in the operator's, from the same two numbers.
 */
export class SeatLimitError extends Error {
  constructor(
    readonly waveId: string,
    readonly seats: number,
  ) {
    super(`wave ${waveId} has no seat left (${seats} booked)`);
    this.name = "SeatLimitError";
  }
}

/**
 * A hosted account that has no room for another person (ticket #117): the
 * free limit of three people, or the seats of its subscriptions.
 *
 * A `SeatLimitError` for every caller that already handles one -- `seats` is the
 * limit that applied -- with the account added for those that want to say more.
 */
export class AccountSeatLimitError extends SeatLimitError {
  constructor(
    waveId: string,
    readonly accountId: string,
    readonly limit: number,
    readonly plan: "free" | "paid",
    /** People the account holds now, open invitations included (`used / limit`). */
    readonly used: number = limit,
  ) {
    super(waveId, limit);
    this.name = "AccountSeatLimitError";
  }
}

/**
 * Refuses an invitation that would take a billed wave past what was booked.
 *
 * Open invitations count as taken: each one is a person who can walk in
 * without asking anyone again, so counting only members would let a full wave
 * hand out any number of links and fill up later. An invitation for the same
 * address is not counted, because creating a new one replaces it.
 *
 * Checked here, at the invitation, and not at the door: an invitation that
 * has been sent is a promise, and refusing it when the person clicks would be
 * the worse place to find out. A wave without a billing row -- every
 * self-hosted one -- has no limit and costs one lookup.
 */
export async function ensureSeatFor(
  db: Database,
  waveId: string,
  rawEmail: string,
  /** Who is added, when that is a known user (a member, not an invitation). */
  person?: { userId: string },
): Promise<void> {
  const email = normaliseEmail(rawEmail);
  // FOR UPDATE: called inside the transaction that then adds the person, and
  // the lock is what makes "count, then add" one step for two callers at once.
  const billed = await db
    .select({ seats: waveBilling.seats })
    .from(waveBilling)
    .where(eq(waveBilling.waveId, waveId))
    .limit(1)
    .for("update");
  const seats = billed[0]?.seats;
  // A wave without a billing row of its own: the account's limit applies, if
  // it has one (ticket #117). Self-hosted waves have no account and no limit.
  if (seats === undefined) return ensureAccountSeat(db, waveId, email, person?.userId);

  const [members] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(waveMembers)
    .where(eq(waveMembers.waveId, waveId));
  const [invites] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(waveInvites)
    .where(
      and(
        eq(waveInvites.waveId, waveId),
        ne(waveInvites.email, email),
        isNull(waveInvites.acceptedAt),
        isNull(waveInvites.revokedAt),
        gt(waveInvites.expiresAt, new Date()),
      ),
    );
  if ((members?.count ?? 0) + (invites?.count ?? 0) >= seats) throw new SeatLimitError(waveId, seats);
}

/**
 * Takes the locks that make a decision about an account's people one at a time:
 * the wave's row, then the account's -- the order `createNode` takes them in, so
 * the two never wait for each other. Returns the account, or null for a wave
 * that has none (every self-hosted one), which locks nothing more.
 *
 * Everything that changes who is in an account has to hold this while it does:
 * `accountRoster()` reads members and invitations in two statements, and a
 * person who is accepted between them is in neither (the invitation is spent,
 * the membership not yet visible) -- room for a fourth person at a limit of
 * three. Callers that already hold the wave's `wave_billing` row take it first
 * (billing row, wave, account), the same everywhere.
 */
export async function lockWaveAccount(db: Database, waveId: string): Promise<string | null> {
  const [wave] = await db
    .select({ accountId: waves.accountId })
    .from(waves)
    .where(eq(waves.id, waveId))
    .limit(1)
    .for("no key update");
  const accountId = wave?.accountId ?? null;
  if (accountId) await lockAccount(db, accountId);
  return accountId;
}

/**
 * The account-wide limit for a wave that has no `wave_billing` row (ticket #117).
 *
 * What the limit is and how people are counted depends on the derived plan
 * (`seatRule()` in plan.ts): three distinct people for a free account, the
 * seats of its subscription for an account with one, and for an account that is
 * paid only through `wave_billing` rows the sum of their seats, counted as
 * memberships plus open invitations. Waves *with* a row keep their own check
 * above; their people are in the roster, but the account check does not run for
 * them.
 *
 * Locks, in the order `createNode` takes them: the wave, then the account. The
 * account row makes "count, then add" one step for two callers at once.
 */
async function ensureAccountSeat(
  db: Database,
  waveId: string,
  email: string,
  userId?: string,
): Promise<void> {
  const accountId = await lockWaveAccount(db, waveId);
  if (!accountId) return;

  const plan = await accountPlan(db, accountId);
  const rule = seatRule(plan, DEFAULT_FREE_LIMITS);
  const roster = await accountRoster(db, accountId);
  const replaced = { waveId, email };
  const have = countPeople(roster, rule.mode, replaced);
  if (have + seatCost(roster, rule.mode, email, replaced, userId) > rule.limit) {
    if (plan.kind === "free") {
      logFreeDecision("denied", {
        reason: "people-limit",
        account: accountId,
        wave: waveId,
        limit: rule.limit,
        have,
      });
    }
    throw new AccountSeatLimitError(waveId, accountId, rule.limit, plan.kind, have);
  }
}
