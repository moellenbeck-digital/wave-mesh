import { AclPolicy, AclSelector } from "@wave/proto";
import { portText } from "./describe.ts";
import { type AclNode, type AclService, compilePolicy, covers } from "./evaluate.ts";
import { invalidTags } from "./store.ts";
import { checkPolicy } from "./validate.ts";

/** One device or service a source may start a connection to, and on which ports. */
export interface ReachPair {
  from: string;
  to: string;
  ports: string;
}

export interface Preview {
  errors: string[];
  warnings: string[];
  /** Null without a policy, or while it does not hold: then nothing is compiled. */
  reach: ReachPair[] | null;
  /** What each selector the caller asked about covers: node ids and service names. */
  covers: Record<string, { nodes: string[]; services: string[] }>;
}

/** The most selectors one preview answers for; a page asks for what it draws. */
const MAX_SELECTORS = 500;

/**
 * A draft judged by the code that judges the real thing.
 *
 * The graph on the policy page edits a policy and the devices' tags together
 * and wants to show what that comes to before anything is saved. Doing that in
 * the browser would mean a second `covers()` -- and the day the two disagree,
 * the page shows one answer and the netmaps carry another. So the draft comes
 * here, the tags are laid over the wave's devices in memory, and the answer is
 * the same compilation that builds the netmaps. Nothing is written.
 */
export function previewPolicy(
  raw: unknown | null,
  subjects: { nodes: (AclNode & { hostname: string })[]; services: AclService[] },
  draftTags: Record<string, string[]>,
  selectors: string[],
): Preview {
  const errors: string[] = [];
  const nodes = subjects.nodes.map((node) => {
    const tags = draftTags[node.id];
    if (!tags) return node;
    const bad = invalidTags(tags);
    if (bad.length > 0) errors.push(`${node.hostname}: not a tag: ${bad.join(", ")}`);
    return { ...node, tags: [...new Set(tags)].sort() };
  });
  const judged = { nodes, services: subjects.services };

  // Groups from the document as written, even when a rule in it does not
  // hold: which devices a group covers is worth showing while the rest is
  // still being fixed.
  const parsed = raw === null ? null : AclPolicy.safeParse(raw);
  const groups = parsed?.success ? (parsed.data.groups ?? {}) : {};
  const coverage: Preview["covers"] = {};
  for (const selector of [...new Set(selectors)].slice(0, MAX_SELECTORS)) {
    if (!AclSelector.safeParse(selector).success) continue;
    coverage[selector] = {
      nodes: selector.startsWith("svc:")
        ? []
        : nodes.filter((node) => covers(selector, node, groups)).map((node) => node.id),
      services: subjects.services
        .filter((service) => selector === "*" || selector === `svc:${service.name}`)
        .map((service) => service.name),
    };
  }

  if (raw === null) return { errors, warnings: [], reach: null, covers: coverage };

  const check = checkPolicy(raw, judged);
  errors.push(...check.errors);
  if (!check.policy || errors.length > 0) {
    return { errors, warnings: check.warnings, reach: null, covers: coverage };
  }

  const compiled = compilePolicy(check.policy, nodes, subjects.services);
  const name = new Map(nodes.map((node) => [node.id, node.hostname]));
  const reach: ReachPair[] = [];
  for (const [from, entry] of compiled.reach) {
    for (const [to, ports] of entry.nodes) {
      reach.push({ from: name.get(from) ?? from, to: name.get(to) ?? to, ports: portText(ports) });
    }
    for (const [service, ports] of entry.services) {
      reach.push({ from: name.get(from) ?? from, to: `svc:${service}`, ports: portText(ports) });
    }
  }
  reach.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return { errors, warnings: check.warnings, reach, covers: coverage };
}
