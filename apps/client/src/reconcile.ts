import { type Candidate, formatEndpoint, type Netmap, type Peer } from "@wave/proto";
import type { DesiredPeer, SetDeviceRequest, WgDeviceState } from "./wgctl.ts";

/**
 * No persistent keepalive -- written out as 0, because a set only changes what
 * it names and a running device would keep its old 25.
 *
 * It used to keep NAT state alive on idle paths, and on a phone it did the
 * opposite of what anyone wanted: a packet every 25 seconds from every desktop
 * holds the radio in its high-power state, and the phone's WireGuard answering
 * the handshakes those keepalives drive made the mobile core count the desktop
 * as active and probe it in turn. A quiet path needs nothing kept alive: the
 * first packet after a pause is sprayed to every candidate and the relay,
 * which reaches the peer whatever its NAT has forgotten, and its answer starts
 * the punch from both sides (see ACTIVE_TIMEOUT_MS in @wave/magicsock).
 */
export const KEEPALIVE_SECONDS = 0;

/**
 * M2 uses whatever address a peer published, preferring one learned from STUN
 * because it is the only one routable from outside the peer's LAN. Choosing
 * between several candidates by probing them is M3's job.
 */
function pickEndpoint(peer: Peer): string | undefined {
  const order: Candidate["kind"][] = ["stun", "portmap", "local", "learned"];
  for (const kind of order) {
    const candidate = peer.candidates.find((c) => c.kind === kind);
    if (candidate) return formatEndpoint(candidate);
  }
  return undefined;
}

/**
 * Decides which address WireGuard should send a peer's packets to. With
 * magicsock in place this is always a loopback address, because magicsock does
 * the real routing; without it, the peer's published address is used directly.
 */
export type EndpointResolver = (peer: Peer) => string | undefined;

export const directEndpoint: EndpointResolver = (peer) => pickEndpoint(peer);

export function desiredPeers(netmap: Netmap, resolve: EndpointResolver = directEndpoint): DesiredPeer[] {
  return netmap.peers.map((peer) => ({
    publicKey: peer.nodeKey,
    endpoint: resolve(peer),
    allowedIps: peer.allowedIps,
    persistentKeepalive: KEEPALIVE_SECONDS,
  }));
}

const sameAllowedIps = (a: string[], b: string[]): boolean =>
  a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");

const peerNeedsUpdate = (
  current: WgDeviceState["peers"][number] | undefined,
  desired: DesiredPeer,
): boolean => {
  if (!current) return true;
  if (desired.endpoint && current.endpoint !== desired.endpoint) return true;
  if (current.persistentKeepalive !== desired.persistentKeepalive) return true;
  return !sameAllowedIps(current.allowedIps, desired.allowedIps);
};

/**
 * Computes the difference between what WireGuard currently has and what the
 * netmap says it should have. Always a diff against observed state, never a
 * replay of remembered commands -- that way a restart, a missed update or an
 * externally modified device all converge on the same result.
 */
export function planDeviceUpdate(
  current: WgDeviceState,
  netmap: Netmap,
  local: { privateKey: string; listenPort: number },
  resolve: EndpointResolver = directEndpoint,
): SetDeviceRequest {
  const desired = desiredPeers(netmap, resolve);
  const byKey = new Map(current.peers.map((peer) => [peer.publicKey, peer]));

  const request: SetDeviceRequest = {
    upsert: desired.filter((peer) => peerNeedsUpdate(byKey.get(peer.publicKey), peer)),
    remove: current.peers
      .map((peer) => peer.publicKey)
      .filter((key) => !desired.some((peer) => peer.publicKey === key)),
  };

  if (current.privateKey !== local.privateKey) request.privateKey = local.privateKey;
  if (current.listenPort !== local.listenPort) request.listenPort = local.listenPort;
  return request;
}

/** Addresses to configure on the tunnel interface. */
export const desiredAddresses = (netmap: Netmap): string[] => netmap.self.addresses;

/** Routes that must point into the tunnel: every address of every peer. */
export const desiredRoutes = (netmap: Netmap): string[] => netmap.peers.flatMap((peer) => peer.allowedIps);
