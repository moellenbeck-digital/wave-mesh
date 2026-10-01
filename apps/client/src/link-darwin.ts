/**
 * The ifconfig/route backend for macOS. Two things differ from Linux beyond
 * the command names: a utun interface only exists while its wireguard-go
 * process runs, so tearing it down means signalling that process, and the
 * routing table mixes our routes with ones the kernel derived from an address,
 * which we must not touch.
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  isIpv6,
  type LinkBackend,
  normalizeRoute,
  spawnRunner,
  spawnWithInput,
} from "./link.ts";
import { pfAnchorName, pfAnchorRules } from "./packet-filter.ts";

/** Where wireguard-go keeps its per-interface files on Darwin. */
export const RUN_DIR = "/var/run/wireguard";
/** First port for a wave's resolver; the wave's number is added to it. */
const DNS_BASE_PORT = 5354;
export const pidFilePath = (iface: string): string => `${RUN_DIR}/${iface}.pid`;
/** Where wireguard-go reports the utun the kernel gave it. */
export const nameFilePath = (iface: string): string => `${RUN_DIR}/${iface}.name`;

/** ifconfig prints the IPv4 netmask as hex; contiguous, so counting bits is enough. */
const prefixFromNetmask = (hex: string): number => {
  let value = Number.parseInt(hex, 16) >>> 0;
  let bits = 0;
  while (value !== 0) {
    bits += value & 1;
    value >>>= 1;
  }
  return bits;
};

/**
 * Reads the addresses out of `ifconfig <iface>`. IPv4 carries a hex netmask
 * and, on a point-to-point interface, a peer address; IPv6 carries a prefix
 * length and a scope suffix the kernel appends to link-local addresses.
 */
export function parseAddresses(output: string): string[] {
  const found: string[] = [];
  for (const line of output.split("\n")) {
    const v6 = /^\s*inet6\s+([^\s%]+)(?:%\S+)?\s+prefixlen\s+(\d+)/.exec(line);
    if (v6?.[1] && v6[2]) {
      found.push(`${v6[1]}/${v6[2]}`);
      continue;
    }
    const v4 = /^\s*inet\s+(\S+).*?netmask\s+(0x[0-9a-fA-F]+)/.exec(line);
    if (v4?.[1] && v4[2]) found.push(`${v4[1]}/${prefixFromNetmask(v4[2])}`);
  }
  return found;
}

/** True when `route add` failed only because the route was already there. */
export const routeExists = (result: { stdout: string; stderr: string }): boolean =>
  `${result.stdout}${result.stderr}`.includes("File exists");

/** netstat abbreviates a network as "100.64/10" and a host route as a bare address. */
export function expandDestination(destination: string): string {
  if (isIpv6(destination)) return destination;
  const [address, prefix] = destination.split("/");
  if (!address) return destination;
  const octets = address.split(".");
  while (octets.length < 4) octets.push("0");
  return prefix ? `${octets.join(".")}/${prefix}` : octets.join(".");
}

/**
 * The routes on `iface` that we could have put there. Unlike `ip route show
 * dev`, the table also carries what the kernel derived from an address -- the
 * host route to ourselves, broadcast, multicast, link-local -- and deleting
 * those would break the interface. Ours are the static ones (S) that the
 * kernel did not scope or clone itself (I, i, m).
 */
export function parseRoutes(output: string, iface: string): string[] {
  const routes: string[] = [];
  for (const line of output.split("\n")) {
    const fields = line.trim().split(/\s+/);
    const [destination, , flags] = fields;
    if (!destination || !flags || destination === "default") continue;
    // The interface has a column of its own; a gateway may merely name it as a scope.
    if (!fields.slice(3).includes(iface)) continue;
    if (!flags.includes("S") || /[Iim]/.test(flags)) continue;
    routes.push(expandDestination(destination));
  }
  return routes;
}

/** Every command is injectable so the tests never touch the real network stack. */
export interface DarwinLinkOptions {
  /** Directory of per-domain resolver files; overridable for tests. */
  resolverDir?: string;
  writeFile?: (path: string, content: string) => Promise<void>;
  removeFile?: (path: string) => Promise<void>;
  ifconfig?: CommandRunner;
  route?: CommandRunner;
  netstat?: CommandRunner;
  kill?: (pid: number) => void;
  pidFile?: (iface: string) => string;
  pfctl?: InputRunner;
}

export class DarwinLink implements LinkBackend {
  private readonly ifconfig: CommandRunner;
  private readonly route: CommandRunner;
  private readonly netstat: CommandRunner;
  private readonly kill: (pid: number) => void;
  private readonly pidFile: (iface: string) => string;
  private readonly resolverDir: string;
  private readonly writeFile: (path: string, content: string) => Promise<void>;
  private readonly removeFile: (path: string) => Promise<void>;
  private readonly pfctl: InputRunner;
  /**
   * The reference `pfctl -E` handed out. pf is enabled by count, not by flag:
   * whoever turns it on gets a token and gives it back, and pf stays on while
   * anyone holds one -- so this never switches it off under somebody else.
   */
  private pfToken?: string;

  constructor(options: DarwinLinkOptions = {}) {
    this.ifconfig = options.ifconfig ?? spawnRunner("ifconfig");
    this.route = options.route ?? spawnRunner("route");
    this.netstat = options.netstat ?? spawnRunner("netstat");
    this.kill = options.kill ?? ((pid) => process.kill(pid, "SIGTERM"));
    this.pidFile = options.pidFile ?? pidFilePath;
    this.resolverDir = options.resolverDir ?? "/etc/resolver";
    this.writeFile = options.writeFile ?? ((path, content) => writeFile(path, content, { mode: 0o644 }));
    this.removeFile = options.removeFile ?? ((path) => rm(path, { force: true }));
    this.pfctl = options.pfctl ?? spawnWithInput("pfctl");
  }

  /**
   * A utun is point-to-point, and macOS sends a packet addressed to its own
   * tunnel address out of the interface instead of delivering it locally --
   * `ping` to it times out, and so would every query to a resolver bound
   * there. Loopback is the only address on this host that answers.
   */
  resolverEndpoint(_tunnelAddress: string, index = 0): { address: string; port: number } {
    // All waves share loopback here, so the port is what keeps them apart --
    // 5354 upwards, well clear of anything a Mac runs by default, and 53 is not
    // an option anyway once the second wave wants it.
    return { address: "127.0.0.1", port: DNS_BASE_PORT + index };
  }

  /**
   * macOS resolves a domain through a file named after it in /etc/resolver,
   * which is split DNS by construction: only names under that domain are sent
   * here, and the rest of the system keeps its usual resolvers.
   */
  /**
   * One file per suffix is all /etc/resolver offers: it routes names that
   * already carry the suffix, but it cannot make the system append one to a
   * bare `laptop`. macOS keeps search domains in the network service's own
   * configuration -- the user's Wi-Fi or Ethernet -- and rewriting that would
   * reach well outside the wave. So routing works here and searching does not,
   * and the caller is told which, rather than being left to guess.
   */
  async configureDns(_iface: string, dns: DnsSettings): Promise<DnsResult> {
    await mkdir(this.resolverDir, { recursive: true });
    // resolver(5) takes the port on a line of its own; without it macOS would
    // ask 53 and never reach the second wave's resolver.
    const body = `nameserver ${dns.resolver}\n` + (dns.port && dns.port !== 53 ? `port ${dns.port}\n` : "");
    for (const suffix of dns.suffixes) {
      await this.writeFile(join(this.resolverDir, suffix), body);
    }
    return { routed: true, searched: false };
  }

  async syncFilter(iface: string, rules: FilterRule[] | null): Promise<FilterResult> {
    const anchor = pfAnchorName(iface);
    if (rules === null) {
      // Nothing to hold: empty the anchor, hand the reference back.
      await this.pfctl(["-a", anchor, "-F", "all"], "");
      if (this.pfToken) await this.pfctl(["-X", this.pfToken], "");
      this.pfToken = undefined;
      return { enforced: true };
    }

    if (!this.pfToken) {
      const enabled = await this.pfctl(["-E"], "");
      const token = /Token\s*:\s*(\d+)/.exec(`${enabled.stdout}\n${enabled.stderr}`)?.[1];
      if (enabled.code !== 0 || !token) {
        return { enforced: false, reason: `pf could not be enabled: ${firstLine(enabled.stderr)}` };
      }
      this.pfToken = token;
    }
    const loaded = await this.pfctl(["-a", anchor, "-f", "-"], pfAnchorRules(iface, rules));
    if (loaded.code !== 0)
      return { enforced: false, reason: `pf refused the rules: ${firstLine(loaded.stderr)}` };
    return { enforced: true };
  }

  async revertDns(_iface: string, dns: DnsSettings): Promise<void> {
    for (const suffix of dns.suffixes) {
      await this.removeFile(join(this.resolverDir, suffix)).catch(() => {});
    }
  }

  private async run(args: string[]): Promise<string> {
    const result = await this.ifconfig(args);
    if (result.code !== 0) throw new Error(`ifconfig ${args.join(" ")} failed: ${result.stderr.trim()}`);
    return result.stdout;
  }

  async setUp(iface: string, mtu: number): Promise<void> {
    await this.run([iface, "mtu", String(mtu), "up"]);
  }

  async syncAddresses(iface: string, desired: string[]) {
    const current = parseAddresses(await this.run([iface]));
    const { add, remove } = diffAddresses(current, desired);

    for (const address of add) {
      // utun is point-to-point: IPv4 wants the peer address spelled out, and
      // pointing it at ourselves is what makes a /32 usable.
      await this.run(
        isIpv6(address)
          ? [iface, "inet6", address, "alias"]
          : [iface, "inet", address, address.split("/")[0] ?? address, "alias"],
      );
    }
    for (const address of remove) {
      const bare = address.split("/")[0] ?? address;
      await this.run([iface, isIpv6(address) ? "inet6" : "inet", bare, "-alias"]);
    }
    return { added: add, removed: remove };
  }

  async syncRoutes(iface: string, desired: string[]) {
    const added: string[] = [];
    const removed: string[] = [];

    for (const family of ["-inet", "-inet6"] as const) {
      const table = await this.netstat(["-rn", "-f", family.slice(1)]);
      const current = parseRoutes(table.stdout, iface);
      const wanted = desired.filter((route) => (family === "-inet6") === isIpv6(route));
      const wantedCanonical = new Set(wanted.map((route) => canonicalAddress(normalizeRoute(route))));

      for (const destination of wanted) {
        const result = await this.route(["-q", "-n", "add", family, destination, "-interface", iface]);
        if (result.code === 0) {
          added.push(destination);
          continue;
        }
        if (!routeExists(result)) {
          throw new Error(`route add ${destination} failed: ${result.stderr.trim()}`);
        }
        // Something already routes this address -- an older wave run, or another
        // tunnel on the same CGNAT range. Point it at us.
        const changed = await this.route(["-q", "-n", "change", family, destination, "-interface", iface]);
        if (changed.code !== 0) {
          throw new Error(`route change ${destination} failed: ${changed.stderr.trim()}`);
        }
      }

      for (const destination of current) {
        if (wantedCanonical.has(canonicalAddress(normalizeRoute(destination)))) continue;
        const result = await this.route(["-q", "-n", "delete", family, destination, "-interface", iface]);
        if (result.code !== 0) {
          throw new Error(`route delete ${destination} failed: ${result.stderr.trim()}`);
        }
        removed.push(destination);
      }
    }
    return { added, removed };
  }

  /**
   * There is no `ifconfig destroy` for utun: the interface belongs to the
   * wireguard-go process and disappears with it.
   */
  async remove(iface: string): Promise<void> {
    // The anchor is not part of the interface, and the utun number is handed
    // out again: a leftover would filter the next tunnel that gets it.
    await this.syncFilter(iface, null);
    const path = this.pidFile(iface);
    if (!existsSync(path)) return;
    const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    // The file outlives the interface, and macOS hands the same utun number to
    // whoever asks next -- so a pid file kept past the kill would eventually
    // name a stranger's process. It goes either way, signal or not.
    try {
      if (Number.isInteger(pid) && pid > 0) this.kill(pid);
    } catch (err) {
      // ESRCH means the process is already gone, which is what we wanted.
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    } finally {
      await this.removeFile(path);
    }
  }
}
