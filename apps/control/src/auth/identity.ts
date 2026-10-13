import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { identities, users } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { lockAddress } from "./address-lock.ts";

export interface ProviderClaims {
  provider: string;
  /** The provider's stable subject. Never an email -- those get reassigned. */
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  avatarUrl: string | null;
}

export interface ResolvedUser {
  userId: string;
  isNewUser: boolean;
  /** True when this login attached a second provider to an existing account. */
  linkedExisting: boolean;
}

const normalizeEmail = (email: string | null): string | null => email?.trim().toLowerCase() || null;

/**
 * Maps provider claims onto a user, creating or linking as needed.
 *
 * The rule that matters: accounts are only ever merged on an email address the
 * provider states is verified. Merging on an unverified address lets anyone who
 * can sign up at a sloppy provider claim someone else's account.
 */
export async function resolveUser(db: Database, claims: ProviderClaims): Promise<ResolvedUser> {
  const email = normalizeEmail(claims.email);

  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ userId: identities.userId })
      .from(identities)
      .where(and(eq(identities.provider, claims.provider), eq(identities.subject, claims.subject)))
      .limit(1);

    const known = existing[0];
    if (known) {
      await tx
        .update(users)
        .set({ name: claims.name, avatarUrl: claims.avatarUrl })
        .where(eq(users.id, known.userId));
      return { userId: known.userId, isNewUser: false, linkedExisting: false };
    }

    if (email && claims.emailVerified) {
      // The same lock a payment takes before it makes the owner's placeholder:
      // decided one at a time, a first login and a checkout for this address
      // cannot both conclude that nobody holds it yet.
      await lockAddress(tx as unknown as Database, email);
      const match = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.email, email), eq(users.emailVerified, true)))
        .limit(1);

      const owner = match[0];
      if (owner) {
        await tx.insert(identities).values({
          id: newId("i"),
          userId: owner.id,
          provider: claims.provider,
          subject: claims.subject,
          email,
        });
        return { userId: owner.id, isNewUser: false, linkedExisting: true };
      }

      // An account made by a payment for this address and not yet claimed:
      // no password, no login of any kind, not verified (billing/
      // subscriptions.ts). The provider vouching for the address is the same
      // proof the setup link mailed there would have been, so this login *is*
      // the owner arriving -- by another door. Taking it over here, rather
      // than making a second account, keeps the paid wave with the person who
      // paid, and keeps one account per verified address.
      const placeholder = await tx
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.email, email),
            eq(users.emailVerified, false),
            isNull(users.passwordHash),
            sql`not exists (select 1 from ${identities} where ${identities.userId} = ${users.id})`,
          ),
        )
        .orderBy(asc(users.createdAt))
        .limit(1);
      const claimed = placeholder[0];
      if (claimed) {
        await tx
          .update(users)
          .set({ emailVerified: true, name: claims.name, avatarUrl: claims.avatarUrl })
          .where(eq(users.id, claimed.id));
        await tx.insert(identities).values({
          id: newId("i"),
          userId: claimed.id,
          provider: claims.provider,
          subject: claims.subject,
          email,
        });
        return { userId: claimed.id, isNewUser: false, linkedExisting: true };
      }
    }

    const userId = newId("u");
    await tx.insert(users).values({
      id: userId,
      email,
      emailVerified: claims.emailVerified && email !== null,
      name: claims.name,
      avatarUrl: claims.avatarUrl,
    });
    await tx.insert(identities).values({
      id: newId("i"),
      userId,
      provider: claims.provider,
      subject: claims.subject,
      email,
    });
    return { userId, isNewUser: true, linkedExisting: false };
  });
}
