import type { FilterRule } from "@wave/proto";

/**
 * Interface, address and route handling. What the two platforms have in
 * common lives here; the commands themselves are in link-linux.ts and
 * link-darwin.ts, chosen by link-platform.ts.
 */

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (args: string[]) => Promise<CommandResult>;

/** A command that takes a document on stdin, the way `nft -f -` does. */
export type InputRunner = (args: string[], input: string) => Promise<CommandResult>;

export const spawnWithInput =
  (binary: string): InputRunner =>
  async (args, input) => {
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn([binary, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    } catch (error) {
      // Not installed is an answer, not a crash: the caller says what it means.
      return { code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
    }
    const stdin = proc.stdin as import("bun").FileSink;
    stdin.write(input);
    await stdin.end();
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
    ]);
    return { code: await proc.exited, stdout, stderr };
  };

/**
 * The same, for a tool that only reads a regular file: the `-` in `args` is
 * replaced by the path of a file holding `input`, removed again afterwards.
 *
 * nft is such a tool in the version Ubuntu 24.04 ships (1.0.9): `nft -f -`
 * answers `Not a regular file: "/dev/stdin"`, while newer ones read the pipe.
 * Found by the ACL e2e test on its first CI run -- every Linux desktop on that
 * release would have run without its ports. The file is 0600 in a directory
 * of its own: it is the device's firewall, not something to leave lying about.
 */
export const spawnWithInputFile =
  (binary: string): InputRunner =>
  async (args, input) => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "wave-"));
    const path = join(dir, "input");
    try {
      await writeFile(path, input, { mode: 0o600 });
      return await spawnRunner(binary)(args.map((arg) => (arg === "-" ? path : arg)));
    } catch (error) {
      return { code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

/**
 * Whether the ports of a wave's policy hold on this device. Who may reach it
 * at all is the netmap's, and holds everywhere; this is the part each
 * platform has to do itself.
 */
export interface FilterResult {
  enforced: boolean;
  /** Why not, when not. */
  reason?: string;
}

/** The first line of a tool's complaint, short enough for a log line. */
export const firstLine = (text: string): string => (text.trim().split("\n")[0] ?? "").slice(0, 200);

/**
 * The answer of a platform that cannot filter yet: macOS would need pf and an
 * anchor of its own, Windows the filtering platform. Named, not faked -- the
 * same rule as `UnsupportedPlatform` in the tray -- and without a policy there
 * is nothing missing, so that case is simply true.
 */
export const unenforcedFilter = (platform: string, rules: FilterRule[] | null): FilterResult =>
  rules === null
    ? { enforced: true }
    : { enforced: false, reason: `ports are not enforced on ${platform} yet` };

export const spawnRunner =
  (binary: string): CommandRunner =>
  async (args) => {
    const proc = Bun.spawn([binary, ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, stdout, stderr };
  };

/** Everything the tunnel needs from the operating system's network stack. */
export interface LinkBackend {
  setUp(iface: string, mtu: number): Promise<void>;
  /** Makes the interface carry exactly `desired`. */
  syncAddresses(iface: string, desired: string[]): Promise<{ added: string[]; removed: string[] }>;
  /**
   * WireGuard's AllowedIPs are a cryptographic filter, not a routing table --
   * the kernel still needs routes to send anything into the tunnel. Routes the
   * netmap no longer asks for are removed: everything routed through this
   * interface was put there by us, and a leftover keeps hijacking an address
   * the wave has given up.
   */
  syncRoutes(iface: string, desired: string[]): Promise<{ added: string[]; removed: string[] }>;
  /** Tears the interface down; a missing interface is not an error. */
  remove(iface: string): Promise<void>;
  /**
   * Where our resolver should listen for this platform. The tunnel address is
   * the obvious choice, but it only works where the kernel delivers packets to
   * an interface's own address locally.
   *
   * Address and port are decided together because a device in several waves
   * runs a resolver per wave: on Linux each has a tunnel address of its own and
   * port 53 is free on all of them, while on macOS they share loopback and only
   * the port can tell them apart. `index` is the wave's number, the same one in
   * `wave0`, `wave1`.
   */
  resolverEndpoint(tunnelAddress: string, index?: number): { address: string; port: number };
  /**
   * Routes only the given suffixes to our resolver and leaves the rest of the
   * system's name resolution untouched. Says what it managed rather than
   * returning a bare yes/no -- taking over the global resolver instead would
   * break every other name on the machine, so we decline rather than improvise.
   */
  configureDns(iface: string, dns: DnsSettings): Promise<DnsResult>;
  /** Undoes {@link configureDns}; never fails. */
  revertDns(iface: string, dns: DnsSettings): Promise<void>;
  /**
   * Lets in over this interface only what the wave's policy names (M7, stage
   * two), or everything again with `rules` null. Never throws: a filter that
   * cannot be installed must not take the tunnel down, it has to be said --
   * who may reach the device is still limited by the netmap.
   */
  syncFilter(iface: string, rules: FilterRule[] | null): Promise<FilterResult>;
}

export interface DnsSettings {
  /** Address our resolver listens on. */
  resolver: string;
  /** Its port. Only ever something other than 53 where 53 is already taken. */
  port?: number;
  /** Suffixes to send there: the wave's own zone plus any delegated ones. */
  suffixes: string[];
  /**
   * The wave's own zone, to be used as a search domain as well, so that a bare
   * `laptop` finds `laptop.rl.wave.internal`. Only this one: the delegated
   * suffixes belong to someone else, and appending them to every unqualified
   * name would change how names outside the wave resolve.
   */
  search?: string;
}

/**
 * Routing and searching are separate abilities, and not every platform has
 * both. Saying which one is missing lets the caller name the gap instead of
 * leaving the user to wonder why `ping laptop` fails while the full name works.
 */
export interface DnsResult {
  /** Names under the suffixes reach our resolver. */
  routed: boolean;
  /** A bare hostname is completed with the wave's zone. */
  searched: boolean;
}

/**
 * The kernel prints IPv6 addresses with leading zeros stripped, so a string
 * comparison against what we asked for would wrongly look like a mismatch and
 * make us add the same address twice.
 */
export function canonicalAddress(cidr: string): string {
  const [address, prefix] = cidr.split("/");
  if (!address?.includes(":")) return cidr;
  const normalized = address
    .toLowerCase()
    .split(":")
    .map((group) => (group ? group.replace(/^0+(?=.)/, "") : ""))
    .join(":");
  return prefix ? `${normalized}/${prefix}` : normalized;
}

/**
 * The address diff both backends work from. Link-local addresses are the
 * kernel's, not ours -- removing them would break neighbour discovery.
 */
export function diffAddresses(current: string[], desired: string[]): { add: string[]; remove: string[] } {
  const currentCanonical = new Set(current.map(canonicalAddress));
  const desiredCanonical = new Set(desired.map(canonicalAddress));
  return {
    add: desired.filter((address) => !currentCanonical.has(canonicalAddress(address))),
    remove: current.filter(
      (address) => !desiredCanonical.has(canonicalAddress(address)) && !address.startsWith("fe80:"),
    ),
  };
}

export const isIpv6 = (cidr: string): boolean => cidr.includes(":");

/** The number in "wave3", which is what keeps two waves' resolvers apart. */
export const interfaceIndex = (interfaceName: string): number => {
  const match = /(\d+)$/.exec(interfaceName);
  return match?.[1] ? Number(match[1]) : 0;
};

/** Routing tables print a host route without its /32 or /128 suffix. */
export const normalizeRoute = (route: string): string => route.replace(/\/(32|128)$/, "");
