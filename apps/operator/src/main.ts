#!/usr/bin/env bun
import { ControlClient } from "@wave/client/api";
import { defaultStatePath, loadProfiles, type Profile } from "@wave/client/state";
import {
  type DesiredService,
  desiredServices,
  GATEWAY_PATH,
  type GatewayObject,
  HTTPROUTE_PATH,
  type HttpRouteObject,
  INGRESS_PATH,
  type IngressObject,
  inClusterClient,
  type KubeClient,
  sameServices,
  WAVE_CLASS,
} from "./index.ts";

/**
 * The wave operator: it tells the control server which names the cluster
 * answers for, and nothing else (D11).
 *
 * It holds no mapping of its own. Names come from Kubernetes, addresses come
 * from the control server, and if this process is down the routes keep working
 * -- the netmap is signed and cached on every device. That is the reason it may
 * be this simple.
 *
 * It authenticates as the **connector**, with the machine key from the shared
 * state file: the cluster is one participant in the wave, and the operator is
 * the part of it that reads Kubernetes. A second identity would mean a second
 * node in the wave that never carries traffic.
 */

export interface OperatorOptions {
  kube: KubeClient;
  profile: Profile;
  className?: string;
  /** How often to look. Kubernetes objects change often; devices do not. */
  intervalMs?: number;
  log?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Stops the loop; only the tests pass one. */
  until?: () => boolean;
}

/**
 * Lists, compares, and calls the server only when something moved.
 *
 * Polling rather than a watch, deliberately: a watch is a long-lived connection
 * with a resource version to resume from, and getting that wrong means either a
 * silent gap or a reconnect storm. A list every few seconds cannot miss a
 * delete, has no state to keep, and the comparison below is what keeps it from
 * being chatty -- which is exactly the debouncing D11 asks for.
 */
export async function runOperator(options: OperatorOptions): Promise<void> {
  const log = options.log ?? console.log;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const control = new ControlClient(options.profile);
  const className = options.className ?? WAVE_CLASS;
  let published: DesiredService[] | null = null;

  while (!options.until?.()) {
    try {
      const [ingresses, routes, gateways] = await Promise.all([
        options.kube.list<IngressObject>(INGRESS_PATH),
        options.kube.list<HttpRouteObject>(HTTPROUTE_PATH),
        options.kube.list<GatewayObject>(GATEWAY_PATH),
      ]);

      const wanted = desiredServices({ ingresses, routes, gateways, className });
      if (published && sameServices(published, wanted)) {
        await sleep(options.intervalMs ?? 10_000);
        continue;
      }

      // The set and the schemes go together in one call: the server keeps the
      // whole set, and the scheme is an attribute of a name within it.
      const answer = await control.syncServices(
        wanted.map((service) => service.host),
        wanted.filter((service) => service.scheme === "https").map((service) => service.host),
      );
      published = wanted;
      log(
        wanted.length === 0
          ? "no wave ingresses; the wave has no services from this cluster"
          : `${answer.services.map((service) => `${service.name} ${service.ipv4}`).join(", ")}`,
      );
    } catch (error) {
      // Never fatal: the cluster's objects are still there, the netmap on every
      // device is still valid, and the next round tries again. An operator that
      // exits on a hiccup is one that needs a restart to do nothing.
      log(`operator: ${error instanceof Error ? error.message : String(error)}`);
      published = null;
    }
    await sleep(options.intervalMs ?? 10_000);
  }
}

/** The connector's enrolment, which is also the operator's credential. */
export async function connectorProfile(statePath: string, controlUrl?: string): Promise<Profile> {
  const profiles = await loadProfiles(statePath);
  const profile = controlUrl ? profiles.find((entry) => entry.controlUrl === controlUrl) : profiles[0];
  if (!profile) {
    throw new Error(
      `no wave enrolment in ${statePath} — the connector joins first, with \`wave login --auth-key\``,
    );
  }
  if (!profile.nodeId) throw new Error("the connector has not finished enrolling yet");
  return profile;
}

if (import.meta.main) {
  const statePath = process.env.WAVE_STATE ?? defaultStatePath();
  const profile = await connectorProfile(statePath, process.env.WAVE_CONTROL_URL);
  await runOperator({
    kube: await inClusterClient(),
    profile,
    className: process.env.WAVE_INGRESS_CLASS,
    intervalMs: Number(process.env.WAVE_SYNC_INTERVAL_MS ?? "") || undefined,
  });
}
