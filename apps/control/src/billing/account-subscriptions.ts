import { and, asc, desc, eq, ne } from "drizzle-orm";
import { lockAddress } from "../auth/address-lock.ts";
import type { Database } from "../db/client.ts";
import { accountSubscriptions, users, waveBilling } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { looksLikeEmail, normaliseEmail } from "../waves/invites.ts";
import { ensureAccountFor } from "./accounts.ts";
import { accountRoster, accountWaveCount, countPeople } from "./plan.ts";
import type { BillingState } from "./subscriptions.ts";

/**
 * The subscription of a whole customer account (ticket #117): the write path of
 * `account_subscriptions`, called by wave-mesh.org like `applySubscription()`
 * and with the same rules, one level up -- the account instead of a wave.
 *
 * - **The state is said, not the change.** Every call names the subscription and
 *   the state it should have; writing only what differs makes a repeated
 *   delivery a no-op. `asOf` (ms, when the site read it) orders deliveries:
 *   an older read than the last applied is answered with the current state.
 * - **Ended stays ended.** A later `active` or `suspended` is a stale read: 409.
 *   `delete_after` exists only in `ended` (now + retention, never pushed back);
 *   nothing deletes by it, because ending an account subscription changes no
 *   wave, key, address or connection -- the account is free again, nothing more.
 * - **A new subscription needs an address and `active`.** The address must be a
 *   *confirmed* user's (`emailVerified`): there is no placeholder for an account
 *   subscription, because a subscription buys more room in an account that is
 *   already somebody's. An address nobody confirmed answers `unknown-account`
 *   and creates nothing. A confirmed user without a customer account gets one
 *   (empty, free until this applies) -- paying before the first wave is fine.
 * - **One live subscription per account.** A second one for an account that has
 *   one (partial unique index) is a conflict, not a second quota.
 *
 * Takes no part in the netmap: an account subscription neither pauses nor
 * starts a mesh, so nothing is pushed to devices.
 */

export interface AccountSubscriptionInput {
  email?: string;
  seats: number;
  state: BillingState;
  asOf?: number;
}

export interface AccountSubscriptionView {
  subscriptionId: string;
  accountId: string;
  created: boolean;
  state: BillingState;
  seats: number;
  deleteAfter: string | null;
  /** Waves under the account now. */
  waves: number;
  /** People held now, counted the way the limit counts them: members and open invitations. */
  people: number;
}

export type AccountSubscriptionResult =
  | { kind: "applied"; view: AccountSubscriptionView }
  /** Not known here and not enough said to create it: no address, or not `active`. */
  | { kind: "unknown" }
  /** The address belongs to no confirmed user: there is no account to put it under. */
  | { kind: "unknown-account" }
  /** Ended for good. */
  | { kind: "ended" }
  /** `account-has-subscription`: another live one; `wave-subscription`: the id is a wave's. */
  | { kind: "conflict"; reason: "account-has-subscription" | "wave-subscription" };

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 30;

export async function applyAccountSubscription(
  db: Database,
  subscriptionId: string,
  input: AccountSubscriptionInput,
  options: { retentionDays?: number; now?: Date } = {},
): Promise<AccountSubscriptionResult> {
  const now = options.now ?? new Date();
  const retentionMs = (options.retentionDays ?? DEFAULT_RETENTION_DAYS) * DAY_MS;

  let created = false;
  if (!(await load(db, subscriptionId))) {
    if (!input.email || input.state !== "active") return { kind: "unknown" };
    const made = await createFor(db, subscriptionId, input);
    if (made.kind === "unknown-account" || made.kind === "conflict") return made;
    created = made.kind === "created";
  }

  const outcome = await db.transaction(async (tx) => {
    const t = tx as unknown as Database;
    const locked = await t
      .select()
      .from(accountSubscriptions)
      .where(eq(accountSubscriptions.subscriptionId, subscriptionId))
      .limit(1)
      .for("update");
    const row = locked[0];
    if (!row) return { kind: "unknown" as const };
    if (row.state === "ended" && input.state !== "ended") return { kind: "ended" as const };
    if (input.asOf !== undefined && row.stateAsOf !== null && input.asOf < row.stateAsOf) {
      return { kind: "stale" as const, row };
    }

    const deleteAfter =
      input.state === "ended" ? (row.deleteAfter ?? new Date(now.getTime() + retentionMs)) : null;
    const changed =
      row.state !== input.state ||
      row.seats !== input.seats ||
      (row.deleteAfter?.getTime() ?? null) !== (deleteAfter?.getTime() ?? null);
    const stateAsOf = input.asOf ?? row.stateAsOf;
    if (changed || stateAsOf !== row.stateAsOf) {
      await t
        .update(accountSubscriptions)
        .set({ state: input.state, seats: input.seats, deleteAfter, stateAsOf, updatedAt: now })
        .where(eq(accountSubscriptions.id, row.id));
    }
    return {
      kind: "applied" as const,
      changed,
      row: { ...row, state: input.state, seats: input.seats, deleteAfter },
    };
  });

  if (outcome.kind === "unknown" || outcome.kind === "ended") return { kind: outcome.kind };
  const row = outcome.row;
  if (outcome.kind === "applied" && outcome.changed) {
    // On stdout like the billing sweep: an account may have no wave to hang an audit entry on.
    console.log(
      `billing: account ${row.accountId} subscription ${subscriptionId} is ${row.state}, ${row.seats} seats`,
    );
  }
  const roster = await accountRoster(db, row.accountId);
  return {
    kind: "applied",
    view: {
      subscriptionId,
      accountId: row.accountId,
      created,
      state: row.state,
      seats: row.seats,
      deleteAfter: row.deleteAfter?.toISOString() ?? null,
      waves: await accountWaveCount(db, row.accountId),
      people: countPeople(roster, "distinct"),
    },
  };
}

async function load(db: Database, subscriptionId: string): Promise<{ id: string } | null> {
  const rows = await db
    .select({ id: accountSubscriptions.id })
    .from(accountSubscriptions)
    .where(eq(accountSubscriptions.subscriptionId, subscriptionId))
    .limit(1);
  return rows[0] ?? null;
}

type Made =
  | { kind: "created" | "exists" }
  | { kind: "unknown-account" }
  | { kind: "conflict"; reason: "account-has-subscription" | "wave-subscription" };

/**
 * The first sighting of a subscription: finds the account of the confirmed user
 * behind the address and puts the row under it. One transaction under the
 * address lock; the unique indexes settle two deliveries racing each other --
 * the loser reads the winner's row.
 */
async function createFor(
  db: Database,
  subscriptionId: string,
  input: AccountSubscriptionInput,
): Promise<Made> {
  const email = normaliseEmail(input.email ?? "");
  if (!looksLikeEmail(email)) throw new Error(`not an email address: ${input.email}`);

  const [wave] = await db
    .select({ waveId: waveBilling.waveId })
    .from(waveBilling)
    .where(eq(waveBilling.subscriptionId, subscriptionId))
    .limit(1);
  if (wave) return { kind: "conflict", reason: "wave-subscription" };

  try {
    return await db.transaction(async (tx): Promise<Made> => {
      const t = tx as unknown as Database;
      await lockAddress(t, email);
      // A delivery of the same subscription that was ahead of this one under the
      // lock: its row is there now, and it is not a conflict with itself.
      if (await load(t, subscriptionId)) return { kind: "exists" };
      const [owner] = await t
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.email, email), eq(users.emailVerified, true)))
        .orderBy(desc(users.emailVerified), asc(users.createdAt))
        .limit(1);
      if (!owner) return { kind: "unknown-account" };

      const accountId = await ensureAccountFor(t, owner.id);
      const [live] = await t
        .select({ id: accountSubscriptions.id })
        .from(accountSubscriptions)
        .where(and(eq(accountSubscriptions.accountId, accountId), ne(accountSubscriptions.state, "ended")))
        .limit(1);
      if (live) return { kind: "conflict", reason: "account-has-subscription" };

      await t.insert(accountSubscriptions).values({
        id: newId("as"),
        subscriptionId,
        accountId,
        seats: input.seats,
        state: "active",
        stateAsOf: input.asOf ?? null,
      });
      return { kind: "created" };
    });
  } catch (error) {
    // Two deliveries at once: the unique indexes let one in. The other finds
    // its row -- or, if the row is another subscription's, the account is taken.
    if (await load(db, subscriptionId)) return { kind: "exists" };
    if ((error as { code?: string }).code === "23505" || /unique|duplicate/i.test(String(error))) {
      return { kind: "conflict", reason: "account-has-subscription" };
    }
    throw error;
  }
}
