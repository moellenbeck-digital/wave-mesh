import { type NonceStore, type VerificationFailure, verifySignedRequest } from "@wave/crypto";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import type { Database } from "../db/client.ts";
import { nodes } from "../db/schema.ts";

/**
 * How a node proves who it is: a signature over method, path, timestamp, nonce
 * and body hash, made with the machine key it enrolled with.
 *
 * One place for it, because every node-facing route needs the same three steps
 * and the body has to be read exactly once -- the raw text is what the
 * signature covers, so a route that parsed it first could not check it.
 */
export interface MachineAuth {
  result: { ok: true; machineKey: string } | { ok: false; reason: VerificationFailure };
  body: string;
}

export async function authenticateMachine(c: Context, nonces: NonceStore): Promise<MachineAuth> {
  const body = await c.req.text();
  return {
    result: verifySignedRequest({
      header: c.req.header("authorization"),
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      body,
      nonces,
    }),
    body,
  };
}

/** The node behind a machine key, or null when it has been removed. */
export async function nodeByMachineKey(db: Database, machineKey: string) {
  const rows = await db.select().from(nodes).where(eq(nodes.machineKey, machineKey)).limit(1);
  return rows[0] ?? null;
}
