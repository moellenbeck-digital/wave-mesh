/**
 * The privileged half, run in the foreground. `wave daemon` and the generated
 * service unit both come here; the CLI and the tray drive it over its control
 * socket and need no privileges themselves.
 */
import { DEFAULT_SOCKET_PATH } from "@wave/ipc";
import { Daemon } from "./daemon.ts";
import { DEFAULT_MTU } from "./engine.ts";
import { defaultStatePath } from "./state.ts";

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
  const daemon = new Daemon({
    statePath: values.state || defaultStatePath(),
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

  await new Promise<void>((resolve) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => void daemon.stop().then(resolve));
    }
  });
}
