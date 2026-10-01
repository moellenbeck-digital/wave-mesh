import type { PortRange } from "@wave/proto";
import type { CompiledPolicy } from "./evaluate.ts";

/** What a device last said about enforcing the ports of the policy. */
export interface Enforcement {
  filterEnforced: boolean | null;
  filterReason: string | null;
}

/**
 * One device's answer, in words. Three of them, because "never said" is not
 * "said no": a client from before the policy existed cannot report at all,
 * and it does not enforce the ports either.
 */
export function enforcementText(device: Enforcement): string {
  if (device.filterEnforced === true) return "ports enforced";
  if (device.filterEnforced === false)
    return `ports NOT enforced (${device.filterReason ?? "no reason given"})`;
  return "ports not reported (a client too old to enforce them)";
}

/**
 * The devices that do not hold the ports, one line each -- empty when all do.
 * Who may reach them at all is still the netmap's, and that holds everywhere;
 * this list is about which ports and which direction.
 */
export function describeEnforcement(devices: (Enforcement & { hostname: string })[]): string[] {
  return [...devices]
    .filter((device) => device.filterEnforced !== true)
    .sort((a, b) => a.hostname.localeCompare(b.hostname))
    .map((device) => `  ${device.hostname}: ${enforcementText(device)}`);
}

const portText = (ranges: PortRange[]): string => {
  const parts = ranges.map((range) => {
    const span =
      range.from === 1 && range.to === 65535
        ? "*"
        : range.from === range.to
          ? `${range.from}`
          : `${range.from}-${range.to}`;
    return range.proto === "any" ? span : `${range.proto}:${span}`;
  });
  return parts.includes("*") ? "all ports" : [...new Set(parts)].join(", ");
};

/**
 * Who reaches whom under a policy, one line per source device.
 *
 * Printed after every change, because a policy is a document about people and
 * machines while what matters is the result: reading "laptop -> nas" is the
 * check that the rule meant what it says, and a device that reaches nothing is
 * said as plainly as one that reaches everything.
 */
export function describeReach(
  compiled: CompiledPolicy,
  nodes: { id: string; hostname: string; tags: string[] }[],
): string[] {
  const name = new Map(nodes.map((node) => [node.id, node.hostname]));
  const labelOf = (node: { hostname: string; tags: string[] }) =>
    node.tags.length > 0 ? `${node.hostname} [${node.tags.join(" ")}]` : node.hostname;
  const width = Math.max(0, ...nodes.map((node) => labelOf(node).length));
  const lines: string[] = [];

  for (const node of [...nodes].sort((a, b) => a.hostname.localeCompare(b.hostname))) {
    const reach = compiled.reach.get(node.id);
    const targets = [
      ...[...(reach?.nodes ?? [])].map(([id, ports]) => `${name.get(id) ?? id} (${portText(ports)})`).sort(),
      ...[...(reach?.services ?? [])].map(([svc, ports]) => `svc:${svc} (${portText(ports)})`).sort(),
    ];
    lines.push(`  ${labelOf(node).padEnd(width)} -> ${targets.length > 0 ? targets.join(", ") : "nothing"}`);
  }
  return lines;
}
