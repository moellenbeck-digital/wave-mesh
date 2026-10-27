#!/usr/bin/env bun
/**
 * Builds the Synology DSM 7 packages from the Linux archives.
 *
 *   bun scripts/build-spk.ts [dist]
 *
 * Run after `scripts/build-clients.sh --package`, and not instead of a build:
 * the binaries in a package are the ones out of `wave-linux-amd64.tar.gz` and
 * `wave-linux-arm64.tar.gz`, byte for byte. A second build with flags of its
 * own is how a NAS ends up running something nobody tested -- in particular
 * the one build whose tray starts and then hangs, which is the one built with
 * --minify or --sourcemap.
 *
 * Writes `wave-<version>-dsm7-x86_64.spk` and `wave-<version>-dsm7-armv8.spk`
 * and lists them in SHA256SUMS. The tar is written here and not by `tar`
 * because the release job runs on macOS: bsdtar and GNU tar disagree on how to
 * say "owned by root", and a package extracted on a NAS keeps the owner the
 * archive names. This way it is the same bytes wherever it is built.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { BRAND_COLOUR, markPixmap } from "../apps/tray/src/icon.ts";
import { pngFromPixmap } from "../apps/tray/src/png.ts";

/** SPK `arch` family, and the archive whose binaries it carries. */
export const SPK_TARGETS = [
  { arch: "x86_64", archive: "wave-linux-amd64.tar.gz" },
  { arch: "armv8", archive: "wave-linux-arm64.tar.gz" },
] as const;

/** What `wave` is called to DSM: the folder under /var/packages, and the package's name. */
export const SPK_PACKAGE = "wave";

/** Taken from the archive, and the only things that go into package.tgz. */
export const PAYLOAD = [
  { name: "wave", mode: 0o755 },
  { name: "wireguard-go", mode: 0o755 },
  { name: "LICENSE", mode: 0o644 },
  { name: "LICENSE.wireguard-go", mode: 0o644 },
] as const;

const PACKAGING = join(import.meta.dir, "..", "packaging", "dsm");

/**
 * The page in DSM's main menu (`ui/`, see INFO's dsmuidir): DSM links the
 * folder to /webman/3rdparty/wave/ and runs index.cgi there. Its key in
 * `ui/config` has to be the INFO's `dsmappname`, or DSM shows no entry.
 */
export const DSM_APP_NAME = "SYNO.SDS.wave";

/**
 * DSM wants `<feature>-<build>`, numbers only -- and ours has words in it.
 * The build number carries the channel so that Package Center's idea of "newer"
 * is semver's: develop.N before insiders.N before the release.
 *
 *   0.12.0                -> 0.12.0-3000
 *   0.12.0-insiders.2     -> 0.12.0-2002
 *   0.12.0-develop.1      -> 0.12.0-1001
 */
export function synologyVersion(version: string): string {
  const match = /^(\d+\.\d+\.\d+)(?:-(insiders|develop)\.(\d+))?$/.exec(version);
  if (!match)
    throw new Error(`${version} is not a release version (X.Y.Z, X.Y.0-insiders.N, X.Y.0-develop.N)`);
  const [, base, channel, number] = match;
  if (!channel) return `${base}-3000`;
  const n = Number(number);
  if (n > 999) throw new Error(`${version}: more than 999 builds of one channel do not fit the build number`);
  return `${base}-${(channel === "insiders" ? 2000 : 1000) + n}`;
}

export interface InfoFields {
  version: string;
  arch: string;
  /** KiB the package takes once installed; DSM checks the volume has room. */
  extractSize: number;
  /** MD5 of package.tgz, which DSM verifies before it unpacks. */
  checksum: string;
}

/** The INFO file: `key="value"`, one per line. */
export function spkInfo(fields: InfoFields): string {
  const lines: Array<[string, string]> = [
    ["package", SPK_PACKAGE],
    ["version", synologyVersion(fields.version)],
    ["os_min_ver", "7.0-40000"],
    ["arch", fields.arch],
    ["displayname", "wave"],
    [
      "description",
      "Self-hosted mesh VPN on WireGuard. After installing, set the service up once as root over SSH: sudo /var/packages/wave/scripts/setup",
    ],
    [
      "description_ger",
      "Selbst gehostetes Mesh-VPN auf WireGuard-Basis. Nach der Installation einmalig per SSH als root einrichten: sudo /var/packages/wave/scripts/setup",
    ],
    ["maintainer", "moellenbeck digital"],
    ["maintainer_url", "https://github.com/moellenbeck-digital/wave-mesh"],
    ["thirdparty", "yes"],
    ["dsmuidir", "ui"],
    ["dsmappname", DSM_APP_NAME],
    // prestart and prestop are for packages that can refuse; this one cannot.
    ["precheckstartstop", "no"],
    ["extractsize", String(fields.extractSize)],
    ["checksum", fields.checksum],
  ];
  return `${lines.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n")}\n`;
}

export interface TarEntry {
  /** Directories end in a slash. */
  path: string;
  content?: Uint8Array;
  mode: number;
}

const BLOCK = 512;

/**
 * An ustar archive, owned by root and dated 1970 so that two builds of the
 * same input are the same file.
 */
export function tar(entries: TarEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const text = new TextEncoder();
  for (const entry of entries) {
    const body = entry.content ?? new Uint8Array(0);
    const directory = entry.path.endsWith("/");
    if (text.encode(entry.path).length > 100) throw new Error(`${entry.path} is too long for a tar header`);

    const header = new Uint8Array(BLOCK);
    const put = (offset: number, value: string): void => header.set(text.encode(value), offset);
    const octal = (value: number, width: number): string => `${value.toString(8).padStart(width - 1, "0")}\0`;
    put(0, entry.path);
    put(100, octal(entry.mode, 8));
    put(108, octal(0, 8));
    put(116, octal(0, 8));
    put(124, octal(body.length, 12));
    put(136, octal(0, 12));
    put(148, "        ");
    put(156, directory ? "5" : "0");
    put(257, "ustar\0");
    put(263, "00");
    put(265, "root");
    put(297, "root");
    const sum = header.reduce((total, byte) => total + byte, 0);
    put(148, `${sum.toString(8).padStart(6, "0")}\0 `);

    parts.push(header, body, new Uint8Array((BLOCK - (body.length % BLOCK)) % BLOCK));
  }
  parts.push(new Uint8Array(BLOCK * 2));
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const md5 = (bytes: Uint8Array): string => createHash("md5").update(bytes).digest("hex");
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** The four files of an archive, read out of it with the system's own tar. */
async function unpack(archive: string): Promise<Record<string, Uint8Array>> {
  const dir = mkdtempSync(join(tmpdir(), "wave-spk-"));
  try {
    const proc = Bun.spawn(["tar", "-xzf", archive, "-C", dir], { stdout: "ignore", stderr: "pipe" });
    const [error, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`could not unpack ${archive}: ${error.trim()}`);
    const files: Record<string, Uint8Array> = {};
    for (const { name } of PAYLOAD) {
      const path = join(dir, name);
      if (!existsSync(path)) throw new Error(`${archive} has no ${name}`);
      files[name] = readFileSync(path);
    }
    return files;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Drawn once per run: the 256 px one takes a second and a half, and both builds want it. */
const iconCache = new Map<number, Uint8Array>();
const icon = (size: number): Uint8Array => {
  let png = iconCache.get(size);
  if (!png) {
    png = pngFromPixmap(markPixmap(BRAND_COLOUR, size));
    iconCache.set(size, png);
  }
  return png;
};

const packaged = (name: string): Uint8Array => readFileSync(join(PACKAGING, name));

/** Every `run-as` in a privilege file, wherever in it. */
export function runAs(privilege: unknown): string[] {
  if (Array.isArray(privilege)) return privilege.flatMap(runAs);
  if (privilege === null || typeof privilege !== "object") return [];
  return Object.entries(privilege).flatMap(([key, value]) =>
    key === "run-as" && typeof value === "string" ? [value] : runAs(value),
  );
}

/**
 * A package that asks for root is one DSM 7 will not install unless Synology
 * signed it ("wave kann nicht installiert werden, da es mit Root-Rechten
 * ausgeführt wird"), and nothing about the build would show it.
 */
function privilegeFile(): Uint8Array {
  const bytes = packaged("conf/privilege");
  if (runAs(JSON.parse(new TextDecoder().decode(bytes))).includes("root")) {
    throw new Error("packaging/dsm/conf/privilege asks for run-as root; DSM 7 refuses to install that");
  }
  return bytes;
}

/** `ui/config`, refused when it names an app other than the one INFO does. */
function uiConfig(): Uint8Array {
  const bytes = packaged("ui/config");
  const apps = Object.keys(JSON.parse(new TextDecoder().decode(bytes))[".url"] ?? {});
  if (!apps.includes(DSM_APP_NAME)) {
    throw new Error(
      `packaging/dsm/ui/config does not name ${DSM_APP_NAME}, so DSM would show no entry for it`,
    );
  }
  return bytes;
}

/** One package, as the bytes of the .spk. */
export function spk(version: string, arch: string, files: Record<string, Uint8Array>): Uint8Array {
  const payload = PAYLOAD.map(({ name, mode }) => ({ path: name, content: files[name] as Uint8Array, mode }));
  const ui = [
    { path: "ui/config", content: uiConfig(), mode: 0o644 },
    // DSM runs it: the request goes to `wave dsm-ui`.
    { path: "ui/index.cgi", content: packaged("ui/index.cgi"), mode: 0o755 },
    { path: "ui/PACKAGE_ICON_256.PNG", content: icon(256), mode: 0o644 },
  ];
  const inner = gzipSync(tar([...payload, { path: "ui/", mode: 0o755 }, ...ui]), { level: 9 });
  const extractSize = Math.ceil(
    [...payload, ...ui].reduce((total, file) => total + file.content.length, 0) / 1024,
  );

  return tar([
    {
      path: "INFO",
      content: new TextEncoder().encode(spkInfo({ version, arch, extractSize, checksum: md5(inner) })),
      mode: 0o644,
    },
    { path: "PACKAGE_ICON.PNG", content: icon(72), mode: 0o644 },
    { path: "PACKAGE_ICON_256.PNG", content: icon(256), mode: 0o644 },
    { path: "conf/", mode: 0o755 },
    // run-as package, never root: DSM 7 refuses to install a package that is not
    // signed by Synology if it asks for root (scripts/build-spk.test.ts holds us to it).
    { path: "conf/privilege", content: privilegeFile(), mode: 0o644 },
    // Puts `wave` on the PATH of the NAS, which is where `wave login` is typed.
    { path: "conf/resource", content: packaged("conf/resource"), mode: 0o644 },
    { path: "package.tgz", content: inner, mode: 0o644 },
    { path: "scripts/", mode: 0o755 },
    { path: "scripts/start-stop-status", content: packaged("scripts/start-stop-status"), mode: 0o755 },
    { path: "scripts/preuninst", content: packaged("scripts/preuninst"), mode: 0o755 },
    // Not one of DSM's hooks: the step as root that DSM 7 does not give a package.
    { path: "scripts/setup", content: packaged("scripts/setup"), mode: 0o755 },
  ]);
}

/** `wave-<version>-dsm7-<arch>.spk` -- the file name is how a person picks theirs. */
export const spkName = (version: string, arch: string): string => `wave-${version}-dsm7-${arch}.spk`;

/**
 * Builds both packages into `dist` and keeps SHA256SUMS in step: one line each,
 * and a rerun replaces them rather than adding a second pair.
 */
export async function buildSpks(dist: string, version: string): Promise<string[]> {
  const names: string[] = [];
  const sums: string[] = [];
  for (const { arch, archive } of SPK_TARGETS) {
    const source = join(dist, archive);
    if (!existsSync(source)) {
      throw new Error(`${source} is missing; run scripts/build-clients.sh --package first`);
    }
    const bytes = spk(version, arch, await unpack(source));
    const name = spkName(version, arch);
    writeFileSync(join(dist, name), bytes);
    names.push(name);
    sums.push(`${sha256(bytes)}  ${name}`);
  }

  const sumsPath = join(dist, "SHA256SUMS");
  const kept = existsSync(sumsPath)
    ? readFileSync(sumsPath, "utf8")
        .split("\n")
        .filter((line) => line !== "" && !line.endsWith(".spk"))
    : [];
  writeFileSync(sumsPath, `${[...kept, ...sums].join("\n")}\n`);
  return names;
}

if (import.meta.main) {
  const dist = process.argv[2] ?? "dist";
  // The same place build-clients.sh reads it, so a release is one number.
  const version: string =
    process.env.WAVE_BUILD_VERSION ?? JSON.parse(readFileSync("package.json", "utf8")).version;
  try {
    for (const name of await buildSpks(dist, version)) console.log(join(dist, name));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
