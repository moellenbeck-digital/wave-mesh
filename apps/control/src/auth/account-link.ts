import { and, asc, count, eq, gt, inArray, isNull, lt, ne } from "drizzle-orm";
import { moveAccounts } from "../billing/accounts.ts";
import type { Database } from "../db/client.ts";
import {
  accountLinks,
  aclPolicies,
  auditLog,
  identities,
  nodes,
  sessions,
  users,
  waveAuthKeys,
  waveBilling,
  waveInvites,
  waveMembers,
  waves,
} from "../db/schema.ts";
import { newId } from "../ids.ts";
import { lockAddress } from "./address-lock.ts";
import { normalizeEmail, type ProviderClaims } from "./identity.ts";
import { verifyPasswordOf } from "./password.ts";
import type { OAuthProvider } from "./providers.ts";
import { verifySecondFactor } from "./two-factor.ts";

/**
 * Joining the account a provider login split off (B) to the verified account
 * that holds its address (A), in three proofs and a confirmation.
 *
 * Why it exists: `resolveUser` links only on an address the provider vouches
 * for, so a provider that did not vouch at first login left B behind -- and a
 * known identity returns at once, so B stays separate after the address is
 * confirmed. Linking on that alone would be the takeover the rule exists to
 * prevent, so nothing here trusts one signal:
 *
 * 1. the provider vouches for the address *now*, in a login made for this
 *    request, and the identity it names is B's -- which also decides A;
 * 2. the person controls A, through one of A's own ways in, without that
 *    opening a session;
 * 3. the person has read what will move and sends the POST.
 *
 * Every step loads the request again and checks all bindings against the
 * database, never against what an earlier step looked at. The merge itself is
 * one transaction under the address lock.
 */

export const LINK_TTL_MS = 10 * 60 * 1000;
/** How long A's right password stays good for while its code is being found. */
const PASSWORD_STEP_MS = 5 * 60 * 1000;
export const LINK_CODE_ATTEMPTS = 5;
/** What counts as "just now" for a login's `auth_time`: the request's own age, give or take clocks. */
const FRESH_SKEW_SECONDS = 60;

const sha256 = (value: string): string => new Bun.CryptoHasher("sha256").update(value).digest("hex");

export type Link = typeof accountLinks.$inferSelect;
export type Role = "owner" | "admin" | "member";

/** Where the request stands, by what the row says is proven. */
export type LinkStage = "address" | "control" | "confirm";
export const stageOf = (link: Link): LinkStage =>
  !link.verifiedAt ? "address" : !link.controlAt ? "control" : "confirm";

const isOpen = (link: Link, now: Date): boolean =>
  link.usedAt === null && link.cancelledAt === null && link.expiresAt.getTime() > now.getTime();

const inTx = <T>(db: Database, run: (t: Database) => Promise<T>): Promise<T> =>
  db.transaction((tx) => run(tx as unknown as Database));

/**
 * Opens a request for B. One at a time: an earlier open request of the same
 * account is cancelled, so there is never a second token that could finish
 * what this one started.
 */
export async function startLink(
  db: Database,
  userId: string,
  authProvider: string,
  now: Date = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const expiresAt = new Date(now.getTime() + LINK_TTL_MS);
  await inTx(db, async (t) => {
    await t
      .update(accountLinks)
      .set({ cancelledAt: now })
      .where(
        and(eq(accountLinks.userId, userId), isNull(accountLinks.usedAt), isNull(accountLinks.cancelledAt)),
      );
    // Spent and stale rows of this account have nothing left to say.
    await t.delete(accountLinks).where(and(eq(accountLinks.userId, userId), lt(accountLinks.expiresAt, now)));
    await t.insert(accountLinks).values({
      id: newId("al"),
      userId,
      tokenHash: sha256(token),
      authProvider,
      expiresAt,
    });
  });
  return { token, expiresAt };
}

/** The open request this token belongs to *and* this account owns, or null. */
export async function openLink(
  db: Database,
  token: string | undefined,
  userId: string,
  now: Date = new Date(),
): Promise<Link | null> {
  if (!token) return null;
  const rows = await db
    .select()
    .from(accountLinks)
    .where(
      and(
        eq(accountLinks.tokenHash, sha256(token)),
        eq(accountLinks.userId, userId),
        isNull(accountLinks.usedAt),
        isNull(accountLinks.cancelledAt),
        gt(accountLinks.expiresAt, now),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function cancelLink(db: Database, linkId: string, now: Date = new Date()): Promise<void> {
  await db
    .update(accountLinks)
    .set({ cancelledAt: now })
    .where(and(eq(accountLinks.id, linkId), isNull(accountLinks.usedAt), isNull(accountLinks.cancelledAt)));
}

type Bound =
  | { kind: "ok"; link: Link }
  /** Used, cancelled, expired or never there. */
  | { kind: "gone" }
  /** Something it was bound to is no longer true: the request cannot go on. */
  | { kind: "changed" };

/**
 * Reads the request and everything it is bound to, afresh.
 *
 * The identity must still be B's, A must still be the one account that holds
 * the address verified, and A is not B. Called by every step after the first,
 * and again inside the merge's transaction -- a step is not allowed to lean on
 * what an earlier one saw.
 */
async function bindings(t: Database, linkId: string, now: Date, lock = false): Promise<Bound> {
  const query = t.select().from(accountLinks).where(eq(accountLinks.id, linkId)).limit(1);
  const link = (lock ? await query.for("update") : await query)[0];
  if (!link || !isOpen(link, now)) return { kind: "gone" };
  if (!link.verifiedAt || !link.targetUserId || !link.email || !link.provider || !link.subject) {
    return { kind: "changed" };
  }
  if (link.targetUserId === link.userId) return { kind: "changed" };

  const identity = await t
    .select({ userId: identities.userId })
    .from(identities)
    .where(and(eq(identities.provider, link.provider), eq(identities.subject, link.subject)))
    .limit(1);
  if (identity[0]?.userId !== link.userId) return { kind: "changed" };

  const holders = await t
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.email, link.email), eq(users.emailVerified, true)));
  if (holders.length !== 1 || holders[0]?.id !== link.targetUserId) return { kind: "changed" };
  return { kind: "ok", link };
}

export type AddressProof =
  | { kind: "ok" }
  | { kind: "gone" }
  /** The provider does not vouch for the address (or sends none). Nothing changes. */
  | { kind: "unverified" }
  /** The login named an identity that is not this account's. */
  | { kind: "foreign-identity" }
  /** The provider answered from an old session. */
  | { kind: "stale" }
  /** Nobody else holds the address verified. */
  | { kind: "no-target" }
  /** More than one account does; which one is meant cannot be told. */
  | { kind: "ambiguous" };

/**
 * Step one: the login made for this request. Only if the provider vouches for
 * the address, the identity is B's, and the login is fresh does the request
 * learn who A is -- from the address, not from anything the browser sent.
 */
export async function proveAddress(
  db: Database,
  linkId: string,
  claims: ProviderClaims,
  now: Date = new Date(),
): Promise<AddressProof> {
  const email = normalizeEmail(claims.email);
  if (!email || !claims.emailVerified) return { kind: "unverified" };

  return inTx(db, async (t) => {
    // The lock a first login takes before it decides who holds an address.
    await lockAddress(t, email);
    const rows = await t
      .select()
      .from(accountLinks)
      .where(eq(accountLinks.id, linkId))
      .limit(1)
      .for("update");
    const link = rows[0];
    if (!link || !isOpen(link, now)) return { kind: "gone" } as const;

    const identity = await t
      .select({ userId: identities.userId })
      .from(identities)
      .where(and(eq(identities.provider, claims.provider), eq(identities.subject, claims.subject)))
      .limit(1);
    if (identity[0]?.userId !== link.userId) return { kind: "foreign-identity" } as const;

    // With `max_age=0` the provider has to say when the person signed in. A
    // token that says nothing cannot be held to it; one that says "long ago"
    // is a session the provider answered from.
    if (
      claims.authTime !== undefined &&
      claims.authTime < link.createdAt.getTime() / 1000 - FRESH_SKEW_SECONDS
    ) {
      return { kind: "stale" } as const;
    }

    const holders = await t
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.email, email), eq(users.emailVerified, true), ne(users.id, link.userId)))
      .orderBy(asc(users.createdAt));
    const target = holders[0];
    if (!target) return { kind: "no-target" } as const;
    if (holders.length > 1) return { kind: "ambiguous" } as const;

    // A restart of the first step takes everything after it back.
    await t
      .update(accountLinks)
      .set({
        provider: claims.provider,
        subject: claims.subject,
        email,
        targetUserId: target.id,
        verifiedAt: now,
        passwordAt: null,
        codeAttempts: 0,
        controlAt: null,
        controlMethod: null,
      })
      .where(eq(accountLinks.id, link.id));
    return { kind: "ok" } as const;
  });
}

export interface ControlWays {
  /** A has a password. Whether it has a second factor is not said before the password is right. */
  password: boolean;
  /** A's own provider logins, other than the one being linked. */
  providers: { id: string; label: string }[];
}

/** Whether a stored identity belongs to this provider (`oidc:<issuer>` is the OIDC one's). */
const belongsTo = (identityProvider: string, providerId: string): boolean =>
  identityProvider === providerId || identityProvider.startsWith(`${providerId}:`);

/**
 * How A can be shown to be the person's: its password, or a provider login
 * that is not the one being linked. Empty means A has no way in the page can
 * offer, and nothing can proceed.
 */
export async function controlWays(
  db: Database,
  link: Link,
  providers: Map<string, OAuthProvider>,
): Promise<ControlWays> {
  if (!link.targetUserId) return { password: false, providers: [] };
  const [target] = await db
    .select({ hash: users.passwordHash })
    .from(users)
    .where(eq(users.id, link.targetUserId))
    .limit(1);
  const own = await db
    .select({ provider: identities.provider })
    .from(identities)
    .where(eq(identities.userId, link.targetUserId));
  const usable = [...providers.values()].filter(
    (p) => p.id !== link.authProvider && own.some((i) => belongsTo(i.provider, p.id)),
  );
  return {
    password: Boolean(target?.hash),
    providers: usable.map((p) => ({ id: p.id, label: p.label })),
  };
}

export type ControlProof =
  | { kind: "ok" }
  /** The password was right and A has a second factor: the code is next. */
  | { kind: "code" }
  | { kind: "wrong" }
  | { kind: "gone" }
  | { kind: "changed" }
  /** The password step lapsed or its guesses are spent: the password again. */
  | { kind: "password-needed" }
  /** The login is the one being linked, or not one of A's. */
  | { kind: "not-target" };

/** Step two with A's password. Creates no session; a right password with a second factor asks for the code. */
export async function proveControlWithPassword(
  db: Database,
  linkId: string,
  password: string,
  now: Date = new Date(),
): Promise<ControlProof> {
  const bound = await bindings(db, linkId, now);
  if (bound.kind !== "ok") return bound;
  const { link } = bound;
  const targetId = link.targetUserId as string;
  if (!(await verifyPasswordOf(db, targetId, password))) return { kind: "wrong" };

  const [second] = await db
    .select({ at: users.totpEnabledAt })
    .from(users)
    .where(eq(users.id, targetId))
    .limit(1);
  if (second?.at) {
    await db
      .update(accountLinks)
      .set({ passwordAt: now, codeAttempts: 0, controlAt: null, controlMethod: null })
      .where(eq(accountLinks.id, link.id));
    return { kind: "code" };
  }
  await db
    .update(accountLinks)
    .set({ controlAt: now, controlMethod: "password", passwordAt: null })
    .where(eq(accountLinks.id, link.id));
  return { kind: "ok" };
}

/** Step two, second half: A's code, only after its password and within five tries. */
export async function proveControlWithCode(
  db: Database,
  linkId: string,
  code: string,
  now: Date = new Date(),
): Promise<ControlProof> {
  const bound = await bindings(db, linkId, now);
  if (bound.kind !== "ok") return bound;
  const { link } = bound;
  if (
    !link.passwordAt ||
    now.getTime() - link.passwordAt.getTime() > PASSWORD_STEP_MS ||
    link.codeAttempts >= LINK_CODE_ATTEMPTS
  ) {
    await db.update(accountLinks).set({ passwordAt: null }).where(eq(accountLinks.id, link.id));
    return { kind: "password-needed" };
  }

  if (!(await verifySecondFactor(db, link.targetUserId as string, code, now.getTime()))) {
    await db
      .update(accountLinks)
      .set({
        codeAttempts: link.codeAttempts + 1,
        passwordAt: link.codeAttempts + 1 >= LINK_CODE_ATTEMPTS ? null : link.passwordAt,
      })
      .where(eq(accountLinks.id, link.id));
    return { kind: "wrong" };
  }
  await db
    .update(accountLinks)
    .set({ controlAt: now, controlMethod: "password+2fa", passwordAt: null, codeAttempts: 0 })
    .where(eq(accountLinks.id, link.id));
  return { kind: "ok" };
}

/**
 * Step two with another provider. The login only looks up the identity -- it
 * neither creates nor updates anything and opens no session -- and counts
 * only if A already owns it.
 */
export async function proveControlWithProvider(
  db: Database,
  linkId: string,
  providerId: string,
  claims: ProviderClaims,
  now: Date = new Date(),
): Promise<ControlProof> {
  const bound = await bindings(db, linkId, now);
  if (bound.kind !== "ok") return bound;
  const { link } = bound;
  if (providerId === link.authProvider || claims.provider === link.provider) return { kind: "not-target" };

  const identity = await db
    .select({ userId: identities.userId })
    .from(identities)
    .where(and(eq(identities.provider, claims.provider), eq(identities.subject, claims.subject)))
    .limit(1);
  if (identity[0]?.userId !== link.targetUserId) return { kind: "not-target" };

  await db
    .update(accountLinks)
    .set({ controlAt: now, controlMethod: claims.provider, passwordAt: null })
    .where(eq(accountLinks.id, link.id));
  return { kind: "ok" };
}

type Billing = "active" | "suspended" | "ended" | null;

export interface MergeSummary {
  from: { email: string | null; name: string | null; hasPassword: boolean };
  into: { email: string | null; name: string | null };
  /** B's logins that become A's. */
  identities: string[];
  /** Waves B owns: they go to A, billing and subscription stay on the wave. */
  ownedWaves: { id: string; name: string; billing: Billing; targetWasMember: boolean }[];
  /** B's other memberships. `keeps-target-role`: A is in the wave already, its role stays and B's row goes. */
  memberships: {
    waveId: string;
    name: string;
    role: Role;
    targetRole: Role | null;
    outcome: "moves" | "keeps-target-role";
  }[];
  /** B's devices: they stay connected, names and addresses unchanged. */
  devices: { id: string; hostname: string; waveName: string; ipv4: string }[];
  /** B's signed-in sessions, all ended by the merge. */
  sessions: number;
}

/** What the confirmation page names beforehand, and what the merge then does. */
export async function describeMerge(db: Database, link: Link, now: Date = new Date()): Promise<MergeSummary> {
  const userId = link.userId;
  const targetId = link.targetUserId as string;
  const [from] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const [into] = await db.select().from(users).where(eq(users.id, targetId)).limit(1);

  const moving = await db
    .select({ provider: identities.provider })
    .from(identities)
    .where(eq(identities.userId, userId))
    .orderBy(asc(identities.createdAt));

  const owned = await db
    .select({ id: waves.id, name: waves.name, billing: waveBilling.state })
    .from(waves)
    .leftJoin(waveBilling, eq(waveBilling.waveId, waves.id))
    .where(eq(waves.ownerUserId, userId))
    .orderBy(asc(waves.name));
  const ownedIds = new Set(owned.map((w) => w.id));

  const mine = await db
    .select({ waveId: waveMembers.waveId, name: waves.name, role: waveMembers.role })
    .from(waveMembers)
    .innerJoin(waves, eq(waves.id, waveMembers.waveId))
    .where(eq(waveMembers.userId, userId))
    .orderBy(asc(waves.name));
  const theirs = await db
    .select({ waveId: waveMembers.waveId, role: waveMembers.role })
    .from(waveMembers)
    .where(eq(waveMembers.userId, targetId));
  const targetRole = new Map(theirs.map((m) => [m.waveId, m.role]));

  const devices = await db
    .select({ id: nodes.id, hostname: nodes.hostname, waveName: waves.name, ipv4: nodes.ipv4 })
    .from(nodes)
    .innerJoin(waves, eq(waves.id, nodes.waveId))
    .where(eq(nodes.userId, userId))
    .orderBy(asc(waves.name), asc(nodes.hostname));

  const [open] = await db
    .select({ n: count() })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, now)));

  return {
    from: {
      email: from?.email ?? null,
      name: from?.name ?? null,
      hasPassword: Boolean(from?.passwordHash),
    },
    into: { email: into?.email ?? null, name: into?.name ?? null },
    identities: moving.map((i) => i.provider),
    ownedWaves: owned.map((w) => ({
      id: w.id,
      name: w.name,
      billing: w.billing ?? null,
      targetWasMember: targetRole.has(w.id),
    })),
    memberships: mine
      .filter((m) => !ownedIds.has(m.waveId))
      .map((m) => ({
        waveId: m.waveId,
        name: m.name,
        role: m.role,
        targetRole: targetRole.get(m.waveId) ?? null,
        outcome: targetRole.has(m.waveId) ? ("keeps-target-role" as const) : ("moves" as const),
      })),
    devices,
    sessions: open?.n ?? 0,
  };
}

export type MergeResult =
  | { kind: "merged"; userId: string; summary: MergeSummary; waveIds: string[]; email: string }
  | { kind: "gone" }
  | { kind: "changed" }
  /** The second proof is missing: the confirmation is not reachable before it. */
  | { kind: "not-controlled" };

/**
 * Step three, after the POST: moves everything from B to A and deletes B.
 *
 * One transaction under the address lock, with the request, A and B locked in
 * that order and every precondition read again inside it -- the summary the
 * person saw is a description, not an instruction. B's row goes at the end,
 * which ends all of B's sessions and takes the request with it (it is spent
 * either way: its token finds nothing afterwards).
 */
export async function mergeAccounts(
  db: Database,
  linkId: string,
  userId: string,
  now: Date = new Date(),
): Promise<MergeResult> {
  const peek = await db.select().from(accountLinks).where(eq(accountLinks.id, linkId)).limit(1);
  const email = peek[0]?.email;
  if (!peek[0] || peek[0].userId !== userId) return { kind: "gone" };
  if (!email) return { kind: "changed" };

  return inTx(db, async (t) => {
    await lockAddress(t, email);
    const bound = await bindings(t, linkId, now, true);
    if (bound.kind !== "ok") return bound;
    const { link } = bound;
    if (link.userId !== userId || link.email !== email) return { kind: "changed" } as const;
    if (!link.controlAt) return { kind: "not-controlled" } as const;

    const targetId = link.targetUserId as string;
    // Both accounts, in one order, so two merges touching the same pair cannot wait for each other.
    await t
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, [userId, targetId]))
      .orderBy(asc(users.id))
      .for("update");

    const summary = await describeMerge(t, link, now);
    const ownedIds = summary.ownedWaves.map((w) => w.id);
    const waveIds = new Set<string>(ownedIds);

    await t.update(identities).set({ userId: targetId }).where(eq(identities.userId, userId));

    // A wave B owns goes to A, and its owner has to hold the owner's role:
    // where A was a member already, that is the one place A's role changes.
    if (ownedIds.length > 0) {
      await t.update(waves).set({ ownerUserId: targetId }).where(eq(waves.ownerUserId, userId));
      await t
        .update(waveMembers)
        .set({ role: "owner" })
        .where(and(eq(waveMembers.userId, targetId), inArray(waveMembers.waveId, ownedIds)));
    }
    // B's customer accounts (billing units, not users) go to A as well, or
    // deleting B below would take them along; their waves stay where they are.
    await moveAccounts(t, userId, targetId);
    const mine = await t.select().from(waveMembers).where(eq(waveMembers.userId, userId));
    for (const member of mine) {
      waveIds.add(member.waveId);
      const already = await t
        .select({ role: waveMembers.role })
        .from(waveMembers)
        .where(and(eq(waveMembers.waveId, member.waveId), eq(waveMembers.userId, targetId)))
        .limit(1);
      const rowOfB = and(eq(waveMembers.waveId, member.waveId), eq(waveMembers.userId, userId));
      if (already[0]) await t.delete(waveMembers).where(rowOfB);
      else await t.update(waveMembers).set({ userId: targetId }).where(rowOfB);
    }

    for (const device of summary.devices) {
      const [row] = await t
        .select({ waveId: nodes.waveId })
        .from(nodes)
        .where(eq(nodes.id, device.id))
        .limit(1);
      if (row) waveIds.add(row.waveId);
    }
    await t.update(nodes).set({ userId: targetId }).where(eq(nodes.userId, userId));
    // What would otherwise vanish with B, or lose its author, stays with A.
    await t.update(waveAuthKeys).set({ userId: targetId }).where(eq(waveAuthKeys.userId, userId));
    await t
      .update(waveInvites)
      .set({ invitedByUserId: targetId })
      .where(eq(waveInvites.invitedByUserId, userId));
    await t
      .update(waveInvites)
      .set({ acceptedByUserId: targetId })
      .where(eq(waveInvites.acceptedByUserId, userId));
    await t
      .update(aclPolicies)
      .set({ updatedByUserId: targetId })
      .where(eq(aclPolicies.updatedByUserId, userId));
    await t.update(auditLog).set({ actorUserId: targetId }).where(eq(auditLog.actorUserId, userId));

    await t.delete(sessions).where(eq(sessions.userId, userId));
    await t.delete(users).where(eq(users.id, userId));
    return { kind: "merged", userId: targetId, summary, waveIds: [...waveIds], email } as const;
  });
}
