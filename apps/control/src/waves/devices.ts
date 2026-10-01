import { asc, eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { nodes, waveServices, waves } from "../db/schema.ts";
import { serviceUrl } from "./services.ts";

/**
 * A device as a browser sees it.
 *
 * One shape, built in one place, because two readers want it: the JSON route
 * a page is rendered from and the socket that keeps that page current. Built
 * twice they would drift, and the drift would only show as a list that jumps
 * the moment the first push arrives.
 */
export interface DeviceView {
  id: string;
  hostname: string;
  os: string;
  ipv4: string;
  ipv6: string;
  approved: boolean;
  ephemeral: boolean;
  createdAt: Date;
  lastSeenAt: Date | null;
  keyExpiresAt: Date | null;
  /** Holds a control connection right now -- not "was here recently". */
  online: boolean;
  /**
   * The build it said it runs in its last `hello`, and the update channel the
   * server gave it (D13). Null for a client from before self-updates, which
   * never says -- shown as unknown rather than guessed.
   */
  clientVersion: string | null;
  updateChannel: string | null;
  services: { name: string; ipv4: string; ipv6: string; url: string }[];
}

/**
 * The devices of one wave, with the services they answer for.
 *
 * Who is online is not in the database: `lastSeenAt` says when a node last
 * spoke, so the set of held control connections comes from the hub and is
 * passed in rather than looked up here.
 */
export async function listDevices(
  db: Database,
  waveId: string,
  online: ReadonlySet<string>,
): Promise<DeviceView[]> {
  const rows = await db
    .select({
      id: nodes.id,
      hostname: nodes.hostname,
      os: nodes.os,
      ipv4: nodes.ipv4,
      ipv6: nodes.ipv6,
      approved: nodes.approved,
      ephemeral: nodes.ephemeral,
      createdAt: nodes.createdAt,
      lastSeenAt: nodes.lastSeenAt,
      keyExpiresAt: nodes.keyExpiresAt,
      clientVersion: nodes.clientVersion,
      updateChannel: nodes.updateChannel,
    })
    .from(nodes)
    .where(eq(nodes.waveId, waveId))
    .orderBy(asc(nodes.hostname));

  // What each node answers for besides itself (D11). A service is an address
  // in this wave and no node of its own, so the only place it can be seen is
  // next to the node that carries it -- otherwise a connector looks like a
  // device that does nothing.
  const services = await db
    .select({
      name: waveServices.name,
      ipv4: waveServices.ipv4,
      ipv6: waveServices.ipv6,
      viaNodeId: waveServices.viaNodeId,
      // Only the cluster knows whether its Ingress terminates TLS, and only
      // the wave knows the zone (D11). Both are here, so what goes out is the
      // finished address -- the same one the netmap carries to every device.
      scheme: waveServices.scheme,
      dnsSuffix: waves.dnsSuffix,
    })
    .from(waveServices)
    .innerJoin(waves, eq(waves.id, waveServices.waveId))
    .where(eq(waveServices.waveId, waveId))
    .orderBy(asc(waveServices.name));

  const byNode = new Map<string, DeviceView["services"]>();
  for (const { viaNodeId, scheme, dnsSuffix, ...service } of services) {
    const entry = { ...service, url: serviceUrl(service.name, dnsSuffix, scheme) };
    byNode.set(viaNodeId, [...(byNode.get(viaNodeId) ?? []), entry]);
  }

  return rows.map((node) => ({
    ...node,
    online: online.has(node.id),
    services: byNode.get(node.id) ?? [],
  }));
}
