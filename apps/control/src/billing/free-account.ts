import { eq } from "drizzle-orm";
import { lockAddress } from "../auth/address-lock.ts";
import type { Database } from "../db/client.ts";
import { users } from "../db/schema.ts";
import { DEFAULT_CAPACITY_RESERVE, DEFAULT_FREE_IPV4_PREFIX_LENGTH } from "../env.ts";
import { ContainerFullError } from "../net/addressing.ts";
import { createWave, IPV4_PREFIX_LENGTH, type WaveCreation } from "../waves/provision.ts";
import { ensureAccountFor, oldestAccountOf } from "./accounts.ts";
import {
  accountPlan,
  accountWaveCount,
  type FreeLimits,
  freeLimitsOf,
  isBlockedDomain,
  isFreePlan,
  lockAccount,
} from "./plan.ts";
import { hasAnyIdentity } from "./setup-links.ts";

/**
 * Who may start a wave, and the free hosted account that comes with the first
 * one (ticket #117). One place: `/api/me` (`canCreateWave`), `/waves/new`, the
 * login redirect and `POST /waves` all ask `waveCreationDenial()`, and the POST
 * asks it again under the locks that make the answer binding.
 *
 * Where billing is not configured the server is self-hosted: no customer
 * account, no limit, nothing is asked (as before). Where it is configured, a
 * **confirmed** user may create waves for a customer account of their own
 * without paying, up to the free limits -- the wave limit here, the people and
 * device limits where those are added.
 */

export interface CreationPolicy {
  /** False on a self-hosted server (no `WAVE_BILLING_TOKEN`): nobody is limited. */
  hosted: boolean;
  limits: FreeLimits;
  /** Lowercased domains that cannot start a free account. */
  blockedDomains: string[];
  /** Prefix length of the block a free wave gets (billed waves: /16). */
  freePrefixLength: number;
  /** Whole /16s that stay free after a free wave is numbered; 0 is off. */
  capacityReserve: number;
}

export const creationPolicyOf = (config: {
  billing?: unknown;
  freeMaxWaves: number;
  freeDeviceLimit: number;
  freeBlockedEmailDomains: string[];
  freeIpv4PrefixLength?: number;
  capacityReserve?: number;
}): CreationPolicy => ({
  hosted: Boolean(config.billing),
  limits: freeLimitsOf(config),
  blockedDomains: config.freeBlockedEmailDomains,
  freePrefixLength: config.freeIpv4PrefixLength ?? DEFAULT_FREE_IPV4_PREFIX_LENGTH,
  capacityReserve: config.capacityReserve ?? DEFAULT_CAPACITY_RESERVE,
});

/**
 * Why a user cannot create a wave. Stable codes: the API says them as they are
 * and the pages turn them into sentences.
 *
 * - `placeholder`: the account a payment made for an address nobody has proven.
 * - `unverified-email`: the address was never confirmed (OIDC `email_verified`,
 *   or a password account whose setup link was followed).
 * - `email-domain`: on `WAVE_FREE_BLOCKED_EMAIL_DOMAINS`.
 * - `wave-limit`: the free account already holds `WAVE_FREE_MAX_WAVES` waves.
 */
export type CreationDenial = "placeholder" | "unverified-email" | "email-domain" | "wave-limit";

interface Evaluation {
  denial: CreationDenial | null;
  email: string | null;
  /** The account a new wave goes to; null where none exists yet. */
  accountId: string | null;
  /** Whether that account (or the one to be made) is free. */
  free: boolean;
}

/**
 * The decision, with or without locks. With `lock` it runs inside the
 * transaction that creates the wave: the address, the user and the account
 * row are taken in that order -- the order the billing paths and the account
 * link take them in.
 */
async function evaluate(
  db: Database,
  policy: CreationPolicy,
  userId: string,
  lock: boolean,
): Promise<Evaluation> {
  if (!policy.hosted) return { denial: null, email: null, accountId: null, free: false };

  const [peek] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  if (lock && peek?.email) await lockAddress(db, peek.email);
  const read = db
    .select({ email: users.email, verified: users.emailVerified, password: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const user = (lock ? await read.for("update") : await read)[0];
  if (!user) return { denial: "unverified-email", email: null, accountId: null, free: true };

  const nothing = { email: user.email, accountId: null, free: true };
  // A placeholder first: it is also unverified, but "nobody signs in here" is the
  // more useful answer, and it must never get as far as an account.
  if (!user.verified && user.password === null && !(await hasAnyIdentity(db, userId))) {
    return { ...nothing, denial: "placeholder" };
  }
  if (!user.verified || !user.email) return { ...nothing, denial: "unverified-email" };

  const accountId = await oldestAccountOf(db, userId);
  if (!accountId) {
    if (isBlockedDomain(user.email, policy.blockedDomains)) return { ...nothing, denial: "email-domain" };
    return { ...nothing, denial: null };
  }
  if (lock) await lockAccount(db, accountId);
  const free = isFreePlan(await accountPlan(db, accountId));
  if (free) {
    if (isBlockedDomain(user.email, policy.blockedDomains)) {
      return { email: user.email, accountId, free, denial: "email-domain" };
    }
    if ((await accountWaveCount(db, accountId)) >= policy.limits.waves) {
      return { email: user.email, accountId, free, denial: "wave-limit" };
    }
  }
  return { email: user.email, accountId, free, denial: null };
}

/** Whether this user may create a wave now, without locking or writing. */
export async function waveCreationDenial(
  db: Database,
  policy: CreationPolicy,
  userId: string,
): Promise<CreationDenial | null> {
  return (await evaluate(db, policy, userId, false)).denial;
}

/**
 * No address block is left for another wave on this server -- or, for a free
 * one, what is left is the reserve held back for billed waves. `detail` says
 * which, for the log; the message the person sees does not change.
 */
export class NoWaveCapacityError extends Error {
  constructor(readonly detail?: string) {
    super("no address block left for another wave");
    this.name = "NoWaveCapacityError";
  }
}

export type WaveCreationForUser =
  | { kind: "created"; waveId: string; accountId: string | null; newAccount: boolean; free: boolean }
  | { kind: "conflict"; conflict: "suffix" }
  | { kind: "denied"; denial: CreationDenial; email: string | null };

/**
 * Creates a wave for a user and, on a hosted server, puts it under their
 * customer account -- made in the same transaction if this is the first wave.
 *
 * `ensureAccountFor()` hands back the same account for the same user every
 * time, and the same Pocket-ID identity is the same user, so one person never
 * gets a second free pot: the locks (address, then the user's row, then the
 * account's) make two simultaneous requests one after the other. Throws
 * `NoWaveCapacityError` when every address block is taken, or when a free wave
 * would leave fewer than the reserve of whole /16s for billed ones (507).
 */
export async function createWaveForUser(
  db: Database,
  policy: CreationPolicy,
  input: { userId: string; name: string; dnsSuffix: string; container?: string },
): Promise<WaveCreationForUser> {
  if (!policy.hosted) {
    // Self-hosted: nobody is refused, the log is told when the container runs low.
    const made = await createWaveChecked(db, {
      ...input,
      reserve: { blocks: policy.capacityReserve, enforce: false },
    });
    return "conflict" in made
      ? { kind: "conflict", conflict: "suffix" }
      : { kind: "created", waveId: made.waveId, accountId: null, newAccount: false, free: false };
  }

  return db
    .transaction(async (tx) => {
      const t = tx as unknown as Database;
      const decided = await evaluate(t, policy, input.userId, true);
      if (decided.denial) return { kind: "denied", denial: decided.denial, email: decided.email } as const;

      const newAccount = decided.accountId === null;
      const accountId = decided.accountId ?? (await ensureAccountFor(t, input.userId));
      // A free wave gets the small block and may not eat into the reserve held
      // back for billed ones; the check runs under the allocation lock in
      // createWave(), so two sign-ups at the limit cannot both pass. A throw
      // rolls back the account made above: no account without a wave.
      const made = await createWaveChecked(t, {
        ...input,
        accountId,
        prefixLength: decided.free ? policy.freePrefixLength : IPV4_PREFIX_LENGTH,
        reserve: { blocks: policy.capacityReserve, enforce: decided.free },
      });
      if ("conflict" in made) {
        // The transaction is not rolled back by returning, so a new account must not stay behind.
        if (newAccount) throw new SuffixTaken();
        return { kind: "conflict", conflict: "suffix" } as const;
      }
      return { kind: "created", waveId: made.waveId, accountId, newAccount, free: decided.free } as const;
    })
    .catch((error) => {
      if (error instanceof SuffixTaken) return { kind: "conflict", conflict: "suffix" } as const;
      throw error;
    });
}

class SuffixTaken extends Error {}

async function createWaveChecked(
  db: Database,
  input: Parameters<typeof createWave>[1],
): Promise<WaveCreation> {
  try {
    return await createWave(db, input);
  } catch (error) {
    if (
      error instanceof ContainerFullError ||
      (error instanceof Error && error.message.startsWith("could not allocate a prefix"))
    ) {
      throw new NoWaveCapacityError(error.message);
    }
    throw error;
  }
}
