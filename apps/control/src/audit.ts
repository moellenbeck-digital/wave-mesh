import { desc, eq } from "drizzle-orm";
import type { Database } from "./db/client.ts";
import { auditLog } from "./db/schema.ts";
import { newId } from "./ids.ts";

/** Who did it: an account, or the shell, which has none. */
export interface Actor {
  userId: string | null;
  label: string;
}

/**
 * wave-admin runs as somebody on the server's shell, not as an account. The
 * login name is what there is to go by; inside a container it is usually
 * root, which says "the operator" -- and that is the honest answer.
 */
export const shellActor = (): Actor => ({
  userId: null,
  label: `shell:${process.env.USER ?? process.env.LOGNAME ?? "unknown"}`,
});

export const userActor = (user: { id: string; email?: string | null }): Actor => ({
  userId: user.id,
  label: user.email ?? user.id,
});

export interface AuditEntry {
  action: string;
  target?: string | null;
  detail?: Record<string, unknown>;
}

/**
 * Writes one entry. Never throws: the change it records has already
 * happened, and failing the request afterwards would report as undone what
 * was done. A lost entry is said on stderr, where an operator looks when the
 * log has a gap.
 */
export async function audit(db: Database, waveId: string, actor: Actor, entry: AuditEntry): Promise<void> {
  try {
    await db.insert(auditLog).values({
      id: newId("aud"),
      waveId,
      actorUserId: actor.userId,
      actor: actor.label,
      action: entry.action,
      target: entry.target ?? null,
      detail: entry.detail ?? null,
    });
  } catch (error) {
    console.error(`audit: could not record ${entry.action} in ${waveId}: ${(error as Error).message}`);
  }
}

export interface AuditRow {
  at: string;
  actor: string;
  action: string;
  target: string | null;
  detail: Record<string, unknown> | null;
}

export async function listAudit(db: Database, waveId: string, limit = 50): Promise<AuditRow[]> {
  const rows = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.waveId, waveId))
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);
  return rows.map((row) => ({
    at: row.createdAt.toISOString(),
    actor: row.actor,
    action: row.action,
    target: row.target,
    detail: row.detail,
  }));
}
