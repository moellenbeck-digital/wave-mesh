/**
 * Services named in the environment, for a connector outside a cluster.
 *
 * In Kubernetes the operator reads the Ingresses and declares the names. On a
 * NAS there is nothing to read, so the list is configuration (`WAVE_SERVICES`)
 * and the connector declares it itself: the same call, the same machine key,
 * the same "this is the whole set" (D11).
 */
import { ControlClient } from "@wave/client/api";
import { defaultStatePath, findProfile, loadProfiles, normaliseControlUrl } from "@wave/client/state";

export interface StaticServices {
  /** The whole set, bare or fully qualified under the wave's suffix. */
  names: string[];
  /** Those of them served over TLS. */
  secure: string[];
  intervalMs: number;
}

const DEFAULT_INTERVAL_MS = 60_000;
const FIRST_RETRY_MS = 2_000;
const REQUEST_TIMEOUT_MS = 15_000;
const NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

function nameList(variable: string, value: string | undefined): string[] {
  const names = (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase().replace(/\.$/, ""))
    .filter(Boolean);
  const wrong = names.find((name) => !NAME.test(name));
  if (wrong) throw new Error(`${variable}: "${wrong}" is not a service name`);
  return [...new Set(names)];
}

/**
 * Undefined while `WAVE_SERVICES` names nothing -- the case in a cluster, where
 * a second voice declaring the set would take the operator's services away.
 * An empty list is therefore never sent; removing the last service is
 * `wave-admin remove-service`.
 */
export function staticServicesFromEnv(env: Record<string, string | undefined>): StaticServices | undefined {
  const names = nameList("WAVE_SERVICES", env.WAVE_SERVICES);
  const plain = nameList("WAVE_SERVICES_NO_TLS", env.WAVE_SERVICES_NO_TLS);
  // The server would ignore it, and the service would be shown as https.
  const unknown = plain.find((name) => !names.includes(name));
  if (unknown) throw new Error(`WAVE_SERVICES_NO_TLS: "${unknown}" is not listed in WAVE_SERVICES`);
  if (names.length === 0) return undefined;
  if (names.length > 500) throw new Error("WAVE_SERVICES: at most 500 services");

  const raw = env.WAVE_SYNC_INTERVAL_MS?.trim();
  const intervalMs = raw ? Number(raw) : DEFAULT_INTERVAL_MS;
  if (!Number.isInteger(intervalMs) || intervalMs < 1000) {
    throw new Error(`WAVE_SYNC_INTERVAL_MS must be a whole number of at least 1000, not "${raw}"`);
  }
  return { names, secure: names.filter((name) => !plain.includes(name)), intervalMs };
}

export interface StaticSyncOptions {
  services: StaticServices;
  statePath?: string;
  /** Which wave, when the state file holds several. */
  controlUrl?: string;
  log?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Stops the loop; only the tests pass one. */
  until?: () => boolean;
}

/** Declares the set once, signed with the enrolment the daemon keeps. */
export async function declareServices(options: StaticSyncOptions): Promise<string> {
  const path = options.statePath ?? defaultStatePath();
  const profiles = await loadProfiles(path);
  const url = options.controlUrl && (normaliseControlUrl(options.controlUrl) ?? options.controlUrl);
  const profile = url ? findProfile(profiles, url) : profiles[0];
  if (!profile?.nodeId) throw new Error(`not enrolled yet (${path})`);
  const answer = await new ControlClient(profile).syncServices(
    options.services.names,
    options.services.secure,
    REQUEST_TIMEOUT_MS,
  );
  return answer.services.map((service) => `${service.name} ${service.ipv4}`).join(", ");
}

/**
 * Declares the set at start and again every interval: a name somebody removed
 * on the server, or a wave that was joined anew, repairs itself. A failure is
 * said and tried again, sooner at first; it never ends the process.
 */
export async function runStaticServices(options: StaticSyncOptions): Promise<void> {
  const log = options.log ?? console.log;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const { intervalMs } = options.services;
  let retry = FIRST_RETRY_MS;
  let published: string | null = null;

  while (!options.until?.()) {
    try {
      const answer = await declareServices(options);
      if (answer !== published) log(`services: ${answer}`);
      published = answer;
      retry = FIRST_RETRY_MS;
      await sleep(intervalMs);
    } catch (error) {
      log(`services: ${error instanceof Error ? error.message : String(error)}`);
      published = null;
      await sleep(Math.min(retry, intervalMs));
      retry *= 2;
    }
  }
}
