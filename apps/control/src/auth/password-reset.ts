import { and, asc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { identities, loginChallenges, passwordResets, sessions, users } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { lockAddress } from "./address-lock.ts";
import { hashPassword } from "./password.ts";

/**
 * "Forgot password" (ticket #159): a one-time link, mailed to the address of an
 * account that has a password, that sets a new one.
 *
 * Three rules shape this file. The link is a secret that only the mailbox
 * receives, so only its SHA-256 is stored and it is good once and for an hour.
 * What a request does is never visible to the person who makes it -- the route
 * answers the same either way -- so everything that differs (which mail, if
 * any) is returned here for the route to do in the background. And a spent link
 * ends every session of the account but opens none: the second factor stays.
 */

/** Short: a mailbox is read within minutes, and a stale link is one more way in. */
export const RESET_TTL_MS = 60 * 60 * 1000;

const hashToken = (token: string): string => new Bun.CryptoHasher("sha256").update(token).digest("hex");
const newToken = (): string => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

export const resetUrl = (baseUrl: string, token: string): string =>
  `${baseUrl.replace(/\/+$/, "")}/password/reset?token=${encodeURIComponent(token)}`;

export type ResetRequest =
  /** The address has a password account: mail this token to it. */
  | { kind: "pending"; token: string }
  /** The address has an account, but only a provider login: mail a hint without a link. */
  | { kind: "no-password" }
  /** Nobody, or only a placeholder a payment made: no mail at all. */
  | { kind: "unknown" };

/**
 * Takes a request for an address.
 *
 * The account that gets the link is the one `verifyLogin` would sign in: the
 * oldest with a password. An earlier open link of the address is revoked, so
 * there is one live link per address. Both outcomes without a link run the same
 * statements (the revoke, a token that is made and dropped), so the work done
 * does not tell the kinds apart.
 */
export async function requestReset(
  db: Database,
  input: { email: string; now?: Date },
): Promise<ResetRequest> {
  const now = input.now ?? new Date();
  const token = newToken();

  return db.transaction(async (tx) => {
    const t = tx as unknown as Database;
    await lockAddress(t, input.email);

    // Spent and expired rows have no use left; the table stays as small as the open links.
    const stale = new Date(now.getTime() - RESET_TTL_MS);
    await t
      .delete(passwordResets)
      .where(
        or(
          lt(passwordResets.expiresAt, stale),
          sql`${passwordResets.usedAt} is not null and ${passwordResets.usedAt} < ${stale}`,
        ),
      );

    const accounts = await t
      .select({ id: users.id, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.email, input.email))
      .orderBy(sql`${users.passwordHash} is null`, asc(users.createdAt));
    const account = accounts.find((row) => row.passwordHash !== null);

    await t
      .update(passwordResets)
      .set({ revokedAt: now })
      .where(
        and(
          eq(passwordResets.email, input.email),
          isNull(passwordResets.usedAt),
          isNull(passwordResets.revokedAt),
        ),
      );

    if (account) {
      await t.insert(passwordResets).values({
        id: newId("pr"),
        userId: account.id,
        email: input.email,
        tokenHash: hashToken(token),
        expiresAt: new Date(now.getTime() + RESET_TTL_MS),
      });
      return { kind: "pending", token } as const;
    }

    // An account with a provider login and no password gets told, without a
    // link: a password set on it by mail would be a second way in nobody asked for.
    const withLogin = accounts.length
      ? await t
          .select({ id: identities.id })
          .from(identities)
          .where(or(...accounts.map((row) => eq(identities.userId, row.id))) ?? sql`false`)
          .limit(1)
      : [];
    return withLogin.length > 0 ? ({ kind: "no-password" } as const) : ({ kind: "unknown" } as const);
  });
}

/** Whether a link is still good, without spending it: what the page asks before it shows its form. */
export async function isLive(db: Database, token: string, now = new Date()): Promise<boolean> {
  if (!token) return false;
  const rows = await db
    .select({ id: passwordResets.id })
    .from(passwordResets)
    .where(
      and(
        eq(passwordResets.tokenHash, hashToken(token)),
        isNull(passwordResets.usedAt),
        isNull(passwordResets.revokedAt),
        gt(passwordResets.expiresAt, now),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export type Redemption =
  | { kind: "changed"; userId: string }
  /** Used, withdrawn, expired or never issued -- or the account lost its password meanwhile. */
  | { kind: "gone" };

/**
 * Spends a link: replaces the password hash, ends every session of the account
 * (and a half-finished login, whose password was the old one), and revokes the
 * account's other open links. One transaction under the lock of the address: the
 * link is spent together with the change or not at all, and a second use finds
 * it spent. Signs nobody in.
 */
export async function redeemReset(
  db: Database,
  token: string,
  password: string,
  now = new Date(),
): Promise<Redemption> {
  if (!token) return { kind: "gone" };
  const found = await db
    .select({ email: passwordResets.email })
    .from(passwordResets)
    .where(eq(passwordResets.tokenHash, hashToken(token)))
    .limit(1);
  const email = found[0]?.email;
  if (!email) return { kind: "gone" };

  // Before the transaction: Argon2 is slow and holds no lock that way.
  const passwordHash = await hashPassword(password);

  return db.transaction(async (tx) => {
    const t = tx as unknown as Database;
    await lockAddress(t, email);
    const rows = await t
      .select()
      .from(passwordResets)
      .where(
        and(
          eq(passwordResets.tokenHash, hashToken(token)),
          isNull(passwordResets.usedAt),
          isNull(passwordResets.revokedAt),
          gt(passwordResets.expiresAt, now),
        ),
      )
      .limit(1)
      .for("update");
    const row = rows[0];
    if (!row) return { kind: "gone" } as const;

    await t.update(passwordResets).set({ usedAt: now }).where(eq(passwordResets.id, row.id));

    const owner = await t
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, row.userId))
      .limit(1)
      .for("update");
    // An account that has no password any more (the operator took it away) is
    // not one a link may give one back to.
    if (!owner[0] || owner[0].passwordHash === null) return { kind: "gone" } as const;

    await t.update(users).set({ passwordHash }).where(eq(users.id, row.userId));
    await t.delete(sessions).where(eq(sessions.userId, row.userId));
    await t.delete(loginChallenges).where(eq(loginChallenges.userId, row.userId));
    await t
      .update(passwordResets)
      .set({ revokedAt: now })
      .where(
        and(
          eq(passwordResets.userId, row.userId),
          isNull(passwordResets.usedAt),
          isNull(passwordResets.revokedAt),
        ),
      );
    return { kind: "changed", userId: row.userId } as const;
  });
}
