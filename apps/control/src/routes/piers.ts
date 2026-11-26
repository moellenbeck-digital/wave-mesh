import { createMemoryNonceStore, type NonceStore } from "@wave/crypto";
import { type PierList, PierRequest, type PierResponse } from "@wave/proto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { type Actor, audit } from "../audit.ts";
import type { Database } from "../db/client.ts";
import { waves } from "../db/schema.ts";
import type { SharedPierConfig } from "../env.ts";
import { publishPierZone } from "../waves/pier-dns.ts";
import {
  effectivePier,
  ensureSharedPierName,
  listPiers,
  pierLabel,
  pierZone,
  removePier,
  setPier,
} from "../waves/piers.ts";
import type { NetmapHub } from "./control-ws.ts";
import { authenticateMachine, nodeForRequest } from "./machine-auth.ts";

/**
 * Where a device puts one of its names into the open network (D12).
 *
 * Authenticated with the device's machine key, like the certificate and service
 * routes: the name is the device's own claim. What decides whether the claim is
 * taken is not here -- the operator's lock, the namespace and the 409 are all
 * `setPier()` -- so a second front for the same thing could not disagree.
 *
 * With a pier of its own, nothing here touches DNS: one wildcard record covers
 * the whole pier zone and belongs to the operator's `set-pier`. Through the
 * shared pier there is no such step, so a claim writes the zone's wildcard
 * itself -- idempotent, and tried again with every claim if it failed.
 */
export interface PierRouteDeps {
  db: Database;
  hub?: NetmapHub;
  nonces?: NonceStore;
  sharedPier?: SharedPierConfig;
  dnsSecret?: Buffer;
  http?: typeof fetch;
}

export function pierRoutes({ db, hub, nonces, sharedPier, dnsSecret, http }: PierRouteDeps) {
  const sharedDomain = sharedPier?.domain;
  const app = new Hono();
  const nonceStore = nonces ?? createMemoryNonceStore();

  app.post("/v1/piers", async (c) => {
    const { result, body } = await authenticateMachine(c, nonceStore);
    if (!result.ok) return c.json({ error: result.reason }, 401);

    const found = await nodeForRequest(db, c, result.machineKey);
    if (!found.ok) return c.json({ error: found.error }, found.status);
    const node = found.node;

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
      sharedDomain,
    });
    if ("error" in set) return c.json({ error: set.error }, set.status);

    if (set.host.shared) {
      const outcome = await publishPierZone(
        { db, dnsSecret, sharedPier, http },
        { waveId: node.waveId, zone: set.zone, host: set.host },
      );
      if (outcome.state !== "published") {
        console.error(`pier: *.${set.zone} is ${outcome.state}${outcome.error ? `: ${outcome.error}` : ""}`);
      }
    }

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

    const found = await nodeForRequest(db, c, result.machineKey);
    if (!found.ok) return c.json({ error: found.error }, found.status);
    const node = found.node;

    const waveRows = await db.select().from(waves).where(eq(waves.id, node.waveId)).limit(1);
    const wave = waveRows[0];
    if (!wave) return c.json({ error: "the wave is gone" }, 404);
    const host = await effectivePier(db, node.waveId);
    // Through the shared pier the zone is decided at the first moment a
    // device asks where its names would go.
    if (host?.shared && sharedDomain && wave.pierZoneMode !== "own" && !wave.sharedPierName) {
      wave.sharedPierName = await ensureSharedPierName(db, wave.id);
    }
    const zone = pierZone(wave, sharedDomain);
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

    const found = await nodeForRequest(db, c, result.machineKey);
    if (!found.ok) return c.json({ error: found.error }, found.status);
    const node = found.node;

    const waveRows = await db.select().from(waves).where(eq(waves.id, node.waveId)).limit(1);
    const wave = waveRows[0];
    if (!wave) return c.json({ error: "the wave is gone" }, 404);

    const zone = pierZone(wave, sharedDomain);
    // Hono has decoded the parameter already; decoding it again would throw on
    // a lone `%` and answer 500 to what is only a name that is not one.
    const label = pierLabel(c.req.param("name"), zone);
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
