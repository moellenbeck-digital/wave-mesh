import { and, asc, eq, or, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { nodes, users, waves } from "../db/schema.ts";

/** A device as an operator on the shell wants to see it. */
export interface DeviceRow {
  id: string;
  hostname: string;
  os: string;
  ipv4: string;
  /** Who brought it in. The browser API leaves this out on purpose. */
  email: string | null;
  userId: string;
  lastSeenAt: Date | null;
  /** Whether this device may ask for the wave's wildcard (D7). */
  wildcardAllowed: boolean;
  /** What it is to the wave's policy (M7). */
  tags: string[];
  /** What it last said about enforcing the policy's ports. */
  filterEnforced: boolean | null;
  filterReason: string | null;
  /** The build it last said it runs, and its update channel (D13). */
  clientVersion: string | null;
  updateChannel: string | null;
}

export async function listNodes(db: Database, waveId: string): Promise<DeviceRow[]> {
  return db
    .select({
      id: nodes.id,
      hostname: nodes.hostname,
      os: nodes.os,
      ipv4: nodes.ipv4,
      email: users.email,
      userId: nodes.userId,
      lastSeenAt: nodes.lastSeenAt,
      wildcardAllowed: nodes.wildcardAllowed,
      tags: nodes.tags,
      filterEnforced: nodes.filterEnforced,
      filterReason: nodes.filterReason,
      clientVersion: nodes.clientVersion,
      updateChannel: nodes.updateChannel,
    })
    .from(nodes)
    .innerJoin(users, eq(users.id, nodes.userId))
    .where(eq(nodes.waveId, waveId))
    .orderBy(asc(nodes.hostname));
}

/** The device an operator names, by hostname or by id. */
export async function findNode(
  db: Database,
  waveId: string,
  selector: string,
): Promise<{ id: string; hostname: string } | null> {
  const rows = await db
    .select({ id: nodes.id, hostname: nodes.hostname })
    .from(nodes)
    .where(and(eq(nodes.waveId, waveId), or(eq(nodes.hostname, selector), eq(nodes.id, selector))))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Lets one device ask for `*.<suffix>`, or takes that back.
 *
 * A grant per device rather than per wave, because the key of a wildcard is
 * held by whoever asked for it: naming the machine is naming who can be every
 * name in the wave. The wave is in the condition for the same reason as
 * everywhere else -- an id from another wave is not this one's to change.
 */
export async function setWildcardAllowed(
  db: Database,
  waveId: string,
  nodeId: string,
  allowed: boolean,
): Promise<{ hostname: string } | null> {
  const updated = await db
    .update(nodes)
    .set({ wildcardAllowed: allowed })
    .where(and(eq(nodes.waveId, waveId), eq(nodes.id, nodeId)))
    .returning({ hostname: nodes.hostname });
  return updated[0] ?? null;
}

export interface RemovedNode {
  id: string;
  hostname: string;
  userId: string;
}

/**
 * Takes one device out of a wave -- the other half of `wave logout`, which
 * only the device itself can run. A machine that was lost, sold or left behind
 * somewhere is exactly the one nobody can run it on any more, so removing it
 * has to work from the server as well.
 *
 * The wave is part of the condition, not just the id: an id from another wave
 * must not be removable by this wave's administrators, and a stale form must
 * not reach across.
 *
 * Bumping the netmap version is what makes the removal visible; the caller
 * pushes afterwards and cuts the device's own control connection.
 */
export async function removeNode(db: Database, waveId: string, nodeId: string): Promise<RemovedNode | null> {
  const removed = await db
    .delete(nodes)
    .where(and(eq(nodes.waveId, waveId), eq(nodes.id, nodeId)))
    .returning({ id: nodes.id, hostname: nodes.hostname, userId: nodes.userId });

  const node = removed[0];
  if (!node) return null;

  await db
    .update(waves)
    .set({ netmapVersion: sql`${waves.netmapVersion} + 1` })
    .where(eq(waves.id, waveId));
  return node;
}
