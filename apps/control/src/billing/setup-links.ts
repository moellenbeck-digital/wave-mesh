import { and, eq, gt, isNull } from "drizzle-orm";
import { hashPassword } from "../auth/password.ts";
import type { Database } from "../db/client.ts";
import { identities, passwordSetups, users } from "../db/schema.ts";
import { newId } from "../ids.ts";

/** As long as an invitation: long enough for a mailbox, short enough to go stale. */
export const SETUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const hashToken = (token: string): string => new Bun.CryptoHasher("sha256").update(token).digest("hex");

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
 * The link replaces any earlier one -- two live links for one account means
 * the one that was meant to be withdrawn still works.
 */
export async function ownerAccess(
  db: Database,
  userId: string,
  baseUrl: string,
): Promise<OwnerAccess | null> {
  const rows = await db
    .select({ email: users.email, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const user = rows[0];
  if (!user?.email) return null;

  const hasPassword = user.passwordHash !== null;
  const identity = await db
    .select({ id: identities.id })
    .from(identities)
    .where(eq(identities.userId, userId))
    .limit(1);
  if (hasPassword || identity.length > 0) return { email: user.email, hasPassword, url: null };

  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  await db
    .update(passwordSetups)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(passwordSetups.userId, userId), isNull(passwordSetups.usedAt), isNull(passwordSetups.revokedAt)),
    );
  await db.insert(passwordSetups).values({
    id: newId("ps"),
    userId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + SETUP_TTL_MS),
  });
  return { email: user.email, hasPassword, url: setupUrl(baseUrl, token) };
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

/**
 * Spends a setup link: sets the password and marks the address verified.
 *
 * Verified because the link went to that address and came back -- the proof
 * Stripe never gave. The token is spent in a conditional update before
 * anything else is written, so two submissions of the same form cannot both
 * set a password.
 */
export async function redeemSetup(
  db: Database,
  token: string,
  password: string,
): Promise<{ userId: string } | null> {
  const setup = await loadSetup(db, token);
  if (!setup) return null;

  const spent = await db
    .update(passwordSetups)
    .set({ usedAt: new Date() })
    .where(
      and(eq(passwordSetups.id, setup.id), isNull(passwordSetups.usedAt), isNull(passwordSetups.revokedAt)),
    )
    .returning({ id: passwordSetups.id });
  if (spent.length === 0) return null;

  await db
    .update(users)
    .set({ passwordHash: await hashPassword(password), emailVerified: true })
    .where(eq(users.id, setup.userId));
  await db
    .insert(identities)
    .values({
      id: newId("i"),
      userId: setup.userId,
      provider: "password",
      subject: setup.email,
      email: setup.email,
    })
    .onConflictDoNothing();
  return { userId: setup.userId };
}
