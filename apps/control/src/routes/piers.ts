import { createMemoryNonceStore, type NonceStore } from "@wave/crypto";
import { PierRequest, type PierResponse } from "@wave/proto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { type Actor, audit } from "../audit.ts";
import type { Database } from "../db/client.ts";
import { waves } from "../db/schema.ts";
import type { Config } from "../env.ts";
import { publishPierName, unpublishPierName } from "../waves/pier-dns.ts";
import { findPierHost, listPiers, removePier, setPier } from "../waves/piers.ts";
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
 * The answer always carries the state of the public record. A wave that writes
 * its zone by hand gets the record to create, the same way dns-01 asks for its
 * TXT record.
 */
export interface PierRouteDeps {
  db: Database;
  config: Pick<Config, "dnsSecret">;
  hub?: NetmapHub;
  nonces?: NonceStore;
  /** For the DNS providers, so a test never reaches a real API. */
  http?: typeof fetch;
}

export function pierRoutes({ db, config, hub, nonces, http }: PierRouteDeps) {
  const app = new Hono();
  const nonceStore = nonces ?? createMemoryNonceStore();
  const dns = { db, dnsSecret: config.dnsSecret, http };

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

    // Every grant is also written to the zone, changed or not: asking again is
    // how a record that could not be written the first time gets written.
    const outcome = await publishPierName(dns, { waveId: node.waveId, fqdn: set.dnsName, host: set.host });

    const actor: Actor = { userId: node.userId, label: `device:${node.hostname}` };
    if (set.changed) {
      await audit(db, node.waveId, actor, {
        action: "pier.expose",
        target: set.dnsName,
        detail: { port: set.pier.port, dns: outcome.state },
      });
      // The pier node and this device both need the new list.
      await hub?.broadcast(node.waveId);
    }

    return c.json({
      name: set.pier.name,
      dnsName: set.dnsName,
      port: set.pier.port,
      dns: outcome.state,
      records: outcome.records,
      ...(outcome.error ? { error: outcome.error } : {}),
    } satisfies PierResponse);
  });

  /** What this device has put out, and whether it may. */
  app.get("/v1/piers", async (c) => {
    const { result } = await authenticateMachine(c, nonceStore);
    if (!result.ok) return c.json({ error: result.reason }, 401);

    const node = await nodeByMachineKey(db, result.machineKey);
    if (!node) return c.json({ error: "unknown node" }, 404);

    const waveRows = await db.select().from(waves).where(eq(waves.id, node.waveId)).limit(1);
    const suffix = waveRows[0]?.dnsSuffix ?? "";
    const host = await findPierHost(db, node.waveId);
    const piers = await listPiers(db, node.waveId, node.id);
    return c.json({
      allowed: node.pierAllowed,
      pier: host ? { publicIpv4: host.publicIpv4, publicIpv6: host.publicIpv6 } : null,
      piers: piers.map((pier) => ({ name: pier.name, dnsName: `${pier.name}.${suffix}`, port: pier.port })),
    });
  });

  app.delete("/v1/piers/:name", async (c) => {
    const { result } = await authenticateMachine(c, nonceStore);
    if (!result.ok) return c.json({ error: result.reason }, 401);

    const node = await nodeByMachineKey(db, result.machineKey);
    if (!node) return c.json({ error: "unknown node" }, 404);

    const waveRows = await db.select().from(waves).where(eq(waves.id, node.waveId)).limit(1);
    const wave = waveRows[0];
    if (!wave) return c.json({ error: "the wave is gone" }, 404);

    const label = serviceLabel(decodeURIComponent(c.req.param("name")), wave.dnsSuffix);
    if (!label) return c.json({ error: "not a name in this wave" }, 400);

    const removed = await removePier(db, { waveId: node.waveId, nodeId: node.id, name: label });
    if (!removed) return c.json({ error: "this device has not put that name out" }, 404);

    const fqdn = `${label}.${wave.dnsSuffix}`;
    const outcome = await unpublishPierName(dns, {
      waveId: node.waveId,
      fqdn,
      host: await findPierHost(db, node.waveId),
    });
    await audit(
      db,
      node.waveId,
      { userId: node.userId, label: `device:${node.hostname}` },
      { action: "pier.unexpose", target: fqdn, detail: { dns: outcome.state } },
    );
    await hub?.broadcast(node.waveId);

    return c.json({
      name: label,
      dnsName: fqdn,
      port: removed.port,
      dns: outcome.state,
      records: outcome.records,
      ...(outcome.error ? { error: outcome.error } : {}),
    } satisfies PierResponse);
  });

  return app;
}
