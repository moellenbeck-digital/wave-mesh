import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { identities, users } from "../db/schema.ts";
import { newId } from "../ids.ts";

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
