import { and, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { identities, signupVerifications, users } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { lockAddress } from "./address-lock.ts";
import { hashPassword } from "./password.ts";

/**
 * Registration with an email address and a password (ticket #150).
 *
 * The one rule: no account without a confirmed address. The registration is
 * therefore not a row in `users` -- an account that exists can sign in -- but a
 * `signup_verifications` row holding the address and the password hash. The
 * account is made when the link of the mail comes back, as a verified one, and
 * not before. Until then there is no login and no wave.
 */

/** As long as a day: a mailbox is read within one, and a stale link is one more way in. */
export const SIGNUP_TTL_MS = 24 * 60 * 60 * 1000;
export const MIN_PASSWORD_LENGTH = 12;
/** The longest address SMTP allows. */
const MAX_EMAIL_LENGTH = 254;
/** Argon2 and the request body both stop being cheap well before this. */
export const MAX_PASSWORD_LENGTH = 1024;

const hashToken = (token: string): string => new Bun.CryptoHasher("sha256").update(token).digest("hex");
const newToken = (): string => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

/** Deliberately plain: the mail itself is the validation. It only has to be one address and safe in a header. */
export const isEmailAddress = (email: string): boolean =>
  email.length <= MAX_EMAIL_LENGTH &&
  /^[^@\s,;<>"()[\]\\]+@[^@\s,;<>"()[\]\\]+\.[^@\s,;<>"()[\]\\]+$/.test(email);

export const confirmUrl = (baseUrl: string, token: string): string =>
  `${baseUrl.replace(/\/+$/, "")}/signup/confirm?token=${encodeURIComponent(token)}`;

export type Registration =
  /** A new (or renewed) registration: mail this token to the address. */
  | { kind: "pending"; token: string }
  /** The address already belongs to an account: mail "you already have one", change nothing. */
  | { kind: "known" };

/**
 * Whether an address belongs to somebody: any account that can sign in some
 * way or whose address is verified. What is not "taken" is free or a placeholder
 * a payment made (no password, no login, unverified), which the confirmation
 * claims, as a first provider login does (auth/identity.ts).
 */
async function ownerOf(
  db: Database,
  email: string,
): Promise<{ kind: "free" } | { kind: "taken" } | { kind: "placeholder"; userId: string }> {
  const accounts = await db
    .select({ id: users.id, verified: users.emailVerified, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.email, email));
  if (accounts.length === 0) return { kind: "free" };
  const withLogin = new Set(
    (
      await db
        .select({ userId: identities.userId })
        .from(identities)
        .where(
          inArray(
            identities.userId,
            accounts.map((account) => account.id),
          ),
        )
    ).map((row) => row.userId),
  );
  const rows = accounts.map((account) => ({
    id: account.id,
    verified: account.verified,
    hasPassword: account.passwordHash !== null,
    hasIdentity: withLogin.has(account.id),
  }));
  if (rows.length === 0) return { kind: "free" };
  const placeholder = rows.find((row) => !row.verified && !row.hasPassword && !row.hasIdentity);
  if (placeholder && rows.length === 1) return { kind: "placeholder", userId: placeholder.id };
  return { kind: "taken" };
}

/**
 * Takes a registration. Always hashes the password -- also when the address is
 * taken -- so the time spent says nothing about the address.
 *
 * An earlier unconfirmed registration of the address is revoked, its link
 * with it: one live link per address, and never a second account.
 */
export async function register(
  db: Database,
  input: { email: string; password: string; now?: Date },
): Promise<Registration> {
  const now = input.now ?? new Date();
  const passwordHash = await hashPassword(input.password);

  return db.transaction(async (tx) => {
    const t = tx as unknown as Database;
    await lockAddress(t, input.email);

    // Spent and expired rows have no use left; the table stays as small as the open registrations.
    await t
      .delete(signupVerifications)
      .where(
        or(
          lt(signupVerifications.expiresAt, new Date(now.getTime() - SIGNUP_TTL_MS)),
          sql`${signupVerifications.usedAt} is not null and ${signupVerifications.usedAt} < ${new Date(now.getTime() - SIGNUP_TTL_MS)}`,
        ),
      );

    if ((await ownerOf(t, input.email)).kind === "taken") return { kind: "known" } as const;

    await t
      .update(signupVerifications)
      .set({ revokedAt: now })
      .where(
        and(
          eq(signupVerifications.email, input.email),
          isNull(signupVerifications.usedAt),
          isNull(signupVerifications.revokedAt),
        ),
      );
    const token = newToken();
    await t.insert(signupVerifications).values({
      id: newId("sv"),
      email: input.email,
      passwordHash,
      tokenHash: hashToken(token),
      expiresAt: new Date(now.getTime() + SIGNUP_TTL_MS),
    });
    return { kind: "pending", token } as const;
  });
}

/** Whether a link is still good, without spending it: what the confirmation page asks before it shows its button. */
export async function isLive(db: Database, token: string, now = new Date()): Promise<boolean> {
  if (!token) return false;
  const rows = await db
    .select({ id: signupVerifications.id })
    .from(signupVerifications)
    .where(
      and(
        eq(signupVerifications.tokenHash, hashToken(token)),
        isNull(signupVerifications.usedAt),
        isNull(signupVerifications.revokedAt),
        gt(signupVerifications.expiresAt, now),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export type Confirmation =
  | { kind: "confirmed"; userId: string }
  /** Used, withdrawn, expired or never issued -- or the address got an account in the meantime. */
  | { kind: "gone" };

/**
 * Spends a link: makes the account, verified, with the password that was
 * chosen. One transaction under the lock of the address: the link is spent
 * together with the account or not at all, and a second use finds it spent.
 *
 * An address that has an account by now (a provider login came first) spends
 * the link and makes nothing: no merge, and the password chosen here does not
 * become a way into somebody else's account.
 */
export async function confirm(db: Database, token: string, now = new Date()): Promise<Confirmation> {
  if (!token) return { kind: "gone" };
  const found = await db
    .select({ email: signupVerifications.email })
    .from(signupVerifications)
    .where(eq(signupVerifications.tokenHash, hashToken(token)))
    .limit(1);
  const email = found[0]?.email;
  if (!email) return { kind: "gone" };

  return db.transaction(async (tx) => {
    const t = tx as unknown as Database;
    await lockAddress(t, email);
    const rows = await t
      .select()
      .from(signupVerifications)
      .where(
        and(
          eq(signupVerifications.tokenHash, hashToken(token)),
          isNull(signupVerifications.usedAt),
          isNull(signupVerifications.revokedAt),
          gt(signupVerifications.expiresAt, now),
        ),
      )
      .limit(1)
      .for("update");
    const row = rows[0];
    if (!row) return { kind: "gone" } as const;

    await t.update(signupVerifications).set({ usedAt: now }).where(eq(signupVerifications.id, row.id));

    const owner = await ownerOf(t, row.email);
    if (owner.kind === "taken") return { kind: "gone" } as const;

    let userId: string;
    if (owner.kind === "placeholder") {
      // A payment made this account and nobody has claimed it; the mailbox is
      // the proof the setup link would have been.
      userId = owner.userId;
      await t
        .update(users)
        .set({ emailVerified: true, passwordHash: row.passwordHash })
        .where(eq(users.id, userId));
    } else {
      userId = newId("u");
      await t.insert(users).values({
        id: userId,
        email: row.email,
        emailVerified: true,
        passwordHash: row.passwordHash,
      });
    }
    await t.insert(identities).values({
      id: newId("i"),
      userId,
      provider: "password",
      subject: row.email,
      email: row.email,
    });
    return { kind: "confirmed", userId } as const;
  });
}
