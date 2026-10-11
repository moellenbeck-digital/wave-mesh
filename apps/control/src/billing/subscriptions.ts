import { and, asc, desc, eq, isNotNull, lte, sql } from "drizzle-orm";
import { type Actor, audit } from "../audit.ts";
import type { Database } from "../db/client.ts";
import { users, waveBilling, waveMembers, waves } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { ContainerFullError } from "../net/addressing.ts";
import { looksLikeEmail, normaliseEmail } from "../waves/invites.ts";
import {
  createWave,
  DEFAULT_DNS_BASE,
  type DeletedWave,
  deleteWave,
  suggestWave,
} from "../waves/provision.ts";
import { hasAnyIdentity } from "./setup-links.ts";

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
  /** When the site read this state, in ms; an older read than the last one applied is stale. */
  asOf?: number;
}

export interface SubscriptionView {
  waveId: string;
  waveName: string;
  dnsSuffix: string;
  created: boolean;
  state: BillingState;
  seats: number;
  /** People in the wave now, open invitations not counted. */
  members: number;
  /**
   * Whether devices see a different wave than before -- the mesh started or
   * stopped. The caller pushes netmaps when it did; nothing else moves them.
   */
  meshChanged: boolean;
}

export type SubscriptionResult =
  | { kind: "applied"; view: SubscriptionView }
  /** Not known here, and not enough said to create it: no address, no name, or not active. */
  | { kind: "unknown" }
  /** Ended for good. Stripe's `canceled` is final, and so is this. */
  | { kind: "ended" };

/** Every /16 of the container is taken: this server cannot hold another wave. */
export class NoCapacityError extends Error {
  constructor(readonly subscriptionId: string) {
    super(`no address block left for ${subscriptionId}`);
    this.name = "NoCapacityError";
  }
}

/**
 * Whether a wave's mesh is stopped for billing.
 *
 * Suspended and ended look the same from a device: the wave is there, the
 * device stays enrolled, and its netmap has nobody in it. Only the sweep tells
 * them apart, by deleting the ended one after its retention.
 */
export async function isSuspended(db: Database, waveId: string): Promise<boolean> {
  const state = await billingStateOf(db, waveId);
  return state !== null && state !== "active";
}

/** The billing state of a wave, or null for one nobody pays for (every self-hosted wave). */
export async function billingStateOf(db: Database, waveId: string): Promise<BillingState | null> {
  const rows = await db
    .select({ state: waveBilling.state })
    .from(waveBilling)
    .where(eq(waveBilling.waveId, waveId))
    .limit(1);
  return rows[0]?.state ?? null;
}

/**
 * Makes a subscription's wave what the site says it should be.
 *
 * Stated, not changed: the site sends the whole desired state on every event,
 * and this writes only what differs. Stripe repeats deliveries and does not
 * keep them in order, so "the same thing twice" has to be a no-op. Two events
 * handled at the same time can still land in either order, which is what
 * `asOf` is for: the row is locked, and a state read before the one already
 * applied is not applied.
 *
 * Three rules beyond that. A wave is only ever created active: an ended or a
 * paused subscription that was never seen here has nothing to be given. An
 * ended one stays ended: Stripe never brings a cancelled subscription back,
 * so a later "active" is a stale read, and applying it would hand out a
 * network for free and cancel its deletion. And the deletion date exists only
 * while the state is "ended".
 */
export async function applySubscription(
  db: Database,
  subscriptionId: string,
  input: SubscriptionInput,
  options: { retentionDays?: number; container?: string; now?: Date } = {},
): Promise<SubscriptionResult> {
  const now = options.now ?? new Date();
  const retentionMs = (options.retentionDays ?? DEFAULT_RETENTION_DAYS) * 24 * 60 * 60 * 1000;

  let created = false;
  if (!(await loadBilled(db, subscriptionId))) {
    if (!input.email || !input.name || input.state !== "active") return { kind: "unknown" };
    created = await createBilledWave(db, subscriptionId, input, options.container);
  }

  const outcome = await db.transaction(async (tx) => {
    const locked = await tx
      .select()
      .from(waveBilling)
      .where(eq(waveBilling.subscriptionId, subscriptionId))
      .limit(1)
      .for("update");
    const row = locked[0];
    // Deleted between the lookup and the lock: the sweep got there first.
    if (!row) return { kind: "unknown" as const };
    if (row.state === "ended" && input.state !== "ended") return { kind: "ended" as const };
    if (input.asOf !== undefined && row.stateAsOf !== null && input.asOf < row.stateAsOf) {
      return { kind: "stale" as const, row };
    }

    const deleteAfter =
      input.state === "ended" ? (row.deleteAfter ?? new Date(now.getTime() + retentionMs)) : null;
    const wasLive = row.state === "active";
    const isLive = input.state === "active";
    const changed =
      row.state !== input.state ||
      row.seats !== input.seats ||
      (row.deleteAfter?.getTime() ?? null) !== (deleteAfter?.getTime() ?? null);
    const stateAsOf = input.asOf ?? row.stateAsOf;

    if (changed || stateAsOf !== row.stateAsOf) {
      await tx
        .update(waveBilling)
        .set({ state: input.state, seats: input.seats, deleteAfter, stateAsOf, updatedAt: now })
        .where(eq(waveBilling.waveId, row.waveId));
    }
    // Only a mesh that starts or stops is news to a device; seats and the
    // deletion date are in no netmap.
    if (changed && wasLive !== isLive) {
      await tx
        .update(waves)
        .set({ netmapVersion: sql`${waves.netmapVersion} + 1` })
        .where(eq(waves.id, row.waveId));
    }
    return {
      kind: "applied" as const,
      row: { ...row, state: input.state, seats: input.seats, deleteAfter },
      changed,
      meshChanged: changed && wasLive !== isLive,
    };
  });

  if (outcome.kind === "unknown" || outcome.kind === "ended") return { kind: outcome.kind };

  // After the commit, never inside it: audit() swallows its own failure, and a
  // failed statement inside a transaction would turn the commit into a silent
  // rollback of the change it was describing.
  if (outcome.kind === "applied" && outcome.changed) {
    const { row } = outcome;
    await audit(db, row.waveId, billingActor, {
      action: "billing.update",
      target: subscriptionId,
      detail: {
        state: row.state,
        seats: row.seats,
        ...(row.deleteAfter ? { deleteAfter: row.deleteAfter.toISOString() } : {}),
      },
    });
  }

  const row = outcome.row;
  const wave = (await db.select().from(waves).where(eq(waves.id, row.waveId)).limit(1))[0];
  if (!wave) return { kind: "unknown" };
  return {
    kind: "applied",
    view: {
      waveId: wave.id,
      waveName: wave.name,
      dnsSuffix: wave.dnsSuffix,
      created,
      state: row.state,
      seats: row.seats,
      members: await memberCount(db, wave.id),
      meshChanged: outcome.kind === "applied" && !created && outcome.meshChanged,
    },
  };
}

async function memberCount(db: Database, waveId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(waveMembers)
    .where(eq(waveMembers.waveId, waveId));
  return row?.count ?? 0;
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
 *
 * Each wave is checked again under its lock before it goes, and each one on
 * its own: one that fails to delete is logged and tried again next hour, and
 * does not hold up the others.
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
    try {
      const gone = await db.transaction(async (tx) => {
        const still = await tx
          .select({ state: waveBilling.state, deleteAfter: waveBilling.deleteAfter })
          .from(waveBilling)
          .where(eq(waveBilling.waveId, waveId))
          .limit(1)
          .for("update");
        const row = still[0];
        if (row?.state !== "ended" || !row.deleteAfter || row.deleteAfter > now) return null;
        return deleteWave(tx as unknown as Database, waveId);
      });
      if (!gone) continue;
      // The wave's own audit log goes with it, so the operator's log is stdout.
      console.log(`billing: deleted ${gone.name} (${waveId}), subscription ${subscriptionId} ended`);
      deleted.push({ ...gone, waveId });
    } catch (error) {
      console.error(`billing: could not delete ${waveId} (${subscriptionId}): ${(error as Error).message}`);
    }
  }
  return deleted;
}

async function loadBilled(db: Database, subscriptionId: string): Promise<{ waveId: string } | null> {
  const rows = await db
    .select({ waveId: waveBilling.waveId })
    .from(waveBilling)
    .where(eq(waveBilling.subscriptionId, subscriptionId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The wave a checkout paid for, owned by the address that paid.
 *
 * One transaction with the billing row, whose unique index on the subscription
 * is what settles two deliveries of the same event racing each other: the
 * loser rolls back its wave and finds the winner's. Returns whether this call
 * made it.
 */
async function createBilledWave(
  db: Database,
  subscriptionId: string,
  input: SubscriptionInput,
  container: string | undefined,
): Promise<boolean> {
  const email = normaliseEmail(input.email ?? "");
  if (!looksLikeEmail(email)) throw new Error(`not an email address: ${input.email}`);

  let waveId: string;
  try {
    waveId = await db.transaction(async (tx) => {
      const t = tx as unknown as Database;
      // One placeholder per address even when two checkouts for the same new
      // address arrive at once: users.email has no unique index (provider
      // accounts may share one), so the address itself is the lock.
      await t.execute(sql`select pg_advisory_xact_lock(hashtext(${`billing-owner:${email}`}))`);
      const userId = await ownerFor(t, email);
      // Two customers called "acme" collide on the suffix; a discriminator
      // rather than a refusal, the same as ensureWaveForUser() does.
      const base = suggestWave(input.name ?? email).name;
      for (let attempt = 0; attempt < 5; attempt++) {
        const name = attempt === 0 ? base : `${base.slice(0, 19)}-${crypto.randomUUID().slice(0, 4)}`;
        let made: Awaited<ReturnType<typeof createWave>>;
        try {
          made = await createWave(t, {
            userId,
            name,
            dnsSuffix: `${name}.${DEFAULT_DNS_BASE}`,
            ...(container ? { container } : {}),
          });
        } catch (error) {
          if (
            error instanceof ContainerFullError ||
            (error as Error).message.startsWith("could not allocate a prefix")
          ) {
            throw new NoCapacityError(subscriptionId);
          }
          throw error;
        }
        if ("waveId" in made) {
          await t.insert(waveBilling).values({
            waveId: made.waveId,
            subscriptionId,
            seats: input.seats,
            state: "active",
            stateAsOf: input.asOf ?? null,
          });
          return made.waveId;
        }
      }
      throw new Error(`could not find a free name for ${input.name}`);
    });
  } catch (error) {
    if (await loadBilled(db, subscriptionId)) return false;
    throw error;
  }

  await audit(db, waveId, billingActor, {
    action: "billing.create",
    target: subscriptionId,
    detail: { owner: email, seats: input.seats },
  });
  return true;
}

/**
 * The account a billed wave belongs to.
 *
 * A **verified** account with the address, if there is one: its owner proved
 * the mailbox, and the wave is theirs to find when they sign in. Otherwise a
 * placeholder -- no password, no provider login, not verified -- reused if one
 * is already there for the address, made if not.
 *
 * Never an unverified account somebody signs in to. Stripe takes whatever
 * address is typed into the checkout, and a provider that does not vouch for
 * an address lets anyone sign up under it: handing a paid wave to such an
 * account would hand it to whoever squatted the address, and that account
 * would then get no setup link either, because it already has a way in.
 *
 * The placeholder becomes a real account in one of two ways, both of which
 * prove the mailbox: the setup link mailed to it, or a provider login that
 * says the address is verified (identity.ts absorbs the placeholder then).
 */
async function ownerFor(db: Database, email: string): Promise<string> {
  const candidates = await db
    .select({ id: users.id, emailVerified: users.emailVerified, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.email, email))
    .orderBy(desc(users.emailVerified), asc(users.createdAt));

  const verified = candidates.find((user) => user.emailVerified);
  if (verified) return verified.id;

  for (const user of candidates) {
    if (user.passwordHash !== null) continue;
    if (await hasAnyIdentity(db, user.id)) continue;
    return user.id;
  }

  const id = newId("u");
  await db.insert(users).values({ id, email, emailVerified: false });
  return id;
}
