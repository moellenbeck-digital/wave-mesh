import { randomInt } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Certificates in Synology DSM's own store.
 *
 * DSM keeps every certificate it knows in `_archive/<id>/` -- cert.pem,
 * chain.pem, fullchain.pem and privkey.pem -- and describes them in one file,
 * `_archive/INFO`: per id a description and the list of services that use it.
 * A service is a pair of names, a subscriber and a service, and its own
 * directory (`system/default`, `smbftpd/ftpd`, `ReverseProxy/<uuid>` ...)
 * holds a copy of the four files. Assigning a certificate in the control panel
 * is DSM moving a service from one id's list to another's and copying the
 * files; a renewal that wants to behave like DSM has to do the second half
 * for every service already on the list, and then tell each subscriber.
 *
 * What is deliberately left alone: `_archive/DEFAULT`, which names the
 * certificate DSM falls back to, and the service lists themselves. Taking
 * over the web interface's certificate because somebody asked for a
 * certificate would be a side effect nobody asked for -- the first assignment
 * is one choice in the control panel, and from then on renewals follow it.
 *
 * Layout and reload steps as the community tool synology-letsencrypt
 * (JessThrysoee) uses them on DSM 6 and 7; Synology documents none of it.
 */

export interface DsmPaths {
  /** `/etc.defaults/VERSION`: present on every DSM, says which one. */
  versionFile: string;
  /** The store: `_archive` lives in here, and the services' own directories as well. */
  certRoot: string;
  /** Where else a service's directory may be; packages keep theirs under /usr/local. */
  serviceRoots: string[];
  /** Directories holding one reload script per subscriber. */
  subscriberDirs: string[];
  /** DSM's per-service TLS profile scripts, run after a certificate changed. */
  profileDir: string;
  /** Reloads nginx where no subscriber script is there to do it. */
  synosystemctl: string;
}

export const DSM_PATHS: DsmPaths = {
  versionFile: "/etc.defaults/VERSION",
  certRoot: "/usr/syno/etc/certificate",
  serviceRoots: ["/usr/local/etc/certificate", "/usr/syno/etc/certificate"],
  subscriberDirs: [
    "/usr/libexec/certificate.d",
    "/usr/local/libexec/certificate.d",
    "/usr/syno/share/certificate.d",
    "/usr/local/share/certificate.d",
  ],
  profileDir: "/usr/libexec/security-profile/tls-profile",
  synosystemctl: "/usr/syno/bin/synosystemctl",
};

/** What the store is told about a certificate. */
export interface DsmCertificate {
  /** What the control panel shows, and how an entry is found again without an id. */
  description: string;
  /** The id from the last time, if there was one. */
  id?: string | null;
  keyPem: string;
  /** Leaf first, then the issuers -- what the control server hands back. */
  chainPem: string;
}

export interface DsmResult {
  id: string;
  /** `subscriber/service` of every service the files went to. */
  services: string[];
  /** Whether this created the entry, which is when somebody has to assign it. */
  created: boolean;
}

export type DsmRunner = (command: string[]) => Promise<{ code: number; output: string }>;

export interface DsmOptions {
  paths?: DsmPaths;
  run?: DsmRunner;
  log?: (message: string) => void;
}

interface DsmService {
  subscriber: string;
  service: string;
  [key: string]: unknown;
}
interface DsmEntry {
  desc?: string;
  services?: DsmService[];
  [key: string]: unknown;
}
type DsmInfo = Record<string, DsmEntry>;

/**
 * Whether this is a Synology DSM, and which version -- or null.
 *
 * Asked of the version file rather than of the platform: every NAS says
 * "linux", and `/usr/syno` exists on machines that merely carry its tools.
 */
export function detectDsm(
  paths: DsmPaths = DSM_PATHS,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): { version: string } | null {
  let text: string;
  try {
    text = read(paths.versionFile);
  } catch {
    return null;
  }
  if (!/^os_name="?DSM"?\s*$/m.test(text)) return null;
  return { version: /^productversion="?([^"\n]+)"?\s*$/m.exec(text)?.[1] ?? "" };
}

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Six characters, the shape DSM gives its own ids. */
function newId(taken: (id: string) => boolean): string {
  for (;;) {
    let id = "";
    for (let i = 0; i < 6; i++) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
    if (!taken(id)) return id;
  }
}

/** The certificates in a chain, in order. */
export function pemCertificates(pem: string): string[] {
  return pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
}

/**
 * Written beside and renamed over, so a service reading the file while a
 * renewal runs sees the old certificate or the new one and never half of
 * either.
 */
async function writeAtomic(path: string, content: string, mode: number): Promise<void> {
  const staged = `${path}.wave-new`;
  await writeFile(staged, content, { mode });
  await chmod(staged, mode).catch(() => {});
  await rename(staged, path);
}

async function readInfo(path: string): Promise<DsmInfo> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`${path} cannot be read (${(error as NodeJS.ErrnoException).code ?? error})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Never overwritten on a guess: this file is DSM's whole index of its
    // certificates, and a renewal is not worth losing it.
    throw new Error(`${path} is not valid JSON; leaving it alone`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} is not what DSM writes; leaving it alone`);
  }
  return parsed as DsmInfo;
}

const isExecutable = (path: string): boolean => {
  try {
    const stat = statSync(path);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
};

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const spawnRunner: DsmRunner = async (command) => {
  try {
    const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, output: `${out}${err}` };
  } catch (error) {
    return { code: 127, output: String(error) };
  }
};

/**
 * Puts a certificate into DSM's store, and keeps it there up to date.
 *
 * The same entry every time: by the id remembered from the last run, and where
 * there is none -- the state file was lost, the device enrolled again -- by its
 * description, so a renewal never adds a second certificate beside the first.
 *
 * Throws when the store itself cannot be written; a service that fails to
 * reload is said through `log` instead, because the files are in place and the
 * others still have to be served.
 */
export async function installInDsm(cert: DsmCertificate, options: DsmOptions = {}): Promise<DsmResult> {
  const paths = options.paths ?? DSM_PATHS;
  const run = options.run ?? spawnRunner;
  const log = options.log ?? (() => {});

  const blocks = pemCertificates(cert.chainPem);
  const leaf = blocks[0];
  if (!leaf) throw new Error("the chain has no certificate in it");
  const files: Array<[string, string, number]> = [
    ["cert.pem", `${leaf}\n`, 0o644],
    ["chain.pem", blocks.length > 1 ? `${blocks.slice(1).join("\n")}\n` : "", 0o644],
    ["fullchain.pem", `${blocks.join("\n")}\n`, 0o644],
    // The key is the one file here nobody but root has any business reading.
    ["privkey.pem", cert.keyPem, 0o600],
  ];

  const archive = join(paths.certRoot, "_archive");
  const infoPath = join(archive, "INFO");
  const info = await readInfo(infoPath);

  let id = cert.id && info[cert.id] ? cert.id : null;
  id ??= Object.keys(info).find((key) => info[key]?.desc === cert.description) ?? null;
  const created = id === null;
  if (id === null) id = newId((candidate) => candidate in info || existsSync(join(archive, candidate)));

  const dir = join(archive, id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const [name, content, mode] of files) await writeAtomic(join(dir, name), content, mode);

  // After the files, so DSM never lists a certificate it cannot read. An
  // existing entry is not rewritten at all: its services are DSM's to manage.
  if (created) {
    info[id] = { desc: cert.description, services: [] };
    await writeAtomic(infoPath, `${JSON.stringify(info, null, 2)}\n`, 0o644);
  }

  const used: string[] = [];
  const assigned = info[id]?.services;
  for (const service of Array.isArray(assigned) ? assigned : []) {
    const { subscriber, service: name } = service;
    if (typeof subscriber !== "string" || typeof name !== "string") continue;
    const label = `${subscriber}/${name}`;
    const target = paths.serviceRoots
      .map((root) => join(root, subscriber, name))
      .find((candidate) => isDirectory(candidate));
    if (!target) {
      log(`DSM: no directory for ${label}; skipped`);
      continue;
    }
    try {
      for (const [file, content, mode] of files) await writeAtomic(join(target, file), content, mode);
    } catch (error) {
      log(`DSM: could not update ${label}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    used.push(label);
    await reload(subscriber, name, paths, run, log);
  }
  return { id, services: used, created };
}

/**
 * Tells a service its certificate changed, the way DSM does: the subscriber's
 * own script first, then the TLS profile that regenerates what hangs off it.
 * Where DSM's web interface has neither, nginx is reloaded directly -- it is
 * the one thing a certificate on `system/default` is for.
 */
async function reload(
  subscriber: string,
  service: string,
  paths: DsmPaths,
  run: DsmRunner,
  log: (message: string) => void,
): Promise<void> {
  const commands: string[][] = [];

  const script = paths.subscriberDirs.map((dir) => join(dir, subscriber)).find(isExecutable);
  if (script) commands.push([script, service]);

  const profile = join(
    paths.profileDir,
    `${subscriber === "system" && service === "default" ? "dsm" : subscriber}.sh`,
  );
  if (isExecutable(profile)) commands.push([profile]);

  if (commands.length === 0 && subscriber === "system") {
    commands.push([paths.synosystemctl, "reload", "nginx"]);
  }

  for (const command of commands) {
    const result = await run(command);
    if (result.code !== 0) {
      const output = result.output.trim().slice(0, 200);
      log(`DSM: ${command.join(" ")} exited ${result.code}${output ? `: ${output}` : ""}`);
    }
  }
}
