import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { generateKeyPair } from "@wave/crypto";
import { type Notice, notice, waveLabel } from "@wave/ipc";
import { UpdateChannel } from "@wave/proto";
import { z } from "zod";

/**
 * Everything one enrolment needs to prove who it is. The three private keys
 * live here and nowhere else -- they are never sent to the control server.
 */
export const NodeState = z.object({
  controlUrl: z.string(),
  machineKey: z.object({ publicKey: z.string(), privateKey: z.string() }),
  nodeKey: z.object({ publicKey: z.string(), privateKey: z.string() }),
  discoKey: z.object({ publicKey: z.string(), privateKey: z.string() }),
  nodeId: z.string().nullable().default(null),
  /** Pinned at enrolment; every later netmap must verify against it. */
  netmapPublicKey: z.string().nullable().default(null),
  interfaceName: z.string().default("wave0"),
  listenPort: z.number().int().default(41641),
});
export type NodeState = z.infer<typeof NodeState>;

/**
 * One enrolment among several. A device can be in more than one wave at once --
 * a personal one and a customer's, say -- and each of those is a separate
 * account on a separate server with keys of its own.
 *
 * Which one is which is decided by `controlUrl` and nothing else. There is no
 * second name to keep in step with it, and none to get wrong: the server is
 * the connection.
 */
export const CertRecord = z.object({
  /** The first name, which is also what the files are filed under. */
  name: z.string(),
  /**
   * Every name on the certificate. A renewal has to ask for the same set, and
   * a wildcard certificate usually carries more than one.
   */
  names: z.array(z.string()).default([]),
  /** ISO. The CA's suggestion where it has one, two thirds of the lifetime otherwise. */
  renewAt: z.string(),
  notAfter: z.string(),
  /** Shell command to run after every renewal, e.g. "systemctl reload caddy". */
  hook: z.string().nullable().default(null),
});
export type CertRecord = z.infer<typeof CertRecord>;

export const Profile = NodeState.extend({
  /**
   * Tells apart further enrolments at the same server. One server can run
   * many waves -- one per project or customer, kept apart on purpose -- and a
   * device in several of them needs an enrolment, with keys of its own, in
   * each. Null for the first enrolment at a server, whose key stays its
   * address: every state file written before keeps working unchanged.
   */
  id: z.string().nullable().default(null),
  /** The wave's DNS suffix, kept from its netmap: the name when several share a server. */
  label: z.string().nullable().default(null),
  /** Whether `wave up` without an address brings this one up. */
  autoStart: z.boolean().default(true),
  /**
   * The certificates this device holds in this wave. Kept with the enrolment
   * because that is what a renewal needs: the machine key to ask with and the
   * date to ask on. The private keys are not here -- they are beside the
   * certificates themselves, and nothing ever sends them anywhere.
   */
  certs: z.array(CertRecord).default([]),
});
export type Profile = z.infer<typeof Profile>;

/**
 * How this device updates itself (D13). One setting for the machine, not one
 * per wave: there is one binary.
 *
 * In the state file and not in wave.env, so there is one place for it -- two
 * places for the same truth is exactly what WAVE_CONTROL_URL got wrong.
 */
export const UpdateSettings = z.object({
  /**
   * The channel this device would like. Only a wish: each control server
   * offers the channels it was configured with and gives a device that wants
   * another one its default. Null leaves it to the servers entirely.
   */
  channel: UpdateChannel.nullable().default(null),
  autoUpdate: z.boolean().default(true),
  /**
   * An update that has been swapped in and not yet proven itself. The next
   * start of the new version has a few minutes to reach a control server;
   * otherwise the old files come back and this version goes on `broken`.
   */
  pending: z
    .object({
      version: z.string(),
      from: z.string(),
      startedAt: z.string(),
      /** The files that were swapped, each with a `.old` beside it. */
      files: z.array(z.string()),
      installDir: z.string(),
    })
    .nullable()
    .default(null),
  /** Versions that were installed once and rolled back; never offered again. */
  broken: z.array(z.string()).default([]),
});
export type UpdateSettings = z.infer<typeof UpdateSettings>;

export const ClientState = z.object({
  version: z.literal(2),
  profiles: z.array(Profile),
  update: UpdateSettings.optional(),
});
export type ClientState = z.infer<typeof ClientState>;

const BASE_PORT = 41641;

/**
 * Where the keys live. The daemon runs as the machine's administrator and uses
 * a system-wide location; an unprivileged run keeps them in the user's own.
 */
export function defaultStatePath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  privileged: boolean = process.getuid?.() === 0,
): string {
  if (platform === "win32") {
    const base = privileged ? (env.PROGRAMDATA ?? "C:\\ProgramData") : (env.LOCALAPPDATA ?? homedir());
    return join(base, "wave", "state.json");
  }
  if (privileged) {
    return platform === "darwin"
      ? "/Library/Application Support/wave/state.json"
      : "/var/lib/wave/state.json";
  }
  const base = env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(base, "wave", "state.json");
}

/**
 * Reads the state file, folding the single-enrolment format that came before
 * into the list. An existing installation therefore keeps its keys and its
 * place in the wave rather than having to enrol again.
 */
export async function loadProfiles(path: string): Promise<Profile[]> {
  return (await loadState(path)).profiles;
}

async function loadState(path: string): Promise<{ profiles: Profile[]; update: UpdateSettings }> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { profiles: [], update: defaultUpdate() };
    throw err;
  }

  const current = ClientState.safeParse(raw);
  if (current.success)
    return { profiles: current.data.profiles, update: current.data.update ?? defaultUpdate() };

  const legacy = NodeState.safeParse(raw);
  if (legacy.success)
    return {
      profiles: [{ ...legacy.data, id: null, label: null, autoStart: true, certs: [] }],
      update: defaultUpdate(),
    };

  throw new Error(`${path} is not a wave state file`);
}

const defaultUpdate = (): UpdateSettings => UpdateSettings.parse({});

async function saveState(
  path: string,
  state: { profiles: Profile[]; update: UpdateSettings },
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file: ClientState = { version: 2, profiles: state.profiles, update: state.update };
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  // Explicit, because an existing file keeps its old mode on write.
  await chmod(path, 0o600);
}

/**
 * Writes the enrolments and keeps whatever else the file holds. Every caller
 * of this predates the update settings, and a write that dropped them would
 * turn auto-update back on with the next login.
 */
export async function saveProfiles(path: string, profiles: Profile[]): Promise<void> {
  const { update } = await loadState(path).catch(() => ({ update: defaultUpdate() }));
  await saveState(path, { profiles, update });
}

export async function loadUpdateSettings(path: string): Promise<UpdateSettings> {
  return (await loadState(path)).update;
}

/** Changes the update settings and leaves the enrolments as they are. */
export async function updateUpdateSettings(
  path: string,
  patch: Partial<UpdateSettings>,
): Promise<UpdateSettings> {
  const state = await loadState(path);
  const update = UpdateSettings.parse({ ...state.update, ...patch });
  await saveState(path, { profiles: state.profiles, update });
  return update;
}

/** How an enrolment is filed: its address for the first at a server, its id for any further one. */
export const profileKey = (profile: Pick<Profile, "id" | "controlUrl">): string =>
  profile.id ?? profile.controlUrl;

/**
 * Finds an enrolment by its key. An address alone is the key of the first
 * enrolment at that server, so callers that only ever knew addresses still
 * find what they meant.
 */
export const findProfile = (profiles: Profile[], key: string): Profile | undefined =>
  profiles.find((profile) => profileKey(profile) === key) ??
  profiles.find((profile) => profile.controlUrl === key);

/**
 * What someone typed, as a control server address. `wave profiles` prints the
 * bare host, so that is what gets typed back -- and taken verbatim it becomes
 * an enrolment whose address is not a URL at all: it takes an interface slot,
 * fails with "Invalid URL" forever, and shows up next to the real one.
 *
 * Anything without a scheme gets https. What still does not parse is refused
 * rather than stored. The trailing slash goes, so the same server typed two
 * ways stays one enrolment -- the control server strips it too.
 */
export function normaliseControlUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    return url.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

/**
 * The waves a person meant by what they typed. `wave profiles` shows the short
 * label in its first column, so that is what gets typed back -- insisting on
 * the full URL would mean rejecting the very string we just printed.
 *
 * Returns every match rather than a single profile, because two waves can sit
 * on the same host under different ports. Guessing between those would take
 * down the wrong tunnel, so the caller has to say so instead.
 */
export function matchProfiles(profiles: Profile[], wanted: string): Profile[] {
  for (const by of [
    // Exactly one enrolment, or the wave's own name -- with several waves at
    // one server, the server's address names all of them.
    (profile: Profile) => profileKey(profile),
    (profile: Profile) => profile.label ?? "",
    (profile: Profile) => profile.controlUrl,
    (profile: Profile) => waveLabel(profile.controlUrl),
    (profile: Profile) => waveLabel(profile.controlUrl).replace(/:\d+$/, ""),
  ]) {
    const found = profiles.filter((profile) => by(profile) === wanted);
    if (found.length > 0) return found;
  }
  return [];
}

/** What to say when what was typed fits more than one wave. */
export const ambiguity = (wanted: string, found: Profile[]): Notice =>
  notice("ambiguous-wave", {
    name: wanted,
    count: String(found.length),
    urls: found.map((p) => (p.label ? `${p.label} (${profileKey(p)})` : p.controlUrl)).join(", "),
  });

/**
 * The lowest interface number no profile holds. Each wave needs its own
 * interface and its own UDP port; both are derived from the same number so a
 * glance at `wave1` says which port it listens on.
 */
export function allocateSlot(profiles: Profile[]): { interfaceName: string; listenPort: number } {
  const interfaces = new Set(profiles.map((profile) => profile.interfaceName));
  const ports = new Set(profiles.map((profile) => profile.listenPort));
  for (let index = 0; ; index++) {
    const interfaceName = `wave${index}`;
    const listenPort = BASE_PORT + index;
    if (!interfaces.has(interfaceName) && !ports.has(listenPort)) return { interfaceName, listenPort };
  }
}

export interface ProfileDefaults {
  interfaceName?: string;
  listenPort?: number;
  /** Exactly this enrolment, by its key -- for bringing up a further wave at a server. */
  key?: string;
  /** A further enrolment at a server that already has one: fresh keys and an id. */
  another?: boolean;
}

/**
 * Returns the enrolment with this control server, creating one with fresh keys
 * if there is none. `wave login <url>` twice therefore joins once and then
 * finds what is already there.
 */
export async function ensureProfile(
  path: string,
  controlUrl: string,
  defaults: ProfileDefaults = {},
): Promise<Profile> {
  const profiles = await loadProfiles(path);
  if (defaults.key) {
    const keyed = findProfile(profiles, defaults.key);
    if (keyed) return keyed;
  }
  const existing = defaults.another ? undefined : findProfile(profiles, controlUrl);
  if (existing) return existing;

  const slot = allocateSlot(profiles);
  const another = defaults.another && profiles.some((profile) => profile.controlUrl === controlUrl);
  const profile: Profile = {
    id: another ? `${controlUrl}#${randomBytes(4).toString("hex")}` : null,
    label: null,
    autoStart: true,
    controlUrl,
    machineKey: generateKeyPair("ed25519"),
    nodeKey: generateKeyPair("x25519"),
    discoKey: generateKeyPair("x25519"),
    nodeId: null,
    netmapPublicKey: null,
    certs: [],
    interfaceName: defaults.interfaceName ?? slot.interfaceName,
    listenPort: defaults.listenPort ?? slot.listenPort,
  };
  await saveProfiles(path, [...profiles, profile]);
  return profile;
}

/** Writes back what enrolment learned, leaving the other profiles alone. */
export async function updateProfile(
  path: string,
  key: string,
  patch: Partial<Profile>,
): Promise<Profile | null> {
  const profiles = await loadProfiles(path);
  const current = findProfile(profiles, key);
  if (!current) return null;

  const next = { ...current, ...patch };
  await saveProfiles(
    path,
    profiles.map((profile) => (profile === current ? next : profile)),
  );
  return next;
}

export async function removeProfile(path: string, key: string): Promise<boolean> {
  const profiles = await loadProfiles(path);
  const current = findProfile(profiles, key);
  if (!current) return false;
  await saveProfiles(
    path,
    profiles.filter((profile) => profile !== current),
  );
  return true;
}
