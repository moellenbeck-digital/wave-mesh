/**
 * Which of Linux' two packet filter interfaces this machine can use, and the
 * little there is to share between the two users of iptables: the port filter
 * of a policy (packet-filter.ts) and the forwarding rules of a connector.
 *
 * nftables is the first choice. Some kernels have none -- Synology's DSM 7 on
 * 4.4 is one -- and there it is iptables or nothing. "Is nft there" is asked
 * of the kernel, not of the PATH: an image that ships the binary on a kernel
 * without nf_tables has no nftables.
 */

import { type CommandRunner, firstLine, type InputRunner, spawnRunner, spawnWithInput } from "./link.ts";

export type NetfilterMode = "auto" | "nft" | "iptables";

/** `WAVE_NETFILTER`. A typo is refused: guessing which filter was meant is how none gets installed. */
export function netfilterMode(env: Record<string, string | undefined> = process.env): NetfilterMode {
  const value = env.WAVE_NETFILTER?.trim().toLowerCase() || "auto";
  if (value === "auto" || value === "nft" || value === "iptables") return value;
  throw new Error(`WAVE_NETFILTER must be auto, nft or iptables, not "${env.WAVE_NETFILTER}"`);
}

/** One flavour of iptables for one address family: `iptables-legacy` and its restore. */
export interface IptablesTool {
  name: string;
  run: CommandRunner;
  restore: InputRunner;
}

export interface NetfilterProbes {
  nft: CommandRunner;
  /** Candidates in the order they are tried; the first that can list a table wins. */
  iptables: IptablesTool[];
  ip6tables: IptablesTool[];
}

export interface IptablesNetfilter {
  kind: "iptables";
  v4: IptablesTool;
  /** Null when no ip6tables works here; `v6Problem` says why. */
  v6: IptablesTool | null;
  v6Problem?: string;
}

export type Netfilter = { kind: "nft" } | IptablesNetfilter | { kind: "none"; reason: string };

/** A binary that is not there is an answer (127), not an exception. */
const quietRunner = (binary: string): CommandRunner => {
  const run = spawnRunner(binary, { LC_ALL: "C", LANG: "C" });
  return async (args) => {
    try {
      return await run(args);
    } catch (error) {
      return { code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
    }
  };
};

export const iptablesTool = (name: string): IptablesTool => ({
  name,
  run: quietRunner(name),
  restore: spawnWithInput(`${name}-restore`),
});

/**
 * The distribution's own `iptables` first: where it works, it is the one the
 * rest of the machine writes with. Where it is the nftables flavour on a
 * kernel without nf_tables it cannot list anything, and `-legacy` is next.
 */
export const systemProbes = (): NetfilterProbes => ({
  nft: quietRunner("nft"),
  iptables: [iptablesTool("iptables"), iptablesTool("iptables-legacy")],
  ip6tables: [iptablesTool("ip6tables"), iptablesTool("ip6tables-legacy")],
});

/** The first candidate that can list a table, or what each of them said. */
async function usable(candidates: IptablesTool[]): Promise<{ tool: IptablesTool } | { problem: string }> {
  const problems: string[] = [];
  for (const tool of candidates) {
    let said = "";
    for (const table of ["filter", "nat"]) {
      const result = await tool.run(["-t", table, "-S"]);
      if (result.code === 0) return { tool };
      said ||= result.code === 127 ? "not installed" : firstLine(result.stderr);
    }
    problems.push(`${tool.name}: ${said}`);
  }
  return { problem: problems.join("; ") };
}

export async function detectNetfilter(
  mode: NetfilterMode,
  probes: NetfilterProbes = systemProbes(),
): Promise<Netfilter> {
  // Asked for by name: taken at its word, and the first rule says if it cannot.
  if (mode === "nft") return { kind: "nft" };

  let nftSaid = "";
  if (mode === "auto") {
    const nft = await probes.nft(["list", "tables"]);
    if (nft.code === 0) return { kind: "nft" };
    nftSaid = nft.code === 127 ? "not installed" : firstLine(nft.stderr);
  }

  const v4 = await usable(probes.iptables);
  if ("problem" in v4) {
    return {
      kind: "none",
      reason:
        mode === "auto"
          ? `neither nft nor iptables is usable (nft: ${nftSaid}; ${v4.problem})`
          : `iptables is not usable (${v4.problem})`,
    };
  }
  const v6 = await usable(probes.ip6tables);
  return "tool" in v6
    ? { kind: "iptables", v4: v4.tool, v6: v6.tool }
    : { kind: "iptables", v4: v4.tool, v6: null, v6Problem: `ip6tables is not usable (${v6.problem})` };
}

/**
 * Detection for a long-running process: remembered once it found something,
 * asked again while it found nothing -- a module loaded later counts.
 */
export function netfilterSelector(
  env: Record<string, string | undefined> = process.env,
  probes: () => NetfilterProbes = systemProbes,
): () => Promise<Netfilter> {
  let found: Netfilter | undefined;
  return async () => {
    if (found) return found;
    const result = await detectNetfilter(netfilterMode(env), probes());
    if (result.kind !== "none") found = result;
    return result;
  };
}

/** A chain of our own, and the built-in chains that lead into it. */
export interface ChainSpec {
  chain: string;
  hooks: { from: string; match?: string }[];
  /** Everything after `-A <chain>`, in order. Null takes the chain away. */
  rules: string[] | null;
}

/** A table the kernel does not have holds nothing of ours. */
const NO_TABLE = /table does not exist/i;

/**
 * The `iptables-restore --noflush` document that makes one table hold exactly
 * these chains, given what `-S` says it holds now. Empty when there is
 * nothing to do.
 *
 * With `--noflush` a chain declared in the document is emptied and nothing else
 * in the table is touched, so the document rebuilds our chains whole. The
 * jumps live in built-in chains that are not ours to empty: every existing one
 * is deleted by its own text and one is inserted again at the top, all in the
 * same commit. Applying it twice is applying it once.
 */
export function restoreDocument(table: string, listing: string, chains: ChainSpec[]): string {
  const lines = listing.split("\n").map((line) => line.trim());
  const existing = new Set(lines.filter((line) => line.startsWith("-N ")).map((line) => line.slice(3)));
  const declare: string[] = [];
  const unhook: string[] = [];
  const write: string[] = [];
  const drop: string[] = [];

  for (const spec of chains) {
    const present = existing.has(spec.chain);
    if (spec.rules === null && !present) continue;
    declare.push(`:${spec.chain} - [0:0]`);
    for (const line of lines) {
      if (!line.startsWith("-A ") || line.startsWith(`-A ${spec.chain} `)) continue;
      const words = line.split(/\s+/);
      if (words[words.indexOf("-j") + 1] === spec.chain && words.includes("-j")) {
        unhook.push(`-D ${line.slice(3)}`);
      }
    }
    if (spec.rules === null) {
      drop.push(`-X ${spec.chain}`);
      continue;
    }
    for (const rule of spec.rules) write.push(`-A ${spec.chain} ${rule}`);
    // Last: nothing leads into a chain before it is filled.
    for (const hook of spec.hooks) {
      write.push(`-I ${hook.from} 1${hook.match ? ` ${hook.match}` : ""} -j ${spec.chain}`);
    }
  }
  if (declare.length === 0) return "";
  return `${[`*${table}`, ...declare, ...unhook, ...write, ...drop, "COMMIT"].join("\n")}\n`;
}

/** Brings one table in line with `chains`, in one commit. Throws with the tool's own complaint. */
export async function syncChains(tool: IptablesTool, table: string, chains: ChainSpec[]): Promise<void> {
  const listing = await tool.run(["-t", table, "-S"]);
  if (listing.code !== 0) {
    if (chains.every((spec) => spec.rules === null) && NO_TABLE.test(listing.stderr)) return;
    throw new Error(`${tool.name} cannot read the ${table} table: ${firstLine(listing.stderr)}`);
  }
  const document = restoreDocument(table, listing.stdout, chains);
  if (!document) return;
  const result = await tool.restore(["--noflush", "--wait"], document);
  if (result.code !== 0) {
    throw new Error(`${tool.name}-restore refused the ${table} rules: ${firstLine(result.stderr)}`);
  }
}
