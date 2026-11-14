import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { nodes, users, waveInvites, waveMembers, waves } from "../db/schema.ts";
import { oldestAccountOf } from "./accounts.ts";
import {
  type AccountPlan,
  accountPlan,
  accountRoster,
  accountWaveCount,
  countPeople,
  type FreeLimits,
  isFreePlan,
  seatRule,
} from "./plan.ts";

/**
 * What a customer account holds against what its plan allows (ticket #117,
 * Nacharbeit): the numbers for `GET /api/billing/accounts/:id/downgrade-check`
 * and for the owner's view in `/api/me`.
 *
 * Read-only. Nothing here changes a wave, a person or a device, and nothing is
 * ever removed because a limit is exceeded -- the limits only say no to what is
 * new (billing/plan.ts), and the **overhang** is the report of what is above
 * them: counts, and per wave who and which devices, so the owner can decide.
 */

export interface Counts {
  waves: number;
  people: number;
  devices: number;
}

/** The limits of a plan; `null` where the plan has none (waves and devices of a paid account). */
export interface PlanLimits {
  waves: number | null;
  people: number | null;
  devices: number | null;
}

export interface OverhangWave {
  waveId: string;
  waveName: string;
  /** Members (their address) and open invitations (the invited address). */
  people: Array<{ email: string | null; kind: "member" | "invitation" }>;
  /** Devices by name. */
  devices: Array<{ name: string }>;
}

export interface Overhang extends Counts {
  /** Per wave, who and what is in it. Empty when nothing is above a limit. */
  perWave: OverhangWave[];
}

/** What a customer account holds now: waves, people (distinct users plus invitations to new addresses) and distinct devices. */
export async function accountUsage(db: Database, accountId: string): Promise<Counts> {
  const roster = await accountRoster(db, accountId);
  const [devices] = await db
    .select({ count: sql<number>`count(distinct ${nodes.machineKey})::int` })
    .from(nodes)
    .innerJoin(waves, eq(waves.id, nodes.waveId))
    .where(eq(waves.accountId, accountId));
  return {
    waves: await accountWaveCount(db, accountId),
    people: countPeople(roster, "distinct"),
    devices: devices?.count ?? 0,
  };
}

const over = (have: number, limit: number | null): number => (limit === null ? 0 : Math.max(0, have - limit));

/** The excess of a usage over limits, by number. */
export const excessOf = (usage: Counts, limits: PlanLimits): Counts => ({
  waves: over(usage.waves, limits.waves),
  people: over(usage.people, limits.people),
  devices: over(usage.devices, limits.devices),
});

const anyOver = (excess: Counts): boolean => excess.waves > 0 || excess.people > 0 || excess.devices > 0;

/** Who and what is in each wave of the account: the concrete list behind the overhang numbers. */
export async function overhangDetail(db: Database, accountId: string): Promise<OverhangWave[]> {
  const rows = await db
    .select({ id: waves.id, name: waves.name })
    .from(waves)
    .where(eq(waves.accountId, accountId))
    .orderBy(asc(waves.name), asc(waves.id));
  const result: OverhangWave[] = [];
  for (const wave of rows) {
    const members = await db
      .select({ email: users.email })
      .from(waveMembers)
      .innerJoin(users, eq(users.id, waveMembers.userId))
      .where(eq(waveMembers.waveId, wave.id))
      .orderBy(asc(users.email));
    const invites = await db
      .select({ email: waveInvites.email })
      .from(waveInvites)
      .where(
        and(
          eq(waveInvites.waveId, wave.id),
          isNull(waveInvites.acceptedAt),
          isNull(waveInvites.revokedAt),
          gt(waveInvites.expiresAt, new Date()),
        ),
      )
      .orderBy(asc(waveInvites.email));
    const devices = await db
      .select({ name: nodes.hostname })
      .from(nodes)
      .where(eq(nodes.waveId, wave.id))
      .orderBy(asc(nodes.hostname));
    result.push({
      waveId: wave.id,
      waveName: wave.name,
      people: [
        ...members.map((m) => ({ email: m.email, kind: "member" as const })),
        ...invites.map((i) => ({ email: i.email, kind: "invitation" as const })),
      ],
      devices: devices.map((d) => ({ name: d.name })),
    });
  }
  return result;
}

/** The limits that apply to an account of this plan. */
export function limitsOfPlan(plan: AccountPlan, free: FreeLimits): PlanLimits {
  if (isFreePlan(plan)) return { waves: free.waves, people: free.people, devices: free.devices };
  // Paid: no wave and no device limit, only the seats (see `seatRule()`).
  return { waves: null, people: seatRule(plan, free).limit, devices: null };
}

export interface AccountOverview {
  /** The customer account, or null where the user has none yet (their first wave makes it). */
  accountId: string | null;
  plan: "free" | "paid";
  limits: PlanLimits;
  usage: Counts;
  overhang: Overhang;
}

/**
 * Plan, limits, usage and overhang of one account, for its owner.
 *
 * The limits are those the plan enforces: the free ones, or for a paid account
 * its seats (and no wave or device limit). The overhang is what the account
 * holds above them -- after a cancellation, for example, the account is free
 * again and may hold more than a free account is let take in.
 */
export async function accountOverview(
  db: Database,
  accountId: string | null,
  free: FreeLimits,
): Promise<AccountOverview> {
  if (!accountId) {
    return {
      accountId: null,
      plan: "free",
      limits: { waves: free.waves, people: free.people, devices: free.devices },
      usage: { waves: 0, people: 0, devices: 0 },
      overhang: { waves: 0, people: 0, devices: 0, perWave: [] },
    };
  }
  const plan = await accountPlan(db, accountId);
  const limits = limitsOfPlan(plan, free);
  let usage = await accountUsage(db, accountId);
  let excess = excessOf(usage, limits);
  if (!isFreePlan(plan)) {
    // A paid account counts its people the way its plan does (memberships for an
    // account paid only through wave_billing). The usage shown next to the limit
    // and the excess have to be that count: `used / limit` is one rule, the
    // plan's, on every screen.
    const rule = seatRule(plan, free);
    const held = countPeople(await accountRoster(db, accountId), rule.mode);
    usage = { ...usage, people: held };
    excess = { ...excess, people: over(held, rule.limit) };
  }
  return {
    accountId,
    plan: plan.kind,
    limits,
    usage,
    overhang: { ...excess, perWave: anyOver(excess) ? await overhangDetail(db, accountId) : [] },
  };
}

/** The overview of the account a user's new waves go to (their oldest), or the empty free one. */
export async function accountOverviewOf(
  db: Database,
  userId: string,
  free: FreeLimits,
): Promise<AccountOverview> {
  return accountOverview(db, await oldestAccountOf(db, userId), free);
}

/**
 * What the account a wave belongs to holds against its plan, as a fragment of
 * the members answer (`{ account: { plan, limits, usage } }`): the numbers the
 * invitation form puts beside the field. Empty for a wave without an account
 * (self-hosted, or made before accounts) -- no plan, no hint. Read-only.
 */
export async function waveAccountOverview(
  db: Database,
  waveId: string,
  free: FreeLimits,
): Promise<{ account?: Pick<AccountOverview, "plan" | "limits" | "usage"> }> {
  const [wave] = await db
    .select({ accountId: waves.accountId })
    .from(waves)
    .where(eq(waves.id, waveId))
    .limit(1);
  if (!wave?.accountId) return {};
  const { plan, limits, usage } = await accountOverview(db, wave.accountId, free);
  return { account: { plan, limits, usage } };
}

/**
 * The downgrade check of the site: may this account go back to free as it is?
 *
 * Judged against the *free* limits whatever the account's plan is now -- it is
 * the question "would it fit", asked before cancelling. `overhang` is by how much
 * it would not.
 */
export interface DowngradeCheck {
  allowed: boolean;
  limits: { waves: number; people: number; devices: number };
  usage: Counts;
  overhang: Counts;
}

export async function downgradeCheck(
  db: Database,
  accountId: string,
  free: FreeLimits,
): Promise<DowngradeCheck> {
  const usage = await accountUsage(db, accountId);
  const limits = { waves: free.waves, people: free.people, devices: free.devices };
  const overhang = excessOf(usage, limits);
  return { allowed: !anyOver(overhang), limits, usage, overhang };
}
