import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { customerAccounts, nodes, waveBilling, waves } from "../db/schema.ts";

/**
 * How many distinct devices a free hosted account may register, across all its
 * waves. The server can change it with `WAVE_FREE_DEVICE_LIMIT`.
 */
export const DEFAULT_FREE_DEVICE_LIMIT = 100;

/**
 * A free hosted account that has no room for another device.
 *
 * Its own class, like `SeatLimitError`: the machine API says it as JSON, the
 * browser approval in the reader's language, from the same two numbers.
 */
export class DeviceLimitError extends Error {
  constructor(
    readonly accountId: string,
    readonly limit: number,
  ) {
    super(`account ${accountId} has no room for another device (${limit} registered)`);
    this.name = "DeviceLimitError";
  }
}

/**
 * Whether a device may still be put into this wave, as the rule of ticket #116:
 *
 * - A wave without `account_id` is self-hosted: no limit.
 * - An account is free when none of its waves has a `wave_billing` row.
 * - A device is `distinct machine_key` over the nodes of all the account's
 *   waves. One that is already in the account takes no further place when it
 *   joins another wave.
 * - Devices over the limit that were there before stay; only a new one is
 *   refused. Removing the last node of a machine key frees its place, because
 *   nothing is counted but the rows that exist.
 *
 * Called inside the transaction that then inserts the node. The account row is
 * locked: the wave row `createNode` holds is per wave, and two waves of one
 * account must not both take the hundredth place.
 *
 * Throws `DeviceLimitError`.
 */
export async function ensureDeviceSlot(
  db: Database,
  input: { waveId: string; machineKey: string; limit: number },
): Promise<void> {
  const [wave] = await db
    .select({ accountId: waves.accountId })
    .from(waves)
    .where(eq(waves.id, input.waveId))
    .limit(1);
  const accountId = wave?.accountId;
  if (!accountId) return;

  await db
    .select({ id: customerAccounts.id })
    .from(customerAccounts)
    .where(eq(customerAccounts.id, accountId))
    .limit(1)
    .for("update");

  if (!(await accountIsFree(db, accountId))) return;

  const [known] = await db
    .select({ one: sql<number>`1` })
    .from(nodes)
    .innerJoin(waves, eq(waves.id, nodes.waveId))
    .where(and(eq(waves.accountId, accountId), eq(nodes.machineKey, input.machineKey)))
    .limit(1);
  if (known) return;

  if ((await accountDeviceCount(db, accountId)) >= input.limit) {
    throw new DeviceLimitError(accountId, input.limit);
  }
}

/** True when no wave of the account is paid for. */
async function accountIsFree(db: Database, accountId: string): Promise<boolean> {
  const [billed] = await db
    .select({ one: sql<number>`1` })
    .from(waveBilling)
    .innerJoin(waves, eq(waves.id, waveBilling.waveId))
    .where(eq(waves.accountId, accountId))
    .limit(1);
  return !billed;
}

/** Distinct devices (`machine_key`) in all the waves of an account. */
export async function accountDeviceCount(db: Database, accountId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(distinct ${nodes.machineKey})::int` })
    .from(nodes)
    .innerJoin(waves, eq(waves.id, nodes.waveId))
    .where(eq(waves.accountId, accountId));
  return row?.count ?? 0;
}

/**
 * The same question without writing or locking, for the places that can say no
 * before they spend something -- a pre-auth key above all. Not binding: the
 * answer `createNode` gets under the lock is.
 */
export async function deviceLimitReached(
  db: Database,
  input: { waveId: string; machineKey: string; limit: number },
): Promise<DeviceLimitError | null> {
  try {
    await db.transaction(async (tx) => {
      await ensureDeviceSlot(tx as unknown as Database, input);
      // Nothing was written; rolling back releases the account lock at once.
    });
    return null;
  } catch (error) {
    if (error instanceof DeviceLimitError) return error;
    throw error;
  }
}
