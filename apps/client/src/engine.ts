import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { type DnsServer, type ResolverConfig, reverseZonesFor, startDnsServer } from "@wave/dns";
import { MagicSock, RelayClient } from "@wave/magicsock";
import { type Candidate, formatEndpoint, type Netmap } from "@wave/proto";
import { ControlClient, verifyNetmap } from "./api.ts";
import { ControlSocket, type ControlSocketOptions } from "./control-socket.ts";
import { findTool } from "./install.ts";
import { interfaceIndex, type LinkBackend } from "./link.ts";
import { nameFilePath, pidFilePath, RUN_DIR } from "./link-darwin.ts";
import { platformLink } from "./link-platform.ts";
import { pidFilePath as windowsPidFilePath, runDir as windowsRunDir } from "./link-windows.ts";
import { desiredAddresses, desiredRoutes, planDeviceUpdate } from "./reconcile.ts";
import { ensureProfile, type Profile, profileKey, updateProfile } from "./state.ts";
import { defaultSocketPath, uapiReady, WgControl } from "./wgctl.ts";
import { findWireguardGo, missingMessage } from "./wireguard-go.ts";

/** 1280 is the largest size that survives any path, relays included. */
export const DEFAULT_MTU = 1280;
const NO_POLICY = "no policy: every peer may reach every port";
const STUN_REFRESH_MS = 60_000;
/** How long to wait for a path before trying a fresh source port. */
const REBIND_INTERVAL_MS = 10_000;
const MAX_REBINDS = 3;

export interface EngineOptions {
  statePath: string;
  /** The server this wave is on. */
  controlUrl: string;
  /**
   * Which enrolment in the state file, by its key, when there may be several
   * at this server -- one per project or customer. Without it, the first
   * enrolment there (or a new one).
   */
  profileKey?: string;
  socketPath?: string;
  wireguardGoPath?: string;
  mtu?: number;
  interfaceName?: string;
  listenPort?: number;
  stunServers?: { ip: string; port: number }[];
  link?: LinkBackend;
  /** Serve the wave's names and route just those to our resolver. */
  dns?: boolean;
  /** Called with the enrolment link, so a UI can show it rather than parse logs. */
  onAuthUrl?: (url: string) => void;
  /** Enrols without a browser, for machines that have none (D11). */
  authKey?: string;
  /** Passed to the control socket; see ControlSocketOptions (D13). */
  hello?: ControlSocketOptions["hello"];
  onUpdate?: ControlSocketOptions["onUpdate"];
  onControlConnected?: () => void;
  log?: (message: string) => void;
}

const noop = () => {};

/**
 * Whether a running resolver still sits where the netmap says it should.
 *
 * A wave can be renumbered -- the server carving it a different block, say --
 * and then the address the resolver is bound to is simply gone from the
 * interface. Only rebinding repairs that; updating its records would leave it
 * listening where nothing arrives.
 */
export const resolverMoved = (
  current: { address: string; port: number } | undefined,
  next: { address: string; port: number },
): boolean => current !== undefined && (current.address !== next.address || current.port !== next.port);

/**
 * Addresses this node might be reachable at. Local interface addresses cover
 * the same-LAN case; the reflexive addresses STUN reports cover the rest.
 */
export function gatherLocalCandidates(listenPort: number, excludeInterface: string): Candidate[] {
  const candidates: Candidate[] = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    if (name === excludeInterface || name === "lo") continue;
    // Other tunnels would nest wave inside them. On macOS every VPN is a
    // utun, including ours, and other mesh VPNs hand out addresses from the
    // CGNAT range -- publishing one would be a tunnel through a tunnel.
    if (
      name.startsWith("wave") ||
      name.startsWith("tailscale") ||
      name.startsWith("wg") ||
      name.startsWith("utun")
    ) {
      continue;
    }
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) continue;
      candidates.push({ kind: "local", ip: address.address, port: listenPort });
    }
  }
  return candidates;
}

/**
 * Asks by connecting rather than by looking for a file: on Windows the UAPI is
 * a named pipe, which never appears in the filesystem, so `existsSync` would
 * wait out the timeout on a tunnel that was ready all along.
 */
async function waitForSocket(path: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await uapiReady(path)) return;
    await Bun.sleep(50);
  }
  throw new Error(`WireGuard UAPI socket did not appear at ${path}`);
}

/**
 * wireguard-go creates the name file and writes the name into it as two steps,
 * so a watcher that only asks whether the file exists can read it empty. An
 * empty name is not a cosmetic problem: it becomes the interface we look for,
 * so the UAPI socket never appears, the start fails -- and the process that
 * owns the utun is left running under a name nobody recorded.
 */
export async function readWhenFilled(path: string, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const content = readFileSync(path, "utf8").trim();
      if (content) return content;
    }
    await Bun.sleep(50);
  }
  throw new Error(`${path} did not appear`);
}

/**
 * Darwin has no say in what a tunnel is called: the kernel hands out the next
 * free utun and wireguard-go reports it through WG_TUN_NAME_FILE. So "wave0"
 * is only a label there, and everything that touches the interface has to use
 * the name that comes back.
 */
export const usesDynamicName = (interfaceName: string, platform: NodeJS.Platform): boolean =>
  platform === "darwin" && !interfaceName.startsWith("utun");

/**
 * Where the tunnel's owning process is recorded.
 *
 * Only the platforms whose interface belongs to a process need one: a utun on
 * macOS and a wintun adapter on Windows both vanish with wireguard-go, so
 * `wave down` has nothing to delete and must signal instead. On Linux the
 * interface outlives the process and `ip link del` is the whole story.
 */
export const pidFileFor = (interfaceName: string, platform: NodeJS.Platform): string | null => {
  if (platform === "darwin") return pidFilePath(interfaceName);
  if (platform === "win32") return windowsPidFilePath(interfaceName);
  return null;
};

/**
 * The character device every TUN interface is made through.
 *
 * Checked before wireguard-go is started rather than after it fails, because
 * what it says then is "Failed to create TUN device" and an exit status of 1 --
 * a sentence that names neither the file nor the module. A NAS or a container
 * is where this is missing: the kernel has the driver and nobody loaded it.
 */
export const TUN_DEVICE = "/dev/net/tun";

/**
 * Ways to make the driver appear, tried in order.
 *
 * modprobe is the answer everywhere it exists. Synology has the module and
 * neither modprobe nor a modules.dep naming it, so the file is loaded
 * directly; on any other system that path is simply not there and insmod
 * fails without doing harm.
 */
export const TUN_LOADERS: string[][] = [
  ["modprobe", "tun"],
  ["insmod", "/lib/modules/tun.ko"],
];

/** Runs a command for its exit status alone. */
export type Loader = (command: string[]) => Promise<number>;

const loadQuietly: Loader = async (command) => {
  const found = findTool(command[0] ?? "");
  if (!found) return 127;
  try {
    const proc = Bun.spawn([found, ...command.slice(1)], { stdout: "ignore", stderr: "ignore" });
    return await proc.exited;
  } catch {
    return 127;
  }
};

/**
 * Makes sure a tunnel can be created at all, and says so when it cannot.
 *
 * Loading the driver is the daemon's business rather than the operator's: it
 * already runs as root, and a NAS that needs `insmod` needs it again after
 * every reboot -- a tunnel that comes back by itself is the whole point of a
 * service. Failures here are not reported on their own; what matters is
 * whether the device is there afterwards, and the message says what to do if
 * it is not.
 */
export async function ensureTunDevice(
  platform: NodeJS.Platform = process.platform,
  run: Loader = loadQuietly,
  exists: (path: string) => boolean = existsSync,
): Promise<string | null> {
  if (platform !== "linux" || exists(TUN_DEVICE)) return null;
  for (const loader of TUN_LOADERS) {
    await run(loader);
    if (exists(TUN_DEVICE)) return null;
  }
  return missingTunMessage(platform, exists);
}

/** What to do about a missing {@link TUN_DEVICE}, or null when it is there. */
export function missingTunMessage(
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string | null {
  if (platform !== "linux" || exists(TUN_DEVICE)) return null;
  return (
    `${TUN_DEVICE} does not exist, so no tunnel interface can be made. ` +
    "Load the driver -- `modprobe tun`, or on a Synology NAS " +
    "`sudo insmod /lib/modules/tun.ko` -- and try again."
  );
}

/**
 * Keeps what a child said, so a failure can quote it.
 *
 * wireguard-go used to inherit both streams: its complaint went to the
 * daemon's journal and the caller was left holding "exited with code 1". The
 * lines are still logged as they arrive -- a tunnel that comes up should look
 * no different -- but now they are also kept, and the last of them go into the
 * error. Only the tail: a long-running tunnel would otherwise grow a log in
 * memory for the sake of a message nobody may ever read.
 */
export function watchOutput(
  stream: ReadableStream<Uint8Array> | null | undefined,
  log: (line: string) => void,
  keep: string[],
  limit = 10,
): Promise<void> {
  if (!stream) return Promise.resolve();
  return (async () => {
    const decoder = new TextDecoder();
    let rest = "";
    const take = (line: string): void => {
      if (!line.trim()) return;
      log(line.trimEnd());
      keep.push(line.trimEnd());
      if (keep.length > limit) keep.shift();
    };
    for await (const chunk of stream) {
      rest += decoder.decode(chunk, { stream: true });
      const lines = rest.split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) take(line);
    }
    take(rest);
  })().catch(() => {
    // A stream that breaks says nothing more; the exit status still does.
  });
}

/** The interface a previous run ended up with, or the name itself on Linux. */
export function resolveInterfaceName(
  interfaceName: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!usesDynamicName(interfaceName, platform)) return interfaceName;
  const path = nameFilePath(interfaceName);
  if (!existsSync(path)) return interfaceName;
  return readFileSync(path, "utf8").trim() || interfaceName;
}

export interface WireguardHandle {
  /** The real interface name -- on Darwin a utun, not what was asked for. */
  interfaceName: string;
  socketPath: string;
}

/** Starts the userspace WireGuard implementation unless it is already running. */
export async function ensureWireguard(options: {
  interfaceName: string;
  socketPath?: string;
  binary: string;
  platform?: NodeJS.Platform;
  log?: (message: string) => void;
}): Promise<WireguardHandle> {
  const log = options.log ?? noop;
  const platform = options.platform ?? process.platform;
  const dynamic = usesDynamicName(options.interfaceName, platform);
  /**
   * Windows stays in the foreground for the same reason macOS does: the adapter
   * belongs to the process we started, so that process has to be the one we can
   * find again and signal. Only Linux can let wireguard-go fork away.
   */
  const foreground = dynamic || platform === "win32";

  const running = resolveInterfaceName(options.interfaceName, platform);
  const runningSocket = options.socketPath ?? defaultSocketPath(running, platform);
  if (await uapiReady(runningSocket)) return { interfaceName: running, socketPath: runningSocket };

  const nameFile = nameFilePath(options.interfaceName);
  if (dynamic) {
    // wireguard-go writes the name file before it creates the socket
    // directory, so on a machine that never ran it there is nowhere to put it.
    mkdirSync(RUN_DIR, { recursive: true, mode: 0o755 });
    // A name file left behind by a crashed run would name a stale interface.
    rmSync(nameFile, { force: true });
  }
  if (platform === "win32") mkdirSync(windowsRunDir(), { recursive: true });

  // Without -f, wireguard-go forks into the background: the process we spawned
  // exits with 0 and the interface belongs to a child we never see. Darwin
  // needs it in the foreground, because "wave down" has to signal that process
  // to make the utun go away. Windows never forks, so the flag is not offered
  // there and passing it would only fail the start.
  // A missing implementation is the most common first-run problem, so say what
  // it is and how to get it rather than reporting an empty PATH lookup.
  if (!options.binary) throw new Error(missingMessage());
  // Before the spawn, not after: without the device wireguard-go fails with a
  // sentence that names neither the file nor how to get it.
  const noTun = await ensureTunDevice(platform);
  if (noTun) throw new Error(noTun);

  const argument = dynamic ? "utun" : options.interfaceName;
  log(`starting ${options.binary} ${argument}`);
  const proc = Bun.spawn(dynamic ? [options.binary, "-f", argument] : [options.binary, argument], {
    stdout: "pipe",
    stderr: "pipe",
    env: dynamic ? { ...process.env, WG_TUN_NAME_FILE: nameFile } : process.env,
  });

  // Piped rather than inherited, so a failure can say what it said. The
  // reading never stops on its own where wireguard-go forks and the child
  // keeps the pipe -- which is why nothing waits on these two except the
  // paths that are about to throw.
  const said: string[] = [];
  const spoke = Promise.all([
    watchOutput(proc.stdout as ReadableStream<Uint8Array>, log, said),
    watchOutput(proc.stderr as ReadableStream<Uint8Array>, log, said),
  ]);
  /**
   * What it said, once it has finished saying it.
   *
   * Bounded, because the streams only close when every holder of them is gone:
   * on Linux wireguard-go forks, and a child that outlives a failed parent
   * would keep this waiting forever for a message that is already complete.
   */
  const complaint = async (): Promise<string> => {
    await Promise.race([spoke, Bun.sleep(500)]);
    return said.length > 0 ? `: ${said.join("; ")}` : "";
  };

  // Without -f the process we spawned exits with 0 once its child owns the
  // interface, so waiting for it to die would report a healthy start as a
  // failure. Only the foreground case can treat an exit as one.
  if (!foreground) {
    const exited = await Promise.race([proc.exited, waitForSocket(runningSocket).then(() => null)]);
    if (exited !== null && exited !== 0) {
      throw new Error(`${options.binary} exited with code ${exited}${await complaint()}`);
    }
    await waitForSocket(runningSocket);
    return { interfaceName: options.interfaceName, socketPath: runningSocket };
  }

  const died = proc.exited.then(async (code): Promise<never> => {
    const output = await complaint();
    throw new Error(
      code === 0
        ? `${options.binary} exited before the interface was ready${output}`
        : `${options.binary} exited with code ${code}${output}`,
    );
  });
  // Once the tunnel is up nothing waits on this any more, and an unobserved
  // rejection would take the client down with the WireGuard process.
  died.catch((err: Error) => log(err.message));

  try {
    // Only macOS has to be told what its interface ended up being called; on
    // Windows wintun takes the name we asked for.
    const interfaceName = dynamic
      ? await Promise.race([readWhenFilled(nameFile), died])
      : options.interfaceName;
    // wave down has no other way to find the process that owns the interface.
    const pidFile = pidFileFor(interfaceName, platform);
    if (pidFile) writeFileSync(pidFile, `${proc.pid}\n`);

    const socketPath = options.socketPath ?? defaultSocketPath(interfaceName, platform);
    await Promise.race([waitForSocket(socketPath), died]);
    return { interfaceName, socketPath };
  } catch (error) {
    // The interface lives exactly as long as the process holding it, and until
    // we get here nothing else knows this one exists. Letting it run would
    // leave an interface behind that no `wave down` can find, every failed
    // attempt adding another.
    proc.kill();
    throw error;
  }
}

export interface TunnelSnapshot {
  /** Which enrolment this tunnel belongs to -- the server is the identity. */
  controlUrl: string;
  interfaceName: string;
  /** Everything on the interface: this node, plus one per service it serves. */
  addresses: string[];
  /** This node itself -- the part of `addresses` that is not a service. */
  self?: {
    hostname: string;
    dnsName: string;
    ipv4: string;
    ipv6: string;
    /** Set when this device is the one fronting names -- a connector (D11). */
    services: Array<{ name: string; dnsName: string; ipv4: string; url: string }>;
  };
  dnsSuffix?: string;
  relay?: { url: string; connected: boolean };
  peers: Array<{
    hostname: string;
    dnsName: string;
    ipv4: string;
    ipv6: string;
    /** "relay", an address, or undefined while no path is confirmed. */
    via?: string;
    rttMs?: number;
    lastHandshakeSecondsAgo?: number;
    /** What this peer answers for besides itself -- a connector's names (D11). */
    services: Array<{ name: string; dnsName: string; ipv4: string; url: string }>;
  }>;
}

/**
 * The names one node answers for.
 *
 * A netmap lists the services of the whole wave and names the node fronting
 * each one; every view wants them the other way round, under their machine.
 */
const servicesOf = (netmap: Netmap, nodeId: string) =>
  (netmap.services ?? [])
    .filter((service) => service.viaNodeId === nodeId)
    .map((service) => ({
      name: service.name,
      dnsName: service.dnsName,
      ipv4: service.ipv4,
      // The server writes the address out; a control server from before it
      // did leaves the field empty, and https on the name is the same answer
      // it would give today. The one place on this side that builds one.
      url: service.url ?? `https://${service.dnsName}`,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

export interface ApplyResult {
  version: number;
  peers: number;
  peersUpserted: number;
  peersRemoved: number;
  addressesAdded: string[];
  routesAdded: string[];
  routesRemoved: string[];
}

/**
 * A running tunnel: userspace WireGuard, the magic socket in front of it, and
 * the control connection that keeps both in sync.
 */
export class Tunnel {
  private stunTimer?: ReturnType<typeof setInterval>;
  private published = "";
  /** What the last policy line said; starts as "no policy", which is not news. */
  private filterSaid = NO_POLICY;
  /** The filter rules last installed, so an unchanged netmap costs no `nft`. */
  private filterApplied?: string;
  private netmap?: Netmap;
  private pendingHints = new Map<string, Candidate[]>();
  private rebindTimer?: ReturnType<typeof setInterval>;
  private rebinds = 0;
  private relay?: { url: string; client: RelayClient };
  private dns?: DnsServer;
  private dnsSuffixes = "";

  constructor(
    readonly state: Profile,
    private readonly wg: WgControl,
    private readonly magic: MagicSock,
    private readonly wireguardPort: number,
    private readonly mtu: number,
    private readonly log: (message: string) => void,
    private readonly configuredStun: { ip: string; port: number }[] = [],
    private readonly control?: ControlSocket,
    /** The interface as the kernel knows it; on Darwin a utun, not state.interfaceName. */
    readonly linkName: string = state.interfaceName,
    private readonly link: LinkBackend = platformLink(),
    private readonly dnsEnabled: boolean = true,
  ) {}

  currentNetmap(): Netmap | undefined {
    return this.netmap;
  }

  status() {
    return this.magic.status();
  }

  /**
   * Brings WireGuard, addresses and routes in line with the netmap. Every peer
   * gets a loopback endpoint, so a change of path never touches WireGuard.
   */
  async apply(netmap: Netmap): Promise<ApplyResult> {
    this.netmap = netmap;
    this.syncRelay(netmap);
    await this.magic.setPeers(
      netmap.peers.map((peer) => ({
        nodeKey: peer.nodeKey,
        discoKey: peer.discoKey,
        candidates: peer.candidates.map((candidate) => ({ ip: candidate.ip, port: candidate.port })),
      })),
    );

    // Punching comes before the WireGuard and routing work: every millisecond
    // spent here widens the gap between the two sides starting to punch, and
    // that gap has to stay below the round-trip time to the peer.
    if (netmap.self.candidates.length > 0) this.magic.enableProbing();
    for (const [nodeId, candidates] of [...this.pendingHints]) this.punch(nodeId, candidates);

    // Before WireGuard learns a new peer, so there is no moment in which it can
    // send and the ports it may use are not yet in place.
    await this.syncFilter(netmap);

    const current = await this.wg.getDevice();
    const update = planDeviceUpdate(
      current,
      netmap,
      { privateKey: this.state.nodeKey.privateKey, listenPort: this.wireguardPort },
      (peer) => {
        const endpoint = this.magic.endpointForWireguard(peer.nodeKey);
        return endpoint ? formatEndpoint(endpoint) : undefined;
      },
    );
    await this.wg.setDevice(update);

    await this.link.setUp(this.linkName, this.mtu);
    const addresses = await this.link.syncAddresses(this.linkName, desiredAddresses(netmap));
    const routes = await this.link.syncRoutes(this.linkName, desiredRoutes(netmap));
    // After the addresses exist: the resolver binds to one of them.
    await this.syncDns(netmap);

    return {
      version: netmap.version,
      peers: netmap.peers.length,
      peersUpserted: update.upsert.length,
      peersRemoved: update.remove.length,
      addressesAdded: addresses.added,
      routesAdded: routes.added,
      routesRemoved: routes.removed,
    };
  }

  /**
   * The port half of the wave's policy (M7). Said once per change, because the
   * one thing worse than a filter that could not be installed is one that
   * silently was not: who may reach this device is still limited by the
   * netmap, but which ports and which direction is then not.
   */
  private async syncFilter(netmap: Netmap): Promise<void> {
    const rules = netmap.packetFilter ?? null;
    const wanted = JSON.stringify(rules);
    if (wanted === this.filterApplied) return;
    const result = await this.link.syncFilter(this.linkName, rules);
    // Remembered only once it holds: a filter that failed is tried again with
    // the next netmap rather than taken for done.
    if (result.enforced) this.filterApplied = wanted;
    const said =
      rules === null
        ? NO_POLICY
        : result.enforced
          ? `policy enforced: ${rules.length} rule(s) let traffic in`
          : `policy NOT enforced here (${result.reason}); peers are limited by the netmap, ports are not`;
    if (said !== this.filterSaid) {
      this.log(said);
      // Only under a policy: without one there is nothing to enforce, and the
      // server shows nothing either way.
      if (rules !== null) {
        this.control?.reportFilter(
          result.enforced ? { enforced: true } : { enforced: false, reason: result.reason },
        );
      }
    }
    this.filterSaid = said;
  }

  /**
   * Connects to the relay the netmap names, so peers that no direct path
   * reaches are still usable. The relay is just another path: it loses to a
   * direct one on round-trip time as soon as punching succeeds.
   */
  private syncRelay(netmap: Netmap): void {
    const relay = netmap.relays[0];
    const stun = netmap.relays.flatMap((entry) => (entry.stun ? [entry.stun] : []));
    if (stun.length > 0 || this.configuredStun.length > 0) {
      this.magic.setStunServers([...this.configuredStun, ...stun]);
    }

    if (!relay) {
      if (this.relay) {
        this.relay.client.close();
        this.relay = undefined;
        this.magic.setRelay(undefined);
      }
      return;
    }
    if (this.relay?.url === relay.url) return;

    this.relay?.client.close();
    const client = new RelayClient({
      url: relay.url.replace(/^http/, "ws"),
      discoPublicKey: this.state.discoKey.publicKey,
      discoPrivateKey: this.state.discoKey.privateKey,
      onPacket: (sender, payload) => this.magic.onRelayPacket(sender, payload),
      log: this.log,
    });
    client.connect();
    this.relay = { url: relay.url, client };
    this.magic.setRelay(client);
    this.log(`relay ${relay.id} at ${relay.url}`);
  }

  /**
   * Serves the wave's names and asks the system to send only those here.
   *
   * Deliberately narrow: the resolver listens on this node's own tunnel
   * address, and the operating system is told to route just the wave's zone
   * and any delegated suffixes to it. Every other name on the machine keeps
   * resolving exactly as it did before wave was installed.
   */
  private async syncDns(netmap: Netmap): Promise<void> {
    if (!this.dnsEnabled) return;

    // The wave's own addresses decide which reverse zones are ours; every node
    // in it shares them.
    const reverse = reverseZonesFor(netmap.self.addresses);
    const config: ResolverConfig = {
      zone: netmap.dns.suffix,
      // Services sit in the same zone as the devices and answer the same way
      // (D11). Nothing else on this side knows they exist: their addresses come
      // in the connector's allowedIps, so the routes are already there, and
      // being inside the wave's own block puts their PTRs in the same reverse
      // zones as everything else.
      records: [netmap.self, ...netmap.peers, ...(netmap.services ?? [])].map((entry) => ({
        name: entry.dnsName,
        ipv4: entry.ipv4,
        ipv6: entry.ipv6,
      })),
      routes: netmap.dns.routes,
      reverse,
    };

    // Where a resolver may listen is the backend's to know: one wave per tunnel
    // address on Linux, one port per wave on macOS.
    const endpoint = this.link.resolverEndpoint(netmap.self.ipv4, interfaceIndex(this.state.interfaceName));

    const running = this.dns;
    if (running && resolverMoved(running, endpoint)) {
      this.log(
        `resolver moves from ${running.address}:${running.port} to ${endpoint.address}:${endpoint.port}`,
      );
      running.close();
      this.dns = undefined;
      // Force the link to be told again; the suffixes did not change, but where
      // to send them did.
      this.dnsSuffixes = "";
    }

    if (!this.dns) {
      try {
        this.dns = await startDnsServer({
          address: endpoint.address,
          port: endpoint.port,
          config,
          log: this.log,
        });
      } catch (error) {
        this.log(`no name resolution: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    } else {
      this.dns.update(config);
    }

    // The reverse zones are routed here too, or the system resolver would send
    // "what is 10.77.0.2 called?" upstream, where nobody knows and nobody says
    // so -- and anything that looks a name up before printing simply waits.
    const suffixes = [netmap.dns.suffix, ...netmap.dns.routes.map((route) => route.suffix), ...reverse];
    const fingerprint = suffixes.join(",");
    if (fingerprint === this.dnsSuffixes) return;

    // The wave's own zone doubles as the search domain, so `ping laptop` works
    // without spelling out the suffix.
    const settings = {
      resolver: this.dns.address,
      port: this.dns.port,
      suffixes,
      search: netmap.dns.suffix,
    };
    const configured = await this.link
      .configureDns(this.linkName, settings)
      .catch(() => ({ routed: false, searched: false }));
    this.dnsSuffixes = fingerprint;

    if (!configured.routed) {
      this.log(
        "this system offers no way to route single domains to a resolver, so wave names will not resolve; " +
          "everything else is untouched",
      );
      return;
    }
    this.log(
      configured.searched
        ? `resolving ${suffixes.join(", ")} via ${this.dns.address}; a bare hostname finds ${netmap.dns.suffix}`
        : `resolving ${suffixes.join(", ")} via ${this.dns.address}; this platform has no per-interface ` +
            `search domain, so names need their .${netmap.dns.suffix} suffix`,
    );
  }

  /** Everything the status view needs, gathered in one place. */
  async snapshot(): Promise<TunnelSnapshot> {
    const netmap = this.netmap;
    const paths = new Map(this.magic.status().map((peer) => [peer.nodeKey, peer]));
    const device = await this.wg.getDevice().catch(() => undefined);
    const handshakes = new Map(
      device?.peers.map((peer) => [peer.publicKey, peer.lastHandshakeSeconds]) ?? [],
    );

    return {
      // Which enrolment this is, so a device in several waves can tell them
      // apart in `wave status` and in the tray.
      controlUrl: this.state.controlUrl,
      // The name the kernel actually gave the interface, which on Darwin is a
      // utun rather than the label in the state file.
      interfaceName: this.linkName,
      addresses: netmap?.self.addresses ?? [],
      self: netmap
        ? {
            hostname: netmap.self.hostname,
            dnsName: netmap.self.dnsName,
            ipv4: netmap.self.ipv4,
            ipv6: netmap.self.ipv6,
            services: servicesOf(netmap, netmap.self.id),
          }
        : undefined,
      dnsSuffix: netmap?.dns.suffix,
      relay: this.relay ? { url: this.relay.url, connected: this.relay.client.connected } : undefined,
      peers: (netmap?.peers ?? []).map((peer) => {
        const path = paths.get(peer.nodeKey);
        const handshake = handshakes.get(peer.nodeKey) ?? 0;
        return {
          services: netmap ? servicesOf(netmap, peer.id) : [],
          hostname: peer.hostname,
          dnsName: peer.dnsName,
          ipv4: peer.ipv4,
          ipv6: peer.ipv6,
          // "idle" before anything else: an idle peer's path is the last one
          // known, not one measured -- the same word the mobile core uses.
          via: path?.idle
            ? "idle"
            : path?.viaRelay
              ? "relay"
              : path?.best
                ? formatEndpoint(path.best)
                : undefined,
          rttMs: path?.rttMs,
          lastHandshakeSecondsAgo: handshake
            ? Math.max(0, Math.round(Date.now() / 1000 - handshake))
            : undefined,
        };
      }),
    };
  }

  /** Tells a specific peer's paths to start probing again, right now. */
  punch(nodeId: string, candidates: Candidate[]): void {
    const peer = this.netmap?.peers.find((p) => p.id === nodeId);
    if (!peer) {
      // A hint can overtake the netmap that introduces the peer.
      this.pendingHints.set(nodeId, candidates);
      return;
    }
    this.pendingHints.delete(nodeId);
    this.magic.punchNow(
      peer.nodeKey,
      candidates.map((candidate) => ({ ip: candidate.ip, port: candidate.port })),
    );
  }

  /** Starts probing; called once our own candidates have reached the server. */
  startProbing(): void {
    this.magic.enableProbing();
  }

  /** Rediscovers our own addresses and publishes them if they changed. */
  async refreshCandidates(): Promise<Candidate[]> {
    const { mapping } = await this.magic.discoverReflexive();
    const candidates: Candidate[] = [
      ...gatherLocalCandidates(this.magic.port, this.linkName),
      ...this.magic
        .reflexiveCandidates()
        .map((mapped: { ip: string; port: number }) => ({ kind: "stun" as const, ...mapped })),
    ];

    const fingerprint = candidates
      .map((c) => `${c.kind}:${c.ip}:${c.port}`)
      .sort()
      .join(",");
    if (fingerprint !== this.published) {
      this.published = fingerprint;
      this.control?.publishEndpoints(candidates);
      const explained =
        mapping === "undetermined"
          ? "NAT behaviour undetermined (needs a second STUN server)"
          : `NAT mapping ${mapping}`;
      this.log(`published ${candidates.length} candidate(s); ${explained}`);
    }
    return candidates;
  }

  /**
   * Watches for a port nobody can reach any more and moves to a fresh one
   * when that happens (see wantsRebind: nobody, not somebody). A NAT port collision cannot be detected directly -- it looks
   * exactly like a peer being offline -- so the recovery is simply tried a few
   * times before giving up and waiting for a relay (M4).
   */
  startConnectivityWatch(intervalMs = REBIND_INTERVAL_MS, maxAttempts = MAX_REBINDS): void {
    this.rebindTimer = setInterval(() => {
      if (!this.magic.needsRebind() || this.rebinds >= maxAttempts) return;
      this.rebinds++;
      void this.magic
        .rebind()
        .then(() => this.refreshCandidates())
        .catch((error) =>
          this.log(`rebind failed: ${error instanceof Error ? error.message : String(error)}`),
        );
    }, intervalMs);
  }

  startCandidateRefresh(): void {
    this.stunTimer = setInterval(() => void this.refreshCandidates().catch(() => {}), STUN_REFRESH_MS);
  }

  /** Says `hello` again, after an update setting changed (D13). */
  announce(): void {
    this.control?.hello();
  }

  async stop(): Promise<void> {
    if (this.stunTimer) clearInterval(this.stunTimer);
    if (this.rebindTimer) clearInterval(this.rebindTimer);
    if (this.dns) {
      await this.link
        .revertDns(this.linkName, { resolver: this.dns.address, suffixes: this.dnsSuffixes.split(",") })
        .catch(() => {});
      this.dns.close();
    }
    this.relay?.client.close();
    this.control?.close();
    await this.magic.close();
  }
}

async function waitForApproval(
  client: ControlClient,
  registration: { authUrl: string; pollSecret: string },
  log: (message: string) => void,
  onAuthUrl?: (url: string) => void,
) {
  onAuthUrl?.(registration.authUrl);
  log(`\nOpen this link to connect this device:\n\n    ${registration.authUrl}\n`);
  log("Waiting for the browser…");
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    const poll = await client.poll(registration.pollSecret);
    if (poll.status === "authorized") return poll;
    if (poll.status === "expired") throw new Error("enrolment request expired — run `wave up` again");
    // The browser approval is one click now, so poll often enough to feel instant.
    await Bun.sleep(1000);
  }
  throw new Error("timed out waiting for approval");
}

/** Registers if needed, waits for approval, and returns the first netmap. */
export async function enrol(
  state: Profile,
  statePath: string,
  log: (message: string) => void,
  onAuthUrl?: (url: string) => void,
  authKey?: string,
): Promise<{ state: Profile; netmap: Netmap }> {
  const client = new ControlClient(state);
  const registration = await client.register(authKey);
  const authorized =
    registration.status === "authorized"
      ? registration
      : await waitForApproval(client, registration, log, onAuthUrl);

  if (state.netmapPublicKey && state.netmapPublicKey !== authorized.netmapPublicKey) {
    throw new Error(
      "control server presented a different netmap signing key than the one pinned at enrolment",
    );
  }
  const netmapPublicKey = state.netmapPublicKey ?? authorized.netmapPublicKey;
  const netmap = verifyNetmap(authorized.netmap, netmapPublicKey);
  // The wave's own name, kept for when it is not running: with several waves
  // at one server, the server's address names all of them.
  const label = netmap.dns.suffix || state.label;
  const next: Profile = { ...state, nodeId: authorized.nodeId, netmapPublicKey, label };
  await updateProfile(statePath, profileKey(state), { nodeId: next.nodeId, netmapPublicKey, label });
  return { state: next, netmap };
}

/**
 * What a start put on the machine, filled in as each piece appears so that a
 * failure halfway can take exactly those pieces off again.
 */
export interface Started {
  /** The name the kernel gave the interface -- on macOS not the one we asked for. */
  linkName?: string;
  magic?: MagicSock;
  tunnel?: Tunnel;
}

/** Enrols, starts the tunnel and keeps it in sync until stopped. */
export async function up(options: EngineOptions): Promise<Tunnel> {
  const log = options.log ?? noop;
  const link = options.link ?? platformLink();
  const initial = await ensureProfile(options.statePath, options.controlUrl, {
    interfaceName: options.interfaceName,
    listenPort: options.listenPort,
    // Exactly this enrolment: with several at one server, the address alone
    // would bring up the first one's keys.
    key: options.profileKey,
  });
  const { state, netmap } = await enrol(initial, options.statePath, log, options.onAuthUrl, options.authKey);

  // Everything below leaves something on the machine, so a failure below takes
  // it off again. A half-built tunnel is worse than none: wireguard-go keeps
  // the interface, the magic socket keeps the UDP port, and the addresses and
  // routes stay on an interface nobody owns any more. The next attempt then
  // trips over its predecessor instead of over whatever went wrong the first
  // time -- on Windows a leftover host route is enough to make it fail for
  // good, because `New-NetRoute` refuses a route that is already there.
  const started: Started = {};
  try {
    return await start(started, state, netmap, link, log, options);
  } catch (error) {
    await unwind(started, link, log);
    throw error;
  }
}

/**
 * Takes the pieces off in the order they went on, and quietly: the error that
 * brought us here is the one worth reporting, and a cleanup failure on top of
 * it would only bury it. It is still logged, because a leftover interface is
 * the next attempt's problem and should be findable.
 *
 * `tunnel.stop()` already closes the magic socket, so the socket is only closed
 * on its own if the tunnel never came to exist.
 */
export async function unwind(
  started: Started,
  link: LinkBackend,
  log: (message: string) => void,
): Promise<void> {
  const failed = (what: string, error: unknown) =>
    log(`could not ${what} after a failed start: ${error instanceof Error ? error.message : error}`);

  if (started.tunnel) await started.tunnel.stop().catch((error) => failed("stop the tunnel", error));
  else if (started.magic) await started.magic.close().catch((error) => failed("close the socket", error));
  if (started.linkName) {
    await link.remove(started.linkName).catch((error) => failed("remove the interface", error));
  }
}

async function start(
  started: Started,
  state: Profile,
  netmap: Netmap,
  link: LinkBackend,
  log: (message: string) => void,
  options: EngineOptions,
): Promise<Tunnel> {
  const wireguard = await ensureWireguard({
    interfaceName: state.interfaceName,
    socketPath: options.socketPath,
    binary: options.wireguardGoPath ?? findWireguardGo() ?? "",
    log,
  });
  started.linkName = wireguard.interfaceName;

  // WireGuard listens on a port of its own choosing and only ever talks to the
  // magic socket over loopback; peers never learn that port.
  const wg = new WgControl(wireguard.socketPath);
  await wg.setDevice({ privateKey: state.nodeKey.privateKey, listenPort: 0, upsert: [], remove: [] });
  const wireguardPort = (await wg.getDevice()).listenPort;

  const magic = new MagicSock({
    listenPort: state.listenPort,
    discoPrivateKey: state.discoKey.privateKey,
    discoPublicKey: state.discoKey.publicKey,
    wireguardPort,
    stunServers: options.stunServers,
    log,
    verbose: process.env.WAVE_VERBOSE === "1",
  });
  await magic.start();
  started.magic = magic;

  let tunnel: Tunnel | undefined;
  const control = new ControlSocket({
    state,
    log,
    hello: options.hello,
    onUpdate: options.onUpdate,
    onConnected: options.onControlConnected,
    onNetmap: async (next) => {
      if (!tunnel) return;
      const startedAt = Date.now();
      const result = await tunnel.apply(next);
      const appliedIn = Date.now() - startedAt;
      log(
        `netmap v${result.version}: ${result.peers} peer(s), ${result.peersUpserted} changed, ` +
          `${result.peersRemoved} removed (applied in ${appliedIn}ms)`,
      );
      // Deliberately not rediscovering our own addresses here: STUN takes
      // hundreds of milliseconds, and blocking this handler delays every
      // later message -- including the netmap that carries a peer's addresses.
    },
    onDiscoHint: (nodeId, candidates) => tunnel?.punch(nodeId, candidates),
  });

  tunnel = new Tunnel(
    state,
    wg,
    magic,
    wireguardPort,
    options.mtu ?? DEFAULT_MTU,
    log,
    options.stunServers ?? [],
    control,
    wireguard.interfaceName,
    link,
    options.dns ?? true,
  );
  started.tunnel = tunnel;
  await tunnel.apply(netmap);
  log(
    `${wireguard.interfaceName} up as ${netmap.self.ipv4} (${netmap.self.dnsName}), ` +
      `${netmap.peers.length} peer(s)`,
  );

  control.connect();
  await tunnel.refreshCandidates();
  tunnel.startCandidateRefresh();
  tunnel.startConnectivityWatch();
  return tunnel;
}
