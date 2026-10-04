import { and, count, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { loginChallenges, totpRecoveryCodes, users } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { base32Encode, newTotpSecret, otpauthUri, verifyTotp } from "./totp.ts";

/**
 * The second factor of the password login: a code from an authenticator app,
 * or one of ten recovery codes for the day the phone is gone.
 *
 * Only the password login asks for it. Google and an OIDC provider such as
 * Pocket ID bring their own second factor, and asking twice would only teach
 * people to type codes without reading where.
 */

const RECOVERY_CODES = 10;
/** How long a password stays good for while the code is being found. */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** Guesses per challenge; the throttle in the route limits them per account as well. */
export const CHALLENGE_ATTEMPTS = 5;
/** What the app shows as the account's issuer. */
const ISSUER = "wave-mesh";

const sha256 = (value: string): string => new Bun.CryptoHasher("sha256").update(value).digest("hex");

/** "abcde-fghij": 50 bits, lower case, grouped so it can be read off a sheet of paper. */
function newRecoveryCode(): string {
  const raw = base32Encode(crypto.getRandomValues(new Uint8Array(7)))
    .slice(0, 10)
    .toLowerCase();
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/** How a typed recovery code is compared: case, spaces and the dash do not matter. */
const normaliseRecovery = (code: string): string => code.toLowerCase().replace(/[\s-]/g, "");

export interface TwoFactorStatus {
  /** 2FA only exists for the password login; without a password there is nothing to protect. */
  available: boolean;
  enabled: boolean;
  enabledAt: string | null;
  recoveryCodesLeft: number;
}

export async function twoFactorStatus(db: Database, userId: string): Promise<TwoFactorStatus> {
  const [user] = await db
    .select({ passwordHash: users.passwordHash, enabledAt: users.totpEnabledAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const [left] = await db
    .select({ n: count() })
    .from(totpRecoveryCodes)
    .where(and(eq(totpRecoveryCodes.userId, userId), isNull(totpRecoveryCodes.usedAt)));
  return {
    available: Boolean(user?.passwordHash),
    enabled: Boolean(user?.enabledAt),
    enabledAt: user?.enabledAt?.toISOString() ?? null,
    recoveryCodesLeft: user?.enabledAt ? (left?.n ?? 0) : 0,
  };
}

/**
 * Starts setting it up: a fresh secret, kept aside until a code from it is
 * confirmed. Nothing changes for the login yet -- a QR code that was never
 * scanned must not lock anyone out.
 */
export async function beginSetup(
  db: Database,
  userId: string,
  account: string,
): Promise<{ secret: string; uri: string } | null> {
  const secret = newTotpSecret();
  const updated = await db
    .update(users)
    .set({ totpPendingSecret: secret })
    .where(and(eq(users.id, userId), isNull(users.totpEnabledAt)))
    .returning({ id: users.id });
  if (updated.length === 0) return null;
  return { secret, uri: otpauthUri(secret, account, ISSUER) };
}

/**
 * Turns it on once the app has proven it holds the secret, and hands out the
 * recovery codes -- the only time they are ever shown.
 */
export async function confirmSetup(
  db: Database,
  userId: string,
  code: string,
  nowMs: number = Date.now(),
): Promise<string[] | null> {
  const [user] = await db
    .select({ pending: users.totpPendingSecret, enabledAt: users.totpEnabledAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user?.pending || user.enabledAt) return null;
  const step = verifyTotp(user.pending, code, nowMs);
  if (step === null) return null;

  return db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({
        totpSecret: user.pending,
        totpPendingSecret: null,
        totpEnabledAt: new Date(nowMs),
        totpLastStep: step,
      })
      .where(eq(users.id, userId));
    return replaceRecoveryCodes(tx as unknown as Database, userId);
  });
}

async function replaceRecoveryCodes(db: Database, userId: string): Promise<string[]> {
  await db.delete(totpRecoveryCodes).where(eq(totpRecoveryCodes.userId, userId));
  const codes = Array.from({ length: RECOVERY_CODES }, newRecoveryCode);
  await db
    .insert(totpRecoveryCodes)
    .values(codes.map((code) => ({ id: newId("rc"), userId, codeHash: sha256(normaliseRecovery(code)) })));
  return codes;
}

/**
 * Checks a second factor and uses it up: an app code moves the account's last
 * step forward, a recovery code is marked used. Both in one statement, so two
 * requests racing with the same code cannot both get through.
 */
export async function verifySecondFactor(
  db: Database,
  userId: string,
  code: string,
  nowMs: number = Date.now(),
): Promise<"totp" | "recovery" | null> {
  const [user] = await db
    .select({ secret: users.totpSecret, lastStep: users.totpLastStep })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user?.secret) return null;

  const step = verifyTotp(user.secret, code, nowMs, user.lastStep);
  if (step !== null) {
    const moved = await db
      .update(users)
      .set({ totpLastStep: step })
      .where(and(eq(users.id, userId), or(isNull(users.totpLastStep), lt(users.totpLastStep, step))))
      .returning({ id: users.id });
    return moved.length > 0 ? "totp" : null;
  }

  const typed = normaliseRecovery(code);
  if (!/^[a-z2-7]{10}$/.test(typed)) return null;
  const used = await db
    .update(totpRecoveryCodes)
    .set({ usedAt: new Date(nowMs) })
    .where(
      and(
        eq(totpRecoveryCodes.userId, userId),
        eq(totpRecoveryCodes.codeHash, sha256(typed)),
        isNull(totpRecoveryCodes.usedAt),
      ),
    )
    .returning({ id: totpRecoveryCodes.id });
  return used.length > 0 ? "recovery" : null;
}

/** New recovery codes, against a valid second factor -- the old ones stop working. */
export async function regenerateRecoveryCodes(
  db: Database,
  userId: string,
  code: string,
  nowMs: number = Date.now(),
): Promise<string[] | null> {
  if (!(await verifySecondFactor(db, userId, code, nowMs))) return null;
  return replaceRecoveryCodes(db, userId);
}

/**
 * Turns it off. With a code when the person does it, without one when the
 * operator does it from the shell (`wave-admin disable-2fa`) -- the case of
 * the lost phone, where there is no code to give.
 */
export async function disableTwoFactor(
  db: Database,
  userId: string,
  proof: { code: string; nowMs?: number } | "operator",
): Promise<boolean> {
  if (proof !== "operator" && !(await verifySecondFactor(db, userId, proof.code, proof.nowMs))) return false;
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ totpSecret: null, totpPendingSecret: null, totpEnabledAt: null, totpLastStep: null })
      .where(eq(users.id, userId));
    await tx.delete(totpRecoveryCodes).where(eq(totpRecoveryCodes.userId, userId));
    await tx.delete(loginChallenges).where(eq(loginChallenges.userId, userId));
  });
  return true;
}

export async function hasTwoFactor(db: Database, userId: string): Promise<boolean> {
  const [user] = await db
    .select({ at: users.totpEnabledAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return Boolean(user?.at);
}

/** Opens the second step of a login. The token goes into a cookie; only its hash is stored. */
export async function createChallenge(
  db: Database,
  userId: string,
  next: string | null,
  nowMs: number = Date.now(),
): Promise<{ token: string; expiresAt: Date }> {
  // Expired ones go on the way in: nothing else ever looks at them again.
  await db.delete(loginChallenges).where(lt(loginChallenges.expiresAt, new Date(nowMs)));
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const expiresAt = new Date(nowMs + CHALLENGE_TTL_MS);
  await db.insert(loginChallenges).values({ id: sha256(token), userId, next, expiresAt });
  return { token, expiresAt };
}

export async function readChallenge(
  db: Database,
  token: string,
  nowMs: number = Date.now(),
): Promise<{ userId: string; next: string | null; attempts: number } | null> {
  const [row] = await db
    .select()
    .from(loginChallenges)
    .where(eq(loginChallenges.id, sha256(token)))
    .limit(1);
  if (!row || row.expiresAt.getTime() <= nowMs || row.attempts >= CHALLENGE_ATTEMPTS) return null;
  return { userId: row.userId, next: row.next, attempts: row.attempts };
}

/** Counts a wrong code; past the limit the challenge is gone and the password has to be typed again. */
export async function failChallenge(db: Database, token: string): Promise<void> {
  await db
    .update(loginChallenges)
    .set({ attempts: sql`${loginChallenges.attempts} + 1` })
    .where(eq(loginChallenges.id, sha256(token)));
}

export async function endChallenge(db: Database, token: string): Promise<void> {
  await db.delete(loginChallenges).where(eq(loginChallenges.id, sha256(token)));
}
