#!/usr/bin/env bun
import { DaemonClient, DEFAULT_SOCKET_PATH, type ProfileStatus } from "@wave/ipc";
import { startPier } from "./proxy.ts";
import { type PierTable, pierTable } from "./table.ts";

/**
 * The wave pier: one node in a wave that answers for names in the open network
 * (D12).
 *
 * It runs beside `wave daemon` in the same pod, like the connector: the daemon
 * holds the tunnel and the signed netmap, this program reads which names the
 * netmap says are out and splices connections to them. It is a participant of
 * the wave and not a second tunnel -- the way from here to a device is an
 * ordinary WireGuard path, with hole punching, the relay as a fallback and the
 * same route choice as between any two devices.
 *
 * It holds no private key and no certificate, and it terminates nothing. A
 * pier node is a member of the wave with a public address, so treat it as a
 * bastion host: its own machine, nothing else on it.
 */

export interface PierNodeOptions {
  socketPath: string;
  host: string;
  port: number;
  /** Which wave, when the pod is in more than one. */
  controlUrl?: string;
  log?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The address the pier listens on, or a refusal.
 *
 * Never `0.0.0.0` and never `::`. The pod shares its network with `wave0`, so a
 * listener on every address would also answer on the pier's own wave address --
 * and every peer in the wave could then open a connection to a name through the
 * pier, which a policy that keeps it from the device would have forbidden.
 * Named, like the connector's `WAVE_POD_IP`: in a pod it is `status.podIP`, on
 * a machine it is the address the world reaches.
 */
export function pierHostFromEnv(env: Record<string, string | undefined>): string {
  const host = (env.WAVE_PIER_HOST ?? env.WAVE_POD_IP)?.trim();
  if (!host || host === "0.0.0.0" || host === "::") {
    throw new Error(
      "WAVE_PIER_HOST is required: the address to listen on (in a pod: status.podIP), never 0.0.0.0 -- " +
        "bound everywhere, the pier would answer on its wave address as well",
    );
  }
  return host;
}

/** Names that came and went, said once per change and not on every look. */
export function describeChange(before: PierTable, after: PierTable): string[] {
  const lines: string[] = [];
  for (const [name, target] of after) {
    const old = before.get(name);
    if (!old || old.ipv4 !== target.ipv4 || old.port !== target.port) {
      lines.push(`pier: serving ${name} -> ${target.ipv4}:${target.port}`);
    }
  }
  for (const name of before.keys()) if (!after.has(name)) lines.push(`pier: no longer serving ${name}`);
  return lines;
}

export async function runPier(options: PierNodeOptions): Promise<void> {
  const log = options.log ?? console.log;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  let table: PierTable = new Map();

  // Listening starts at once, before the tunnel is up: the ingress in front of
  // it asks whether the port answers, and a closed connection is exactly what
  // an empty table is supposed to give anyway.
  await startPier({ host: options.host, port: options.port, table: () => table, log });

  for (;;) {
    const attempt = await DaemonClient.open(options.socketPath);
    if (!attempt.ok) {
      log(`waiting for the wave daemon at ${options.socketPath} (${attempt.reason})`);
      await sleep(2000);
      continue;
    }
    try {
      const response = await attempt.client.request({ command: "status" });
      if (response.type !== "status") throw new Error("the daemon did not answer with a status");
      const profiles: ProfileStatus[] = response.status.profiles;
      const next = pierTable(profiles, options.controlUrl);
      for (const line of describeChange(table, next)) log(line);
      table = next;
    } catch (error) {
      log(`pier: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      attempt.client.close();
    }
    await sleep(2000);
  }
}

if (import.meta.main) {
  await runPier({
    socketPath: process.env.WAVE_SOCKET ?? DEFAULT_SOCKET_PATH,
    host: pierHostFromEnv(process.env),
    port: Number(process.env.WAVE_PIER_PORT ?? 8443),
    controlUrl: process.env.WAVE_CONTROL_URL,
  });
}
