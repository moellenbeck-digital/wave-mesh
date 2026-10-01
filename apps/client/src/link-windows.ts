/**
 * The Windows backend.
 *
 * Everything here goes through PowerShell rather than `netsh`, and that is the
 * one decision worth explaining: netsh prints for humans and is *localised*, so
 * on a German installation `netsh interface ipv4 show addresses` answers with
 * "IP-Adresse" and every parser written against the English output silently
 * finds nothing. The NetTCPIP cmdlets return objects whose property names are
 * the same in every language, and `ConvertTo-Json` makes them parseable without
 * guessing at column positions.
 *
 * Two further differences from Linux and macOS:
 *
 *  - The adapter belongs to the wireguard-go process the way a utun does on
 *    macOS: wintun creates it, and it disappears when that process ends. So
 *    `remove()` signals a pid rather than deleting an interface.
 *  - Split DNS is the NRPT (Name Resolution Policy Table), which is exactly the
 *    primitive we want: a rule sends one namespace to one server and leaves the
 *    rest of the system's resolution alone. Unlike macOS, the search side works
 *    too -- a connection-specific suffix belongs to the adapter, so setting it
 *    reaches no further than this tunnel.
 */

import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
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
  isIpv6,
  type LinkBackend,
  normalizeRoute,
  spawnRunner,
} from "./link.ts";
import { windowsFirewallScript } from "./packet-filter.ts";

/** Where we keep the per-interface pid files; ProgramData is the system-wide spot. */
export const runDir = (env: NodeJS.ProcessEnv = process.env): string =>
  join(env.PROGRAMDATA ?? "C:\\ProgramData", "wave", "run");

export const pidFilePath = (iface: string, env: NodeJS.ProcessEnv = process.env): string =>
  join(runDir(env), `${iface}.pid`);

/** PowerShell single-quoted string; doubling is how a quote escapes itself. */
export const psQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/**
 * `ConvertTo-Json` emits a bare object for one result and an array for several,
 * and nothing at all for none -- so all three have to be folded into a list
 * before anything reads it.
 */
export function parseJsonList(output: string): Record<string, unknown>[] {
  const text = output.trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (parsed === null) return [];
  return (Array.isArray(parsed) ? parsed : [parsed]) as Record<string, unknown>[];
}

/** `Get-NetIPAddress` reports address and prefix separately; we want CIDRs. */
export function parseAddresses(output: string): string[] {
  const found: string[] = [];
  for (const entry of parseJsonList(output)) {
    const address = entry.IPAddress;
    const prefix = entry.PrefixLength;
    if (typeof address !== "string" || typeof prefix !== "number") continue;
    // The kernel appends the zone to a link-local address, as it does elsewhere.
    found.push(`${address.split("%")[0]}/${prefix}`);
  }
  return found;
}

/**
 * The routes on this interface that we could have put there.
 *
 * Windows derives routes from every address -- the on-link prefix, the host
 * route to ourselves, multicast -- and deleting those breaks the adapter. It
 * marks them `Local`, while a route added with `New-NetRoute` is `NetMgmt`.
 * That flag is this platform's answer to the S/I/i/m flags on macOS.
 */
export function parseRoutes(output: string): string[] {
  const routes: string[] = [];
  for (const entry of parseJsonList(output)) {
    const destination = entry.DestinationPrefix;
    if (typeof destination !== "string") continue;
    if (entry.Protocol !== "NetMgmt" && entry.Protocol !== 3) continue;
    routes.push(destination);
  }
  return routes;
}

/**
 * Every destination on this interface, whoever put it there.
 *
 * The protocol filter above answers one question -- "may we delete this?" --
 * and that is the wrong one to ask before adding. A prefix that already points
 * into the tunnel needs no second route, and asking for one is not merely
 * redundant: `New-NetRoute` refuses an instance that already exists (Windows
 * system error 87), and the refusal ends the whole bring-up. Windows derives a
 * host route from every address the adapter holds and marks it `Local`, so a
 * prefix we hold ourselves is enough to run into it.
 */
export function parseRouteDestinations(output: string): string[] {
  const routes: string[] = [];
  for (const entry of parseJsonList(output)) {
    const destination = entry.DestinationPrefix;
    if (typeof destination === "string") routes.push(destination);
  }
  return routes;
}

export interface WindowsLinkOptions {
  /** Injectable so the tests never shell out. */
  powershell?: CommandRunner;
  kill?: (pid: number) => void;
  pidFile?: (iface: string) => string;
  removeFile?: (path: string) => Promise<void>;
  readPid?: (path: string) => string | null;
}

export class WindowsLink implements LinkBackend {
  private readonly powershell: CommandRunner;
  private readonly kill: (pid: number) => void;
  private readonly pidFile: (iface: string) => string;
  private readonly removeFile: (path: string) => Promise<void>;
  private readonly readPid: (path: string) => string | null;

  constructor(options: WindowsLinkOptions = {}) {
    this.powershell =
      options.powershell ??
      ((args) => spawnRunner("powershell.exe")(["-NoProfile", "-NonInteractive", "-Command", ...args]));
    this.kill = options.kill ?? ((pid) => process.kill(pid, "SIGTERM"));
    this.pidFile = options.pidFile ?? ((iface) => pidFilePath(iface));
    this.removeFile = options.removeFile ?? ((path) => rm(path, { force: true }));
    this.readPid =
      options.readPid ?? ((path) => (existsSync(path) ? readFileSync(path, "utf8").trim() : null));
  }

  private async ps(script: string): Promise<string> {
    const result = await this.powershell([script]);
    if (result.code !== 0) throw new Error(`powershell failed: ${result.stderr.trim() || script}`);
    return result.stdout;
  }

  /**
   * Windows delivers a packet addressed to one of its own interface addresses
   * locally, so the resolver can listen on the tunnel address itself -- and
   * because every wave has an address of its own, port 53 is free on each. That
   * matters more here than on Linux: an NRPT rule names a server but has no
   * field for a port, so a resolver anywhere else would be unreachable.
   */
  resolverEndpoint(tunnelAddress: string, _index = 0): { address: string; port: number } {
    return { address: tunnelAddress, port: 53 };
  }

  async setUp(iface: string, mtu: number): Promise<void> {
    // wintun brings the adapter up as it creates it; only the MTU is ours. The
    // store is the active one throughout: a setting that outlived the tunnel
    // would apply to an adapter that no longer exists.
    await this.ps(
      `Set-NetIPInterface -InterfaceAlias ${psQuote(iface)} -NlMtuBytes ${mtu} ` +
        "-PolicyStore ActiveStore -ErrorAction Stop",
    );
  }

  async syncAddresses(iface: string, desired: string[]) {
    const current = parseAddresses(
      await this.ps(
        `Get-NetIPAddress -InterfaceAlias ${psQuote(iface)} -ErrorAction SilentlyContinue | ` +
          "Select-Object IPAddress,PrefixLength | ConvertTo-Json -Compress",
      ),
    );
    const { add, remove } = diffAddresses(current, desired);

    for (const address of add) {
      const [bare, prefix] = address.split("/");
      await this.ps(
        `New-NetIPAddress -InterfaceAlias ${psQuote(iface)} -IPAddress ${psQuote(bare ?? address)} ` +
          `-PrefixLength ${prefix ?? (isIpv6(address) ? 128 : 32)} -PolicyStore ActiveStore -ErrorAction Stop`,
      );
    }
    for (const address of remove) {
      const bare = address.split("/")[0] ?? address;
      await this.ps(
        `Remove-NetIPAddress -InterfaceAlias ${psQuote(iface)} -IPAddress ${psQuote(bare)} ` +
          "-Confirm:$false -PolicyStore ActiveStore -ErrorAction Stop",
      );
    }
    return { added: add, removed: remove };
  }

  async syncRoutes(iface: string, desired: string[]) {
    const listed = await this.ps(
      `Get-NetRoute -InterfaceAlias ${psQuote(iface)} -PolicyStore ActiveStore ` +
        "-ErrorAction SilentlyContinue | Select-Object DestinationPrefix,Protocol | ConvertTo-Json -Compress",
    );
    // Two questions, so two lists: everything on the interface says what still
    // has to be added, and only what we could have added ourselves says what
    // may be removed.
    const ours = parseRoutes(listed);
    const present = new Set(
      parseRouteDestinations(listed).map((route) => canonicalAddress(normalizeRoute(route))),
    );
    const wantedCanonical = new Set(desired.map((route) => canonicalAddress(normalizeRoute(route))));

    const added: string[] = [];
    const removed: string[] = [];

    for (const route of desired) {
      const key = canonicalAddress(normalizeRoute(route));
      if (present.has(key)) continue;
      // An on-link route: the tunnel has no gateway, so the next hop is the
      // unspecified address of its family. Whether it is needed at all is asked
      // again inside the script rather than trusted from the listing above --
      // the two run a moment apart, and a route that appeared in between would
      // end the bring-up over a state we wanted anyway.
      await this.ps(
        `if (-not (Get-NetRoute -InterfaceAlias ${psQuote(iface)} -DestinationPrefix ${psQuote(route)} ` +
          "-PolicyStore ActiveStore -ErrorAction SilentlyContinue)) { " +
          `New-NetRoute -InterfaceAlias ${psQuote(iface)} -DestinationPrefix ${psQuote(route)} ` +
          `-NextHop ${psQuote(isIpv6(route) ? "::" : "0.0.0.0")} -PolicyStore ActiveStore -ErrorAction Stop }`,
      );
      // Two peers can name the same prefix, and so can a peer and a service;
      // the second attempt would be exactly the error the guard above avoids.
      present.add(key);
      added.push(route);
    }
    for (const route of ours) {
      if (wantedCanonical.has(canonicalAddress(normalizeRoute(route)))) continue;
      await this.ps(
        `Remove-NetRoute -InterfaceAlias ${psQuote(iface)} -DestinationPrefix ${psQuote(route)} ` +
          "-Confirm:$false -PolicyStore ActiveStore -ErrorAction Stop",
      );
      removed.push(route);
    }
    return { added, removed };
  }

  /** So that revertDns finds exactly the rules this interface put there. */
  private static comment = (iface: string): string => `wave:${iface}`;

  /**
   * An NRPT rule routes one namespace to one server and touches nothing else,
   * which is the whole requirement. The namespace has to start with a dot to
   * mean "and everything under it".
   *
   * The search side is separate and, unlike macOS, available: a
   * connection-specific suffix hangs off this adapter, so `ping laptop` finds
   * laptop.rl.wave.internal without the global suffix search list -- which is
   * system-wide and would change how bare names resolve outside the wave.
   */
  async configureDns(iface: string, dns: DnsSettings): Promise<DnsResult> {
    if (dns.suffixes.length === 0) return { routed: true, searched: true };
    // Same stance as resolvectl on Linux: without the cmdlets there is no way
    // to route a single suffix, and taking over the whole resolver instead is
    // not a trade we make.
    const available = await this.powershell([
      "if (Get-Command Add-DnsClientNrptRule -ErrorAction SilentlyContinue) { 'yes' }",
    ]);
    if (available.code !== 0 || !available.stdout.includes("yes")) {
      return { routed: false, searched: false };
    }

    const comment = WindowsLink.comment(iface);
    for (const suffix of dns.suffixes) {
      await this.ps(
        `Add-DnsClientNrptRule -Namespace ${psQuote(`.${suffix}`)} ` +
          `-NameServers ${psQuote(dns.resolver)} -Comment ${psQuote(comment)} -ErrorAction Stop`,
      );
    }

    if (dns.search === undefined) return { routed: true, searched: false };
    await this.ps(
      `Set-DnsClient -InterfaceAlias ${psQuote(iface)} ` +
        `-ConnectionSpecificSuffix ${psQuote(dns.search)} -ErrorAction Stop`,
    );
    return { routed: true, searched: true };
  }

  async syncFilter(iface: string, rules: FilterRule[] | null): Promise<FilterResult> {
    // Rules in a firewall that is off hold nothing, so it is asked in the
    // same call -- and said, instead of reporting rules that do not bite.
    const check =
      rules === null
        ? ""
        : "\n$off = @(Get-NetFirewallProfile | Where-Object { -not $_.Enabled } | ForEach-Object { $_.Name })" +
          '\nif ($off.Count -gt 0) { Write-Output ("firewall-off:" + ($off -join ",")) }';
    const result = await this.powershell([`${windowsFirewallScript(iface, rules)}${check}`]);
    if (result.code !== 0) {
      return rules === null
        ? { enforced: true }
        : { enforced: false, reason: `the firewall refused the rules: ${firstLine(result.stderr)}` };
    }
    const off = /firewall-off:(\S+)/.exec(result.stdout)?.[1];
    if (off)
      return { enforced: false, reason: `the Windows Firewall is off for ${off.replaceAll(",", ", ")}` };
    return { enforced: true };
  }

  async revertDns(iface: string): Promise<void> {
    const comment = WindowsLink.comment(iface);
    // Never fails, like the other backends: this runs on the way down, where a
    // missing rule is the state we wanted anyway.
    await this.powershell([
      `Get-DnsClientNrptRule | Where-Object { $_.Comment -eq ${psQuote(comment)} } | ` +
        "ForEach-Object { Remove-DnsClientNrptRule -Name $_.Name -Force }",
    ]);
    await this.powershell([
      `Set-DnsClient -InterfaceAlias ${psQuote(iface)} -ConnectionSpecificSuffix '' ` +
        "-ErrorAction SilentlyContinue",
    ]);
  }

  /**
   * There is no command that deletes a wintun adapter: it belongs to the
   * wireguard-go process and goes away with it, exactly as a utun does on
   * macOS. The pid file goes either way -- Windows reuses process ids, and one
   * kept past the kill would eventually name a stranger.
   */
  async remove(iface: string): Promise<void> {
    // Firewall rules are persistent and would outlive the tunnel -- and the
    // next adapter of that name.
    await this.syncFilter(iface, null);
    const path = this.pidFile(iface);
    const raw = this.readPid(path);
    if (raw === null) return;
    const pid = Number.parseInt(raw, 10);
    try {
      if (Number.isInteger(pid) && pid > 0) this.kill(pid);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    } finally {
      await this.removeFile(path);
    }
  }
}
