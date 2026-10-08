#!/usr/bin/env bun
import { DaemonClient, DEFAULT_SOCKET_PATH, type ProfileStatus } from "@wave/ipc";

/**
 * Whether the connector still carries traffic -- the liveness probe of its pod.
 *
 * A connector that is up in every way a control server can see and carries
 * nothing is the failure this exists for: it held its control connection, the
 * server showed it online, and no phone could reach a single service through
 * it. Kubernetes restarts a container on its own only when the process exits,
 * and this one had not. So the daemon is asked what it can say about its own
 * data path, and the probe fails when the answer is "nothing is getting
 * through" -- often enough in a row (the probe's failureThreshold) that a
 * relay reconnecting or a quiet minute does not restart anything.
 */

/** Longer than any handshake a live tunnel goes without: WireGuard renews
 *  them every two minutes while keepalives (25 s) flow to every peer. */
export const STALE_AFTER_SECONDS = 10 * 60;

export type Health = { healthy: true } | { healthy: false; reason: string };

/** The verdict on one status, pure so it can be tested without a daemon. */
export function assessHealth(profiles: ProfileStatus[], controlUrl?: string): Health {
  const profile = controlUrl
    ? profiles.find((entry) => entry.controlUrl === controlUrl)
    : (profiles.find((entry) => entry.state === "up") ?? profiles[0]);
  if (!profile) return { healthy: false, reason: "the daemon holds no wave" };
  if (profile.state !== "up") return { healthy: false, reason: `the tunnel is ${profile.state}` };
  if (profile.relay && !profile.relay.connected) {
    return { healthy: false, reason: `the relay ${profile.relay.url} is not connected` };
  }
  // Nobody to talk to is not a fault: a new wave, or every device asleep.
  if (profile.peers.length === 0) return { healthy: true };
  const fresh = profile.peers.some(
    (peer) => peer.lastHandshakeSecondsAgo !== null && peer.lastHandshakeSecondsAgo < STALE_AFTER_SECONDS,
  );
  if (!fresh) {
    return {
      healthy: false,
      reason: `no handshake with any of ${profile.peers.length} peers in ${STALE_AFTER_SECONDS / 60} minutes`,
    };
  }
  return { healthy: true };
}

if (import.meta.main) {
  const socketPath = process.env.WAVE_SOCKET ?? DEFAULT_SOCKET_PATH;
  // A daemon that does not answer at all is the plainest kind of dead.
  const timeout = setTimeout(() => {
    console.error("unhealthy: the daemon did not answer within 10 s");
    process.exit(1);
  }, 10_000);
  const attempt = await DaemonClient.open(socketPath);
  if (!attempt.ok) {
    console.error(`unhealthy: no daemon at ${socketPath} (${attempt.reason})`);
    process.exit(1);
  }
  const response = await attempt.client.request({ command: "status" });
  clearTimeout(timeout);
  attempt.client.close();
  if (response.type !== "status") {
    console.error("unhealthy: the daemon did not answer with a status");
    process.exit(1);
  }
  const verdict = assessHealth(response.status.profiles, process.env.WAVE_CONTROL_URL);
  if (!verdict.healthy) {
    console.error(`unhealthy: ${verdict.reason}`);
    process.exit(1);
  }
  console.log("healthy");
}
