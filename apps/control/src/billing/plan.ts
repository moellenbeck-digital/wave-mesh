import { and, eq, gt, isNull, ne, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import {
  accountSubscriptions,
  customerAccounts,
  users,
  waveBilling,
  waveInvites,
  waveMembers,
  waves,
} from "../db/schema.ts";

/**
 * What a hosted customer account is allowed to hold (ticket #117).
 *
 * The plan of an account is **derived, never stored**: it is paid when the
 * account has an `account_subscriptions` row that is not `ended`, or when one
 * of its waves has a `wave_billing` row (an ended one counts too, as before:
 * the row is what a paid wave is). Otherwise it is free. Because nothing is
 * written, a subscription that ends lets the account fall back to free without
 * a wave, key, address or connection being touched -- the limits only say no
 * to what is *new*; what is there stays.
 */

/** People in a free account, across all its waves: members plus open invitations. */
export const FREE_PEOPLE_LIMIT = 3;
/** Waves a free account may hold. The server can change it with `WAVE_FREE_MAX_WAVES`. */
export const DEFAULT_FREE_MAX_WAVES = 3;

/**
 * How many distinct devices a free account may register across all its waves
 * (ticket #116, `billing/device-limit.ts`). The server can change it with
 * `WAVE_FREE_DEVICE_LIMIT`.
 */
export const DEFAULT_FREE_DEVICE_LIMIT = 100;

export interface FreeLimits {
  waves: number;
  people: number;
  devices: number;
}

export const DEFAULT_FREE_LIMITS: FreeLimits = {
  waves: DEFAULT_FREE_MAX_WAVES,
  people: FREE_PEOPLE_LIMIT,
  devices: DEFAULT_FREE_DEVICE_LIMIT,
};

/** The limits a server was configured with. */
export const freeLimitsOf = (config: { freeMaxWaves: number; freeDeviceLimit: number }): FreeLimits => ({
  waves: config.freeMaxWaves,
  people: FREE_PEOPLE_LIMIT,
  devices: config.freeDeviceLimit,
});

/** `a.example, B.example` -> `["a.example", "b.example"]`; empty and blanks drop out. */
export function parseBlockedDomains(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
}

/** Whether the address is on one of the blocked domains (exact domain or a subdomain of it). */
export function isBlockedDomain(email: string | null, blocked: readonly string[]): boolean {
  if (!email || blocked.length === 0) return false;
  const domain = email.trim().toLowerCase().split("@").pop() ?? "";
  return blocked.some((entry) => domain === entry || domain.endsWith(`.${entry}`));
}

export type AccountPlan =
  | { kind: "free" }
  | {
      kind: "paid";
      /** The live account subscription, if there is one. */
      subscription: { subscriptionId: string; seats: number } | null;
      /** The sum of `wave_billing.seats` over the account's waves. */
      waveSeats: number;
      /** Waves with a `wave_billing` row. */
      billedWaves: number;
    };

export async function accountPlan(db: Database, accountId: string): Promise<AccountPlan> {
  const [live] = await db
    .select({ subscriptionId: accountSubscriptions.subscriptionId, seats: accountSubscriptions.seats })
    .from(accountSubscriptions)
    .where(and(eq(accountSubscriptions.accountId, accountId), ne(accountSubscriptions.state, "ended")))
    .limit(1);
  const [billed] = await db
    .select({
      waves: sql<number>`count(*)::int`,
      seats: sql<number>`coalesce(sum(${waveBilling.seats}), 0)::int`,
    })
    .from(waveBilling)
    .innerJoin(waves, eq(waves.id, waveBilling.waveId))
    .where(eq(waves.accountId, accountId));
  if (!live && !billed?.waves) return { kind: "free" };
  return {
    kind: "paid",
    subscription: live ?? null,
    waveSeats: billed?.seats ?? 0,
    billedWaves: billed?.waves ?? 0,
  };
}

export const isFreePlan = (plan: AccountPlan): boolean => plan.kind === "free";

/**
 * How many people a plan holds in the waves that have no `wave_billing` row of
 * their own, and how they are counted:
 *
 * - **free**: `limits.people`, counted as distinct people.
 * - **paid with an account subscription**: its seats plus the seats of the
 *   account's `wave_billing` rows, counted as distinct people.
 * - **paid by `wave_billing` only**: the sum of those seats, counted the way
 *   `accountQuota()` counts: memberships plus open invitations (a person in two
 *   waves is two).
 */
export function seatRule(
  plan: AccountPlan,
  limits: FreeLimits,
): { limit: number; mode: "distinct" | "memberships" } {
  if (plan.kind === "free") return { limit: limits.people, mode: "distinct" };
  if (plan.subscription) {
    return { limit: plan.subscription.seats + plan.waveSeats, mode: "distinct" };
  }
  return { limit: plan.waveSeats, mode: "memberships" };
}

/** Takes the account's row, so what is decided about it is decided one at a time. */
export async function lockAccount(db: Database, accountId: string): Promise<void> {
  await db
    .select({ id: customerAccounts.id })
    .from(customerAccounts)
    .where(eq(customerAccounts.id, accountId))
    .limit(1)
    .for("update");
}

/** Waves under the account. */
export async function accountWaveCount(db: Database, accountId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(waves)
    .where(eq(waves.accountId, accountId));
  return row?.count ?? 0;
}

/** Who is in an account's waves and who has been asked to join. */
export interface Roster {
  userIds: Set<string>;
  memberEmails: Set<string>;
  memberships: number;
  invites: Array<{ waveId: string; email: string }>;
}

const lower = (value: string | null): string | null => value?.trim().toLowerCase() || null;

export async function accountRoster(db: Database, accountId: string): Promise<Roster> {
  const members = await db
    .select({ userId: waveMembers.userId, email: users.email })
    .from(waveMembers)
    .innerJoin(waves, eq(waves.id, waveMembers.waveId))
    .innerJoin(users, eq(users.id, waveMembers.userId))
    .where(eq(waves.accountId, accountId));
  const invites = await db
    .select({ waveId: waveInvites.waveId, email: waveInvites.email })
    .from(waveInvites)
    .innerJoin(waves, eq(waves.id, waveInvites.waveId))
    .where(
      and(
        eq(waves.accountId, accountId),
        isNull(waveInvites.acceptedAt),
        isNull(waveInvites.revokedAt),
        gt(waveInvites.expiresAt, new Date()),
      ),
    );
  const memberEmails = new Set<string>();
  for (const member of members) {
    const email = lower(member.email);
    if (email) memberEmails.add(email);
  }
  return {
    userIds: new Set(members.map((member) => member.userId)),
    memberEmails,
    memberships: members.length,
    invites: invites.map((invite) => ({ waveId: invite.waveId, email: invite.email })),
  };
}

/** An invitation that is about to be replaced, so it is not counted twice. */
export interface Replaced {
  waveId: string;
  email: string;
}

const keep = (roster: Roster, replaced?: Replaced) =>
  roster.invites.filter(
    (invite) => !(replaced && invite.waveId === replaced.waveId && invite.email === replaced.email),
  );

/** People held now: see `seatRule()` for what is counted. */
export function countPeople(roster: Roster, mode: "distinct" | "memberships", replaced?: Replaced): number {
  const open = keep(roster, replaced);
  if (mode === "memberships") return roster.memberships + open.length;
  // An open invitation for an address that is already a member (or already
  // invited elsewhere) is not another person.
  const addresses = new Set(open.map((invite) => invite.email));
  let extra = 0;
  for (const email of addresses) if (!roster.memberEmails.has(email)) extra++;
  return roster.userIds.size + extra;
}

/** What one more invitation or member for this address costs: 0 if the person is already counted. */
export function seatCost(
  roster: Roster,
  mode: "distinct" | "memberships",
  email: string,
  replaced?: Replaced,
): 0 | 1 {
  if (mode === "memberships") return 1;
  const address = lower(email);
  if (!address) return 1;
  if (roster.memberEmails.has(address)) return 0;
  return keep(roster, replaced).some((invite) => invite.email === address) ? 0 : 1;
}
