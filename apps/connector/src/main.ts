#!/usr/bin/env bun
import { DaemonClient, DEFAULT_SOCKET_PATH, type ProfileStatus } from "@wave/ipc";
import { type ConnectorRules, DEFAULT_PORTS, nftRuleset } from "./rules.ts";

/**
 * The wave connector: a cluster's one membership in a wave (D11).
 *
 * It runs beside `wave daemon` in the same pod, waits until the tunnel carries
 * addresses, and installs the forwarding rules. That is all it does -- the
 * addresses come from the netmap, and which of them exist is the operator's
 * business, not this program's.
 *
 * Deliberately not a second tunnel: a connector is one node with one identity,
 * and the services are addresses routed to it. Twenty ingresses as twenty nodes
 * would be twenty WireGuard peers in one pod.
 */

export interface ConnectorOptions {
  socketPath: string;
  /** The internal ingress controller, as a ClusterIP. Never a LoadBalancer. */
  backend: { ipv4: string; ipv6?: string };
  ports: number[];
  /** Which wave, when the pod is in more than one. */
  controlUrl?: string;
  apply: (ruleset: string) => Promise<void>;
  log?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

const MTU_FALLBACK = 1280;

/**
 * The node's *own* addresses, or nothing while the tunnel is coming up.
 *
 * Deliberately not `profile.addresses`: that is everything the interface
 * wears, and since D11 it includes one address per service this connector
 * answers for -- the server puts them in `self.addresses` so they land on
 * `wave0`. Treating those as ours is exactly backwards, because they are the
 * ones that have to be forwarded: the ruleset exempts our own addresses and
 * sends the rest to the backend, so every service got a `return` and the
 * cluster answered nothing. Seen on the first real cluster, 21.09.2026.
 */
export function ownAddressesOf(status: ProfileStatus[], controlUrl?: string): string[] {
  const profile = controlUrl
    ? status.find((entry) => entry.controlUrl === controlUrl)
    : (status.find((entry) => entry.state === "up") ?? status[0]);
  if (profile?.state !== "up" || !profile.self) return [];
  return [profile.self.ipv4, profile.self.ipv6].filter((entry) => entry.length > 0);
}

/**
 * Watches the tunnel and keeps the rules in step with it.
 *
 * Reapplied whenever the set of addresses changes, because that set is exactly
 * what the rules exempt: the node's own addresses are the ones *not* forwarded,
 * and every other address on the interface belongs to a service. A wave that is
 * renumbered therefore repairs itself without a restart.
 */
export async function runConnector(options: ConnectorOptions): Promise<void> {
  const log = options.log ?? console.log;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  let applied = "";

  for (;;) {
    const attempt = await DaemonClient.open(options.socketPath);
    if (!attempt.ok) {
      log(`waiting for the wave daemon at ${options.socketPath} (${attempt.reason})`);
      await sleep(2000);
      continue;
    }

    const client = attempt.client;
    try {
      const response = await client.request({ command: "status" });
      if (response.type !== "status") throw new Error("the daemon did not answer with a status");

      const addresses = ownAddressesOf(response.status.profiles, options.controlUrl);
      if (addresses.length === 0) {
        log("the tunnel has no addresses yet");
        await sleep(2000);
        continue;
      }

      const rules: ConnectorRules = {
        interfaceName:
          response.status.profiles.find((entry) => entry.state === "up")?.interfaceName ?? "wave0",
        ownAddresses: addresses,
        backend: options.backend,
        ports: options.ports.length > 0 ? options.ports : DEFAULT_PORTS,
        mtu: MTU_FALLBACK,
      };
      const ruleset = nftRuleset(rules);

      // Only on a change: nft is cheap, but a log line every two seconds is
      // how a pod's output stops being worth reading.
      if (ruleset !== applied) {
        await options.apply(ruleset);
        applied = ruleset;
        log(
          `forwarding ${rules.interfaceName} to ${rules.backend.ipv4}, own addresses ${addresses.join(", ")}`,
        );
      }
    } catch (error) {
      log(`connector: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      client.close();
    }
    await sleep(5000);
  }
}

/** Hands the ruleset to nft. One document, one call, all or nothing. */
export async function applyWithNft(ruleset: string): Promise<void> {
  const child = Bun.spawn(["nft", "-f", "-"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(ruleset);
  await child.stdin.end();
  const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`nft exited ${code}: ${error.trim().slice(0, 300)}`);
}

if (import.meta.main) {
  const backendV4 = process.env.WAVE_BACKEND_IPV4;
  if (!backendV4) {
    console.error("WAVE_BACKEND_IPV4 is required: the ClusterIP of the internal ingress controller");
    process.exit(1);
  }
  await runConnector({
    socketPath: process.env.WAVE_SOCKET ?? DEFAULT_SOCKET_PATH,
    backend: { ipv4: backendV4, ipv6: process.env.WAVE_BACKEND_IPV6 },
    ports: (process.env.WAVE_BACKEND_PORTS ?? "")
      .split(",")
      .map((port) => Number(port.trim()))
      .filter((port) => Number.isInteger(port) && port > 0),
    controlUrl: process.env.WAVE_CONTROL_URL,
    apply: applyWithNft,
  });
}
