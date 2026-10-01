/** The iproute2 backend. */

import type { FilterRule } from "@wave/proto";
import {
  type CommandRunner,
  canonicalAddress,
  type DnsResult,
  type DnsSettings,
  diffAddresses,
  type FilterResult,
  firstLine,
  type InputRunner,
  type LinkBackend,
  normalizeRoute,
  spawnRunner,
  spawnWithInputFile,
} from "./link.ts";
import { nftFilterRuleset } from "./packet-filter.ts";

export function parseAddresses(output: string): string[] {
  const found: string[] = [];
  for (const line of output.split("\n")) {
    const match = /\s(?:inet6?)\s(\S+)/.exec(line);
    if (match?.[1]) found.push(match[1]);
  }
  return found;
}

export function parseRoutes(output: string): string[] {
  const routes: string[] = [];
  for (const line of output.split("\n")) {
    const destination = line.trim().split(/\s+/)[0];
    if (destination && destination !== "default") routes.push(destination);
  }
  return routes;
}

export class LinuxLink implements LinkBackend {
  constructor(
    private readonly run: CommandRunner = spawnRunner("ip"),
    private readonly resolvectl: CommandRunner = spawnRunner("resolvectl"),
    private readonly nft: InputRunner = spawnWithInputFile("nft"),
  ) {}

  /** Whatever is on the interface is replaced whole; see packet-filter.ts. */
  async syncFilter(iface: string, rules: FilterRule[] | null): Promise<FilterResult> {
    const result = await this.nft(["-f", "-"], nftFilterRuleset(iface, rules));
    if (result.code === 0) return { enforced: true };
    // Without nft there is no table an earlier policy could have left, so
    // "no policy" is already true -- and saying otherwise would have the
    // engine try again with every netmap on every machine without nftables.
    if (rules === null && result.code === 127) return { enforced: true };
    return {
      enforced: false,
      reason:
        result.code === 127 ? "nft is not installed" : `nft refused the rules: ${firstLine(result.stderr)}`,
    };
  }

  private async ip(args: string[]): Promise<string> {
    const result = await this.run(args);
    if (result.code !== 0) throw new Error(`ip ${args.join(" ")} failed: ${result.stderr.trim()}`);
    return result.stdout;
  }

  /**
   * Linux routes an interface's own address through lo, so it reaches us -- and
   * because each wave has an address of its own, port 53 is free on every one
   * of them and no wave has to move.
   */
  resolverEndpoint(tunnelAddress: string, _index = 0): { address: string; port: number } {
    return { address: tunnelAddress, port: 53 };
  }

  async setUp(iface: string, mtu: number): Promise<void> {
    await this.ip(["link", "set", "dev", iface, "mtu", String(mtu), "up"]);
  }

  async syncAddresses(iface: string, desired: string[]) {
    const current = parseAddresses(await this.ip(["-o", "addr", "show", "dev", iface]));
    const { add, remove } = diffAddresses(current, desired);
    for (const address of add) await this.ip(["addr", "add", address, "dev", iface]);
    for (const address of remove) await this.ip(["addr", "del", address, "dev", iface]);
    return { added: add, removed: remove };
  }

  async syncRoutes(iface: string, desired: string[]) {
    const added: string[] = [];
    const removed: string[] = [];

    for (const family of ["-4", "-6"] as const) {
      const current = parseRoutes(await this.ip([family, "route", "show", "dev", iface]));
      const currentCanonical = new Set(current.map(canonicalAddress));
      const wanted = desired.filter((route) => (family === "-6") === route.includes(":"));
      const wantedCanonical = new Set(wanted.map((route) => canonicalAddress(normalizeRoute(route))));

      for (const route of wanted) {
        if (currentCanonical.has(canonicalAddress(normalizeRoute(route)))) continue;
        await this.ip(["route", "replace", route, "dev", iface]);
        added.push(route);
      }
      for (const route of current) {
        if (wantedCanonical.has(canonicalAddress(route))) continue;
        await this.ip(["route", "del", route, "dev", iface]);
        removed.push(route);
      }
    }
    return { added, removed };
  }

  /**
   * systemd-resolved can route single domains to one interface's resolver. The
   * "~" prefix makes a domain routing-only: names under it are asked here,
   * everything else keeps going to the machine's usual resolvers. Without
   * resolved there is no way to do that short of rewriting /etc/resolv.conf,
   * which would capture every name on the system -- so we decline instead.
   *
   * The wave's own zone is listed *without* the "~", which makes it a search
   * domain on top of a routing one: that is what lets `ping laptop` find
   * laptop.rl.wave.internal. A search domain is only ever appended to a name
   * that is not already qualified, so nothing outside the wave changes meaning;
   * an unqualified name that also exists elsewhere now has one more candidate,
   * and our resolver answers NXDOMAIN for anything the wave does not know.
   */
  async configureDns(iface: string, dns: DnsSettings): Promise<DnsResult> {
    // Nothing asked for, so nothing failed.
    if (dns.suffixes.length === 0) return { routed: true, searched: true };
    if ((await this.resolvectl(["--version"])).code !== 0) return { routed: false, searched: false };

    const server = await this.resolvectl(["dns", iface, dns.resolver]);
    if (server.code !== 0) return { routed: false, searched: false };

    const domains = await this.resolvectl([
      "domain",
      iface,
      ...dns.suffixes.map((suffix) => (suffix === dns.search ? suffix : `~${suffix}`)),
    ]);
    if (domains.code !== 0) return { routed: false, searched: false };
    return { routed: true, searched: dns.search !== undefined };
  }

  async revertDns(iface: string): Promise<void> {
    await this.resolvectl(["revert", iface]);
  }

  async remove(iface: string): Promise<void> {
    // The table is not part of the interface and would outlive it. Harmless
    // -- it matches a name that no longer exists -- but a leftover all the same.
    await this.syncFilter(iface, null);
    const result = await this.run(["link", "del", "dev", iface]);
    if (result.code !== 0 && !result.stderr.includes("Cannot find device")) {
      throw new Error(`ip link del ${iface} failed: ${result.stderr.trim()}`);
    }
  }
}
