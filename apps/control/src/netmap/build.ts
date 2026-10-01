import { canonicalJson, sign } from "@wave/crypto";
import type { Netmap, Peer, Relay, Service, SignedNetmap } from "@wave/proto";
import { and, asc, eq, ne } from "drizzle-orm";
import { visibleTo } from "../acl/evaluate.ts";
import { inboundFilter } from "../acl/filter.ts";
import { compiledPolicyFor } from "../acl/store.ts";
import type { Database } from "../db/client.ts";
import { nodes, waveServices, waves } from "../db/schema.ts";
import { resolverAddressFor } from "../net/addressing.ts";
import { serviceUrl } from "../waves/services.ts";
import { boundCandidates } from "./candidates.ts";

type NodeRow = typeof nodes.$inferSelect;
type WaveRow = typeof waves.$inferSelect;

type ServiceRow = typeof waveServices.$inferSelect;

/**
 * A node's own addresses, plus every service it answers for.
 *
 * This is the whole mechanism behind D11: a service is not a peer, it is an
 * address in somebody else's `allowedIps`. `desiredRoutes()` on every device
 * flattens those into routes, and the connector puts the same addresses on its
 * own interface -- neither function has to learn what a service is.
 */
const addressesOf = (node: NodeRow, services: ServiceRow[]): string[] => [
  `${node.ipv4}/32`,
  `${node.ipv6}/128`,
  ...services
    .filter((service) => service.viaNodeId === node.id)
    .flatMap((service) => [`${service.ipv4}/32`, `${service.ipv6}/128`]),
];

const toPeer = (node: NodeRow, wave: WaveRow, services: ServiceRow[] = []): Peer => ({
  id: node.id as Peer["id"],
  nodeKey: node.nodeKey as Peer["nodeKey"],
  discoKey: node.discoKey as Peer["discoKey"],
  hostname: node.hostname,
  dnsName: `${node.hostname}.${wave.dnsSuffix}`,
  ipv4: node.ipv4,
  ipv6: node.ipv6,
  allowedIps: addressesOf(node, services),
  // Bounded here too, not only when stored: a row written before the bound
  // existed would otherwise reach every peer until its node publishes again.
  candidates: boundCandidates(node.candidates),
  online: node.lastSeenAt !== null && Date.now() - node.lastSeenAt.getTime() < 120_000,
  keyExpiresAt: node.keyExpiresAt?.toISOString() ?? null,
});

/** The view of the wave as one node is allowed to see it. */
export async function buildNetmap(
  db: Database,
  nodeId: string,
  relays: Relay[] = [],
): Promise<Netmap | null> {
  const rows = await db
    .select({ node: nodes, wave: waves })
    .from(nodes)
    .innerJoin(waves, eq(waves.id, nodes.waveId))
    .where(eq(nodes.id, nodeId))
    .limit(1);

  const self = rows[0];
  if (!self) return null;

  const allPeerRows = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.waveId, self.wave.id), ne(nodes.id, nodeId), eq(nodes.approved, true)));

  // By name, like every other list of these: an array that comes back in a
  // different order for no reason is a netmap that looks changed when nothing
  // moved -- and the browser's list is sorted the same way, so the two really
  // are the same document about the same wave.
  const allServices = await db
    .select()
    .from(waveServices)
    .where(eq(waveServices.waveId, self.wave.id))
    .orderBy(asc(waveServices.name));

  // Judged against everything in the wave, not what this node may see: a
  // reservation taken by a device hidden from us is still taken.
  const resolver = reservedResolver(self.wave, [self.node, ...allPeerRows], allServices);

  // The first stage of M7, and the one that does the protecting: a peer that is
  // not in this netmap is not a WireGuard peer here, and whatever it sends is
  // dropped before any service could see it. A service works the same way --
  // left out, its address is neither routed nor resolved, even though it sits
  // behind a connector this node may otherwise reach.
  const policy = await compiledPolicyFor(db, self.wave.id);
  const visible = policy ? visibleTo(policy.compiled, self.node.id, policy.services) : null;
  const peerRows = visible ? allPeerRows.filter((peer) => visible.peers.has(peer.id)) : allPeerRows;
  const services = visible
    ? allServices.filter((service) => visible.services.has(service.name))
    : allServices;

  return {
    version: self.wave.netmapVersion,
    waveId: self.wave.id as Netmap["waveId"],
    self: {
      ...toPeer(self.node, self.wave, allServices),
      // The connector learns from its own netmap which addresses to put on its
      // interface; for every other node this is just its own two. All of them,
      // policy or not: a connector answers for every service it fronts,
      // whoever may reach them.
      addresses: addressesOf(self.node, allServices),
    },
    peers: peerRows.map((peer) => toPeer(peer, self.wave, services)),
    services: services.map(
      (service): Service => ({
        name: service.name,
        dnsName: `${service.name}.${self.wave.dnsSuffix}`,
        ipv4: service.ipv4,
        ipv6: service.ipv6,
        viaNodeId: service.viaNodeId as Service["viaNodeId"],
        // Finished, not in parts: this is the one place that knows both the
        // cluster's scheme and the wave's zone, and every device shows the
        // same address because it never builds one.
        url: serviceUrl(service.name, self.wave.dnsSuffix, service.scheme),
      }),
    ),
    // Only under a policy: absent is "no policy" and lets everything in, while
    // an empty list is "deny all but replies" -- the field must not appear by
    // accident, so it is spread in rather than set to undefined.
    ...(policy ? { packetFilter: inboundFilter(policy.compiled, self.node, allPeerRows, allServices) } : {}),
    dns: {
      suffix: self.wave.dnsSuffix,
      ...(resolver ? { resolverAddress: resolver } : {}),
      routes: [],
      upstream: [],
    },
    relays,
    issuedAt: new Date().toISOString(),
  };
}

/**
 * The address this wave's resolver answers on, or nothing.
 *
 * Nothing when a node or a service already holds it: waves numbered before the
 * reservation existed could have given it away, and pointing every device's DNS
 * at one of them would take that device off the network. The clients that need
 * it say so themselves when it is missing -- better than a netmap that lies.
 *
 * Why it is reserved at all: a resolver without a socket of its own, which is
 * what a phone runs, is reached by routing its address into the tunnel. An
 * address the tunnel interface *holds* is answered locally by the kernel, where
 * nothing is listening, so the query never gets there. It therefore has to be
 * an address that belongs to the wave and to no device in it.
 */
function reservedResolver(wave: WaveRow, nodeRows: NodeRow[], services: ServiceRow[]): string | null {
  let reserved: string;
  try {
    reserved = resolverAddressFor(wave.ipv4Prefix);
  } catch {
    return null; // a block too small to spare one
  }
  if (nodeRows.some((node) => node.ipv4 === reserved)) return null;
  if (services.some((service) => service.ipv4 === reserved)) return null;
  return reserved;
}

export interface SigningKey {
  publicKey: string;
  privateKey: string;
}

/**
 * Signs the canonical encoding, so a client can verify the netmap even if some
 * proxy re-serialises the JSON on the way.
 */
export function signNetmap(netmap: Netmap, key: SigningKey): SignedNetmap {
  return {
    netmap,
    signature: sign(key.privateKey, canonicalJson(netmap)),
    keyId: key.publicKey,
  };
}
