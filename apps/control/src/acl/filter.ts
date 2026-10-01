import type { FilterPorts, FilterRule, PortRange } from "@wave/proto";
import type { CompiledPolicy } from "./evaluate.ts";

interface Addressed {
  id: string;
  ipv4: string;
  ipv6: string;
}

interface AddressedService {
  name: string;
  viaNodeId: string;
  ipv4: string;
  ipv6: string;
}

const hosts = (entry: { ipv4: string; ipv6: string }): string[] => [`${entry.ipv4}/32`, `${entry.ipv6}/128`];

const ports = (ranges: PortRange[]): FilterPorts[] =>
  // Sorted and deduplicated: a netmap is compared by its bytes, and two rules
  // granting the same thing in a different order are not a change.
  [...new Map(ranges.map((range) => [`${range.proto}:${range.from}-${range.to}`, range])).values()]
    .sort((a, b) => a.from - b.from || a.to - b.to || a.proto.localeCompare(b.proto))
    .map((range) => ({ proto: range.proto, from: range.from, to: range.to }));

/**
 * What one node lets in, rule by rule (M7, stage two).
 *
 * Built for the receiving side on purpose. A sender could be anybody's
 * compromised laptop; the device that is reached is the one whose rules have
 * to hold, so it gets the list of who may reach it and enforces it itself.
 * A connector gets rules for its services too, with the service address as the
 * destination -- it is the one device those packets arrive at.
 */
export function inboundFilter(
  compiled: CompiledPolicy,
  self: Addressed,
  others: Addressed[],
  services: AddressedService[],
): FilterRule[] {
  const rules: FilterRule[] = [];
  const own = services.filter((service) => service.viaNodeId === self.id);

  for (const source of [...others].sort((a, b) => a.ipv4.localeCompare(b.ipv4))) {
    const reach = compiled.reach.get(source.id);
    if (!reach) continue;

    const toSelf = reach.nodes.get(self.id);
    if (toSelf) rules.push({ src: hosts(source), dst: hosts(self), ports: ports(toSelf) });

    for (const service of own) {
      const granted = reach.services.get(service.name);
      if (granted) rules.push({ src: hosts(source), dst: hosts(service), ports: ports(granted) });
    }
  }
  return rules;
}
