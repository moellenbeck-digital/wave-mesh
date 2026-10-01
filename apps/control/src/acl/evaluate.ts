import { type AclPolicy, type PortRange, parsePortSpec } from "@wave/proto";

/** A device as the policy sees it: who it belongs to, or which tags it wears. */
export interface AclNode {
  id: string;
  email: string | null;
  role: "owner" | "admin" | "member";
  tags: string[];
}

export interface AclService {
  name: string;
  viaNodeId: string;
}

const ALL_PORTS: PortRange[] = [{ proto: "any", from: 1, to: 65535 }];

/**
 * What one source may reach, as the policy grants it.
 *
 * Kept per target with the ports attached, although the netmap filter only
 * asks "at all?": the ports are what the devices enforce themselves, and the
 * answer to both questions has to come out of the same evaluation.
 */
export interface Reach {
  nodes: Map<string, PortRange[]>;
  services: Map<string, PortRange[]>;
}

export interface CompiledPolicy {
  /** Keyed by source node id. */
  reach: Map<string, Reach>;
}

/**
 * Whether a selector covers a device.
 *
 * A tagged device is its tags: `user:`, `group:` and `role:` never match it,
 * only `tag:` and `*` do. See the note on AclPolicy for why.
 */
export function covers(selector: string, node: AclNode, groups: Record<string, string[]>): boolean {
  if (selector === "*") return true;
  if (selector.startsWith("tag:")) return node.tags.includes(selector);
  if (node.tags.length > 0) return false;
  const email = node.email?.toLowerCase();
  if (selector.startsWith("user:")) return email !== undefined && selector.slice(5).toLowerCase() === email;
  if (selector.startsWith("group:")) {
    return email !== undefined && (groups[selector] ?? []).some((member) => member.toLowerCase() === email);
  }
  if (selector.startsWith("role:")) return selector.slice(5) === node.role;
  return false;
}

function add(into: Map<string, PortRange[]>, key: string, ports: PortRange[]): void {
  const existing = into.get(key);
  into.set(key, existing ? [...existing, ...ports] : [...ports]);
}

export function compilePolicy(policy: AclPolicy, nodes: AclNode[], services: AclService[]): CompiledPolicy {
  const groups = policy.groups ?? {};
  const reach = new Map<string, Reach>();
  for (const node of nodes) reach.set(node.id, { nodes: new Map(), services: new Map() });

  for (const rule of policy.acls) {
    const ports = rule.ports
      ? rule.ports.map((spec) => parsePortSpec(spec)).filter((range): range is PortRange => range !== null)
      : ALL_PORTS;
    const sources = nodes.filter((node) => rule.src.some((selector) => covers(selector, node, groups)));
    const targetNodes = nodes.filter((node) =>
      rule.dst.some((selector) => !selector.startsWith("svc:") && covers(selector, node, groups)),
    );
    const targetServices = services.filter((service) =>
      rule.dst.some((selector) => selector === "*" || selector === `svc:${service.name}`),
    );

    for (const source of sources) {
      const entry = reach.get(source.id);
      if (!entry) continue;
      for (const target of targetNodes) if (target.id !== source.id) add(entry.nodes, target.id, ports);
      for (const service of targetServices) add(entry.services, service.name, ports);
    }
  }
  return { reach };
}

/**
 * What one node's netmap may contain.
 *
 * A peer is visible in *both* directions of a grant: if A may reach B, B has to
 * know A as well, or it could not answer -- WireGuard only talks to peers it
 * has. Which direction may start a connection is then the devices' own
 * business, with the ports in the netmap. The same holds for a service: whoever
 * may reach it needs its connector, and the connector needs them.
 */
export interface Visibility {
  peers: Set<string>;
  services: Set<string>;
}

export function visibleTo(compiled: CompiledPolicy, viewerId: string, services: AclService[]): Visibility {
  const peers = new Set<string>();
  const visibleServices = new Set<string>();
  const viaOf = new Map(services.map((service) => [service.name, service.viaNodeId]));
  const own = compiled.reach.get(viewerId);

  for (const target of own?.nodes.keys() ?? []) peers.add(target);
  for (const name of own?.services.keys() ?? []) {
    visibleServices.add(name);
    const via = viaOf.get(name);
    if (via && via !== viewerId) peers.add(via);
  }

  for (const [sourceId, entry] of compiled.reach) {
    if (sourceId === viewerId) continue;
    if (entry.nodes.has(viewerId)) peers.add(sourceId);
    for (const name of entry.services.keys()) if (viaOf.get(name) === viewerId) peers.add(sourceId);
  }

  // A connector's own services are its own: its netmap names them either way.
  for (const service of services) if (service.viaNodeId === viewerId) visibleServices.add(service.name);
  peers.delete(viewerId);
  return { peers, services: visibleServices };
}

/** Whether two devices may know of each other at all, in either direction. */
export function mayMeet(compiled: CompiledPolicy, a: string, b: string, services: AclService[]): boolean {
  return visibleTo(compiled, a, services).peers.has(b);
}
