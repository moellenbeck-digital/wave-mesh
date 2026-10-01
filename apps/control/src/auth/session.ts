import { and, eq, gt } from "drizzle-orm";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Database } from "../db/client.ts";
import { sessions, users } from "../db/schema.ts";
import type { Config } from "../env.ts";

export const SESSION_COOKIE = "wave_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Sessions are stored hashed, so a database leak does not hand out logins. */
const hashToken = (token: string): string => new Bun.CryptoHasher("sha256").update(token).digest("hex");

export async function createSession(
  db: Database,
  userId: string,
  meta: { userAgent?: string | null; ip?: string | null } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({
    id: hashToken(token),
    userId,
    expiresAt,
    userAgent: meta.userAgent ?? null,
    ip: meta.ip ?? null,
  });
  return { token, expiresAt };
}

export type SessionUser = typeof users.$inferSelect;

export async function lookupSession(db: Database, token: string): Promise<SessionUser | null> {
  const rows = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, hashToken(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return rows[0]?.user ?? null;
}

export async function destroySession(db: Database, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, hashToken(token)));
}

export function setSessionCookie(c: Context, config: Config, token: string, expiresAt: Date): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.secureCookies,
    // Lax, not Strict: the OAuth callback is a cross-site redirect and would
    // otherwise arrive without the cookie we just set.
    sameSite: "Lax",
    path: "/",
    expires: expiresAt,
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}
export const readSessionCookie = (c: Context): string | undefined => getCookie(c, SESSION_COOKIE);
