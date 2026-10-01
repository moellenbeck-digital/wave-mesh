import type { Candidate } from "@wave/proto";

/**
 * How many candidates of one kind a node may carry in the netmap.
 *
 * Every peer probes every candidate of every other peer, a few times a second
 * while none answers, and each probe to a new port is a NAT session on the
 * router in front of the prober. A client that never forgot its reflexive
 * addresses once published 2670 of them from behind a port-randomising NAT
 * and filled a home router's session table from the other end of the wave.
 * Current clients stay far below this; the bound is for the ones that do not.
 */
export const MAX_CANDIDATES_PER_KIND = 8;

/**
 * A node's candidates as the server keeps them: without duplicates and with at
 * most MAX_CANDIDATES_PER_KIND of each kind -- the last ones, because a client
 * appends what it learns, so the tail is what is current.
 */
export function boundCandidates(candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  const unique = candidates.filter((candidate) => {
    const address = `${candidate.kind}:${candidate.ip}:${candidate.port}`;
    if (seen.has(address)) return false;
    seen.add(address);
    return true;
  });

  const remaining = new Map<string, number>();
  for (const candidate of unique) remaining.set(candidate.kind, (remaining.get(candidate.kind) ?? 0) + 1);
  return unique.filter((candidate) => {
    const left = remaining.get(candidate.kind) ?? 0;
    remaining.set(candidate.kind, left - 1);
    return left <= MAX_CANDIDATES_PER_KIND;
  });
}
