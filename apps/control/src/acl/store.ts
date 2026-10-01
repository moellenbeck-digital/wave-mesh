import { type AclPolicy, TAG_PATTERN } from "@wave/proto";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { aclPolicies, nodes, users, waveMembers, waveServices, waves } from "../db/schema.ts";
import type { Enforcement } from "./describe.ts";
import { type AclNode, type AclService, type CompiledPolicy, compilePolicy } from "./evaluate.ts";

export interface StoredPolicy {
  document: AclPolicy;
  version: number;
  updatedAt: Date;
}

export async function getPolicy(db: Database, waveId: string): Promise<StoredPolicy | null> {
  const rows = await db
    .select({
      document: aclPolicies.document,
      version: aclPolicies.version,
      updatedAt: aclPolicies.updatedAt,
    })
    .from(aclPolicies)
    .where(eq(aclPolicies.waveId, waveId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Every change to who may see whom moves the netmap: a device that lost a peer
 * has to lose it on the wire, not only in this table.
 */
async function bumpNetmap(db: Database, waveId: string): Promise<void> {
  await db
    .update(waves)
    .set({ netmapVersion: sql`${waves.netmapVersion} + 1` })
    .where(eq(waves.id, waveId));
}

/** Replaces a wave's policy whole; the caller has validated it. */
export async function setPolicy(
  db: Database,
  waveId: string,
  document: AclPolicy,
  updatedByUserId: string | null,
): Promise<number> {
  const rows = await db
    .insert(aclPolicies)
    .values({ waveId, document, updatedByUserId })
    .onConflictDoUpdate({
      target: aclPolicies.waveId,
      set: {
        document,
        updatedByUserId,
        updatedAt: new Date(),
        version: sql`${aclPolicies.version} + 1`,
      },
    })
    .returning({ version: aclPolicies.version });
  await bumpNetmap(db, waveId);
  return rows[0]?.version ?? 1;
}

/** Back to the full mesh. */
export async function removePolicy(db: Database, waveId: string): Promise<boolean> {
  const removed = await db
    .delete(aclPolicies)
    .where(eq(aclPolicies.waveId, waveId))
    .returning({ waveId: aclPolicies.waveId });
  if (removed.length === 0) return false;
  await bumpNetmap(db, waveId);
  return true;
}

export function invalidTags(tags: string[]): string[] {
  return tags.filter((tag) => !TAG_PATTERN.test(tag));
}

/** Replaces one device's tags. The wave is in the condition, as everywhere. */
export async function setTags(
  db: Database,
  waveId: string,
  nodeId: string,
  tags: string[],
): Promise<{ hostname: string; tags: string[] } | null> {
  const unique = [...new Set(tags)].sort();
  const updated = await db
    .update(nodes)
    .set({ tags: unique })
    .where(and(eq(nodes.waveId, waveId), eq(nodes.id, nodeId)))
    .returning({ hostname: nodes.hostname, tags: nodes.tags });
  if (updated.length === 0) return null;
  await bumpNetmap(db, waveId);
  return updated[0] ?? null;
}

/** The devices and services of a wave, as the policy needs to see them. */
export async function aclSubjects(
  db: Database,
  waveId: string,
): Promise<{
  nodes: (AclNode & Enforcement & { hostname: string; ipv4: string })[];
  services: (AclService & { ipv4: string })[];
}> {
  const nodeRows = await db
    .select({
      id: nodes.id,
      hostname: nodes.hostname,
      ipv4: nodes.ipv4,
      email: users.email,
      role: waveMembers.role,
      tags: nodes.tags,
      filterEnforced: nodes.filterEnforced,
      filterReason: nodes.filterReason,
    })
    .from(nodes)
    .innerJoin(users, eq(users.id, nodes.userId))
    // Left, not inner: removing a member takes their devices along, but a
    // device whose membership is gone for any other reason must still be
    // judged -- as a member, the least that role can mean.
    .leftJoin(waveMembers, and(eq(waveMembers.waveId, nodes.waveId), eq(waveMembers.userId, nodes.userId)))
    .where(and(eq(nodes.waveId, waveId), eq(nodes.approved, true)));

  const serviceRows = await db
    .select({ name: waveServices.name, viaNodeId: waveServices.viaNodeId, ipv4: waveServices.ipv4 })
    .from(waveServices)
    .where(eq(waveServices.waveId, waveId));

  return {
    nodes: nodeRows.map((row) => ({ ...row, role: row.role ?? "member" })),
    services: serviceRows,
  };
}

/**
 * The wave's policy, compiled against who is in it right now -- or null for
 * the full mesh. Compiled per request and not cached: a device, a tag or a
 * membership that changed is part of the answer, and the waves here have a
 * handful of devices, not thousands.
 */
export async function compiledPolicyFor(
  db: Database,
  waveId: string,
): Promise<{ compiled: CompiledPolicy; services: AclService[] } | null> {
  const stored = await getPolicy(db, waveId);
  if (!stored) return null;
  const subjects = await aclSubjects(db, waveId);
  return {
    compiled: compilePolicy(stored.document, subjects.nodes, subjects.services),
    services: subjects.services,
  };
}
