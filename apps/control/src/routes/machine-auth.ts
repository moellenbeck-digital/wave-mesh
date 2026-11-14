import { type NonceStore, type VerificationFailure, verifySignedRequest } from "@wave/crypto";
import { and, eq } from "drizzle-orm";
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

/**
 * Which wave a request is about, when its device is in more than one.
 *
 * The machine key is one identity across waves (docs/DEVICE-IDENTITY.md), so a
 * signed request alone does not say which of the device's nodes it means. The
 * header is not part of the signature and needs not be: the signature proves
 * the machine key, and the header only picks among the nodes *that key already
 * has*. Naming a wave the device is not in finds nothing; it cannot reach
 * another device's node.
 */
export const WAVE_HEADER = "x-wave-id";

export type NodeRow = typeof nodes.$inferSelect;

export type NodeLookup = { ok: true; node: NodeRow } | { ok: false; status: 404 | 409; error: string };

/**
 * The node a request is about: the one in the named wave, or -- without a
 * wave -- the only one the device has. A device in several waves that names
 * none is refused rather than guessed at; the wave decides addresses, DNS and
 * who sees the device.
 */
export async function nodeByMachineKey(
  db: Database,
  machineKey: string,
  waveId?: string | null,
): Promise<NodeLookup> {
  const rows = await db
    .select()
    .from(nodes)
    .where(
      waveId
        ? and(eq(nodes.machineKey, machineKey), eq(nodes.waveId, waveId))
        : eq(nodes.machineKey, machineKey),
    )
    .limit(2);
  const [node, other] = rows;
  if (!node) return { ok: false, status: 404, error: "unknown node" };
  if (other) {
    return {
      ok: false,
      status: 409,
      error: `this device is in several waves: name one in the ${WAVE_HEADER} header`,
    };
  }
  return { ok: true, node };
}

/** `nodeByMachineKey` for the request at hand, reading the wave from its header. */
export const nodeForRequest = (db: Database, c: Context, machineKey: string): Promise<NodeLookup> =>
  nodeByMachineKey(db, machineKey, c.req.header(WAVE_HEADER));
