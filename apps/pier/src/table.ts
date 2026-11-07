import type { ProfileStatus } from "@wave/ipc";
import { normalise } from "@wave/sni";

/**
 * Which names the pier answers for, and where each one leads (D12).
 *
 * Read from the daemon's status, which is read from the signed netmap -- the
 * pier holds no list of its own. A name that is not in it is not a name here.
 */

export interface PierTarget {
  /** The wave address of the device that terminates TLS for this name. */
  ipv4: string;
  port: number;
}

export type PierTable = Map<string, PierTarget>;

function profileOf(status: ProfileStatus[], controlUrl?: string): ProfileStatus | undefined {
  return controlUrl
    ? status.find((entry) => entry.controlUrl === controlUrl)
    : (status.find((entry) => entry.state === "up") ?? status[0]);
}

/**
 * The lookup the splice uses for every connection, from one status.
 *
 * A name only counts if its address is one a peer of this netmap has (or this
 * node itself). The server writes the address, but the pier is the one place
 * where somebody on the internet picks the name, and "connect to whatever the
 * entry says" is the one thing here that must never reach beyond the wave: a
 * damaged or forged entry pointing at a metadata service or a LAN host would
 * make the pier an open door into its own network.
 */
export function pierTable(status: ProfileStatus[], controlUrl?: string): PierTable {
  const table: PierTable = new Map();
  const profile = profileOf(status, controlUrl);
  if (profile?.state !== "up") return table;

  const waveAddresses = new Set(profile.peers.map((peer) => peer.ipv4));
  if (profile.self?.ipv4) waveAddresses.add(profile.self.ipv4);

  for (const pier of profile.piers ?? []) {
    if (!waveAddresses.has(pier.ipv4)) continue;
    table.set(normalise(pier.dnsName), { ipv4: pier.ipv4, port: pier.port });
  }
  return table;
}
