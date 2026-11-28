/**
 * Puts the connector's forwarding rules into the kernel, with nft or -- where
 * there is none -- with iptables (netfilter.ts says which).
 */
import { existsSync, readFileSync } from "node:fs";
import {
  type IptablesNetfilter,
  type IptablesTool,
  type Netfilter,
  syncChains,
} from "@wave/client/netfilter";
import { type ConnectorRules, type IptablesFeatures, iptablesTables, nftRuleset } from "./rules.ts";

export interface Forwarder {
  name: string;
  /** The rules as text: what is compared to see whether anything changed. */
  render(rules: ConnectorRules): string;
  apply(ruleset: string, rules: ConnectorRules): Promise<void>;
  /** Takes the rules out again when the connector stops. Absent where they stay. */
  clear?(): Promise<void>;
}

/** Hands the ruleset to nft. One document, one call, all or nothing. */
export async function applyWithNft(ruleset: string): Promise<void> {
  const child = Bun.spawn(["nft", "-f", "-"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(ruleset);
  await child.stdin.end();
  const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`nft exited ${code}: ${error.trim().slice(0, 300)}`);
}

export const nftForwarder = (): Forwarder => ({ name: "nft", render: nftRuleset, apply: applyWithNft });

export interface Ipv6State {
  /** Whether there is an IPv6 stack at all. */
  present: () => boolean;
  /** Whether the kernel would pass IPv6 on from one interface to another. */
  forwarding: () => boolean;
}

export const systemIpv6: Ipv6State = {
  present: () => existsSync("/proc/net/if_inet6"),
  forwarding: () => {
    try {
      return readFileSync("/proc/sys/net/ipv6/conf/all/forwarding", "utf8").trim() !== "0";
    } catch {
      // Not readable is not "off".
      return true;
    }
  },
};

const said = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The iptables half. Each table is one atomic commit, and the order between
 * them is the safety: the filter chains (what may *not* pass) go in before the
 * nat chains open the way, and come out after them.
 *
 * IPv6 is never left open quietly. Where it cannot be filtered, that is fine
 * only if the kernel does not forward it and nothing asked for it; otherwise
 * nothing at all is applied and the reason is thrown.
 */
export function iptablesForwarder(
  netfilter: IptablesNetfilter,
  options: { log?: (message: string) => void; ipv6?: Ipv6State } = {},
): Forwarder {
  const log = options.log ?? console.log;
  const ipv6 = options.ipv6 ?? systemIpv6;
  const warned = new Set<string>();
  const warnOnce = (message: string) => {
    if (warned.has(message)) return;
    warned.add(message);
    log(message);
  };

  /** The filter chains, giving up the extras a kernel may lack, one at a time. */
  const filter = async (tool: IptablesTool, rules: ConnectorRules, fam: "ip" | "ip6") => {
    const attempts: IptablesFeatures[] = [
      { clampMss: true, reject: true },
      { clampMss: false, reject: true },
      ...(fam === "ip6"
        ? [
            { clampMss: true, reject: false },
            { clampMss: false, reject: false },
          ]
        : []),
    ];
    let first: unknown;
    for (const features of attempts) {
      try {
        await syncChains(tool, "filter", iptablesTables(rules, fam, features).filter);
        const without = [
          ...(features.clampMss ? [] : ["the MSS clamp (TCPMSS)"]),
          ...(features.reject ? [] : ["REJECT (dropping instead)"]),
        ];
        if (without.length > 0) {
          warnOnce(
            `${tool.name}: the kernel refused the full rules (${said(first)}); without ${without.join(" and ")}`,
          );
        }
        return;
      } catch (error) {
        first ??= error;
      }
    }
    throw first;
  };

  const apply = async (rules: ConnectorRules) => {
    const { v4, v6 } = netfilter;
    const wantsV6 = Boolean(rules.backend.ipv6);
    /** Whether doing without IPv6 rules is safe; throws where it is not. */
    const withoutV6 = (why: string) => {
      if (wantsV6) throw new Error(`an IPv6 backend is set, but ${why}`);
      if (ipv6.present() && ipv6.forwarding()) {
        throw new Error(
          `IPv6 forwarding is on and cannot be filtered: ${why}. Set net.ipv6.conf.all.forwarding=0`,
        );
      }
      if (ipv6.present()) {
        warnOnce(`no IPv6 rules: ${why}. IPv6 is not forwarded here, and its service ports go unanswered`);
      }
    };

    // Everything that can refuse does so before the way is opened.
    await filter(v4, rules, "ip");
    let useV6 = v6;
    if (!v6) withoutV6(netfilter.v6Problem ?? "ip6tables is not usable");
    else {
      try {
        await filter(v6, rules, "ip6");
      } catch (error) {
        withoutV6(said(error));
        useV6 = null;
      }
    }
    if (useV6) await syncChains(useV6, "nat", iptablesTables(rules, "ip6").nat);
    await syncChains(v4, "nat", iptablesTables(rules, "ip").nat);
  };

  const clear = async () => {
    // Any rules will do: only the chain names matter for taking them away.
    const empty: ConnectorRules = {
      interfaceName: "wave0",
      ownAddresses: [],
      backend: { ipv4: "" },
      ports: [],
      mtu: 1280,
    };
    const problems: string[] = [];
    for (const table of ["nat", "filter"] as const) {
      for (const [fam, tool] of [
        ["ip", netfilter.v4],
        ["ip6", netfilter.v6],
      ] as const) {
        if (!tool) continue;
        const gone = iptablesTables(empty, fam)[table].map((spec) => ({ ...spec, rules: null }));
        await syncChains(tool, table, gone).catch((error) => problems.push(said(error)));
      }
    }
    if (problems.length > 0) throw new Error(problems.join("; "));
  };

  // One after the other, and nothing after the end: an apply that was still
  // running when the signal came must not put back what clear() just removed.
  let queue: Promise<unknown> = Promise.resolve();
  let stopped = false;
  const queued = (work: () => Promise<void>): Promise<void> => {
    const next = queue.then(work);
    queue = next.catch(() => {});
    return next;
  };

  return {
    name: `iptables (${netfilter.v4.name})`,
    render: (rules) => JSON.stringify({ v4: iptablesTables(rules, "ip"), v6: iptablesTables(rules, "ip6") }),
    apply: (_ruleset, rules) => queued(async () => (stopped ? undefined : apply(rules))),
    clear: () => {
      stopped = true;
      return queued(clear);
    },
  };
}

export function forwarderFor(netfilter: Netfilter, log?: (message: string) => void): Forwarder {
  if (netfilter.kind === "none") throw new Error(netfilter.reason);
  return netfilter.kind === "nft" ? nftForwarder() : iptablesForwarder(netfilter, { log });
}
