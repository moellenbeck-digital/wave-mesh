import { createMemoryNonceStore, type NonceStore } from "@wave/crypto";
import { ServiceSyncRequest } from "@wave/proto";
import { Hono } from "hono";
import type { Database } from "../db/client.ts";
import { listServices, syncServices } from "../waves/services.ts";
import type { NetmapHub } from "./control-ws.ts";
import { authenticateMachine, nodeByMachineKey } from "./machine-auth.ts";

/**
 * Where a cluster says which names it answers for (D11).
 *
 * Authenticated with the connector's machine key, because the connector *is*
 * the cluster's membership in the wave: one identity, one tunnel, and the
 * services are addresses routed to it. The operator that watches the Ingresses
 * holds that same key -- it is not a second participant, it is the part of the
 * connector that reads Kubernetes.
 *
 * The whole set is declared at once. A cluster's objects come and go, and
 * "these are the services now" is the only shape that cannot drift: a missed
 * delete would otherwise leave a name in the wave that nothing answers for.
 */
export interface ServiceRouteDeps {
  db: Database;
  hub?: NetmapHub;
  nonces?: NonceStore;
}

export function serviceRoutes({ db, hub, nonces }: ServiceRouteDeps) {
  const app = new Hono();
  const nonceStore = nonces ?? createMemoryNonceStore();

  app.post("/v1/services", async (c) => {
    const { result, body } = await authenticateMachine(c, nonceStore);
    if (!result.ok) return c.json({ error: result.reason }, 401);

    const node = await nodeByMachineKey(db, result.machineKey);
    if (!node) return c.json({ error: "unknown node" }, 404);

    const parsed = ServiceSyncRequest.safeParse(JSON.parse(body || "{}"));
    if (!parsed.success) return c.json({ error: "invalid request", detail: parsed.error.issues }, 400);

    const synced = await syncServices(db, {
      waveId: node.waveId,
      viaNodeId: node.id,
      names: parsed.data.names,
      secure: parsed.data.secure,
    });
    // A name that is already a device, or somebody else's service: something a
    // person has to rename, not something that broke.
    if ("conflict" in synced) return c.json({ error: synced.conflict }, 409);

    // Every device in the wave routes these addresses, so they all need the new
    // netmap -- and only when something actually moved.
    if (synced.changed) await hub?.broadcast(node.waveId);

    return c.json({
      services: synced.services.map((service) => ({
        name: service.name,
        ipv4: service.ipv4,
        ipv6: service.ipv6,
      })),
    });
  });

  /** What this node currently answers for, for an operator that restarted. */
  app.get("/v1/services", async (c) => {
    const { result } = await authenticateMachine(c, nonceStore);
    if (!result.ok) return c.json({ error: result.reason }, 401);

    const node = await nodeByMachineKey(db, result.machineKey);
    if (!node) return c.json({ error: "unknown node" }, 404);

    const services = await listServices(db, node.waveId);
    return c.json({
      services: services
        .filter((service) => service.viaNodeId === node.id)
        .map((service) => ({ name: service.name, ipv4: service.ipv4, ipv6: service.ipv6 })),
    });
  });

  return app;
}
