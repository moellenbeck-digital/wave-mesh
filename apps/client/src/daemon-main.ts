/**
 * The privileged half, run in the foreground. `wave daemon` and the generated
 * service unit both come here; the CLI and the tray drive it over its control
 * socket and need no privileges themselves.
 */
import { DEFAULT_SOCKET_PATH } from "@wave/ipc";
import { Daemon } from "./daemon.ts";
import { DEFAULT_MTU } from "./engine.ts";
import { defaultStatePath, findProfile, loadProfiles } from "./state.ts";
import { Updater } from "./update.ts";

export interface DaemonArgs {
  state: string;
  daemon?: string;
  interface?: string;
  port?: string;
  mtu?: string;
  stun?: string;
  "no-dns"?: boolean;
  "wg-socket"?: string;
  group?: string;
}

/** "host:port,host:port" -- hostnames must already be resolved to addresses. */
function parseStunServers(value: string): Array<{ ip: string; port: number }> {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => ({
      ip: entry.slice(0, entry.lastIndexOf(":")),
      port: Number(entry.slice(entry.lastIndexOf(":") + 1)),
    }));
}

export async function runDaemon(values: DaemonArgs): Promise<void> {
  const statePath = values.state || defaultStatePath();
  let daemon: Daemon | undefined;
  const updater = new Updater({
    statePath,
    log: (message) => console.log(`update: ${message}`),
    // Read at the moment of the download: enrolments come and go while the
    // daemon runs, and the download is signed by the one that was offered it.
    profile: async (controlUrl) => findProfile(await loadProfiles(statePath), controlUrl),
    // Down first: on Windows the NRPT rules are registry entries that would
    // outlive the process, and everywhere the new build should find the
    // interfaces gone rather than half-owned.
    shutdown: async () => {
      await daemon?.down();
      await daemon?.stop();
    },
    // Seconds instead of hours, for trying an update by hand.
    maxDelayMs: process.env.WAVE_UPDATE_MAX_DELAY
      ? Number(process.env.WAVE_UPDATE_MAX_DELAY) * 1000
      : undefined,
  });
  // Before any tunnel: a build on trial that has run out of time goes back
  // here, and a build that keeps failing comes back here on every restart.
  await updater.init();

  daemon = new Daemon({
    statePath,
    updater,
    socketPath: values["wg-socket"],
    interfaceName: values.interface,
    listenPort: values.port ? Number(values.port) : undefined,
    mtu: Number(values.mtu ?? DEFAULT_MTU),
    stunServers: parseStunServers(values.stun ?? ""),
    dns: !values["no-dns"],
    controlSocketPath: values.daemon ?? process.env.WAVE_SOCKET ?? DEFAULT_SOCKET_PATH,
    socketGroup: values.group ?? process.env.WAVE_SOCKET_GROUP ?? "wave",
  });

  const path = await daemon.listen();
  console.log(`wave daemon listening on ${path}`);

  // Bring up what this machine has joined. A fresh install has joined nothing
  // and simply waits for `wave login`.
  void daemon.up();
  // A build on trial proves itself by reaching a control server. With nothing
  // to connect to there is nothing it could prove, and nothing it can break.
  const profiles = await loadProfiles(statePath).catch(() => []);
  if (!profiles.some((profile) => profile.autoStart)) void updater.confirm();

  await new Promise<void>((resolve) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => void daemon.stop().then(resolve));
    }
  });
}
