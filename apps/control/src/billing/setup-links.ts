import { createHmac } from "node:crypto";
import { and, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { hashPassword } from "../auth/password.ts";
import type { Database } from "../db/client.ts";
import { identities, passwordSetups, users } from "../db/schema.ts";
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
        .select({ id: passwordSetups.id })
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
      if (same[0]) {
        return {
          email: user.email,
          hasPassword,
          url: setupUrl(options.baseUrl, tokenFor(options.secret, same[0].id)),
        };
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

    // A second verified account with the same address would make two accounts
    // the password login could pick between. The one that is there first is
    // the one its owner already signs in with.
    const other = await t
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.email, setup.email), eq(users.emailVerified, true), ne(users.id, setup.userId)))
      .limit(1);

    const written =
      other.length > 0
        ? []
        : await t
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

/** Whether an account can sign in some other way than a password. */
export async function hasAnyIdentity(db: Database, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: identities.id })
    .from(identities)
    .where(eq(identities.userId, userId))
    .limit(1);
  return rows.length > 0;
}
