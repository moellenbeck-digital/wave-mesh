import { and, asc, desc, eq, isNotNull, lte, sql } from "drizzle-orm";
import { type Actor, audit } from "../audit.ts";
import type { Database } from "../db/client.ts";
import { users, waveBilling, waves } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { looksLikeEmail, normaliseEmail } from "../waves/invites.ts";
import {
  createWave,
  DEFAULT_DNS_BASE,
  type DeletedWave,
  deleteWave,
  suggestWave,
} from "../waves/provision.ts";

export type BillingState = "active" | "suspended" | "ended";

/** How long an ended subscription's wave is kept before the sweep deletes it. */
export const DEFAULT_RETENTION_DAYS = 30;

/** The site is the only caller, and it is not a person. */
export const billingActor: Actor = { userId: null, label: "billing" };

export interface SubscriptionInput {
  email?: string;
  name?: string;
  seats: number;
  state: BillingState;
}

export interface SubscriptionView {
  waveId: string;
  waveName: string;
  dnsSuffix: string;
  created: boolean;
  state: BillingState;
  seats: number;
  /**
   * Whether devices see a different wave than before -- the mesh started or
   * stopped. The caller pushes netmaps when it did; nothing else moves them.
   */
  meshChanged: boolean;
}

/**
 * Whether a wave's mesh is stopped for billing.
 *
 * Suspended and ended look the same from a device: the wave is there, the
 * device stays enrolled, and its netmap has nobody in it. Only the sweep tells
 * them apart, by deleting the ended one after its retention.
 */
export async function isSuspended(db: Database, waveId: string): Promise<boolean> {
  const rows = await db
    .select({ state: waveBilling.state })
    .from(waveBilling)
    .where(eq(waveBilling.waveId, waveId))
    .limit(1);
  const state = rows[0]?.state;
  return state !== undefined && state !== "active";
}

/**
 * Makes a subscription's wave what the site says it should be.
 *
 * Stated, not changed: the site sends the whole desired state on every event,
 * and this writes only what differs. Stripe repeats deliveries and does not
 * keep them in order, so "the same thing twice" has to be a no-op and a stale
 * event has to be no worse than a repeated one -- which a description of the
 * end state gives for free and a list of changes would not.
 *
 * Returns null for an unknown subscription that does not say who it belongs
 * to: only the checkout event carries the address and the name, and anything
 * that arrives before it has nothing to build a wave from.
 */
export async function applySubscription(
  db: Database,
  subscriptionId: string,
  input: SubscriptionInput,
  options: { retentionDays?: number; container?: string; now?: Date } = {},
): Promise<SubscriptionView | null> {
  const now = options.now ?? new Date();
  const retentionMs = (options.retentionDays ?? DEFAULT_RETENTION_DAYS) * 24 * 60 * 60 * 1000;

  let existing = await loadBilled(db, subscriptionId);
  let created = false;
  if (!existing) {
    if (!input.email || !input.name) return null;
    existing = await createBilledWave(db, subscriptionId, input, options.container);
    created = existing.created;
  }

  const { row, wave } = existing;
  const deleteAfter =
    input.state === "active"
      ? null
      : input.state === "ended"
        ? (row.deleteAfter ?? new Date(now.getTime() + retentionMs))
        : row.deleteAfter;

  const wasLive = row.state === "active";
  const isLive = input.state === "active";
  const unchanged =
    row.state === input.state &&
    row.seats === input.seats &&
    (row.deleteAfter?.getTime() ?? null) === (deleteAfter?.getTime() ?? null);

  if (!unchanged) {
    await db
      .update(waveBilling)
      .set({ state: input.state, seats: input.seats, deleteAfter, updatedAt: now })
      .where(eq(waveBilling.waveId, wave.id));
    // Only a mesh that starts or stops is news to a device; seats and the
    // deletion date are in no netmap.
    if (wasLive !== isLive) {
      await db
        .update(waves)
        .set({ netmapVersion: sql`${waves.netmapVersion} + 1` })
        .where(eq(waves.id, wave.id));
    }
    await audit(db, wave.id, billingActor, {
      action: "billing.update",
      target: subscriptionId,
      detail: {
        state: input.state,
        seats: input.seats,
        ...(deleteAfter ? { deleteAfter: deleteAfter.toISOString() } : {}),
      },
    });
  }

  return {
    waveId: wave.id,
    waveName: wave.name,
    dnsSuffix: wave.dnsSuffix,
    created,
    state: input.state,
    seats: input.seats,
    meshChanged: !created && wasLive !== isLive,
  };
}

/** A subscription's wave and the owner it was made for. */
export async function billedWave(
  db: Database,
  subscriptionId: string,
): Promise<{ waveId: string; ownerUserId: string } | null> {
  const rows = await db
    .select({ waveId: waves.id, ownerUserId: waves.ownerUserId })
    .from(waveBilling)
    .innerJoin(waves, eq(waves.id, waveBilling.waveId))
    .where(eq(waveBilling.subscriptionId, subscriptionId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Deletes the waves whose subscription ended longer ago than the retention.
 *
 * In the control process and not driven by the site: the site only hears from
 * Stripe when something happens, and "thirty days have passed" is not an
 * event. Each wave goes the way the owner's delete button takes it, through
 * deleteWave(), and the node ids come back so their connections can be cut.
 */
export async function sweepEndedWaves(
  db: Database,
  now: Date = new Date(),
): Promise<Array<DeletedWave & { waveId: string }>> {
  const due = await db
    .select({ waveId: waveBilling.waveId, subscriptionId: waveBilling.subscriptionId })
    .from(waveBilling)
    .where(
      and(
        eq(waveBilling.state, "ended"),
        isNotNull(waveBilling.deleteAfter),
        lte(waveBilling.deleteAfter, now),
      ),
    );

  const deleted: Array<DeletedWave & { waveId: string }> = [];
  for (const { waveId, subscriptionId } of due) {
    const gone = await deleteWave(db, waveId);
    if (!gone) continue;
    // The wave's own audit log goes with it, so the operator's log is stdout.
    console.log(`billing: deleted ${gone.name} (${waveId}), subscription ${subscriptionId} ended`);
    deleted.push({ ...gone, waveId });
  }
  return deleted;
}

type BilledRow = typeof waveBilling.$inferSelect;
type WaveRow = typeof waves.$inferSelect;

async function loadBilled(
  db: Database,
  subscriptionId: string,
): Promise<{ row: BilledRow; wave: WaveRow; created: boolean } | null> {
  const rows = await db
    .select({ row: waveBilling, wave: waves })
    .from(waveBilling)
    .innerJoin(waves, eq(waves.id, waveBilling.waveId))
    .where(eq(waveBilling.subscriptionId, subscriptionId))
    .limit(1);
  const found = rows[0];
  return found ? { ...found, created: false } : null;
}

/**
 * The wave a checkout paid for, owned by the address that paid.
 *
 * The account is found by address or made without a password and **without**
 * `emailVerified`. Stripe takes whatever address is typed into the checkout
 * and never proves the mailbox; calling it verified would let a later Google
 * login with that address attach to an account whose password the payer
 * chose -- someone else's address, in someone else's hands. The address
 * becomes verified when the setup link sent to it is followed.
 *
 * One transaction with the billing row, whose unique index on the subscription
 * is what settles two deliveries of the same event racing each other: the
 * loser rolls back its wave and reads the winner's.
 */
async function createBilledWave(
  db: Database,
  subscriptionId: string,
  input: SubscriptionInput,
  container: string | undefined,
): Promise<{ row: BilledRow; wave: WaveRow; created: boolean }> {
  const email = normaliseEmail(input.email ?? "");
  if (!looksLikeEmail(email)) throw new Error(`not an email address: ${input.email}`);

  try {
    await db.transaction(async (tx) => {
      const t = tx as unknown as Database;
      const userId = await ownerFor(t, email);
      // Two customers called "acme" collide on the suffix; a discriminator
      // rather than a refusal, the same as ensureWaveForUser() does.
      const base = suggestWave(input.name ?? email).name;
      for (let attempt = 0; attempt < 5; attempt++) {
        const name = attempt === 0 ? base : `${base.slice(0, 19)}-${crypto.randomUUID().slice(0, 4)}`;
        const made = await createWave(t, {
          userId,
          name,
          dnsSuffix: `${name}.${DEFAULT_DNS_BASE}`,
          ...(container ? { container } : {}),
        });
        if ("waveId" in made) {
          // Created live and then brought to the stated state by the caller,
          // so a wave born suspended is one code path, not two.
          await t.insert(waveBilling).values({
            waveId: made.waveId,
            subscriptionId,
            seats: input.seats,
            state: "active",
          });
          await audit(t, made.waveId, billingActor, {
            action: "billing.create",
            target: subscriptionId,
            detail: { owner: email, seats: input.seats },
          });
          return;
        }
      }
      throw new Error(`could not find a free name for ${input.name}`);
    });
  } catch (error) {
    const winner = await loadBilled(db, subscriptionId);
    if (winner) return winner;
    throw error;
  }

  const made = await loadBilled(db, subscriptionId);
  if (!made) throw new Error(`the wave for ${subscriptionId} vanished after it was created`);
  return { ...made, created: true };
}

/**
 * The account a billed wave belongs to: the one that has the address, or a new
 * one. Verified accounts first, then the oldest -- the same address twice is a
 * leftover of provider logins before linking, and the verified one is the one
 * its owner signs in with.
 */
async function ownerFor(db: Database, email: string): Promise<string> {
  const found = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .orderBy(desc(users.emailVerified), asc(users.createdAt))
    .limit(1);
  if (found[0]) return found[0].id;

  const id = newId("u");
  await db.insert(users).values({ id, email, emailVerified: false });
  return id;
}
