import { z } from "zod";
import { DiscoKey, NodeId, NodeKey, WaveId } from "./keys.ts";
import { Cidr, Endpoint, Ipv4, Ipv6, Timestamp } from "./net.ts";

export const CandidateKind = z.enum(["local", "stun", "portmap", "relay", "learned"]);
export type CandidateKind = z.infer<typeof CandidateKind>;

/** One address a peer might be reachable at. Order carries no meaning. */
export const Candidate = Endpoint.extend({ kind: CandidateKind });
export type Candidate = z.infer<typeof Candidate>;

export const Relay = z.looseObject({
  id: z.string().min(1),
  region: z.string().min(1),
  url: z.url(),
  stun: Endpoint.optional(),
});
export type Relay = z.infer<typeof Relay>;

export const Peer = z.looseObject({
  id: NodeId,
  nodeKey: NodeKey,
  discoKey: DiscoKey,
  hostname: z.string().min(1),
  /** Fully qualified name under the wave's DNS suffix. */
  dnsName: z.string().min(1),
  ipv4: Ipv4,
  ipv6: Ipv6,
  /** What this peer is allowed to send us -- its own addresses plus any routes. */
  allowedIps: z.array(Cidr).min(1),
  candidates: z.array(Candidate),
  /** Relay to fall back to while no direct path exists. */
  homeRelayId: z.string().optional(),
  online: z.boolean(),
  keyExpiresAt: Timestamp.nullable(),
});
export type Peer = z.infer<typeof Peer>;

export const SelfNode = Peer.extend({
  /** Addresses to configure on the local tunnel interface. */
  addresses: z.array(Cidr).min(1),
});
export type SelfNode = z.infer<typeof SelfNode>;

/**
 * A service in the wave: a name and an address that is not a device (D11).
 *
 * It has no keys and is no WireGuard peer. Reaching it works because its
 * address sits in the `allowedIps` of the node named here -- so every device
 * routes it into the tunnel, and that node answers for it.
 */
export const Service = z.looseObject({
  /** The label under the wave's suffix, e.g. "grafana". */
  name: z.string().min(1),
  dnsName: z.string().min(1),
  ipv4: Ipv4,
  ipv6: Ipv6,
  /** The node that fronts it. Always a peer (or self) of this netmap. */
  viaNodeId: NodeId,
  /**
   * Where to open it, written out by the server.
   *
   * The whole address and not its parts: the scheme is the cluster's, the zone
   * is the wave's, and both are known in one place. Every view that offers a
   * link would otherwise rebuild it from a scheme, a name and a suffix -- four
   * of them by now -- and four spellings of one address is exactly how they
   * come to disagree.
   *
   * Optional and **without a default**, like everything else in here. A server
   * from before this field leaves it out, and inventing it on the way in would
   * change the canonical form away from the one that was signed.
   */
  url: z.url().optional(),
});
export type Service = z.infer<typeof Service>;

export const DnsConfig = z.looseObject({
  /** e.g. "wave.example.com" -- always a domain the wave owner controls. */
  suffix: z.string().min(1),
  /**
   * The address this wave reserves for its resolver, if it has one.
   *
   * Optional and **without a default**, like everything else inside a netmap:
   * a default would add the field to a document the server never sent, the
   * canonical encoding would differ from the one that was signed, and a
   * perfectly good netmap would be reported as forged. That is not theoretical
   * here -- the server leaves it out for a wave whose reservation was given to
   * a node before the reservation existed.
   *
   * It matters most where the resolver has no socket of its own: on a phone the
   * query only reaches it if this address is *routed* into the tunnel and held
   * by nobody, because a packet to an address the interface holds is answered
   * locally by a kernel with nothing listening behind it.
   */
  resolverAddress: Ipv4.optional(),
  /** Split-DNS: send queries for these suffixes to these nameservers. */
  routes: z.array(z.object({ suffix: z.string().min(1), nameservers: z.array(z.string()).min(1) })),
  /** Upstream for everything else; empty means "keep the system resolver". */
  upstream: z.array(z.string()).optional(),
});
export type DnsConfig = z.infer<typeof DnsConfig>;

/** One range of ports a filter rule opens, for one protocol or both. */
export const FilterPorts = z.looseObject({
  proto: z.enum(["tcp", "udp", "any"]),
  from: z.number().int().min(1).max(65535),
  to: z.number().int().min(1).max(65535),
});
export type FilterPorts = z.infer<typeof FilterPorts>;

/**
 * Traffic a node lets in: from these addresses, to these of its own, on these
 * ports (M7, stage two). Addresses as CIDRs; `dst` is the node itself or one
 * of the services it fronts.
 */
export const FilterRule = z.looseObject({
  src: z.array(z.string()),
  dst: z.array(z.string()),
  ports: z.array(FilterPorts),
});
export type FilterRule = z.infer<typeof FilterRule>;

/**
 * The complete view of the network as one node sees it. Signed by the control
 * server so a compromised transport cannot substitute peer keys.
 *
 * **Nothing in it may be dropped or invented.** The signature covers the
 * canonical encoding of what the server sent, so a schema that removed an
 * unknown field -- or added a missing one from a default -- would canonicalise
 * something else and report a perfectly good netmap as forged. Hence
 * `looseObject` throughout, and hence no `.default()` anywhere inside: the
 * first is what lets an old client read a newer server, the second what lets a
 * new client read an older one. Both were live failures the day `services` was
 * added, and both read like an attack rather than a version skew.
 */
export const Netmap = z.looseObject({
  version: z.number().int().nonnegative(),
  waveId: WaveId,
  self: SelfNode,
  peers: z.array(Peer),
  /**
   * Names in the wave that are not devices.
   *
   * Optional and **without a default**: a default would add the field to a
   * netmap from a server that never sent it, and the canonical encoding would
   * then differ from the one that was signed. Absent and empty mean the same
   * thing to every reader here, and only one of them survives a signature.
   */
  services: z.array(Service).optional(),
  /**
   * What this node lets in over the tunnel, when its wave has a policy (M7).
   *
   * Absent means no policy: everything the netmap's peers send is let in, as
   * it always was. Present -- empty included -- means default deny: only what
   * a rule names, plus replies to connections this node opened and ICMP. The
   * difference between the two is the whole point, which is why this is
   * optional without a default like everything else here: a default would
   * turn "no policy" into "deny all" on the reader's side.
   */
  packetFilter: z.array(FilterRule).optional(),
  dns: DnsConfig,
  relays: z.array(Relay),
  issuedAt: Timestamp,
});
export type Netmap = z.infer<typeof Netmap>;

export const SignedNetmap = z.object({
  netmap: Netmap,
  /** Ed25519 signature over the canonical JSON encoding of `netmap`. */
  signature: z.string().min(1),
  keyId: z.string().min(1),
});
export type SignedNetmap = z.infer<typeof SignedNetmap>;
