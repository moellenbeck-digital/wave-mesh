import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import {
  accountSubscriptions,
  auditLog,
  customerAccounts,
  nodes,
  passwordResets,
  signupVerifications,
  users,
  waveBilling,
  waveInvites,
  waveMembers,
  waves,
} from "../db/schema.ts";
import { newId } from "../ids.ts";
import { canManage, type Role } from "../waves/members.ts";
import { type LeavingPier, pierLeaving } from "../waves/pier-dns.ts";
import { deleteWave } from "../waves/provision.ts";

/**
 * Deleting one's own account (ticket #31; Google Play, GDPR Art. 17).
 *
 * `waves.owner_user_id` cascades, so deleting the user row alone would take
 * every wave they own along -- with the other members in it. Each wave of the
 * user is therefore decided on first (`planDeletion`), and nothing is written
 * until none of them is a reason to refuse:
 *
 * - **leave**: other members remain and the user is not what keeps the wave
 *   administered (a plain member, or an admin next to another admin). Their
 *   membership and devices go, the wave stays.
 * - **handover**: the user owns it, others remain, and an administrator is
 *   among them. That one becomes the owner (the owner if there is one, else
 *   the oldest admin), then the user leaves as above.
 * - **delete**: the user is its only member. The wave goes with them, through
 *   `deleteWave` like every other deletion, so devices and the pier's DNS
 *   record are cleaned up the same way.
 * - **blocked**: others remain and the user is the last owner/admin. Nothing
 *   happens; the person has to hand the wave over or delete it first.
 *
 * Billing never blocks. A subscription is the payment provider's, not this
 * server's, so a deleted account leaves a live subscription behind that only
 * its customer can cancel (customer portal). That is said before the
 * confirmation (`describeDeletion`) and logged for the operator afterwards.
 */

/** What the audit log says in place of the person once they are gone. */
export const DELETED_ACTOR = "deleted-account";

export type WaveOutcome = "delete" | "handover" | "leave";

interface PlannedWave {
  id: string;
  name: string;
  role: Role;
  outcome: WaveOutcome;
  /** Only for a handover: the member that becomes owner. */
  newOwnerId?: string;
  /** Whether this wave has a membership row of the user (an owner without one is an inconsistency, still handled). */
  member: boolean;
}

interface Plan {
  waves: PlannedWave[];
  blockers: { id: string; name: string }[];
}

/** Reads the user's waves and decides each one. Writes nothing. */
async function planDeletion(db: Database, userId: string): Promise<Plan> {
  const rows = await db
    .select({
      id: waves.id,
      name: waves.name,
      owner: waves.ownerUserId,
      role: waveMembers.role,
    })
    .from(waves)
    .leftJoin(waveMembers, and(eq(waveMembers.waveId, waves.id), eq(waveMembers.userId, userId)))
    .where(or(eq(waveMembers.userId, userId), eq(waves.ownerUserId, userId)))
    .orderBy(asc(waves.name), asc(waves.id));

  const planned: PlannedWave[] = [];
  const blockers: { id: string; name: string }[] = [];
  for (const row of rows) {
    const owner = row.owner === userId || row.role === "owner";
    const role: Role = owner ? "owner" : (row.role ?? "member");
    const others = await db
      .select({ userId: waveMembers.userId, role: waveMembers.role })
      .from(waveMembers)
      .where(and(eq(waveMembers.waveId, row.id), ne(waveMembers.userId, userId)))
      .orderBy(asc(waveMembers.createdAt), asc(waveMembers.userId));
    const base = { id: row.id, name: row.name, role, member: row.role !== null };

    if (others.length === 0) {
      planned.push({ ...base, outcome: "delete" });
      continue;
    }
    const admins = others.filter((member) => canManage(member.role));
    if (canManage(role) && admins.length === 0) {
      blockers.push({ id: row.id, name: row.name });
      continue;
    }
    if (owner) {
      const next = admins.find((member) => member.role === "owner") ?? admins[0];
      planned.push({ ...base, outcome: "handover", newOwnerId: next?.userId });
    } else {
      planned.push({ ...base, outcome: "leave" });
    }
  }
  return { waves: planned, blockers };
}

export interface DeletionPreview {
  /** Waves that stop the deletion: others are in them and the user is their last admin. */
  blockers: { id: string; name: string }[];
  /** Waves that go with the account: the user is their only member. */
  deleted: { id: string; name: string }[];
  /** Waves that stay and get another owner. */
  handedOver: { id: string; name: string }[];
  /** Waves that stay; the user just leaves them. */
  left: { id: string; name: string }[];
  /** Devices that are removed, in every wave. */
  devices: number;
  /**
   * Waves whose subscription is still running at the payment provider and
   * that the deleted account was the customer of: it has to be cancelled in
   * the customer portal, deleting the account does not do it.
   * `outcome` says what happens to the wave itself.
   */
  billed: { id: string; name: string; outcome: WaveOutcome }[];
  /** Whether the account itself has a subscription (ticket #117) that is not ended. */
  accountSubscription: boolean;
}

/** Subscriptions that outlive the deletion, as the operator's log and the preview name them. */
interface Orphans {
  waves: { waveId: string; subscriptionId: string; state: string }[];
  accounts: { accountId: string; subscriptionId: string; state: string }[];
}

async function findOrphans(db: Database, userId: string, plan: Plan): Promise<Orphans> {
  const ownedIds = plan.waves.filter((wave) => wave.role === "owner").map((wave) => wave.id);
  const billed = ownedIds.length
    ? await db
        .select({
          waveId: waveBilling.waveId,
          subscriptionId: waveBilling.subscriptionId,
          state: waveBilling.state,
        })
        .from(waveBilling)
        .where(and(inArray(waveBilling.waveId, ownedIds), ne(waveBilling.state, "ended")))
    : [];
  const accounts = await db
    .select({
      accountId: accountSubscriptions.accountId,
      subscriptionId: accountSubscriptions.subscriptionId,
      state: accountSubscriptions.state,
    })
    .from(accountSubscriptions)
    .innerJoin(customerAccounts, eq(customerAccounts.id, accountSubscriptions.accountId))
    .where(and(eq(customerAccounts.ownerUserId, userId), ne(accountSubscriptions.state, "ended")));
  return { waves: billed, accounts };
}

/** What the confirmation page names beforehand. Reads only. */
export async function describeDeletion(db: Database, userId: string): Promise<DeletionPreview> {
  const plan = await planDeletion(db, userId);
  const orphans = await findOrphans(db, userId, plan);

  const [devices] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(nodes)
    .where(eq(nodes.userId, userId));

  // Waves of the user's customer accounts are covered by an account
  // subscription: they are named as well, wherever they are going.
  const accountIds = orphans.accounts.map((a) => a.accountId);
  const covered = accountIds.length
    ? await db.select({ id: waves.id }).from(waves).where(inArray(waves.accountId, accountIds))
    : [];
  const billedIds = new Set([...orphans.waves.map((w) => w.waveId), ...covered.map((w) => w.id)]);
  const pick = (outcome: WaveOutcome) =>
    plan.waves.filter((wave) => wave.outcome === outcome).map(({ id, name }) => ({ id, name }));

  return {
    blockers: plan.blockers,
    deleted: pick("delete"),
    handedOver: pick("handover"),
    left: pick("leave"),
    devices: devices?.n ?? 0,
    billed: plan.waves
      .filter((wave) => billedIds.has(wave.id))
      .map(({ id, name, outcome }) => ({ id, name, outcome })),
    accountSubscription: orphans.accounts.length > 0,
  };
}

export interface DeletedAccount {
  /** The devices whose connections have to be cut, by wave. */
  nodes: { waveId: string; nodeId: string }[];
  /** Waves that stay and whose netmap lost devices: push them to the rest. */
  changedWaves: string[];
  /** Waves that went with the account. */
  deletedWaves: { id: string; name: string }[];
  /** Pier wildcards that went with a device, to take out of the zone after the commit. */
  piers: LeavingPier[];
  /** Subscriptions left running at the provider; for the operator's log, no personal data. */
  orphans: Orphans;
}

export type DeleteAccountResult =
  | ({ kind: "deleted" } & DeletedAccount)
  | { kind: "blocked"; waves: { id: string; name: string }[] }
  /** The user does not exist (any more): a second request of the same deletion. */
  | { kind: "gone" };

/**
 * Deletes the account in one transaction. The caller has checked who is
 * asking and confirmed it (route); what is done here is only the data.
 *
 * The user's row is locked first, then the billing rows and the waves of the
 * user in one order (billing before wave, as `deleteWave` and the sweep take
 * them), and the plan is made again under those locks: what the confirmation
 * page showed is a description, not an instruction.
 */
export async function deleteAccount(db: Database, userId: string): Promise<DeleteAccountResult> {
  // Read before the rows go: a pier's public addresses go with its device, and
  // with them the only record of what the wildcard pointed at.
  const mine = await db
    .select({ id: waveMembers.waveId })
    .from(waveMembers)
    .where(eq(waveMembers.userId, userId));
  const owned = await db.select({ id: waves.id }).from(waves).where(eq(waves.ownerUserId, userId));
  const piers: LeavingPier[] = [];
  for (const waveId of new Set([...mine, ...owned].map((row) => row.id))) {
    // `userId` also covers a wave that is deleted whole: it only has this user's devices.
    const pier = await pierLeaving(db, { waveId, leaving: { userId } });
    if (pier) piers.push(pier);
  }

  return db.transaction(async (tx) => {
    const t = tx as unknown as Database;
    const [user] = await t
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .for("update");
    if (!user) return { kind: "gone" } as const;

    const candidates = await t
      .select({ id: waves.id })
      .from(waves)
      .leftJoin(waveMembers, and(eq(waveMembers.waveId, waves.id), eq(waveMembers.userId, userId)))
      .where(or(eq(waveMembers.userId, userId), eq(waves.ownerUserId, userId)))
      .orderBy(asc(waves.id));
    const ids = [...new Set(candidates.map((row) => row.id))];
    if (ids.length > 0) {
      await t
        .select({ waveId: waveBilling.waveId })
        .from(waveBilling)
        .where(inArray(waveBilling.waveId, ids))
        .orderBy(asc(waveBilling.waveId))
        .for("update");
      await t
        .select({ id: waves.id })
        .from(waves)
        .where(inArray(waves.id, ids))
        .orderBy(asc(waves.id))
        .for("update");
    }

    const plan = await planDeletion(t, userId);
    if (plan.blockers.length > 0) return { kind: "blocked", waves: plan.blockers } as const;
    const orphans = await findOrphans(t, userId, plan);

    const devices = await t
      .select({ id: nodes.id, waveId: nodes.waveId })
      .from(nodes)
      .where(eq(nodes.userId, userId));
    const deviceCount = new Map<string, number>();
    for (const device of devices) deviceCount.set(device.waveId, (deviceCount.get(device.waveId) ?? 0) + 1);

    // Past entries that name the person go anonymous. The reference would be
    // nulled by the delete anyway; the words (an address) would stay.
    await t.update(auditLog).set({ actor: DELETED_ACTOR }).where(eq(auditLog.actorUserId, userId));
    const named = user.email ? [userId, user.email] : [userId];
    await t.update(auditLog).set({ target: DELETED_ACTOR }).where(inArray(auditLog.target, named));
    // What the address left behind outside of the account.
    if (user.email) {
      await t.delete(waveInvites).where(eq(waveInvites.email, user.email));
      await t.delete(signupVerifications).where(eq(signupVerifications.email, user.email));
      await t.delete(passwordResets).where(eq(passwordResets.email, user.email.toLowerCase()));
    }

    const deletedWaves: { id: string; name: string }[] = [];
    const changedWaves: string[] = [];
    for (const wave of plan.waves) {
      if (wave.outcome === "delete") {
        const gone = await deleteWave(t, wave.id);
        if (gone) deletedWaves.push({ id: wave.id, name: gone.name });
        continue;
      }
      if (wave.outcome === "handover" && wave.newOwnerId) {
        await t.update(waves).set({ ownerUserId: wave.newOwnerId }).where(eq(waves.id, wave.id));
        await t
          .update(waveMembers)
          .set({ role: "owner" })
          .where(and(eq(waveMembers.waveId, wave.id), eq(waveMembers.userId, wave.newOwnerId)));
      }
      const removed = deviceCount.get(wave.id) ?? 0;
      // The devices go with the user below; the version tells the others' next push.
      await t
        .update(waves)
        .set({ netmapVersion: sql`${waves.netmapVersion} + 1` })
        .where(eq(waves.id, wave.id));
      changedWaves.push(wave.id);
      // Role and number of devices only: no address, name or user id.
      await t.insert(auditLog).values({
        id: newId("aud"),
        waveId: wave.id,
        actorUserId: null,
        actor: DELETED_ACTOR,
        action: "account.delete",
        target: null,
        detail: { role: wave.role, removedDevices: removed },
      });
    }

    // No wave may be left that the user owns: the delete below would take it.
    const left = await t.select({ id: waves.id }).from(waves).where(eq(waves.ownerUserId, userId)).limit(1);
    if (left.length > 0) throw new Error(`account deletion: wave ${left[0]?.id} is still owned by the user`);

    // Devices are cascaded as well, but listed first so their connections can be cut.
    await t.delete(nodes).where(eq(nodes.userId, userId));
    // Sessions, challenges, recovery codes, identities, password setups, links, auth keys,
    // memberships, customer accounts (and their subscriptions) go by cascade.
    await t.delete(users).where(eq(users.id, userId));

    return {
      kind: "deleted",
      nodes: devices.map((device) => ({ waveId: device.waveId, nodeId: device.id })),
      changedWaves,
      deletedWaves,
      piers,
      orphans,
    } as const;
  });
}

/** One line per subscription that is left running; wave and subscription ids only, no person. */
export function orphanLogLines(orphans: Orphans): string[] {
  return [
    ...orphans.waves.map(
      (o) =>
        `account-delete: subscription ${o.subscriptionId} (${o.state}) of wave ${o.waveId} has no customer any more; cancel it at the payment provider`,
    ),
    ...orphans.accounts.map(
      (o) =>
        `account-delete: account subscription ${o.subscriptionId} (${o.state}) of customer account ${o.accountId} has no customer any more; cancel it at the payment provider`,
    ),
  ];
}
