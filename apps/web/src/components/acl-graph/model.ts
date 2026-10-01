// Types only: `@/lib/control` reads the request's cookies on the server.
import type { AclView } from "@/lib/control";

/**
 * The graph's picture of a policy, and the way back.
 *
 * A rule names several sources and several destinations; the graph draws one
 * arrow per pair. Splitting is exact -- a rule is the union of its pairs -- and
 * joining goes back by source and ports, so a saved document may be shaped
 * differently from the one that was loaded while meaning the same thing.
 */

export interface Edge {
  id: string;
  src: string;
  dst: string;
  /** Empty means every port, the same as a rule without `ports`. */
  ports: string[];
}

export interface Draft {
  /** False is the full mesh: no policy at all, not an empty one. */
  policy: boolean;
  edges: Edge[];
  groups: Record<string, string[]>;
  /** Per device id: the tags it would wear. */
  tags: Record<string, string[]>;
  /** Tags created on the page that no device wears and no rule names yet. */
  extraTags: string[];
}

export type Kind = "user" | "group" | "role" | "any" | "tag" | "svc";

export interface GraphNode {
  id: string;
  kind: Kind;
  /** For `user:` -- the member's role, if they are one. */
  role?: string;
}

let counter = 0;
export const edgeId = () => `e${++counter}`;

interface LooseRule {
  src?: unknown;
  dst?: unknown;
  ports?: unknown;
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

export function draftFrom(view: AclView): Draft {
  const doc = (view.policy ?? {}) as { groups?: Record<string, unknown>; acls?: LooseRule[] };
  const edges: Edge[] = [];
  for (const rule of doc.acls ?? []) {
    const ports = strings(rule.ports);
    for (const src of strings(rule.src)) {
      for (const dst of strings(rule.dst)) {
        if (edges.some((e) => e.src === src && e.dst === dst && samePorts(e.ports, ports))) continue;
        edges.push({ id: edgeId(), src, dst, ports: ports.includes("*") ? [] : ports });
      }
    }
  }
  const groups: Record<string, string[]> = {};
  for (const [name, members] of Object.entries(doc.groups ?? {})) groups[name] = strings(members);
  return {
    policy: view.policy !== null,
    edges,
    groups,
    tags: Object.fromEntries(view.devices.map((device) => [device.id, [...device.tags]])),
    extraTags: [],
  };
}

const samePorts = (a: string[], b: string[]) => [...a].sort().join(",") === [...b].sort().join(",");

/** The document to save, or null for the full mesh. */
export function policyOf(draft: Draft): unknown | null {
  if (!draft.policy) return null;
  const rules = new Map<string, { src: string[]; dst: string[]; ports: string[] }>();
  for (const edge of draft.edges) {
    const key = `${edge.src}|${[...edge.ports].sort().join(",")}`;
    const rule = rules.get(key) ?? { src: [edge.src], dst: [], ports: edge.ports };
    rule.dst.push(edge.dst);
    rules.set(key, rule);
  }
  const acls = [...rules.values()].map((rule) =>
    rule.ports.length > 0
      ? { src: rule.src, dst: rule.dst, ports: rule.ports }
      : { src: rule.src, dst: rule.dst },
  );
  return Object.keys(draft.groups).length > 0 ? { groups: draft.groups, acls } : { acls };
}

/** The devices whose tags the draft changes, with what they would wear. */
export function changedTags(draft: Draft, view: AclView): Record<string, string[]> {
  const changed: Record<string, string[]> = {};
  for (const device of view.devices) {
    const next = [...(draft.tags[device.id] ?? [])].sort();
    if (next.join(" ") !== [...device.tags].sort().join(" ")) changed[device.id] = next;
  }
  return changed;
}

/** Whether saving would change anything: compared by meaning, not by shape. */
export function isDirty(draft: Draft, view: AclView): boolean {
  if (Object.keys(changedTags(draft, view)).length > 0) return true;
  return canonical(draft) !== canonical(draftFrom(view));
}

/** One spelling per meaning: pairs and group members sorted, order of drawing forgotten. */
function canonical(draft: Draft): string {
  if (!draft.policy) return "mesh";
  const pairs = draft.edges.map((e) => `${e.src}>${e.dst}:${[...e.ports].sort().join(",")}`).sort();
  const groups = Object.entries(draft.groups)
    .map(([name, members]) => `${name}=${[...members].sort().join(",")}`)
    .sort();
  return JSON.stringify({ pairs, groups });
}

export function kindOf(selector: string): Kind {
  if (selector === "*") return "any";
  const prefix = selector.slice(0, selector.indexOf(":"));
  return (["user", "group", "role", "tag", "svc"].includes(prefix) ? prefix : "user") as Kind;
}

/**
 * Everything a rule could name in this wave, plus whatever the draft names
 * that is not there (yet): a rule for a member who left still has to be
 * visible, or it could never be removed.
 */
export function nodesOf(draft: Draft, view: AclView): GraphNode[] {
  const seen = new Map<string, GraphNode>();
  const add = (id: string, extra: Partial<GraphNode> = {}) => {
    if (!seen.has(id)) seen.set(id, { id, kind: kindOf(id), ...extra });
  };
  for (const member of view.members) add(`user:${member.email}`, { role: member.role });
  for (const role of ["owner", "admin", "member"]) add(`role:${role}`);
  for (const group of Object.keys(draft.groups)) add(group);
  add("*");
  const tags = new Set([...Object.values(draft.tags).flat(), ...draft.extraTags]);
  for (const tag of [...tags].sort()) add(tag);
  for (const service of view.services) add(`svc:${service.name}`);
  for (const edge of draft.edges) {
    add(edge.src);
    add(edge.dst);
  }
  return [...seen.values()];
}

/** Ports as the policy takes them: `*`, `22`, `5000-5001`, optionally `tcp:`/`udp:`. */
export function parsePort(raw: string): string | null {
  const spec = raw.trim().toLowerCase();
  const match = /^(?:(tcp|udp):)?(\*|(\d{1,5})(?:-(\d{1,5}))?)$/.exec(spec);
  if (!match) return null;
  if (match[2] !== "*") {
    const from = Number(match[3]);
    const to = match[4] ? Number(match[4]) : from;
    if (from < 1 || to > 65535 || from > to) return null;
  }
  return spec;
}

/** The same pattern as TAG_PATTERN and GROUP_PATTERN in @wave/proto. */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

// ---- layout ----

export const NODE_W = 184;
export const NODE_H = 64;
export const VIEW_W = 1000;
const ROW = 88;
const COLUMN_X: Record<Kind, number> = { user: 20, any: 20, group: 270, role: 270, tag: 540, svc: 796 };

/**
 * Columns by kind, so arrows mostly run left to right: people and `*` first,
 * then what is made of people (groups, roles), then tags, then services.
 */
export function layout(nodes: GraphNode[]): Record<string, { x: number; y: number }> {
  const columns = new Map<number, GraphNode[]>();
  const order: Kind[] = ["user", "any", "group", "role", "tag", "svc"];
  for (const kind of order) {
    for (const node of nodes.filter((n) => n.kind === kind)) {
      const x = COLUMN_X[kind];
      columns.set(x, [...(columns.get(x) ?? []), node]);
    }
  }
  const out: Record<string, { x: number; y: number }> = {};
  for (const [x, column] of columns)
    for (const [index, node] of column.entries()) out[node.id] = { x, y: 20 + index * ROW };
  return out;
}

export function viewHeight(positions: Record<string, { x: number; y: number }>): number {
  return Math.max(400, ...Object.values(positions).map((p) => p.y + NODE_H + 20));
}
