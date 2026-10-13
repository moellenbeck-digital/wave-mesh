import { createHmac } from "node:crypto";
import { and, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { hashPassword } from "../auth/password.ts";
import type { Database } from "../db/client.ts";
import {
  identities,
  nodes,
  passwordSetups,
  users,
  waveAuthKeys,
  waveInvites,
  waveMembers,
  waves,
} from "../db/schema.ts";
import { newId } from "../ids.ts";

/** As long as an invitation: long enough for a mailbox, short enough to go stale. */
export const SETUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const hashToken = (token: string): string => new Bun.CryptoHasher("sha256").update(token).digest("hex");

/**
 * A link's token, derived from its row and the server's billing secret.
 *
 * Derived rather than random so it can be given out again: the database keeps
 * only the hash, and a webhook that Stripe delivers twice must mail the link
 * the first delivery issued, not a second one that withdraws it. Knowing the
 * row id does not help anyone -- without the secret there is no token.
 */
const tokenFor = (secret: string, setupId: string): string =>
  createHmac("sha256", secret).update(`password-setup:${setupId}`).digest("base64url");

export const setupUrl = (baseUrl: string, token: string): string =>
  `${baseUrl.replace(/\/+$/, "")}/account/setup/${token}`;

export interface OwnerAccess {
  email: string;
  hasPassword: boolean;
  /** Null when the account already has a way in and needs no link. */
  url: string | null;
}

/**
 * A way into a freshly paid-for wave for its owner.
 *
 * Only for an account that has no way in yet: no password and no provider
 * login. An account that has one signs in as always, and a link that set a
 * new password on it would be a way to take it over for whoever got the link.
 *
 * The same `key` (the site sends the checkout session) gets the same link
 * back while it is unused and fresh. Anything else replaces the earlier link:
 * two live links for one account means the one meant to be withdrawn still
 * works. Issued under a lock on the account, so two calls at once cannot both
 * decide there is no link yet and leave two.
 */
export async function ownerAccess(
  db: Database,
  userId: string,
  options: { baseUrl: string; secret: string; key?: string | undefined; now?: Date },
): Promise<OwnerAccess | null> {
  const now = options.now ?? new Date();
  return db.transaction(async (tx) => {
    const t = tx as unknown as Database;
    const rows = await t
      .select({ email: users.email, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .for("update");
    const user = rows[0];
    if (!user?.email) return null;

    const hasPassword = user.passwordHash !== null;
    if (hasPassword || (await hasAnyIdentity(t, userId)))
      return { email: user.email, hasPassword, url: null };

    if (options.key) {
      const same = await t
        .select({ id: passwordSetups.id, tokenHash: passwordSetups.tokenHash })
        .from(passwordSetups)
        .where(
          and(
            eq(passwordSetups.userId, userId),
            eq(passwordSetups.key, options.key),
            isNull(passwordSetups.usedAt),
            isNull(passwordSetups.revokedAt),
            gt(passwordSetups.expiresAt, now),
          ),
        )
        .limit(1);
      // Derived again only if it still is the token that was stored: after
      // the billing secret changed, the same derivation yields a token that
      // matches nothing, and mailing it would send a link that says "gone".
      // Then a fresh link is the right answer, the same as for a new key.
      const derived = same[0] ? tokenFor(options.secret, same[0].id) : null;
      if (derived && hashToken(derived) === same[0]?.tokenHash) {
        return { email: user.email, hasPassword, url: setupUrl(options.baseUrl, derived) };
      }
    }

    await t
      .update(passwordSetups)
      .set({ revokedAt: now })
      .where(
        and(
          eq(passwordSetups.userId, userId),
          isNull(passwordSetups.usedAt),
          isNull(passwordSetups.revokedAt),
        ),
      );
    const id = newId("ps");
    const token = tokenFor(options.secret, id);
    await t.insert(passwordSetups).values({
      id,
      userId,
      tokenHash: hashToken(token),
      key: options.key ?? null,
      expiresAt: new Date(now.getTime() + SETUP_TTL_MS),
    });
    return { email: user.email, hasPassword, url: setupUrl(options.baseUrl, token) };
  });
}

/** The account a setup link is for, or null if it is used, withdrawn or stale. */
export async function loadSetup(
  db: Database,
  token: string,
): Promise<{ id: string; userId: string; email: string } | null> {
  if (!token) return null;
  const rows = await db
    .select({ id: passwordSetups.id, userId: passwordSetups.userId, email: users.email })
    .from(passwordSetups)
    .innerJoin(users, eq(users.id, passwordSetups.userId))
    .where(
      and(
        eq(passwordSetups.tokenHash, hashToken(token)),
        isNull(passwordSetups.usedAt),
        isNull(passwordSetups.revokedAt),
        gt(passwordSetups.expiresAt, new Date()),
      ),
    )
    .limit(1);
  const found = rows[0];
  return found?.email ? { id: found.id, userId: found.userId, email: found.email } : null;
}

export type Redeemed =
  | { kind: "redeemed"; userId: string }
  /** Used, withdrawn, expired or never issued. */
  | { kind: "gone" }
  /**
   * The account found a way in after the link was sent -- a password from the
   * operator, a provider login -- or another verified account holds the
   * address. The link is spent either way; it must not set a password now.
   */
  | { kind: "has-access" };

/**
 * Spends a setup link: sets the password and marks the address verified.
 *
 * Verified because the link went to that address and came back -- the proof
 * Stripe never gave. All in one transaction: the link is locked, the account
 * written only while it still has no password and no login, and the link
 * spent last, so a failure on the way leaves it usable instead of burnt.
 */
export async function redeemSetup(db: Database, token: string, password: string): Promise<Redeemed> {
  const setup = await loadSetup(db, token);
  if (!setup) return { kind: "gone" };
  const passwordHash = await hashPassword(password);

  return db.transaction(async (tx) => {
    const t = tx as unknown as Database;
    // The account first, then its link: the order ownerAccess() takes them
    // in. The other way round, a redeem and a new link for the same account
    // at the same moment each held what the other waited for.
    await t.select({ id: users.id }).from(users).where(eq(users.id, setup.userId)).for("update");
    const locked = await t
      .select({ id: passwordSetups.id })
      .from(passwordSetups)
      .where(
        and(
          eq(passwordSetups.id, setup.id),
          isNull(passwordSetups.usedAt),
          isNull(passwordSetups.revokedAt),
          gt(passwordSetups.expiresAt, new Date()),
        ),
      )
      .limit(1)
      .for("update");
    if (!locked[0]) return { kind: "gone" } as const;

    // Another verified account holds the address: its owner signed in with a
    // provider before the payment made this placeholder (the two raced, or
    // the login came first). The link came back from that very mailbox, so
    // it is the same person -- the paid wave moves to the account they
    // already use, and the placeholder goes. No password is set and nobody
    // is signed in here: that account may have a second factor, and a link
    // must not be a way around it.
    const other = await t
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.email, setup.email), eq(users.emailVerified, true), ne(users.id, setup.userId)))
      .limit(1);
    const verified = other[0];
    if (verified) {
      await t.update(passwordSetups).set({ usedAt: new Date() }).where(eq(passwordSetups.id, setup.id));
      if (await isPlaceholder(t, setup.userId)) await moveTo(t, setup.userId, verified.id);
      return { kind: "has-access" } as const;
    }

    const written = await t
      .update(users)
      .set({ passwordHash, emailVerified: true })
      .where(
        and(
          eq(users.id, setup.userId),
          isNull(users.passwordHash),
          sql`not exists (select 1 from ${identities} where ${identities.userId} = ${users.id})`,
        ),
      )
      .returning({ id: users.id });

    await t.update(passwordSetups).set({ usedAt: new Date() }).where(eq(passwordSetups.id, setup.id));
    if (written.length === 0) return { kind: "has-access" } as const;

    await t
      .insert(identities)
      .values({
        id: newId("i"),
        userId: setup.userId,
        provider: "password",
        subject: setup.email,
        email: setup.email,
      })
      .onConflictDoNothing();
    return { kind: "redeemed", userId: setup.userId } as const;
  });
}

/** Still the account a payment made: unverified, no password, no login. */
async function isPlaceholder(db: Database, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.emailVerified, false), isNull(users.passwordHash)))
    .limit(1);
  return rows.length > 0 && !(await hasAnyIdentity(db, userId));
}

/**
 * Hands everything a placeholder owns to the account that holds its address,
 * then drops the placeholder. A placeholder only ever owns paid waves and is
 * their only member until its owner arrives, but the moves are written for
 * any membership: where the account is in the wave already, it keeps its own
 * row and takes the higher role.
 */
async function moveTo(db: Database, fromUserId: string, toUserId: string): Promise<void> {
  await db.update(waves).set({ ownerUserId: toUserId }).where(eq(waves.ownerUserId, fromUserId));
  const moving = await db
    .select({ waveId: waveMembers.waveId, role: waveMembers.role })
    .from(waveMembers)
    .where(eq(waveMembers.userId, fromUserId));
  for (const member of moving) {
    const already = await db
      .select({ role: waveMembers.role })
      .from(waveMembers)
      .where(and(eq(waveMembers.waveId, member.waveId), eq(waveMembers.userId, toUserId)))
      .limit(1);
    if (already[0]) {
      if (member.role === "owner" && already[0].role !== "owner") {
        await db
          .update(waveMembers)
          .set({ role: "owner" })
          .where(and(eq(waveMembers.waveId, member.waveId), eq(waveMembers.userId, toUserId)));
      }
    } else {
      await db
        .update(waveMembers)
        .set({ userId: toUserId })
        .where(and(eq(waveMembers.waveId, member.waveId), eq(waveMembers.userId, fromUserId)));
    }
  }
  // Whatever else hangs off the account by a cascading key goes along: an
  // operator may have enrolled a device into the paid wave with a pre-auth
  // key in the owner's name before the owner ever signed in.
  await db.update(nodes).set({ userId: toUserId }).where(eq(nodes.userId, fromUserId));
  await db.update(waveAuthKeys).set({ userId: toUserId }).where(eq(waveAuthKeys.userId, fromUserId));
  await db
    .update(waveInvites)
    .set({ invitedByUserId: toUserId })
    .where(eq(waveInvites.invitedByUserId, fromUserId));
  await db.delete(users).where(eq(users.id, fromUserId));
}

/** Whether an account can sign in some other way than a password. */
export async function hasAnyIdentity(db: Database, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: identities.id })
    .from(identities)
    .where(eq(identities.userId, userId))
    .limit(1);
  return rows.length > 0;
}
