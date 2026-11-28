import { existsSync } from "node:fs";
import type { FilterPorts, FilterRule } from "@wave/proto";
import type { FilterResult } from "./link.ts";
import { type ChainSpec, type IptablesNetfilter, type IptablesTool, syncChains } from "./netfilter.ts";

/**
 * The port half of a wave's policy (M7, stage two): for Linux as one nftables
 * document or as iptables chains, for macOS and Windows further down.
 *
 * Who may reach this device at all is already decided by the netmap: a peer
 * the policy hides is not a WireGuard peer here. What is left for the device
 * is *which ports*, and *which direction* -- a grant from A to B puts each in
 * the other's netmap, so B could otherwise open connections to A as well.
 *
 * The chain hangs off prerouting at priority -150, before the connector's
 * dstnat (-100) and after conntrack (-200). One rule set therefore covers both
 * a laptop's own services and the service addresses a connector forwards into
 * its cluster: at this point a packet still carries the address it was sent
 * to. Replies to connections this device opened pass on conntrack's word, and
 * ICMP passes always -- ping and path MTU discovery are how a tunnel is
 * debugged, and neither opens anything.
 *
 * Written as a whole table that is created, deleted and written again, the
 * same opening the connector uses: applying it twice is applying it once, and a
 * daemon that restarts cannot know what it left behind.
 */
export function tableName(iface: string): string {
  return `wave-acl-${iface}`;
}

const family = (cidr: string): "ip" | "ip6" => (cidr.includes(":") ? "ip6" : "ip");

const portSet = (ranges: FilterPorts[], proto: "tcp" | "udp"): string | null => {
  const items = ranges
    .filter((range) => range.proto === "any" || range.proto === proto)
    .map((range) => (range.from === range.to ? `${range.from}` : `${range.from}-${range.to}`));
  return items.length > 0 ? `{ ${[...new Set(items)].join(", ")} }` : null;
};

function ruleLines(rule: FilterRule): string[] {
  const lines: string[] = [];
  for (const fam of ["ip", "ip6"] as const) {
    const src = rule.src.filter((cidr) => family(cidr) === fam);
    const dst = rule.dst.filter((cidr) => family(cidr) === fam);
    if (src.length === 0 || dst.length === 0) continue;
    const match = `${fam} saddr { ${src.join(", ")} } ${fam} daddr { ${dst.join(", ")} }`;
    for (const proto of ["tcp", "udp"] as const) {
      const ports = portSet(rule.ports, proto);
      if (ports) lines.push(`    ${match} ${proto} dport ${ports} accept`);
    }
  }
  return lines;
}

/**
 * The document for `nft -f -`. With `rules` null -- no policy -- it only takes
 * away a table an earlier policy left, and the tunnel is back to letting in
 * whatever its peers send.
 */
export function nftFilterRuleset(iface: string, rules: FilterRule[] | null): string {
  const table = `inet ${tableName(iface)}`;
  const opening = [`table ${table} {}`, `delete table ${table}`];
  if (rules === null) return `${opening.join("\n")}\n`;

  return `${[
    ...opening,
    `table ${table} {`,
    "  chain inbound {",
    "    type filter hook prerouting priority -150; policy accept;",
    `    iifname "${iface}" jump rules`,
    "  }",
    "  chain rules {",
    "    ct state established,related accept",
    "    meta l4proto { icmp, ipv6-icmp } accept",
    ...rules.flatMap(ruleLines),
    "    drop",
    "  }",
    "}",
  ].join("\n")}\n`;
}

/**
 * The same rules where the kernel has no nftables, as iptables chains.
 *
 * The nft chain sits at prerouting priority -150, which in iptables is exactly
 * the mangle table's PREROUTING: after conntrack, before the connector's DNAT.
 * A kernel without that table gets the filter table instead, on INPUT and
 * FORWARD. There a connector's DNAT has already happened, so the rules name
 * the address and port a packet was *sent* to, which conntrack remembers.
 *
 * What is let in leaves the chain with RETURN, not ACCEPT: an accept here would
 * also overrule the machine's own firewall further down, which the nft table
 * never does. What is not let in is dropped here, and that is final.
 */
export type FilterTable = "mangle" | "filter";

export const iptablesChainName = (iface: string): string => `WAVE-ACL-${iface}`;

/** Addresses go into a line-based document; anything that is not one stays out. */
function checked(cidr: string): string {
  if (!/^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(cidr)) throw new Error(`not an address: ${JSON.stringify(cidr)}`);
  return cidr;
}

export function iptablesFilterRules(rules: FilterRule[], fam: "ip" | "ip6", table: FilterTable): string[] {
  const lines = [
    "-m conntrack --ctstate RELATED,ESTABLISHED -j RETURN",
    `-p ${fam === "ip" ? "icmp" : "ipv6-icmp"} -j RETURN`,
  ];
  for (const rule of rules) {
    const src = rule.src.filter((cidr) => family(cidr) === fam).map(checked);
    const dst = rule.dst.filter((cidr) => family(cidr) === fam).map(checked);
    for (const proto of ["tcp", "udp"] as const) {
      const ports = [
        ...new Set(
          rule.ports
            .filter((range) => range.proto === "any" || range.proto === proto)
            .map((range) => (range.from === range.to ? `${range.from}` : `${range.from}:${range.to}`)),
        ),
      ];
      for (const from of src) {
        for (const to of dst) {
          for (const port of ports) {
            lines.push(
              table === "mangle"
                ? `-s ${from} -d ${to} -p ${proto} -m ${proto} --dport ${port} -j RETURN`
                : `-s ${from} -p ${proto} -m conntrack --ctorigdst ${to} --ctorigdstport ${port} -j RETURN`,
            );
          }
        }
      }
    }
  }
  lines.push("-j DROP");
  return lines;
}

/** The chain of one interface in one table; with `rules` null, its removal. */
export function iptablesFilterChain(
  iface: string,
  rules: FilterRule[] | null,
  fam: "ip" | "ip6",
  table: FilterTable,
): ChainSpec {
  if (!/^[\w.-]{1,15}$/.test(iface)) throw new Error(`not an interface name: ${JSON.stringify(iface)}`);
  const match = `-i ${iface}`;
  return {
    chain: iptablesChainName(iface),
    hooks: (table === "mangle" ? ["PREROUTING"] : ["INPUT", "FORWARD"]).map((from) => ({ from, match })),
    rules: rules === null ? null : iptablesFilterRules(rules, fam, table),
  };
}

/** Whether this machine speaks IPv6 at all; without a stack there is nothing to leave open. */
export const ipv6Present = (): boolean => existsSync("/proc/net/if_inet6");

async function syncFamily(
  tool: IptablesTool,
  iface: string,
  rules: FilterRule[] | null,
  fam: "ip" | "ip6",
): Promise<void> {
  let wanted: FilterTable | null = null;
  if (rules !== null) {
    wanted = (await tool.run(["-t", "mangle", "-S", "PREROUTING"])).code === 0 ? "mangle" : "filter";
    await syncChains(tool, wanted, [iptablesFilterChain(iface, rules, fam, wanted)]);
  }
  // Whatever an earlier run left in the other table -- or in both, without a policy.
  for (const table of ["mangle", "filter"] as const) {
    if (table !== wanted) await syncChains(tool, table, [iptablesFilterChain(iface, null, fam, table)]);
  }
}

/**
 * Installs or removes the policy with iptables, one family at a time. Never
 * throws. A family that cannot be filtered is reported as not enforced, with
 * the family named -- even though the other one holds, because a half-open
 * policy must not read as an enforced one.
 */
export async function syncIptablesFilter(
  netfilter: IptablesNetfilter,
  iface: string,
  rules: FilterRule[] | null,
  hasIpv6: () => boolean = ipv6Present,
): Promise<FilterResult> {
  const problems: string[] = [];
  for (const [fam, label, tool] of [
    ["ip", "IPv4", netfilter.v4],
    ["ip6", "IPv6", netfilter.v6],
  ] as const) {
    if (!tool) {
      if (rules !== null && hasIpv6()) {
        problems.push(`${label} is not filtered: ${netfilter.v6Problem ?? "ip6tables is not usable"}`);
      }
      continue;
    }
    try {
      await syncFamily(tool, iface, rules, fam);
    } catch (error) {
      problems.push(`${label} is not filtered: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return problems.length === 0 ? { enforced: true } : { enforced: false, reason: problems.join("; ") };
}

/**
 * The same rules for macOS, as a pf anchor (M7, stage two).
 *
 * macOS' own /etc/pf.conf evaluates `anchor "com.apple/*"`, so rules loaded
 * into an anchor under it are live without touching the system's
 * configuration -- and they go when the anchor is flushed. pf is stateful:
 * `pass out ... keep state` is what lets the replies to this device's own
 * connections back in, the part conntrack does on Linux. Every rule is
 * `quick`, so nothing in a later anchor can reopen what this one closed.
 */
export function pfAnchorName(iface: string): string {
  return `com.apple/wave.${iface}`;
}

const pfPorts = (ranges: FilterPorts[], proto: "tcp" | "udp"): string | null => {
  const items = ranges
    .filter((range) => range.proto === "any" || range.proto === proto)
    .map((range) => (range.from === range.to ? `${range.from}` : `${range.from}:${range.to}`));
  return items.length > 0 ? `{ ${[...new Set(items)].join(", ")} }` : null;
};

const bare = (cidr: string): string =>
  cidr.endsWith("/32") || cidr.endsWith("/128") ? (cidr.split("/")[0] ?? cidr) : cidr;

export function pfAnchorRules(iface: string, rules: FilterRule[]): string {
  const on = `on ${iface}`;
  const lines = [
    `pass out quick ${on} all keep state`,
    `pass in quick ${on} inet proto icmp all`,
    `pass in quick ${on} inet6 proto ipv6-icmp all`,
  ];
  for (const rule of rules) {
    for (const fam of ["ip", "ip6"] as const) {
      const src = rule.src.filter((cidr) => family(cidr) === fam).map(bare);
      const dst = rule.dst.filter((cidr) => family(cidr) === fam).map(bare);
      if (src.length === 0 || dst.length === 0) continue;
      const af = fam === "ip" ? "inet" : "inet6";
      for (const proto of ["tcp", "udp"] as const) {
        const ports = pfPorts(rule.ports, proto);
        if (!ports) continue;
        lines.push(
          `pass in quick ${on} ${af} proto ${proto} from { ${src.join(", ")} } to { ${dst.join(", ")} } port ${ports} keep state`,
        );
      }
    }
  }
  lines.push(`block drop in quick ${on} all`);
  return `${lines.join("\n")}\n`;
}

/**
 * The same rules for Windows, as Windows Firewall rules (M7, stage two).
 *
 * Inside out, and for a reason: in the Windows Firewall a block rule beats
 * every allow rule, so "block all, allow these" cannot be said -- the block
 * would take the allows with it. What is written instead is only blocks, for
 * the complement of what the policy grants: everything from a source it names
 * nothing for, and from each source it does, every TCP and UDP port outside
 * the granted ones. Replies to this device's own connections are not judged
 * by inbound rules at all, which is what conntrack and `keep state` do
 * elsewhere.
 */
export function firewallGroup(iface: string): string {
  return `wave-acl-${iface}`;
}

interface Span {
  from: number;
  to: number;
}

/** The ports in 1..65535 that the given ranges leave out, merged. */
export function complementPorts(allowed: Span[]): Span[] {
  const sorted = [...allowed].sort((a, b) => a.from - b.from);
  const gaps: Span[] = [];
  let next = 1;
  for (const span of sorted) {
    if (span.from > next) gaps.push({ from: next, to: span.from - 1 });
    next = Math.max(next, span.to + 1);
  }
  if (next <= 65535) gaps.push({ from: next, to: 65535 });
  return gaps;
}

const V4_MAX = (1n << 32n) - 1n;
const V6_MAX = (1n << 128n) - 1n;

function toBig(address: string): bigint {
  if (!address.includes(":")) {
    return address.split(".").reduce((value, part) => (value << 8n) | BigInt(Number(part)), 0n);
  }
  const [head = "", tail = ""] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = address.includes("::") ? (tail ? tail.split(":") : []) : [];
  const groups = address.includes("::")
    ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    : address.split(":");
  return groups.reduce((value, group) => (value << 16n) | BigInt(Number.parseInt(group || "0", 16)), 0n);
}

function fromBig(value: bigint, v6: boolean): string {
  if (!v6) return [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 255n)).join(".");
  const groups: string[] = [];
  for (let shift = 112n; shift >= 0n; shift -= 16n) groups.push(((value >> shift) & 0xffffn).toString(16));
  return groups.join(":");
}

/**
 * Every address of one family except the given hosts, as `from-to` ranges --
 * the form `-RemoteAddress` takes. Hosts only: the policy's sources are
 * devices, one /32 and one /128 each.
 */
export function complementAddresses(hosts: string[], v6: boolean): string[] {
  const max = v6 ? V6_MAX : V4_MAX;
  const points = [...new Set(hosts.map((host) => toBig(host.split("/")[0] ?? host)))].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const ranges: string[] = [];
  let next = 0n;
  for (const point of points) {
    if (point > next) ranges.push(`${fromBig(next, v6)}-${fromBig(point - 1n, v6)}`);
    next = point + 1n;
  }
  if (next <= max) ranges.push(`${fromBig(next, v6)}-${fromBig(max, v6)}`);
  return ranges;
}

const psList = (items: string[]): string => `@(${items.map((item) => `'${item}'`).join(",")})`;

/**
 * The whole script: remove what the group held, then write it again. With
 * `rules` null only the removal -- no policy, nothing blocked.
 */
export function windowsFirewallScript(iface: string, rules: FilterRule[] | null): string {
  const group = firewallGroup(iface);
  const quoted = `'${iface.replace(/'/g, "''")}'`;
  const lines = [
    `Get-NetFirewallRule -Group '${group}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction Stop`,
  ];
  if (rules === null) return lines.join("\n");

  let count = 0;
  const block = (remote: string[], protocol: string, ports?: Span[]) => {
    count++;
    const local = ports
      ? ` -LocalPort ${psList(ports.map((p) => (p.from === p.to ? `${p.from}` : `${p.from}-${p.to}`)))}`
      : "";
    lines.push(
      `New-NetFirewallRule -DisplayName '${group} ${count}' -Group '${group}' -Direction Inbound -Action Block ` +
        `-InterfaceAlias ${quoted} -RemoteAddress ${psList(remote)} -Protocol ${protocol}${local} ` +
        "-ErrorAction Stop | Out-Null",
    );
  };

  // Per source, what it may reach here -- the destinations are this device's
  // own addresses, which the interface scope already says.
  const bySource = new Map<string, FilterPorts[]>();
  for (const rule of rules) {
    for (const src of rule.src) bySource.set(src, [...(bySource.get(src) ?? []), ...rule.ports]);
  }

  for (const v6 of [false, true]) {
    const sources = [...bySource.keys()].filter((src) => src.includes(":") === v6);
    // Everyone the policy names nothing for: everything, every protocol.
    block(complementAddresses(sources, v6), "Any");
    for (const src of sources) {
      const ports = bySource.get(src) ?? [];
      for (const proto of ["tcp", "udp"] as const) {
        const open = ports.filter((range) => range.proto === "any" || range.proto === proto);
        const closed = complementPorts(open);
        if (closed.length === 0) continue;
        const host = src.split("/")[0] ?? src;
        block([host], proto.toUpperCase(), open.length === 0 ? undefined : closed);
      }
    }
  }
  return lines.join("\n");
}
