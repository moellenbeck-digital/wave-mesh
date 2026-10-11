import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { nodes, users, waveBilling, waveMembers, waves } from "../db/schema.ts";

export type Role = "owner" | "admin" | "member";

/** Who may invite, remove and hand out roles. Members may only look. */
export const canManage = (role: Role): boolean => role === "owner" || role === "admin";

export interface Member {
  userId: string;
  email: string | null;
  name: string | null;
  role: Role;
  /** Devices this user has in this wave -- what a removal would take with it. */
  nodeCount: number;
  joinedAt: Date;
}

/** This user's role in this wave, or null if they are not in it. */
export async function roleOf(db: Database, waveId: string, userId: string): Promise<Role | null> {
  const rows = await db
    .select({ role: waveMembers.role })
    .from(waveMembers)
    .where(and(eq(waveMembers.waveId, waveId), eq(waveMembers.userId, userId)))
    .limit(1);
  return rows[0]?.role ?? null;
}

/** Every wave this user belongs to, oldest first, so the order is stable. */
/**
 * The waves an account is in. `billing` is null for a wave nobody pays for
 * (every self-hosted one); for a booked wave it says whether the mesh runs, so
 * a page can tell its owner why the devices see nobody.
 */
export async function wavesOf(
  db: Database,
  userId: string,
): Promise<
  {
    id: string;
    name: string;
    dnsSuffix: string;
    role: Role;
    billing: { state: "active" | "suspended" | "ended" } | null;
  }[]
> {
  const rows = await db
    .select({
      id: waves.id,
      name: waves.name,
      dnsSuffix: waves.dnsSuffix,
      role: waveMembers.role,
      billingState: waveBilling.state,
    })
    .from(waveMembers)
    .innerJoin(waves, eq(waves.id, waveMembers.waveId))
    .leftJoin(waveBilling, eq(waveBilling.waveId, waves.id))
    .where(eq(waveMembers.userId, userId))
    .orderBy(asc(waveMembers.createdAt), asc(waves.name));
  return rows.map(({ billingState, ...wave }) => ({
    ...wave,
    billing: billingState ? { state: billingState } : null,
  }));
}

export async function listMembers(db: Database, waveId: string): Promise<Member[]> {
  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      name: users.name,
      role: waveMembers.role,
      joinedAt: waveMembers.createdAt,
      nodeCount: sql<number>`(
        select count(*) from ${nodes}
        where ${nodes.waveId} = ${waveMembers.waveId} and ${nodes.userId} = ${waveMembers.userId}
      )`.mapWith(Number),
    })
    .from(waveMembers)
    .innerJoin(users, eq(users.id, waveMembers.userId))
    .where(eq(waveMembers.waveId, waveId))
    .orderBy(asc(waveMembers.createdAt));
  return rows;
}

/**
 * Puts a user in a wave. Re-adding someone only changes their role, so this is
 * safe to run twice; the owner's row is never touched, because ownership is not
 * a role that gets handed around by this path.
 */
export async function addMember(
  db: Database,
  waveId: string,
  userId: string,
  role: "admin" | "member",
): Promise<{ added: boolean; role: Role }> {
  const current = await roleOf(db, waveId, userId);
  if (current === "owner") return { added: false, role: "owner" };
  if (current === role) return { added: false, role };
  if (current) {
    await db
      .update(waveMembers)
      .set({ role })
      .where(and(eq(waveMembers.waveId, waveId), eq(waveMembers.userId, userId)));
    return { added: false, role };
  }
  await db.insert(waveMembers).values({ waveId, userId, role });
  return { added: true, role };
}

export type RemovalRefusal = "not-a-member" | "owner" | "forbidden";

export interface Removal {
  /** Devices that went with the membership. */
  removedNodes: number;
}

/**
 * Takes a user out of a wave and their devices with them.
 *
 * Leaving the nodes behind would mean a former member keeps a signed netmap, an
 * address and a peer entry on everyone else's WireGuard interface -- revoking
 * the membership has to revoke the access, or it revokes nothing. The netmap
 * version is bumped so the remaining nodes notice on their next push.
 */
export async function removeMember(
  db: Database,
  waveId: string,
  actorRole: Role,
  userId: string,
): Promise<Removal | RemovalRefusal> {
  const target = await roleOf(db, waveId, userId);
  if (!target) return "not-a-member";
  // The owner's account is what the wave hangs off; letting it be removed would
  // leave a wave nobody can administer. Transferring ownership is its own step.
  if (target === "owner") return "owner";
  // An admin keeps the wave running; only the owner decides about other admins.
  if (actorRole !== "owner" && target !== "member") return "forbidden";

  const removed = await db
    .delete(nodes)
    .where(and(eq(nodes.waveId, waveId), eq(nodes.userId, userId)))
    .returning({ id: nodes.id });
  await db.delete(waveMembers).where(and(eq(waveMembers.waveId, waveId), eq(waveMembers.userId, userId)));
  await db
    .update(waves)
    .set({ netmapVersion: sql`${waves.netmapVersion} + 1` })
    .where(eq(waves.id, waveId));

  return { removedNodes: removed.length };
}
