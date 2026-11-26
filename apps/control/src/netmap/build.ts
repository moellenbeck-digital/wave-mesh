import { canonicalJson, sign } from "@wave/crypto";
import type { Netmap, Peer, Pier, Relay, Service, SignedNetmap } from "@wave/proto";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { visibleTo } from "../acl/evaluate.ts";
import { inboundFilter } from "../acl/filter.ts";
import { compiledPolicyFor } from "../acl/store.ts";
import { isSuspended } from "../billing/subscriptions.ts";
import type { Database } from "../db/client.ts";
import { nodes, wavePiers, waveServices, waves } from "../db/schema.ts";
import { resolverAddressFor } from "../net/addressing.ts";
import {
  findSharedPier,
  type PierHost,
  pierFilter,
  pierZone,
  toPierHost,
  usesSharedZone,
  wavesOnSharedPier,
  waveWideFilter,
} from "../waves/piers.ts";
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
  sharedDomain?: string,
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
  // The pier (D12). Its node needs every device that owns a name, and such a
  // device needs the pier: a WireGuard peer that is not in the netmap is
  // dropped on arrival, replies included. Under a policy the claim is itself
  // the grant -- two locks and a named port -- so both are added to what the
  // policy lets this node see, and `pierFilter()` opens that one port below.
  // Piers of a device that is not approved are left out, like the device.
  const ownPierHost = [self.node, ...allPeerRows].map(toPierHost).find((host) => host !== null) ?? null;
  // Without a pier of its own, the wave's names go out through the shared one
  // -- a node of another wave, which is a peer here of exactly the devices
  // that hold a name and nobody else.
  const shared = ownPierHost ? null : await findSharedPier(db);
  const viaShared = shared !== null && shared.waveId !== self.wave.id;
  const pierHost: PierHost | null = ownPierHost ?? (viaShared ? shared.host : null);
  const targetOf = (nodeId: string) =>
    nodeId === self.node.id ? self.node : allPeerRows.find((row) => row.id === nodeId);
  const isPierHost = pierHost?.id === self.node.id;
  const zone = pierZone(self.wave, sharedDomain);
  // The owner's permission once more, not only at claim time: a claim that
  // outlived its `pier_allowed` somehow is still not one the pier serves.
  const allPiers = (
    await db.select().from(wavePiers).where(eq(wavePiers.waveId, self.wave.id)).orderBy(asc(wavePiers.name))
  ).filter((pier) => targetOf(pier.nodeId)?.pierAllowed === true);
  const ownPiers = allPiers.filter((pier) => pier.nodeId === self.node.id);
  const pierPeers = new Set<string>(
    isPierHost
      ? allPiers.map((pier) => pier.nodeId).filter((id) => id !== self.node.id)
      : ownPiers.length > 0 && pierHost && !viaShared
        ? [pierHost.id]
        : [],
  );
  const reachable = visible
    ? allPeerRows.filter((peer) => visible.peers.has(peer.id) || pierPeers.has(peer.id))
    : allPeerRows;
  const offered = visible ? allServices.filter((service) => visible.services.has(service.name)) : allServices;

  // A wave paused for billing keeps everything -- devices, addresses, members,
  // policy -- and stops the mesh by having nobody in it. A device stays
  // enrolled and connected, so taking the pause back is one netmap and not a
  // round of re-approving every machine; a device with no peers simply has
  // nobody to talk to. Deleting the wave is the sweep's job, after retention.
  const suspended = await isSuspended(db, self.wave.id);
  const peerRows = suspended ? [] : reachable;
  const services = suspended ? [] : offered;
  // Who hears of a name: the pier node of every one, because it splices them;
  // everybody else of their own and of those owned by a peer they may reach --
  // inside the wave the name resolves to the owner's wave address, the direct
  // way, and a name whose owner this node cannot reach would resolve to an
  // address that answers nothing.
  const listed = new Set([self.node.id, ...peerRows.map((peer) => peer.id)]);
  const piers = suspended ? [] : isPierHost ? allPiers : allPiers.filter((pier) => listed.has(pier.nodeId));

  // The shared pier, as seen from both ends. From a device that holds a name
  // through it: one more peer, reaching only the device's own addresses, and
  // only once the device has said it enforces its filter -- that filter is
  // all that keeps the pier from every other port. From the pier: every such
  // device of every wave on it, and their names under their own zones.
  const sharedPeer =
    viaShared && !suspended && ownPiers.length > 0 && self.node.filterEnforced === true
      ? toPeer(shared.node, await waveOf(db, shared.waveId))
      : null;
  const linked = self.node.sharedPier ? await linkedDevices(db, self.wave.id, sharedDomain) : null;
  const version =
    self.wave.netmapVersion +
    (linked ? linked.versions : 0) +
    (viaShared && ownPiers.length > 0 ? (await waveOf(db, shared.waveId)).netmapVersion : 0);

  const pierEntries: Pier[] = piers.map((pier): Pier => {
    // Present by construction: piers of a device this netmap cannot name were
    // dropped above.
    const target = targetOf(pier.nodeId) as NodeRow;
    return {
      name: pier.name,
      dnsName: `${pier.name}.${zone}`,
      nodeId: pier.nodeId as Pier["nodeId"],
      ipv4: target.ipv4,
      ipv6: target.ipv6,
      port: pier.port,
    };
  });
  const allPierEntries = [...pierEntries, ...(linked?.piers ?? [])];
  // Through the shared pier the zone is only said once it is decided: a wave
  // that has not been given its random label yet would otherwise be told a
  // zone its names will never be in, and the daemon asks the server instead.
  const zoneKnown = !viaShared || usesSharedZone(self.wave, sharedDomain) || self.wave.pierZoneMode === "own";
  const pierZoneEntry =
    pierHost && !suspended && zoneKnown
      ? {
          nodeId: pierHost.id as Pier["nodeId"],
          zone: self.node.sharedPier && sharedDomain ? sharedDomain : zone,
        }
      : null;
  // What the pier may send to a device that has put a name out. Not for the
  // pier node itself: it is only ever the sender.
  const toPier = pierHost && !isPierHost && !suspended ? pierFilter(pierHost, self.node, ownPiers) : [];
  // Through the shared pier the device always gets a filter, policy or not;
  // see `waveWideFilter()`.
  const sharedFilter = viaShared && !suspended && ownPiers.length > 0;

  return {
    version,
    waveId: self.wave.id as Netmap["waveId"],
    self: {
      ...toPeer(self.node, self.wave, allServices),
      // The connector learns from its own netmap which addresses to put on its
      // interface; for every other node this is just its own two. All of them,
      // policy or not: a connector answers for every service it fronts,
      // whoever may reach them.
      addresses: addressesOf(self.node, allServices),
    },
    peers: [
      ...peerRows.map((peer) => toPeer(peer, self.wave, services)),
      ...(sharedPeer ? [sharedPeer] : []),
      ...(linked?.peers ?? []),
    ],
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
    // Only when there is something to say: absent and empty mean the same to
    // every reader, but only the absent one keeps the canonical form of a wave
    // that has never heard of piers exactly as it was signed before this field.
    ...(allPierEntries.length > 0 ? { piers: allPierEntries } : {}),
    // Where the pier zone is and which node splices it, while the wave has a
    // pier. Left out otherwise, so a wave without one signs the document it
    // always did.
    ...(pierZoneEntry ? { pier: pierZoneEntry } : {}),
    // Only under a policy -- or through the shared pier: absent is "no policy"
    // and lets everything in, while an empty list is "deny all but replies" --
    // the field must not appear by accident, so it is spread in rather than set
    // to undefined.
    ...(policy
      ? { packetFilter: [...inboundFilter(policy.compiled, self.node, allPeerRows, allServices), ...toPier] }
      : sharedFilter
        ? { packetFilter: [waveWideFilter(self.wave, addressesOf(self.node, allServices)), ...toPier] }
        : {}),
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

async function waveOf(db: Database, waveId: string): Promise<WaveRow> {
  const rows = await db.select().from(waves).where(eq(waves.id, waveId)).limit(1);
  const wave = rows[0];
  if (!wave) throw new Error(`wave ${waveId} is gone`);
  return wave;
}

/**
 * What the shared pier needs of every wave it serves: the devices that hold a
 * name (approved, allowed, filter enforced, wave not paused) as peers that
 * reach only their own two addresses, and their names under their zones.
 * `versions` is the sum of those waves' netmap versions, so a change in any of
 * them is a new netmap for the pier -- also when it came from the shell.
 */
async function linkedDevices(
  db: Database,
  hostingWaveId: string,
  sharedDomain: string | undefined,
): Promise<{ peers: Peer[]; piers: Pier[]; versions: number }> {
  const peers: Peer[] = [];
  const piers: Pier[] = [];
  let versions = 0;
  for (const waveId of await wavesOnSharedPier(db, hostingWaveId)) {
    const wave = await waveOf(db, waveId);
    versions += wave.netmapVersion;
    if (await isSuspended(db, waveId)) continue;
    const zone = pierZone(wave, sharedDomain);
    const claims = await db
      .select({ pier: wavePiers, node: nodes })
      .from(wavePiers)
      .innerJoin(nodes, eq(nodes.id, wavePiers.nodeId))
      .where(eq(wavePiers.waveId, waveId))
      .orderBy(asc(wavePiers.name));
    const seen = new Set<string>();
    for (const { pier, node } of claims) {
      if (!node.approved || !node.pierAllowed || node.filterEnforced !== true) continue;
      if (!seen.has(node.id)) {
        seen.add(node.id);
        peers.push(toPeer(node, wave));
      }
      piers.push({
        name: pier.name,
        dnsName: `${pier.name}.${zone}`,
        nodeId: pier.nodeId as Pier["nodeId"],
        ipv4: node.ipv4,
        ipv6: node.ipv6,
        port: pier.port,
      });
    }
  }
  return { peers, piers, versions };
}

/**
 * The version a node's netmap carries: its wave's, plus whatever other wave
 * the netmap is built from -- the shared pier's wave for a device that holds a
 * name through it, every wave on the shared pier for the pier itself. The
 * heartbeat compares against exactly this.
 */
export async function netmapVersionOf(db: Database, nodeId: string): Promise<number | null> {
  const rows = await db
    .select({ node: nodes, wave: waves })
    .from(nodes)
    .innerJoin(waves, eq(waves.id, nodes.waveId))
    .where(eq(nodes.id, nodeId))
    .limit(1);
  const self = rows[0];
  if (!self) return null;
  let version = self.wave.netmapVersion;
  if (self.node.sharedPier) {
    for (const waveId of await wavesOnSharedPier(db, self.wave.id)) {
      version += (await waveOf(db, waveId)).netmapVersion;
    }
    return version;
  }
  const own = await db
    .select({ id: wavePiers.id })
    .from(wavePiers)
    .where(eq(wavePiers.nodeId, nodeId))
    .limit(1);
  if (!own[0] || !self.node.pierAllowed) return version;
  const ownPier = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.waveId, self.wave.id),
        sql`(${nodes.pierIpv4} is not null or ${nodes.pierIpv6} is not null)`,
      ),
    )
    .limit(1);
  if (ownPier[0]) return version;
  const shared = await findSharedPier(db);
  if (!shared || shared.waveId === self.wave.id) return version;
  return version + (await waveOf(db, shared.waveId)).netmapVersion;
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
