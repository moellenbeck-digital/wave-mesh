import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { RELEASE_PUBLIC_KEYS, verifyRelease } from "@wave/crypto";
import {
  englishText,
  isDevVersion,
  type Notice,
  notice,
  PLATFORM,
  type UpdateStatus,
  VERSION,
} from "@wave/ipc";
import {
  archiveName,
  channelAccepts,
  compareVersions,
  type ReleaseArchive,
  type SignedRelease,
  type UpdateChannel,
} from "@wave/proto";
import { ControlClient } from "./api.ts";
import type { Hello, UpdateOffer } from "./control-socket.ts";
import { defaultBinaryPath, WINDOWS_DAEMON_TASK } from "./install.ts";
import { loadUpdateSettings, type Profile, type UpdateSettings, updateUpdateSettings } from "./state.ts";

/**
 * The daemon updating itself (D13).
 *
 * Only the daemon: it is the one process allowed to write the installation
 * directory. The CLI and the tray can show that an update is there and ask
 * for it to happen now, but which version and from where is decided here,
 * from signed offers -- otherwise any member of the socket's group could have
 * root run a binary of their choosing.
 *
 * The order of an update, and why:
 *
 * 1. Offers arrive from every control server this device is enrolled with.
 *    The best valid one wins: signed by a release key this binary carries,
 *    from a channel the offering server assigned, newer than this build and
 *    never rolled back before. Which operator to believe never comes up --
 *    every valid offer is a genuine release.
 * 2. A random delay of up to a few hours, so a release does not arrive on
 *    every device at once -- every download goes through one control pod.
 * 3. The archive, through the server that offered it, checked against the
 *    manifest's hash before anything is opened.
 * 4. The swap: each file is renamed to `.old` and the new one renamed into
 *    place. That works over running files on every platform -- even Windows
 *    lets a running .exe be renamed, only not overwritten.
 * 5. The process ends and the service manager starts the new build. It has a
 *    few minutes to reach a control server; otherwise the next start puts the
 *    `.old` files back and never takes that version again. Without that, a
 *    bad release takes every device off the network -- and through the
 *    tunnel nobody can reach them any more to repair it.
 */

/** The files a release replaces, as they are named beside the binary. */
export const updateFiles = (os: NodeJS.Platform): string[] =>
  os === "win32" ? ["wave.exe", "wireguard.exe", "wintun.dll"] : ["wave", "wireguard-go"];

/** Whether this process is a `bun build --compile` binary rather than bun running a script. */
export function isCompiledBinary(main: string = Bun.main): boolean {
  return main.startsWith("/$bunfs/") || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(main);
}

/** Where package managers keep binaries: they update those, we do not. */
const PACKAGE_MANAGED = [
  /^\/usr\/bin\//,
  /^\/usr\/sbin\//,
  /^\/opt\/homebrew\//,
  /\/Cellar\//,
  /^\/nix\/store\//,
];

/**
 * Why this binary must not update itself, or null if it may.
 *
 * Only the copy `wave install` put in place updates: that is the one a service
 * manager restarts, and the one nothing else claims. A package manager that
 * owns the file would overwrite us and we it, so there the offers are only
 * shown.
 */
export function updateBlocker(options: {
  version: string;
  compiled: boolean;
  execPath: string;
  os: NodeJS.Platform;
  /** Where `wave install` puts the binary; only the tests say otherwise. */
  installedPath?: string;
}): Notice | null {
  if (!options.compiled || isDevVersion(options.version)) return notice("update-dev-build");
  let path = options.execPath;
  try {
    path = realpathSync(path);
  } catch {
    // Keep what we were told; the comparison below then decides.
  }
  if (PACKAGE_MANAGED.some((pattern) => pattern.test(path))) {
    return notice("update-package-managed", { path });
  }
  const installed = options.installedPath ?? defaultBinaryPath(options.os);
  let installedRealPath = installed;
  try {
    installedRealPath = realpathSync(installed);
  } catch {
    // The default installation may not exist yet; the comparison still blocks updates.
  }
  if (path !== installedRealPath) {
    return notice("update-not-installed-copy", { path, installed });
  }
  return null;
}

export interface Choice {
  signed: SignedRelease;
  archive: ReleaseArchive;
  /** Every server offering exactly this archive, so a failed download can try the next. */
  sources: string[];
}

export interface Rejection {
  controlUrl: string;
  version: string;
  reason: string;
}

/**
 * The best update among the offers, and why the others were not taken.
 *
 * An offer that is merely not newer is not a rejection -- that is the normal
 * state of a device that is up to date, and there is nothing to say about it.
 * Downgrades are never taken, whatever the signature: an old release with a
 * valid one is exactly how a server would bring back a fixed hole.
 */
export function chooseUpdate(
  offers: Iterable<[string, UpdateOffer]>,
  context: { version: string; platform: string; broken: string[]; trusted?: readonly string[] },
): { choice: Choice | null; rejected: Rejection[] } {
  const rejected: Rejection[] = [];
  const valid: Array<{ controlUrl: string; signed: SignedRelease; archive: ReleaseArchive }> = [];
  const wanted = archiveName(context.platform);

  for (const [controlUrl, offer] of offers) {
    const signed = offer.offer;
    if (!signed) continue;
    const { manifest } = signed;
    const reject = (reason: string) => rejected.push({ controlUrl, version: manifest.version, reason });

    if (!verifyRelease(manifest, signed.signature, signed.keyId, context.trusted ?? RELEASE_PUBLIC_KEYS)) {
      reject("not signed by a release key this build trusts");
      continue;
    }
    if (!channelAccepts(offer.channel, manifest.channel)) {
      reject(`a ${manifest.channel} release, offered on ${offer.channel}`);
      continue;
    }
    if (compareVersions(manifest.version, context.version) <= 0) continue;
    if (context.broken.includes(manifest.version)) {
      reject("rolled back once on this device");
      continue;
    }
    const archive = manifest.archives.find(
      (entry) => entry.platform === context.platform && entry.name === wanted,
    );
    if (!archive) {
      reject(`no archive for ${context.platform}`);
      continue;
    }
    valid.push({ controlUrl, signed, archive });
  }

  if (valid.length === 0) return { choice: null, rejected };
  valid.sort((a, b) => compareVersions(b.signed.manifest.version, a.signed.manifest.version));
  const best = valid[0] as (typeof valid)[number];
  const sources = valid
    .filter(
      (entry) =>
        entry.signed.manifest.version === best.signed.manifest.version &&
        entry.archive.sha256 === best.archive.sha256,
    )
    .map((entry) => entry.controlUrl);
  return { choice: { signed: best.signed, archive: best.archive, sources }, rejected };
}

/**
 * Puts the new files in place, keeping each old one beside it as `.old`.
 *
 * Renames only, which is what makes it work over running files: Unix keeps
 * the old inode for whoever has it open, Windows refuses to overwrite a
 * running .exe but not to rename it. If one rename fails, the ones before it
 * are undone -- half a release is worse than either whole one.
 */
export function swapIn(installDir: string, stagedDir: string, files: string[], os: NodeJS.Platform): void {
  for (const file of files) {
    if (!existsSync(join(stagedDir, file))) throw new Error(`the archive has no ${file}`);
  }
  const done: string[] = [];
  try {
    for (const file of files) {
      const target = join(installDir, file);
      rmSync(`${target}.old`, { force: true });
      if (existsSync(target)) renameSync(target, `${target}.old`);
      renameSync(join(stagedDir, file), target);
      if (os !== "win32") chmodSync(target, 0o755);
      done.push(file);
    }
  } catch (error) {
    restore(installDir, done);
    throw error;
  }
}

/**
 * Brings the `.old` files back. The one being replaced may be running -- on
 * Windows it is, it is us -- so it is renamed out of the way rather than
 * deleted, and removed only where that works.
 */
export function restore(installDir: string, files: string[]): void {
  for (const file of files) {
    const target = join(installDir, file);
    const old = `${target}.old`;
    if (!existsSync(old)) continue;
    if (existsSync(target)) {
      rmSync(`${target}.failed`, { force: true });
      renameSync(target, `${target}.failed`);
    }
    renameSync(old, target);
    try {
      rmSync(`${target}.failed`, { force: true });
    } catch {
      // Still running; the next update's swap clears it.
    }
  }
}

/** Removes what an update left behind once it has proven itself. Best effort. */
export function dropOld(installDir: string, files: string[]): void {
  for (const file of files) {
    for (const suffix of [".old", ".failed"]) {
      try {
        rmSync(join(installDir, `${file}${suffix}`), { force: true });
      } catch {
        // A file still in use on Windows; harmless, and gone next time.
      }
    }
  }
}

/**
 * Streams an archive to disk and checks it against the manifest while it
 * comes in. More bytes than the manifest says is a failure at once rather
 * than after filling the disk.
 */
export async function receiveArchive(
  response: Response,
  dest: string,
  archive: ReleaseArchive,
): Promise<void> {
  if (!response.body) throw new Error("the download has no body");
  const hash = createHash("sha256");
  const writer = Bun.file(dest).writer();
  let size = 0;
  try {
    try {
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > archive.size) throw new Error(`more than the ${archive.size} bytes the manifest names`);
        hash.update(chunk);
        writer.write(chunk);
      }
    } finally {
      await writer.end();
    }
    const digest = hash.digest("hex");
    if (size !== archive.size || digest !== archive.sha256) {
      throw new Error(`${archive.name} does not match its manifest (sha256 ${digest}, ${size} bytes)`);
    }
  } catch (error) {
    // Nothing of a file that failed its check stays on disk to be opened.
    rmSync(dest, { force: true });
    throw error;
  }
}

/** Unpacks with the system's tar, which on Windows 10 and later also reads zip. */
async function extract(archive: string, into: string): Promise<void> {
  mkdirSync(into, { recursive: true });
  const proc = Bun.spawn(["tar", archive.endsWith(".zip") ? "-xf" : "-xzf", archive, "-C", into], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`could not unpack ${archive}: ${stderr.trim() || `tar exited ${code}`}`);
}

export interface UpdaterOptions {
  statePath: string;
  log: (message: string) => void;
  /** The enrolment for a control server, to sign the download with. */
  profile: (controlUrl: string) => Promise<Profile | undefined>;
  /** Takes the tunnels down before the process ends. */
  shutdown: () => Promise<void>;
  exit?: (code: number) => void;
  version?: string;
  platform?: string;
  os?: NodeJS.Platform;
  execPath?: string;
  /** Where `wave install` puts the binary; only the tests say otherwise. */
  installedPath?: string;
  compiled?: boolean;
  trusted?: readonly string[];
  /** The longest random wait before an offered update is installed. */
  maxDelayMs?: number;
  /** How long a new build has to reach a control server before it is rolled back. */
  trialMs?: number;
  random?: () => number;
  now?: () => Date;
}

const HOUR = 60 * 60 * 1000;

export class Updater {
  private readonly offers = new Map<string, UpdateOffer>();
  private settings: UpdateSettings | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private scheduledAt: Date | null = null;
  private installing = false;
  private message: Notice | null = null;
  private trial?: { pending: NonNullable<UpdateSettings["pending"]>; timer: ReturnType<typeof setTimeout> };
  /** What has been said about rejected offers, so each is logged once. */
  private readonly said = new Set<string>();
  private readonly blocker: Notice | null;

  private readonly version: string;
  private readonly platform: string;
  private readonly os: NodeJS.Platform;
  private readonly execPath: string;

  constructor(private readonly options: UpdaterOptions) {
    this.version = options.version ?? VERSION;
    this.platform = options.platform ?? PLATFORM;
    this.os = options.os ?? process.platform;
    this.execPath = options.execPath ?? process.execPath;
    this.blocker = updateBlocker({
      version: this.version,
      compiled: options.compiled ?? isCompiledBinary(),
      execPath: this.execPath,
      os: this.os,
      installedPath: options.installedPath,
    });
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private exit(code: number): void {
    (this.options.exit ?? process.exit)(code);
  }

  /**
   * Reads the settings and settles an update that is still on trial. Called
   * once, at the start, before any tunnel: a build that keeps failing to come
   * up comes back here on every restart, and the deadline is checked against
   * the clock, not against a timer that a crash would have taken with it.
   */
  async init(): Promise<void> {
    this.settings = await loadUpdateSettings(this.options.statePath);
    const pending = this.settings.pending;
    if (!pending) return;

    if (pending.version !== this.version) {
      // Not the build on trial. Either the old one is back -- the swap failed
      // or something put it back -- or somebody installed another by hand.
      if (this.version === pending.from) {
        this.options.log(`the update to ${pending.version} did not hold; staying on ${this.version}`);
        await this.save({ pending: null, broken: unique([...this.settings.broken, pending.version]) });
      } else {
        await this.save({ pending: null });
      }
      dropOld(pending.installDir, pending.files);
      return;
    }

    const trialMs = this.options.trialMs ?? 5 * 60 * 1000;
    const left = Date.parse(pending.startedAt) + trialMs - this.now().getTime();
    if (left <= 0) {
      await this.rollBack(
        pending,
        `did not reach a control server within ${Math.round(trialMs / 60000)} minutes`,
      );
      return;
    }
    this.options.log(`running ${this.version} on trial: it has to reach a control server to stay`);
    this.trial = {
      pending,
      timer: setTimeout(
        () =>
          void this.rollBack(
            pending,
            `did not reach a control server within ${Math.round(trialMs / 60000)} minutes`,
          ),
        left,
      ),
    };
  }

  private async save(patch: Partial<UpdateSettings>): Promise<UpdateSettings> {
    this.settings = await updateUpdateSettings(this.options.statePath, patch);
    return this.settings;
  }

  /**
   * A control connection is up. For a build on trial that is the proof it
   * works: the `.old` files go and the update stays. Also called when there
   * is nothing to connect to, because then there is nothing to prove.
   */
  async confirm(): Promise<void> {
    const trial = this.trial;
    if (!trial) return;
    this.trial = undefined;
    clearTimeout(trial.timer);
    await this.save({ pending: null });
    dropOld(trial.pending.installDir, trial.pending.files);
    this.options.log(`the update to ${this.version} holds`);
  }

  private async rollBack(pending: NonNullable<UpdateSettings["pending"]>, why: string): Promise<void> {
    this.trial = undefined;
    // Written before anything moves: if the restore fails half-way, the old
    // build that comes up must not take this version again.
    const settings = this.settings ?? (await loadUpdateSettings(this.options.statePath));
    await this.save({ pending: null, broken: unique([...settings.broken, pending.version]) });
    this.options.log(`${pending.version} ${why}; going back to ${pending.from}`);
    try {
      restore(pending.installDir, pending.files);
    } catch (error) {
      this.options.log(`could not put ${pending.from} back: ${describe(error)}`);
      return;
    }
    await this.restart();
  }

  /** What this device says about itself in every `hello`. */
  hello(): Hello {
    return {
      version: this.version,
      platform: this.platform,
      ...(this.settings?.channel ? { channel: this.settings.channel } : {}),
      autoUpdate: this.settings?.autoUpdate ?? true,
    };
  }

  receive(controlUrl: string, offer: UpdateOffer): void {
    this.offers.set(controlUrl, offer);
    this.consider();
  }

  /** A wave was left; its server no longer has a say. */
  forget(controlUrl: string): void {
    this.offers.delete(controlUrl);
    this.consider();
  }

  private choose(): Choice | null {
    const { choice, rejected } = chooseUpdate(this.offers, {
      version: this.version,
      platform: this.platform,
      broken: this.settings?.broken ?? [],
      trusted: this.options.trusted,
    });
    for (const rejection of rejected) {
      const key = `${rejection.controlUrl} ${rejection.version} ${rejection.reason}`;
      if (this.said.has(key)) continue;
      this.said.add(key);
      this.options.log(
        `update ${rejection.version} from ${rejection.controlUrl} refused: ${rejection.reason}`,
      );
    }
    return choice;
  }

  /** Schedules the best offer, if there is one and this device takes updates. */
  private consider(): void {
    const choice = this.choose();
    if (!choice) {
      this.unschedule();
      return;
    }
    if (this.installing || this.timer) return;
    if (this.blocker || !(this.settings?.autoUpdate ?? true)) return;

    const delay = Math.floor((this.options.random ?? Math.random)() * (this.options.maxDelayMs ?? 4 * HOUR));
    this.scheduledAt = new Date(this.now().getTime() + delay);
    // Fires with whatever is best then, not with what was best now: a newer
    // release that arrives meanwhile simply replaces this one.
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.scheduledAt = null;
      const current = this.choose();
      if (current) void this.install(current);
    }, delay);
    this.options.log(
      `update to ${choice.signed.manifest.version} available; installing at ${this.scheduledAt.toISOString()}`,
    );
  }

  private unschedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.scheduledAt = null;
  }

  /** Changes the settings and tells the caller where that leaves things. */
  async configure(patch: { channel?: UpdateChannel | null; autoUpdate?: boolean }): Promise<UpdateStatus> {
    await this.save({
      ...(patch.channel !== undefined ? { channel: patch.channel } : {}),
      ...(patch.autoUpdate !== undefined ? { autoUpdate: patch.autoUpdate } : {}),
    });
    if (patch.autoUpdate === false) this.unschedule();
    this.consider();
    return this.status();
  }

  /** `wave update`: the best offer, now rather than after the delay. */
  async installNow(): Promise<Notice> {
    if (this.blocker) return this.blocker;
    if (this.installing) return notice("update-busy");
    const choice = this.choose();
    if (!choice) return notice("update-newest", { version: this.version });
    this.unschedule();
    // Not awaited past the download: on success the process ends, and the
    // caller would never get an answer anyway.
    const failure = await this.install(choice);
    return failure ?? notice("update-installing", { version: choice.signed.manifest.version });
  }

  /** Returns why it failed; on success it does not return at all. */
  private async install(choice: Choice): Promise<Notice | null> {
    const version = choice.signed.manifest.version;
    this.installing = true;
    this.message = notice("update-installing", { version });
    const installDir = dirname(realpathSync(this.execPath));
    // Beside the binary rather than in a temp directory: a rename only works
    // within one filesystem, and the swap is nothing but renames.
    const staging = join(installDir, `.wave-update-${version}`);
    const files = updateFiles(this.os);

    try {
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true, mode: 0o700 });
      const archivePath = join(staging, choice.archive.name);

      let fetched = false;
      for (const source of choice.sources) {
        const profile = await this.options.profile(source);
        if (!profile) continue;
        try {
          const response = await new ControlClient(profile).download(version, choice.archive.name);
          await receiveArchive(response, archivePath, choice.archive);
          fetched = true;
          break;
        } catch (error) {
          this.options.log(`could not fetch ${version} from ${source}: ${describe(error)}`);
        }
      }
      if (!fetched) throw new Error(`no server delivered ${choice.archive.name}`);

      const unpacked = join(staging, "unpacked");
      await extract(archivePath, unpacked);

      // Written before the first file moves, so whatever happens next -- a
      // power cut in the middle of the swap included -- the next start knows
      // what was going on and can go back.
      await this.save({
        pending: { version, from: this.version, startedAt: this.now().toISOString(), files, installDir },
      });
      try {
        swapIn(installDir, unpacked, files, this.os);
      } catch (error) {
        await this.save({ pending: null });
        throw error;
      }
      rmSync(staging, { recursive: true, force: true });
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      this.installing = false;
      this.message = notice("update-failed", { version, reason: describe(error) });
      this.options.log(englishText(this.message));
      return this.message;
    }

    this.options.log(`installed ${version}; restarting`);
    await this.restart();
    return null;
  }

  /**
   * Ends this process so the service manager starts the new build. systemd
   * (Restart=always) and launchd (KeepAlive) restart on any exit. Task
   * Scheduler does not restart a task that ended cleanly, and its restart
   * after a failure waits at least a minute -- so on Windows a detached
   * helper runs the task again a few seconds after we are gone, and the
   * failure exit is the fallback if it does not.
   */
  private async restart(): Promise<void> {
    await this.options.shutdown().catch((error) => this.options.log(`shutdown: ${describe(error)}`));
    if (this.os === "win32") {
      try {
        Bun.spawn(
          [
            "powershell.exe",
            "-NoProfile",
            "-WindowStyle",
            "Hidden",
            "-Command",
            `Start-Sleep -Seconds 5; schtasks.exe /run /tn '${WINDOWS_DAEMON_TASK}'`,
          ],
          { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
        ).unref();
      } catch (error) {
        this.options.log(`could not schedule the restart: ${describe(error)}`);
      }
      this.exit(1);
      return;
    }
    this.exit(0);
  }

  status(): UpdateStatus {
    const choice = this.peek();
    return {
      autoUpdate: this.settings?.autoUpdate ?? true,
      wish: this.settings?.channel ?? null,
      channels: [...this.offers].map(([controlUrl, offer]) => ({
        controlUrl,
        channel: offer.channel,
        offered: offer.channels,
      })),
      available: choice?.signed.manifest.version ?? null,
      state: this.installing
        ? "installing"
        : this.blocker
          ? "unavailable"
          : this.scheduledAt
            ? "scheduled"
            : "idle",
      message: this.blocker || this.message ? englishText((this.blocker ?? this.message) as Notice) : null,
      notice: this.blocker ?? this.message,
      scheduledAt: this.scheduledAt?.toISOString() ?? null,
    };
  }

  /** The best offer, without logging rejections again. */
  private peek(): Choice | null {
    return chooseUpdate(this.offers, {
      version: this.version,
      platform: this.platform,
      broken: this.settings?.broken ?? [],
      trusted: this.options.trusted,
    }).choice;
  }

  stop(): void {
    this.unschedule();
    if (this.trial) clearTimeout(this.trial.timer);
  }
}

const unique = (values: string[]): string[] => [...new Set(values)];

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));
