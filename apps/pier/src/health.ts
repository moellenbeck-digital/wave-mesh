#!/usr/bin/env bun
import { connect } from "node:net";
import { DaemonClient, DEFAULT_SOCKET_PATH, type ProfileStatus } from "@wave/ipc";

/**
 * Whether the pier still does its job -- the liveness probe of its pod.
 *
 * Two things have to hold: the tunnel is up (without it every name is refused,
 * which looks like a working pier that serves nothing), and the listener
 * accepts a connection (without it the ingress in front sends everything into
 * a closed port). The probe connects and hangs up without a word; the pier
 * reads that as a client that never said a name, which it closes quietly.
 */

export type Health = { healthy: true } | { healthy: false; reason: string };

export function assessTunnel(profiles: ProfileStatus[], controlUrl?: string): Health {
  const profile = controlUrl
    ? profiles.find((entry) => entry.controlUrl === controlUrl)
    : (profiles.find((entry) => entry.state === "up") ?? profiles[0]);
  if (!profile) return { healthy: false, reason: "the daemon holds no wave" };
  if (profile.state !== "up") return { healthy: false, reason: `the tunnel is ${profile.state}` };
  if (profile.relay && !profile.relay.connected) {
    return { healthy: false, reason: `the relay ${profile.relay.url} is not connected` };
  }
  return { healthy: true };
}

const accepts = (host: string, port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 5000 }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });

if (import.meta.main) {
  const timeout = setTimeout(() => {
    console.error("unhealthy: no answer within 10 s");
    process.exit(1);
  }, 10_000);
  const attempt = await DaemonClient.open(process.env.WAVE_SOCKET ?? DEFAULT_SOCKET_PATH);
  if (!attempt.ok) {
    console.error(`unhealthy: no daemon (${attempt.reason})`);
    process.exit(1);
  }
  const response = await attempt.client.request({ command: "status" });
  attempt.client.close();
  if (response.type !== "status") {
    console.error("unhealthy: the daemon did not answer with a status");
    process.exit(1);
  }
  const verdict = assessTunnel(response.status.profiles, process.env.WAVE_CONTROL_URL);
  if (!verdict.healthy) {
    console.error(`unhealthy: ${verdict.reason}`);
    process.exit(1);
  }
  const host = process.env.WAVE_PIER_HOST ?? process.env.WAVE_POD_IP ?? "127.0.0.1";
  const port = Number(process.env.WAVE_PIER_PORT ?? 8443);
  if (!(await accepts(host, port))) {
    console.error(`unhealthy: nothing accepts connections on ${host}:${port}`);
    process.exit(1);
  }
  clearTimeout(timeout);
  console.log("healthy");
}
