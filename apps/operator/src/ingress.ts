/**
 * Which names a cluster wants in the wave (D11).
 *
 * Read out of the objects a user already writes -- an `Ingress` with
 * `ingressClassName: wave`, or an `HTTPRoute` attached to a `Gateway` of the
 * same class. Nothing is invented here and nothing is stored: the operator is
 * not a second place where the mapping lives, it only says what Kubernetes
 * says, and the control server decides the addresses.
 *
 * Pure on purpose. Everything hard about an operator is the watching; what it
 * *means* is a list of hosts, and that part deserves to be testable without a
 * cluster.
 */

import type { ServiceScheme } from "@wave/proto";

export const WAVE_CLASS = "wave";

/** The slice of an Ingress this cares about. Anything else is ignored. */
export interface IngressObject {
  metadata?: { name?: string; namespace?: string };
  spec?: {
    ingressClassName?: string;
    rules?: { host?: string }[];
    /** Which hosts the ingress terminates TLS for; that is what makes https. */
    tls?: { hosts?: string[] }[];
  };
}

export interface HttpRouteObject {
  metadata?: { name?: string; namespace?: string };
  spec?: {
    parentRefs?: { name?: string; kind?: string; sectionName?: string }[];
    hostnames?: string[];
  };
}

export interface GatewayObject {
  metadata?: { name?: string; namespace?: string };
  spec?: {
    gatewayClassName?: string;
    /** Where the protocol lives for a route: on the parent, not on the route. */
    listeners?: { name?: string; protocol?: string }[];
  };
}

/** One name the cluster wants in the wave, and how it serves it. */
export interface DesiredService {
  host: string;
  scheme: ServiceScheme;
}

/** A host is usable if it names one thing; a wildcard names a zone. */
const usableHost = (host: string | undefined): string | null => {
  if (!host || host.includes("*")) return null;
  return host.toLowerCase();
};

/** HTTPS and TLS are the listener protocols that mean a browser gets https. */
const secureListener = (protocol: string | undefined): boolean => protocol === "HTTPS" || protocol === "TLS";

/**
 * The hosts and the secure subset, as the one shape everything downstream uses.
 *
 * Sorted and deduplicated, and **https wins**: a name served both ways is shown
 * as https, because the plain-text path is a redirect at best and a name under
 * the wave's domain exists to carry a certificate (D7). Since `secure` is a
 * union over every object, one Ingress with TLS is enough to make it so.
 */
const services = (hosts: Set<string>, secure: Set<string>): DesiredService[] =>
  [...hosts]
    .sort()
    .map((host) => ({ host, scheme: secure.has(host) ? ("https" as const) : ("http" as const) }));

/**
 * Hosts from every Ingress of the wave class, sorted and without duplicates.
 *
 * A wildcard host is skipped rather than refused: the wave issues names, and
 * `*.example.com` is not one. Refusing the whole list because of one object
 * would make a single bad Ingress take down every other service's name.
 */
export function ingressHosts(ingresses: IngressObject[], className = WAVE_CLASS): DesiredService[] {
  const hosts = new Set<string>();
  const secure = new Set<string>();

  for (const ingress of ingresses) {
    if (ingress.spec?.ingressClassName !== className) continue;
    const rules = (ingress.spec.rules ?? [])
      .map((rule) => usableHost(rule.host))
      .filter((host): host is string => host !== null);

    // A `tls` entry without hosts is the API's way of saying "the ones this
    // ingress serves" -- it defaults to whatever the controller holds for
    // them. Read as an empty list it would silently make every such service
    // http, which is the common shape with a default certificate.
    const covered = new Set(
      (ingress.spec.tls ?? []).flatMap((entry) =>
        entry.hosts === undefined
          ? rules
          : entry.hosts.map(usableHost).filter((host): host is string => host !== null),
      ),
    );

    for (const host of rules) {
      hosts.add(host);
      if (covered.has(host)) secure.add(host);
    }
  }
  return services(hosts, secure);
}

/**
 * Hosts from every HTTPRoute whose parent is a Gateway of the wave class.
 *
 * The class sits on the Gateway, not the route, so the routes can only be
 * judged together with the gateways they point at -- which is why both lists
 * come in here.
 */
export function routeHosts(
  routes: HttpRouteObject[],
  gateways: GatewayObject[],
  className = WAVE_CLASS,
): DesiredService[] {
  const waveGateways = new Map(
    gateways
      .filter((gateway) => gateway.spec?.gatewayClassName === className)
      .filter((gateway) => gateway.metadata?.name)
      .map((gateway) => [gateway.metadata?.name as string, gateway]),
  );

  const hosts = new Set<string>();
  const secure = new Set<string>();

  for (const route of routes) {
    const parents = (route.spec?.parentRefs ?? []).filter(
      (parent) => (parent.kind ?? "Gateway") === "Gateway" && parent.name && waveGateways.has(parent.name),
    );
    if (parents.length === 0) continue;

    // The protocol sits on the parent's listener. A parentRef that names a
    // section means that one listener; without one the route rides every
    // listener of the gateway, and any secure listener is enough -- the same
    // direction as the rule for ingresses.
    const isSecure = parents.some((parent) => {
      const listeners = waveGateways.get(parent.name as string)?.spec?.listeners ?? [];
      const relevant = parent.sectionName
        ? listeners.filter((listener) => listener.name === parent.sectionName)
        : listeners;
      return relevant.some((listener) => secureListener(listener.protocol));
    });

    for (const hostname of route.spec?.hostnames ?? []) {
      const host = usableHost(hostname);
      if (!host) continue;
      hosts.add(host);
      if (isSecure) secure.add(host);
    }
  }
  return services(hosts, secure);
}

/** Everything the cluster wants, from both kinds of object, as one set. */
export function desiredServices(input: {
  ingresses?: IngressObject[];
  routes?: HttpRouteObject[];
  gateways?: GatewayObject[];
  className?: string;
}): DesiredService[] {
  const className = input.className ?? WAVE_CLASS;
  const found = [
    ...ingressHosts(input.ingresses ?? [], className),
    ...routeHosts(input.routes ?? [], input.gateways ?? [], className),
  ];
  // Merged rather than concatenated: the same name can come from an Ingress
  // and an HTTPRoute, and https still wins across the two.
  return services(
    new Set(found.map((service) => service.host)),
    new Set(found.filter((service) => service.scheme === "https").map((service) => service.host)),
  );
}

/**
 * Whether anything actually moved, which is what decides on a call.
 *
 * The scheme counts as movement: a certificate added to an existing Ingress
 * changes no name, and a comparison on names alone would leave the wave
 * showing http until something else happened to change.
 */
export const sameServices = (a: DesiredService[], b: DesiredService[]): boolean =>
  a.length === b.length &&
  a.every((service, index) => service.host === b[index]?.host && service.scheme === b[index]?.scheme);
