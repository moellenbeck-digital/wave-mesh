import { asc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { identities, users } from "../db/schema.ts";
import { newId } from "../ids.ts";

/**
 * Local accounts: an email address and a password, for deployments that do not
 * want to depend on an external identity provider.
 *
 * Passwords are hashed with Argon2id. There is no self-service signup -- an
 * account is created by the operator with `bun src/admin.ts set-password`,
 * which keeps a publicly reachable server from being a place where anyone can
 * make themselves a user.
 */

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export const hashPassword = (password: string): Promise<string> =>
  Bun.password.hash(password, { algorithm: "argon2id" });

/**
 * A real hash of a random secret, verified against when no account exists, so
 * that answering costs the same either way and cannot be used to find out
 * which addresses are registered.
 */
let decoyHash: Promise<string> | undefined;
const decoy = (): Promise<string> => {
  decoyHash ??= hashPassword(crypto.randomUUID());
  return decoyHash;
};

export async function verifyLogin(
  db: Database,
  email: string,
  password: string,
): Promise<{ userId: string } | null> {
  // The account with a password first: an address can belong to more than
  // one row (a provider login that was never linked), and picking one that
  // has none would refuse the right password.
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.email, normalizeEmail(email)))
    .orderBy(sql`${users.passwordHash} is null`, asc(users.createdAt))
    .limit(1);
  const user = rows[0];

  const ok = await Bun.password.verify(password, user?.passwordHash ?? (await decoy())).catch(() => false);
  if (!ok || !user?.passwordHash) return null;
  return { userId: user.id };
}

/** Creates the account if needed and sets its password. */
export async function setPassword(
  db: Database,
  email: string,
  password: string,
): Promise<{ userId: string; created: boolean }> {
  const normalized = normalizeEmail(email);
  const hash = await hashPassword(password);

  const existing = await db.select().from(users).where(eq(users.email, normalized)).limit(1);
  const found = existing[0];
  if (found) {
    await db.update(users).set({ passwordHash: hash }).where(eq(users.id, found.id));
    return { userId: found.id, created: false };
  }

  const userId = newId("u");
  await db.insert(users).values({
    id: userId,
    email: normalized,
    // The operator vouches for the address by creating the account, which is
    // what lets a later provider login attach to the same user.
    emailVerified: true,
    passwordHash: hash,
  });
  await db.insert(identities).values({
    id: newId("i"),
    userId,
    provider: "password",
    subject: normalized,
    email: normalized,
  });
  return { userId, created: true };
}

/**
 * Throttles guessing. Counts per address and per source, in this process only:
 * a multi-instance deployment needs a shared store, as does surviving a restart.
 */
export class LoginThrottle {
  private readonly attempts = new Map<string, { count: number; until: number }>();

  constructor(
    private readonly limit = 10,
    private readonly windowMs = 15 * 60 * 1000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private key(email: string, source: string): string {
    return `${normalizeEmail(email)}|${source}`;
  }

  blocked(email: string, source: string): boolean {
    const entry = this.attempts.get(this.key(email, source));
    if (!entry) return false;
    if (entry.until <= this.now()) {
      this.attempts.delete(this.key(email, source));
      return false;
    }
    return entry.count >= this.limit;
  }

  fail(email: string, source: string): void {
    const key = this.key(email, source);
    const entry = this.attempts.get(key);
    if (!entry || entry.until <= this.now()) {
      this.attempts.set(key, { count: 1, until: this.now() + this.windowMs });
      return;
    }
    entry.count++;
  }

  succeed(email: string, source: string): void {
    this.attempts.delete(this.key(email, source));
  }
}
