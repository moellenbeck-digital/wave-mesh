import { createMemoryNonceStore, type NonceStore } from "@wave/crypto";
import { type PierList, PierRequest, type PierResponse } from "@wave/proto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { type Actor, audit } from "../audit.ts";
import type { Database } from "../db/client.ts";
import { waves } from "../db/schema.ts";
import { findPierHost, listPiers, pierZone, removePier, setPier } from "../waves/piers.ts";
import { serviceLabel } from "../waves/services.ts";
import type { NetmapHub } from "./control-ws.ts";
import { authenticateMachine, nodeByMachineKey } from "./machine-auth.ts";

/**
 * Where a device puts one of its names into the open network (D12).
 *
 * Authenticated with the device's machine key, like the certificate and service
 * routes: the name is the device's own claim. What decides whether the claim is
 * taken is not here -- the operator's lock, the namespace and the 409 are all
 * `setPier()` -- so a second front for the same thing could not disagree.
 *
 * Nothing here touches DNS: one wildcard record covers the whole pier zone and
 * belongs to the operator's `set-pier`. A claim is a row and a netmap push.
 */
export interface PierRouteDeps {
  db: Database;
  hub?: NetmapHub;
  nonces?: NonceStore;
}

export function pierRoutes({ db, hub, nonces }: PierRouteDeps) {
  const app = new Hono();
  const nonceStore = nonces ?? createMemoryNonceStore();

  app.post("/v1/piers", async (c) => {
    const { result, body } = await authenticateMachine(c, nonceStore);
    if (!result.ok) return c.json({ error: result.reason }, 401);

    const node = await nodeByMachineKey(db, result.machineKey);
    if (!node) return c.json({ error: "unknown node" }, 404);

    let json: unknown;
    try {
      json = JSON.parse(body || "{}");
    } catch {
      return c.json({ error: "invalid request" }, 400);
    }
    const parsed = PierRequest.safeParse(json);
    if (!parsed.success) return c.json({ error: "invalid request", detail: parsed.error.issues }, 400);

    const set = await setPier(db, {
      waveId: node.waveId,
      nodeId: node.id,
      name: parsed.data.name,
      port: parsed.data.port,
    });
    if ("error" in set) return c.json({ error: set.error }, set.status);

    const actor: Actor = { userId: node.userId, label: `device:${node.hostname}` };
    if (set.changed) {
      await audit(db, node.waveId, actor, {
        action: "pier.expose",
        target: set.dnsName,
        detail: { port: set.pier.port },
      });
      // The pier node and this device both need the new list.
      await hub?.broadcast(node.waveId);
    }

    return c.json({
      name: set.pier.name,
      dnsName: set.dnsName,
      port: set.pier.port,
    } satisfies PierResponse);
  });

  /** What this device has put out, and whether it may. */
  app.get("/v1/piers", async (c) => {
    const { result } = await authenticateMachine(c, nonceStore);
    if (!result.ok) return c.json({ error: result.reason }, 401);

    const node = await nodeByMachineKey(db, result.machineKey);
    if (!node) return c.json({ error: "unknown node" }, 404);

    const waveRows = await db.select().from(waves).where(eq(waves.id, node.waveId)).limit(1);
    const wave = waveRows[0];
    if (!wave) return c.json({ error: "the wave is gone" }, 404);
    const zone = pierZone(wave);
    const host = await findPierHost(db, node.waveId);
    const piers = await listPiers(db, node.waveId, node.id);
    return c.json({
      allowed: node.pierAllowed,
      zone,
      pier: host ? { publicIpv4: host.publicIpv4, publicIpv6: host.publicIpv6 } : null,
      piers: piers.map((pier) => ({ name: pier.name, dnsName: `${pier.name}.${zone}`, port: pier.port })),
    } satisfies PierList);
  });

  app.delete("/v1/piers/:name", async (c) => {
    const { result } = await authenticateMachine(c, nonceStore);
    if (!result.ok) return c.json({ error: result.reason }, 401);

    const node = await nodeByMachineKey(db, result.machineKey);
    if (!node) return c.json({ error: "unknown node" }, 404);

    const waveRows = await db.select().from(waves).where(eq(waves.id, node.waveId)).limit(1);
    const wave = waveRows[0];
    if (!wave) return c.json({ error: "the wave is gone" }, 404);

    const zone = pierZone(wave);
    const label = serviceLabel(decodeURIComponent(c.req.param("name")), zone);
    if (!label) return c.json({ error: `not a name under ${zone}` }, 400);

    const removed = await removePier(db, { waveId: node.waveId, nodeId: node.id, name: label });
    if (!removed) return c.json({ error: "this device has not put that name out" }, 404);

    const fqdn = `${label}.${zone}`;
    await audit(
      db,
      node.waveId,
      { userId: node.userId, label: `device:${node.hostname}` },
      { action: "pier.unexpose", target: fqdn },
    );
    await hub?.broadcast(node.waveId);

    return c.json({
      name: label,
      dnsName: fqdn,
      port: removed.port,
    } satisfies PierResponse);
  });

  return app;
}
