import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import {
  type CertificateStatus,
  type CertWaiting,
  DEFAULT_SOCKET_PATH,
  encodeMessage,
  LineReader,
  PLATFORM,
  type ProfileStatus,
  profileStatusFromSnapshot,
  Request,
  type Status,
  type TunnelState,
  VERSION,
} from "@wave/ipc";
import { ControlClient } from "./api.ts";
import { certPaths, dueCertificates, issueCertificate, namesOf } from "./certs.ts";
import { up as bringUp, type EngineOptions, type Tunnel } from "./engine.ts";
import { platformLink } from "./link-platform.ts";
import { describeConflict, findConflict } from "./overlap.ts";
import {
  describeAmbiguity,
  ensureProfile,
  loadProfiles,
  matchProfiles,
  normaliseControlUrl,
  type Profile,
  removeProfile,
} from "./state.ts";
import type { Updater } from "./update.ts";

/**
 * The privileged half of the client.
 *
 * Creating a tunnel interface, setting addresses and routes and binding port 53
 * all need CAP_NET_ADMIN, and capabilities are not inherited by the `ip` child
 * processes -- so this part runs as root, once, under a service manager. The
 * CLI and the tray then speak to it over a unix socket and need no privileges
 * of their own.
 */

/**
 * Deliberately without `controlUrl`: the daemon is installed for the machine,
 * not for a server. Which wave a tunnel belongs to is a property of its
 * profile, and profiles come from `wave login`.
 */
export interface DaemonOptions extends Omit<EngineOptions, "controlUrl"> {
  /** Our control socket. EngineOptions.socketPath is WireGuard's, a different thing. */
  controlSocketPath?: string;
  /** Group allowed to use the socket; without it only root may. */
  socketGroup?: string;
  /**
   * Self-updates (D13). Optional so a daemon can run without them -- the
   * tests do, and so does every run from source, where the updater would
   * only ever say it is a development build.
   */
  updater?: Updater;
}

const isPipe = (path: string): boolean => path.startsWith("\\\\");

/** How often the daemon looks for a certificate that has reached its date. */
const RENEWAL_CHECK_MS = 60 * 60 * 1000;

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Resolves a group name (or numeric id) without a native getgrnam. */
export function resolveGroupId(group: string, groupFile = "/etc/group"): number | null {
  if (/^\d+$/.test(group)) return Number(group);
  try {
    for (const line of readFileSync(groupFile, "utf8").split("\n")) {
      const [name, , id] = line.split(":");
      if (name === group && id) return Number(id);
    }
  } catch {
    // No group database: fall through to root-only.
  }
  return null;
}

interface ClientData {
  reader: LineReader;
  watch?: (status: Status) => void;
}

/** One enrolment as the daemon holds it: the tunnel, plus how it is going. */
interface Runtime {
  profile: Profile;
  tunnel?: Tunnel;
  /**
   * The attempt currently building this tunnel, if any. Enrolment waits for a
   * human at a browser, so an attempt stays in flight for minutes -- long
   * enough for a second caller to arrive.
   */
  starting?: Promise<void>;
  state: TunnelState;
  authUrl: string | null;
  message: string | null;
  events: string[];
}

export class Daemon {
  /** Keyed by profile name, in the order the state file lists them. */
  private readonly runtimes = new Map<string, Runtime>();
  /** Daemon-level lines, the ones that belong to no single tunnel. */
  private readonly events: string[] = [];
  private readonly watchers = new Set<(status: Status) => void>();
  private server?: Server;
  private ticker?: ReturnType<typeof setInterval>;
  private renewals?: ReturnType<typeof setInterval>;

  constructor(private readonly options: DaemonOptions) {}

  private readonly log = (message: string): void => {
    for (const line of message.split("\n")) if (line.trim()) this.events.push(line.trim());
    while (this.events.length > 8) this.events.shift();
    (this.options.log ?? console.log)(message);
  };

  /** A log that lands on one profile, so its lines stay with its tunnel. */
  private logFor(name: string) {
    return (message: string): void => {
      const runtime = this.runtimes.get(name);
      for (const line of message.split("\n")) {
        if (line.trim()) runtime?.events.push(line.trim());
      }
      while ((runtime?.events.length ?? 0) > 8) runtime?.events.shift();
      (this.options.log ?? console.log)(`[${name}] ${message}`);
    };
  }

  /**
   * Every profile the state file knows, whether or not it is running. A
   * configured but stopped wave still belongs in `wave status` -- otherwise
   * there is no way to see that it exists.
   */
  private async sync(): Promise<Profile[]> {
    const profiles = await loadProfiles(this.options.statePath);
    for (const profile of profiles) {
      const runtime = this.runtimes.get(profile.controlUrl);
      if (runtime) runtime.profile = profile;
      else {
        this.runtimes.set(profile.controlUrl, {
          profile,
          state: "stopped",
          authUrl: null,
          message: null,
          events: [],
        });
      }
    }
    // A profile that was logged out elsewhere should not linger in the view.
    const known = new Set(profiles.map((profile) => profile.controlUrl));
    for (const [name, runtime] of this.runtimes) {
      if (!known.has(name) && !runtime.tunnel) this.runtimes.delete(name);
    }
    return profiles;
  }

  async status(): Promise<Status> {
    await this.sync().catch(() => []);
    const profiles: ProfileStatus[] = [];
    for (const runtime of this.runtimes.values()) {
      profiles.push(
        profileStatusFromSnapshot(await runtime.tunnel?.snapshot(), {
          controlUrl: runtime.profile.controlUrl,
          state: runtime.state,
          authUrl: runtime.authUrl,
          message: runtime.message,
          events: [...runtime.events],
        }),
      );
    }
    return {
      daemon: { version: VERSION, platform: PLATFORM, update: this.options.updater?.status() ?? null },
      profiles,
      events: [...this.events],
    };
  }

  private async publish(): Promise<void> {
    if (this.watchers.size === 0) return;
    const status = await this.status();
    for (const watcher of this.watchers) watcher(status);
  }

  /** What every running tunnel has configured, for the overlap check. */
  private claims(except: string) {
    const claims = [];
    for (const runtime of this.runtimes.values()) {
      if (runtime.profile.controlUrl === except) continue;
      const netmap = runtime.tunnel?.currentNetmap();
      if (!netmap) continue;
      claims.push({
        controlUrl: runtime.profile.controlUrl,
        cidrs: [...netmap.self.addresses, ...netmap.peers.flatMap((peer) => peer.allowedIps)],
      });
    }
    return claims;
  }

  /** Without a name: every profile that asked to come up on its own. */
  async up(name?: string): Promise<string | null> {
    const profiles = await this.sync();

    // Nothing to bring up is not a failure -- it is a device that has not
    // joined a wave yet, and `up` is not how it joins one.
    if (!name && profiles.length === 0) {
      return this.refuse("not in any wave yet — `wave login <control-server-url>` joins one");
    }

    const wanted = name ? matchProfiles(profiles, name) : profiles.filter((p) => p.autoStart);

    if (name && wanted.length !== 1) {
      return this.refuse(
        wanted.length === 0
          ? `not in a wave at ${name}; \`wave profiles\` lists the ones there are`
          : describeAmbiguity(name, wanted),
      );
    }
    // Sequentially: two enrolments starting at once would race for the same
    // interface number, and the second would want a link the first just took.
    for (const profile of wanted) await this.upOne(profile);
    return null;
  }

  /**
   * Says no, out loud and to the caller. Logging alone was not enough: the CLI
   * printed "left ..." over a logout that had removed nothing, because the
   * only answer it ever got back was "ok".
   */
  private async refuse(message: string): Promise<string> {
    this.log(message);
    await this.publish();
    return message;
  }

  /**
   * WireGuard wants one control socket per interface, so the configured path
   * says where they live rather than naming one: /run/wireguard/wave0.sock
   * means wave1 gets /run/wireguard/wave1.sock. Sharing one would leave the
   * second tunnel talking to the first one's device.
   */
  private socketFor(interfaceName: string): string | undefined {
    if (!this.options.socketPath) return undefined;
    return join(dirname(this.options.socketPath), `${interfaceName}.sock`);
  }

  private async upOne(profile: Profile, authKey?: string): Promise<void> {
    const runtime = this.runtimes.get(profile.controlUrl);
    if (!runtime || runtime.tunnel) return;
    // Guarding on the finished tunnel alone is not enough: it is only assigned
    // once `bringUp` returns, and between "login" and someone clicking approve
    // that can be minutes. A second caller would start a second enrolment, and
    // whichever one lost would then overwrite the winner's state with its own
    // timeout -- a wave reported as failed while its tunnel carries traffic.
    if (runtime.starting) return runtime.starting;

    runtime.starting = this.startOne(runtime, profile, authKey);
    try {
      await runtime.starting;
    } finally {
      runtime.starting = undefined;
    }
  }

  private async startOne(runtime: Runtime, profile: Profile, authKey?: string): Promise<void> {
    runtime.state = "starting";
    runtime.message = null;
    void this.publish();

    try {
      const tunnel = await bringUp({
        ...this.options,
        authKey,
        controlUrl: profile.controlUrl,
        interfaceName: profile.interfaceName,
        listenPort: profile.listenPort,
        socketPath: this.socketFor(profile.interfaceName),
        log: this.logFor(profile.controlUrl),
        // Every server this device is in gets to make an offer; the updater
        // takes the best valid one of them all.
        hello: this.options.updater ? () => (this.options.updater as Updater).hello() : undefined,
        onUpdate: (offer) => this.options.updater?.receive(profile.controlUrl, offer),
        onControlConnected: () => void this.options.updater?.confirm(),
        onAuthUrl: (url) => {
          runtime.authUrl = url;
          runtime.state = "waiting-for-approval";
          void this.publish();
        },
      });

      // Only now are the addresses known, so this is the first moment the
      // overlap can be seen -- and the tunnel has to go again if there is one.
      const netmap = tunnel.currentNetmap();
      const wanted = netmap
        ? [...netmap.self.addresses, ...netmap.peers.flatMap((peer) => peer.allowedIps)]
        : [];
      const conflict = findConflict(wanted, this.claims(profile.controlUrl));
      if (conflict) {
        await this.stopTunnel(tunnel);
        throw new Error(describeConflict(profile.controlUrl, conflict));
      }

      runtime.tunnel = tunnel;
      runtime.authUrl = null;
      runtime.state = "up";
    } catch (error) {
      runtime.state = "failed";
      runtime.message = error instanceof Error ? error.message : String(error);
      this.log(`${profile.controlUrl} could not come up: ${runtime.message}`);
    }
    void this.publish();
  }

  private async stopTunnel(tunnel: Tunnel): Promise<void> {
    await tunnel.stop();
    await (this.options.link ?? platformLink()).remove(tunnel.linkName).catch(() => {});
  }

  async down(wanted?: string): Promise<string | null> {
    let matched: Set<string> | null = null;
    if (wanted) {
      const found = matchProfiles(await this.sync(), wanted);
      if (found.length !== 1) {
        return this.refuse(
          found.length === 0
            ? `not in a wave at ${wanted}; \`wave profiles\` lists the ones there are`
            : describeAmbiguity(wanted, found),
        );
      }
      matched = new Set(found.map((p) => p.controlUrl));
    }
    for (const runtime of this.runtimes.values()) {
      if (matched && !matched.has(runtime.profile.controlUrl)) continue;
      const tunnel = runtime.tunnel;
      runtime.tunnel = undefined;
      runtime.state = "stopped";
      runtime.authUrl = null;
      if (tunnel) await this.stopTunnel(tunnel);
    }
    await this.publish();
    return null;
  }

  /** Leaves one wave and forgets its keys; the others are untouched. */
  async logout(wanted: string): Promise<string | null> {
    const found = matchProfiles(await this.sync(), wanted);
    // Never a bulk operation, and never a guess: this throws keys away.
    if (found.length !== 1) {
      return this.refuse(
        found.length === 0
          ? `not in a wave at ${wanted}; \`wave profiles\` lists the ones there are`
          : describeAmbiguity(wanted, found),
      );
    }

    const profile = found[0] as Profile;
    const url = profile.controlUrl;
    await this.down(url);
    // Best effort: the local enrolment goes away either way.
    await new ControlClient(profile).logout().catch((error) => this.log(`${url} logout: ${error}`));
    await removeProfile(this.options.statePath, url);
    this.runtimes.delete(url);
    this.options.updater?.forget(url);
    this.log(`left ${url}`);
    await this.publish();
    return null;
  }

  /**
   * Enrols with a further server. The profile is written before the tunnel is
   * attempted, so a device that gets interrupted mid-enrolment can simply be
   * told `wave up` again rather than starting over.
   */
  async login(wanted: string, authKey?: string): Promise<string | null> {
    const controlUrl = normaliseControlUrl(wanted);
    if (!controlUrl) return this.refuse(`${wanted} is not a control server address`);

    const profile = await ensureProfile(this.options.statePath, controlUrl);
    await this.sync();
    await this.upOne(profile, authKey);
    return null;
  }

  /**
   * Gets a certificate for one wave and keeps it from then on.
   *
   * Named like every other command that means one wave: by its control server.
   * Without a name it is this device's own name there, which is the case that
   * needs no thought -- and with one, the server decides whether it is this
   * device's to ask for.
   */
  async cert(
    wanted?: string,
    names?: string[],
    hook?: string,
    wildcard?: boolean,
  ): Promise<CertificateStatus[] | { waiting: CertWaiting } | string> {
    const profiles = await this.sync();
    if (profiles.length === 0) {
      return this.refuse("not in any wave yet — `wave login <control-server-url>` joins one");
    }

    const found = wanted ? matchProfiles(profiles, wanted) : profiles;
    if (found.length !== 1) {
      return this.refuse(
        found.length === 0
          ? `not in a wave at ${wanted}; \`wave profiles\` lists the ones there are`
          : wanted
            ? describeAmbiguity(wanted, found)
            : `this device is in ${found.length} waves; name the one the certificate is for`,
      );
    }

    const profile = found[0] as Profile;
    const log = this.logFor(profile.controlUrl);
    try {
      const result = await issueCertificate({
        statePath: this.options.statePath,
        profile,
        names,
        wildcard,
        hook: hook ?? null,
        log,
      });
      // Handed straight back rather than waited on: the records need a person,
      // and the caller is the only one here who can reach one.
      if ("waiting" in result) return { waiting: { name: result.name, records: result.waiting } };

      await this.sync();
      await this.publish();
      return [{ controlUrl: profile.controlUrl, ...result.issued }];
    } catch (error) {
      // What was asked for, in the words it was asked in. `--wildcard` sends no
      // names at all -- the suffix comes from the netmap, which is exactly what
      // a failure here may not have got to -- so an empty list is not "no name"
      // but "the wildcard", and without either it is the wave itself.
      const asked = names?.length ? names.join(", ") : wildcard ? "the wave's wildcard" : profile.controlUrl;
      return this.refuse(`no certificate for ${asked}: ${describe(error)}`);
    }
  }

  /** What this device holds, across every wave. */
  async certs(): Promise<CertificateStatus[]> {
    const profiles = await this.sync();
    return profiles.flatMap((profile) =>
      profile.certs.map((record) => ({
        controlUrl: profile.controlUrl,
        ...record,
        ...certPaths(this.options.statePath, record.name),
      })),
    );
  }

  /**
   * Renews what has reached its date, silently and on its own.
   *
   * The whole point of the first issuance being a command is that this one is
   * not: a service that stops serving HTTPS after ninety days because nobody
   * ran anything is the failure this exists to prevent. A renewal that fails
   * is logged and tried again on the next round -- the date stays in the past
   * until one succeeds.
   */
  async renewDue(now: Date = new Date()): Promise<void> {
    for (const profile of await this.sync()) {
      for (const record of dueCertificates(profile, now)) {
        const log = this.logFor(profile.controlUrl);
        try {
          const result = await issueCertificate({
            statePath: this.options.statePath,
            profile,
            names: namesOf(record),
            hook: record.hook,
            log,
          });
          // Nobody is watching a renewal, so a record that has to be made by
          // hand is said out loud and left: the date stays in the past, the
          // next round asks again, and the order at the CA stays open.
          if ("waiting" in result) {
            for (const wanted of result.waiting) {
              log(`${record.name} needs a TXT record: ${wanted.name} = ${wanted.value}`);
            }
          }
        } catch (error) {
          log(`could not renew ${record.name}: ${describe(error)}`);
        }
      }
    }
  }

  /**
   * Binds the control socket and starts serving. node:net rather than a
   * Bun-specific listener, because the same call gives a named pipe on
   * Windows and a unix socket everywhere else.
   */
  async listen(): Promise<string> {
    const path = this.options.controlSocketPath ?? DEFAULT_SOCKET_PATH;
    if (!isPipe(path)) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
      if (existsSync(path)) rmSync(path, { force: true });
    }

    this.server = createServer((socket: Socket) => {
      const client: ClientData = { reader: new LineReader() };
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        for (const line of client.reader.push(chunk)) void this.handle(socket, client, line);
      });
      socket.on("error", () => socket.destroy());
      socket.on("close", () => {
        if (client.watch) this.watchers.delete(client.watch);
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(path, resolve);
    });

    this.applyPermissions(path);
    this.ticker = setInterval(() => void this.publish(), 1000);
    // Hourly, and once at the start: a renewal window is days wide, so the
    // exact moment does not matter -- being there at all does.
    this.renewals = setInterval(() => void this.renewDue().catch(() => {}), RENEWAL_CHECK_MS);
    void this.renewDue().catch(() => {});
    return path;
  }

  /**
   * Access is decided by the socket's permissions: root always, plus one group
   * if configured. Without a group the socket stays root-only rather than
   * falling back to something more permissive.
   */
  private applyPermissions(path: string): void {
    if (isPipe(path)) {
      // A named pipe carries an ACL instead of a mode; the default already
      // limits it to the creating account and administrators.
      this.log("control channel is a named pipe; access follows its ACL");
      return;
    }
    const group = this.options.socketGroup ? resolveGroupId(this.options.socketGroup) : null;
    if (group === null) {
      chmodSync(path, 0o600);
      if (this.options.socketGroup) {
        this.log(`group ${this.options.socketGroup} does not exist; only root can use the control socket`);
      }
      return;
    }
    try {
      chownSync(path, 0, group);
      chmodSync(path, 0o660);
      this.log(`control socket at ${path} for group ${this.options.socketGroup}`);
    } catch (error) {
      chmodSync(path, 0o600);
      this.log(`could not hand the socket to the group (${error}); only root can use it`);
    }
  }

  private async handle(socket: Socket, client: ClientData, line: string): Promise<void> {
    const reply = (message: unknown) => socket.write(encodeMessage(message));

    const parsed = Request.safeParse(JSON.parse(line));
    if (!parsed.success) {
      reply({ type: "error", message: "unknown command" });
      return;
    }

    switch (parsed.data.command) {
      case "status":
        reply({ type: "status", status: await this.status() });
        return;
      case "watch": {
        // One callback per connection, so closing removes exactly that one.
        client.watch ??= (status: Status) => reply({ type: "status", status });
        this.watchers.add(client.watch);
        reply({ type: "status", status: await this.status() });
        return;
      }
      case "up": {
        const refused = await this.up(parsed.data.controlUrl);
        if (refused) reply({ type: "error", message: refused });
        else reply({ type: "status", status: await this.status() });
        return;
      }
      case "down": {
        const refused = await this.down(parsed.data.controlUrl);
        reply(refused ? { type: "error", message: refused } : { type: "ok" });
        return;
      }
      case "logout": {
        const refused = await this.logout(parsed.data.controlUrl);
        reply(refused ? { type: "error", message: refused } : { type: "ok" });
        return;
      }
      case "login": {
        const refused = await this.login(parsed.data.controlUrl, parsed.data.authKey);
        if (refused) reply({ type: "error", message: refused });
        else reply({ type: "status", status: await this.status() });
        return;
      }
      case "cert": {
        const result = await this.cert(
          parsed.data.controlUrl,
          parsed.data.names,
          parsed.data.hook,
          parsed.data.wildcard,
        );
        if (typeof result === "string") reply({ type: "error", message: result });
        else if ("waiting" in result) reply({ type: "cert-waiting", waiting: result.waiting });
        else reply({ type: "certs", certs: result });
        return;
      }
      case "certs":
        reply({ type: "certs", certs: await this.certs() });
        return;
      case "update": {
        const updater = this.options.updater;
        if (!updater) {
          reply({ type: "error", message: "this daemon does not update itself (it runs from source)" });
          return;
        }
        const { channel, autoUpdate, install } = parsed.data;
        if (channel !== undefined || autoUpdate !== undefined) {
          await updater.configure({ channel, autoUpdate });
          // The servers assign the channel, so they have to hear the new wish
          // now and not with the next reconnect.
          for (const runtime of this.runtimes.values()) runtime.tunnel?.announce();
        }
        // On success the process ends here and the caller hears nothing but
        // the socket closing -- which is what "restarting" looks like.
        const message = install ? await updater.installNow() : null;
        reply({ type: "update", update: updater.status(), message });
        return;
      }
    }
  }

  async stop(): Promise<void> {
    this.options.updater?.stop();
    if (this.ticker) clearInterval(this.ticker);
    if (this.renewals) clearInterval(this.renewals);
    this.watchers.clear();
    this.server?.close();
    for (const runtime of this.runtimes.values()) await runtime.tunnel?.stop();
  }
}
