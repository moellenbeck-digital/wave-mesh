import { and, asc, eq, gt, isNull } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { users, waveInvites, waves } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { addMember } from "./members.ts";

/** Long enough to reach someone by mail or chat, short enough to go stale. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const hashToken = (token: string): string => new Bun.CryptoHasher("sha256").update(token).digest("hex");

export const normaliseEmail = (email: string): string => email.trim().toLowerCase();

/** Deliberately loose: the provider decides what a real address is, not us. */
export const looksLikeEmail = (email: string): boolean => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);

type InviteRow = typeof waveInvites.$inferSelect;

export interface PendingInvite {
  id: string;
  waveId: string;
  waveName: string;
  email: string;
  role: "admin" | "member";
  invitedBy: string | null;
  expiresAt: Date;
}

const pending = (row: InviteRow, waveName: string, invitedBy: string | null): PendingInvite => ({
  id: row.id,
  waveId: row.waveId,
  waveName,
  email: row.email,
  role: row.role,
  invitedBy,
  expiresAt: row.expiresAt,
});

export interface CreatedInvite extends PendingInvite {
  /** Shown once, here and nowhere else: the database only keeps its hash. */
  url: string;
  token: string;
}

/** Where the invited person has to go. Same origin as everything else. */
export const inviteUrl = (baseUrl: string, token: string): string =>
  `${baseUrl.replace(/\/+$/, "")}/invite/${token}`;

export async function createInvite(
  db: Database,
  input: {
    waveId: string;
    waveName: string;
    email: string;
    role: "admin" | "member";
    invitedByUserId: string;
    baseUrl: string;
  },
): Promise<CreatedInvite> {
  const email = normaliseEmail(input.email);
  if (!looksLikeEmail(email)) throw new Error(`not an email address: ${input.email}`);

  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const id = newId("wi");
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  // An earlier invitation for the same address in the same wave is replaced
  // rather than added to: two live links for one seat means the revoked one
  // still works, which is the opposite of what revoking is for.
  await db
    .update(waveInvites)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(waveInvites.waveId, input.waveId),
        eq(waveInvites.email, email),
        isNull(waveInvites.acceptedAt),
        isNull(waveInvites.revokedAt),
      ),
    );

  const [row] = await db
    .insert(waveInvites)
    .values({
      id,
      waveId: input.waveId,
      email,
      role: input.role,
      tokenHash: hashToken(token),
      invitedByUserId: input.invitedByUserId,
      expiresAt,
    })
    .returning();
  if (!row) throw new Error("could not create the invitation");

  return {
    ...pending(row, input.waveName, null),
    token,
    url: inviteUrl(input.baseUrl, token),
  };
}

/** The invitation a link stands for, or null if it is spent, revoked or stale. */
export async function loadInvite(db: Database, token: string): Promise<PendingInvite | null> {
  if (!token) return null;
  const rows = await db
    .select({ invite: waveInvites, waveName: waves.name, invitedBy: users.email })
    .from(waveInvites)
    .innerJoin(waves, eq(waves.id, waveInvites.waveId))
    .innerJoin(users, eq(users.id, waveInvites.invitedByUserId))
    .where(
      and(
        eq(waveInvites.tokenHash, hashToken(token)),
        isNull(waveInvites.acceptedAt),
        isNull(waveInvites.revokedAt),
        gt(waveInvites.expiresAt, new Date()),
      ),
    )
    .limit(1);

  const found = rows[0];
  return found ? pending(found.invite, found.waveName, found.invitedBy) : null;
}

/** The invitations still waiting for an address, across all waves. */
export async function invitesFor(db: Database, email: string | null): Promise<PendingInvite[]> {
  if (!email) return [];
  const rows = await db
    .select({ invite: waveInvites, waveName: waves.name, invitedBy: users.email })
    .from(waveInvites)
    .innerJoin(waves, eq(waves.id, waveInvites.waveId))
    .innerJoin(users, eq(users.id, waveInvites.invitedByUserId))
    .where(
      and(
        eq(waveInvites.email, normaliseEmail(email)),
        isNull(waveInvites.acceptedAt),
        isNull(waveInvites.revokedAt),
        gt(waveInvites.expiresAt, new Date()),
      ),
    )
    .orderBy(asc(waveInvites.createdAt));
  return rows.map((row) => pending(row.invite, row.waveName, row.invitedBy));
}

/** What a wave's admins see: who has been asked and has not answered yet. */
export async function listInvites(db: Database, waveId: string): Promise<PendingInvite[]> {
  const rows = await db
    .select({ invite: waveInvites, waveName: waves.name, invitedBy: users.email })
    .from(waveInvites)
    .innerJoin(waves, eq(waves.id, waveInvites.waveId))
    .innerJoin(users, eq(users.id, waveInvites.invitedByUserId))
    .where(
      and(
        eq(waveInvites.waveId, waveId),
        isNull(waveInvites.acceptedAt),
        isNull(waveInvites.revokedAt),
        gt(waveInvites.expiresAt, new Date()),
      ),
    )
    .orderBy(asc(waveInvites.createdAt));
  return rows.map((row) => pending(row.invite, row.waveName, row.invitedBy));
}

export type AcceptRefusal = "gone" | "wrong-address" | "unverified-address";

/**
 * Redeems an invitation for a signed-in user.
 *
 * Two checks carry this: the address has to match, and it has to be one the
 * provider called verified. Without the second, anyone who can sign up at a
 * sloppy provider under someone else's address could take their seat -- the
 * same hole that makes account linking on unverified addresses unsafe.
 *
 * The write is conditional on the invitation still being open, so two clicks on
 * the same link cannot both succeed.
 */
export async function acceptInvite(
  db: Database,
  token: string,
  user: { id: string; email: string | null; emailVerified: boolean },
): Promise<{ waveId: string; waveName: string; role: "admin" | "member" } | AcceptRefusal> {
  const invite = await loadInvite(db, token);
  if (!invite) return "gone";
  if (!user.email || normaliseEmail(user.email) !== invite.email) return "wrong-address";
  if (!user.emailVerified) return "unverified-address";

  const claimed = await db
    .update(waveInvites)
    .set({ acceptedAt: new Date(), acceptedByUserId: user.id })
    .where(and(eq(waveInvites.id, invite.id), isNull(waveInvites.acceptedAt), isNull(waveInvites.revokedAt)))
    .returning({ id: waveInvites.id });
  if (!claimed[0]) return "gone";

  await addMember(db, invite.waveId, user.id, invite.role);
  return { waveId: invite.waveId, waveName: invite.waveName, role: invite.role };
}

/** Withdraws an invitation that has not been used. Idempotent. */
export async function revokeInvite(
  db: Database,
  waveId: string,
  selector: { id?: string; email?: string },
): Promise<boolean> {
  const target = selector.id
    ? eq(waveInvites.id, selector.id)
    : selector.email
      ? eq(waveInvites.email, normaliseEmail(selector.email))
      : null;
  if (!target) return false;

  const revoked = await db
    .update(waveInvites)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(waveInvites.waveId, waveId),
        target,
        isNull(waveInvites.acceptedAt),
        isNull(waveInvites.revokedAt),
      ),
    )
    .returning({ id: waveInvites.id });
  return revoked.length > 0;
}
