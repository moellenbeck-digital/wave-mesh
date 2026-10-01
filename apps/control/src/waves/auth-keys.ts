import { createHash } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { waveAuthKeys } from "../db/schema.ts";
import { newId } from "../ids.ts";

/**
 * Enrolling without a browser (D11).
 *
 * Every device so far joined by having a human open a link. A connector in a
 * Kubernetes cluster has no human and no browser: it is deployed. A pre-auth
 * key is the same decision made in advance and written down -- for one wave,
 * with an expiry, and revocable.
 *
 * It is a bearer secret, so it is treated like one: 32 random bytes, shown
 * once, stored only as a SHA-256, and never long-lived by default.
 */

const DEFAULT_TTL_DAYS = 90;

export const hashKey = (token: string): string => createHash("sha256").update(token).digest("hex");

export interface CreatedAuthKey {
  id: string;
  /** The only time this exists in the clear. */
  token: string;
  expiresAt: Date;
}

export async function createAuthKey(
  db: Database,
  input: {
    waveId: string;
    userId: string;
    label?: string;
    reusable?: boolean;
    days?: number;
  },
): Promise<CreatedAuthKey> {
  // Prefixed so that a key found in a log or a manifest is recognisable as one
  // -- and so a scanner looking for leaked secrets has something to match.
  const token = `wavekey-${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
  const expiresAt = new Date(Date.now() + (input.days ?? DEFAULT_TTL_DAYS) * 24 * 60 * 60 * 1000);
  const id = newId("ak");

  await db.insert(waveAuthKeys).values({
    id,
    waveId: input.waveId,
    userId: input.userId,
    tokenHash: hashKey(token),
    label: input.label ?? null,
    reusable: input.reusable ?? false,
    expiresAt,
  });
  return { id, token, expiresAt };
}

export interface UsableAuthKey {
  id: string;
  waveId: string;
  userId: string;
}

/**
 * Claims one use of a key, or says why not.
 *
 * The count is raised in the same statement that checks it, so two devices
 * registering at once cannot both spend the last use of a single-use key.
 */
export async function claimAuthKey(db: Database, token: string): Promise<UsableAuthKey | null> {
  const rows = await db
    .select()
    .from(waveAuthKeys)
    .where(eq(waveAuthKeys.tokenHash, hashKey(token)))
    .limit(1);
  const key = rows[0];
  if (!key) return null;
  if (key.revokedAt || key.expiresAt.getTime() < Date.now()) return null;
  if (!key.reusable && key.uses > 0) return null;

  const claimed = await db
    .update(waveAuthKeys)
    .set({ uses: key.uses + 1 })
    .where(and(eq(waveAuthKeys.id, key.id), eq(waveAuthKeys.uses, key.uses), isNull(waveAuthKeys.revokedAt)))
    .returning({ id: waveAuthKeys.id });
  if (claimed.length === 0) return null;

  return { id: key.id, waveId: key.waveId, userId: key.userId };
}

export interface AuthKeyRow {
  id: string;
  label: string | null;
  reusable: boolean;
  uses: number;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

export async function listAuthKeys(db: Database, waveId: string): Promise<AuthKeyRow[]> {
  return db
    .select({
      id: waveAuthKeys.id,
      label: waveAuthKeys.label,
      reusable: waveAuthKeys.reusable,
      uses: waveAuthKeys.uses,
      createdAt: waveAuthKeys.createdAt,
      expiresAt: waveAuthKeys.expiresAt,
      revokedAt: waveAuthKeys.revokedAt,
    })
    .from(waveAuthKeys)
    .where(eq(waveAuthKeys.waveId, waveId))
    .orderBy(desc(waveAuthKeys.createdAt));
}

/**
 * Withdraws a key. Devices that already enrolled with it keep their place --
 * they have their own keys now, and removing them is `remove-device`.
 */
export async function revokeAuthKey(db: Database, waveId: string, id: string): Promise<boolean> {
  const revoked = await db
    .update(waveAuthKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(waveAuthKeys.waveId, waveId), eq(waveAuthKeys.id, id), isNull(waveAuthKeys.revokedAt)))
    .returning({ id: waveAuthKeys.id });
  return revoked.length > 0;
}
