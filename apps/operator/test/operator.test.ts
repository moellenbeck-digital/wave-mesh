import { describe, expect, test } from "bun:test";
import { desiredServices, ingressHosts, routeHosts, sameServices } from "../src/ingress.ts";
import { GATEWAY_PATH, HTTPROUTE_PATH, INGRESS_PATH, type KubeClient } from "../src/kube.ts";
import { runOperator } from "../src/main.ts";

/**
 * What the operator means, without a cluster: which names it reads out of which
 * objects, and that it only speaks when something moved.
 */

const ingress = (host: string, className = "wave") => ({
  metadata: { name: host, namespace: "default" },
  spec: { ingressClassName: className, rules: [{ host }] },
});

/** The same, with a certificate on it -- which is what makes a name https. */
const secureIngress = (host: string, tlsHosts: string[] | undefined = [host]) => ({
  metadata: { name: host, namespace: "default" },
  spec: { ingressClassName: "wave", rules: [{ host }], tls: [{ hosts: tlsHosts }] },
});

/** Just the names, for the cases that are about the set and not the scheme. */
const hostsOf = (services: { host: string }[]) => services.map((service) => service.host);

describe("reading ingresses", () => {
  test("takes the hosts of the wave class and leaves the rest alone", () => {
    const hosts = ingressHosts([
      ingress("grafana.rl.wave.example.com"),
      ingress("public.example.com", "nginx"),
      ingress("git.rl.wave.example.com"),
    ]);
    expect(hostsOf(hosts)).toEqual(["git.rl.wave.example.com", "grafana.rl.wave.example.com"]);
  });

  // One unusable object must not cost every other service its name.
  test("skips a wildcard host instead of refusing the list", () => {
    expect(
      hostsOf(ingressHosts([ingress("*.rl.wave.example.com"), ingress("git.rl.wave.example.com")])),
    ).toEqual(["git.rl.wave.example.com"]);
  });

  test("an ingress without a host contributes nothing", () => {
    expect(ingressHosts([{ spec: { ingressClassName: "wave", rules: [{}] } }])).toEqual([]);
  });
});

describe("reading HTTPRoutes", () => {
  const gateways = [
    { metadata: { name: "wave-gw" }, spec: { gatewayClassName: "wave" } },
    { metadata: { name: "public-gw" }, spec: { gatewayClassName: "istio" } },
  ];

  // The class is on the Gateway, so a route can only be judged together with
  // the gateway it points at.
  test("follows the parent's class, not the route's", () => {
    const routes = [
      { spec: { parentRefs: [{ name: "wave-gw" }], hostnames: ["a.rl.wave.example.com"] } },
      { spec: { parentRefs: [{ name: "public-gw" }], hostnames: ["b.example.com"] } },
    ];
    expect(hostsOf(routeHosts(routes, gateways))).toEqual(["a.rl.wave.example.com"]);
  });

  test("a route pointing at nothing known contributes nothing", () => {
    expect(routeHosts([{ spec: { hostnames: ["x.example"] } }], gateways)).toEqual([]);
  });
});

describe("both kinds together", () => {
  test("are one sorted set without duplicates", () => {
    const hosts = desiredServices({
      ingresses: [ingress("b.rl.wave.example.com"), ingress("a.rl.wave.example.com")],
      routes: [{ spec: { parentRefs: [{ name: "gw" }], hostnames: ["a.rl.wave.example.com"] } }],
      gateways: [{ metadata: { name: "gw" }, spec: { gatewayClassName: "wave" } }],
    });
    expect(hostsOf(hosts)).toEqual(["a.rl.wave.example.com", "b.rl.wave.example.com"]);
  });

  test("sameServices sees order-equal lists as equal and a change as a change", () => {
    const http = (host: string) => ({ host, scheme: "http" as const });
    expect(sameServices([http("a"), http("b")], [http("a"), http("b")])).toBe(true);
    expect(sameServices([http("a")], [http("a"), http("b")])).toBe(false);
  });

  // A certificate added to an existing Ingress changes no name at all. Compared
  // on names alone the operator would stay quiet and the wave would go on
  // showing http until something else happened to move.
  test("a scheme that flips counts as a change", () => {
    expect(sameServices([{ host: "a", scheme: "http" }], [{ host: "a", scheme: "https" }])).toBe(false);
  });
});

describe("which protocol a name is served on", () => {
  const schemes = (services: { host: string; scheme: string }[]) =>
    Object.fromEntries(services.map((service) => [service.host, service.scheme]));

  test("a plain ingress is http, one with a certificate is https", () => {
    expect(
      schemes(ingressHosts([ingress("plain.rl.wave.example.com"), secureIngress("tls.rl.wave.example.com")])),
    ).toEqual({ "plain.rl.wave.example.com": "http", "tls.rl.wave.example.com": "https" });
  });

  // What the user sees has to be the one that works. The plain-text path is a
  // redirect at best, and the name exists to carry a certificate (D7).
  test("https wins where the same name is served both ways", () => {
    const both = ingressHosts([
      ingress("grafana.rl.wave.example.com"),
      secureIngress("grafana.rl.wave.example.com"),
    ]);
    expect(both).toEqual([{ host: "grafana.rl.wave.example.com", scheme: "https" }]);
  });

  // `tls: [{}]` means "the hosts this ingress serves", which is the shape a
  // default certificate takes. Read as an empty list it would be http.
  test("a tls block without hosts covers the ingress's own rules", () => {
    expect(schemes(ingressHosts([secureIngress("a.rl.wave.example.com", undefined)]))).toEqual({
      "a.rl.wave.example.com": "https",
    });
  });

  test("the scheme survives the merge of both kinds of object", () => {
    const wanted = desiredServices({
      ingresses: [ingress("a.rl.wave.example.com")],
      routes: [{ spec: { parentRefs: [{ name: "gw" }], hostnames: ["a.rl.wave.example.com"] } }],
      gateways: [
        {
          metadata: { name: "gw" },
          spec: { gatewayClassName: "wave", listeners: [{ name: "web", protocol: "HTTPS" }] },
        },
      ],
    });
    expect(wanted).toEqual([{ host: "a.rl.wave.example.com", scheme: "https" }]);
  });

  describe("for an HTTPRoute the protocol is the parent's", () => {
    const gateway = (listeners: { name?: string; protocol?: string }[]) => ({
      metadata: { name: "gw" },
      spec: { gatewayClassName: "wave", listeners },
    });
    const route = (sectionName?: string) => ({
      spec: { parentRefs: [{ name: "gw", sectionName }], hostnames: ["a.rl.wave.example.com"] },
    });

    test("an http-only gateway makes an http name", () => {
      expect(routeHosts([route()], [gateway([{ name: "web", protocol: "HTTP" }])])).toEqual([
        { host: "a.rl.wave.example.com", scheme: "http" },
      ]);
    });

    test("any secure listener is enough when no section is named", () => {
      const gw = gateway([
        { name: "web", protocol: "HTTP" },
        { name: "websecure", protocol: "HTTPS" },
      ]);
      expect(routeHosts([route()], [gw])).toEqual([{ host: "a.rl.wave.example.com", scheme: "https" }]);
    });

    test("a named section is the listener that counts", () => {
      const gw = gateway([
        { name: "web", protocol: "HTTP" },
        { name: "websecure", protocol: "HTTPS" },
      ]);
      expect(routeHosts([route("web")], [gw])).toEqual([{ host: "a.rl.wave.example.com", scheme: "http" }]);
    });

    // A TLS listener passes the connection through rather than terminating it,
    // but what reaches the browser is still https.
    test("a TLS listener counts as secure", () => {
      expect(routeHosts([route()], [gateway([{ name: "tls", protocol: "TLS" }])])).toEqual([
        { host: "a.rl.wave.example.com", scheme: "https" },
      ]);
    });
  });
});

/** A cluster whose object lists a test can change between rounds. */
function fakeCluster(state: { ingresses: ReturnType<typeof ingress>[] }): KubeClient {
  return {
    async list<T>(path: string): Promise<T[]> {
      if (path === INGRESS_PATH) return state.ingresses as unknown as T[];
      if (path === HTTPROUTE_PATH || path === GATEWAY_PATH) return [];
      throw new Error(`unexpected ${path}`);
    },
  };
}

describe("the loop", () => {
  /** A control server that only records what it was told. */
  function recorder() {
    const calls: string[][] = [];
    const secure: (string[] | undefined)[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const body = (await request.json()) as { names: string[]; secure?: string[] };
        calls.push(body.names);
        secure.push(body.secure);
        return Response.json({ services: [] });
      },
    });
    return { calls, secure, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
  }

  const profileFor = async (url: string) => {
    const { generateKeyPair } = await import("@wave/crypto");
    return {
      autoStart: true,
      controlUrl: url,
      machineKey: generateKeyPair("ed25519"),
      nodeKey: generateKeyPair("x25519"),
      discoKey: generateKeyPair("x25519"),
      nodeId: "n_1",
      netmapPublicKey: null,
      interfaceName: "wave0",
      listenPort: 41641,
      certs: [],
    };
  };

  test("declares once, then keeps quiet until something changes", async () => {
    const control = recorder();
    const state = { ingresses: [ingress("grafana.rl.wave.example.com")] };
    let rounds = 0;

    await runOperator({
      kube: fakeCluster(state),
      profile: await profileFor(control.url),
      log: () => {},
      sleep: async () => {
        rounds++;
        // Nothing changed in between, so this round must not speak again.
        if (rounds === 2) state.ingresses.push(ingress("git.rl.wave.example.com"));
      },
      until: () => rounds >= 4,
    });
    control.stop();

    expect(control.calls).toEqual([
      ["grafana.rl.wave.example.com"],
      ["git.rl.wave.example.com", "grafana.rl.wave.example.com"],
    ]);
  });

  // The set and the schemes travel together: the server keeps the set, and the
  // scheme is an attribute of a name inside it.
  test("says which of the names it serves over TLS", async () => {
    const control = recorder();
    const state = {
      ingresses: [ingress("plain.rl.wave.example.com"), secureIngress("tls.rl.wave.example.com")],
    };
    let rounds = 0;

    await runOperator({
      kube: fakeCluster(state as never),
      profile: await profileFor(control.url),
      log: () => {},
      sleep: async () => {
        rounds++;
      },
      until: () => rounds >= 2,
    });
    control.stop();

    expect(control.calls[0]).toEqual(["plain.rl.wave.example.com", "tls.rl.wave.example.com"]);
    expect(control.secure[0]).toEqual(["tls.rl.wave.example.com"]);
  });

  test("an ingress taken away is declared away", async () => {
    const control = recorder();
    const state = { ingresses: [ingress("grafana.rl.wave.example.com")] };
    let rounds = 0;

    await runOperator({
      kube: fakeCluster(state),
      profile: await profileFor(control.url),
      log: () => {},
      sleep: async () => {
        rounds++;
        if (rounds === 1) state.ingresses = [];
      },
      until: () => rounds >= 3,
    });
    control.stop();

    // The empty set is the point: a missed delete would leave a name in the
    // wave that nothing answers for.
    expect(control.calls[control.calls.length - 1]).toEqual([]);
  });

  test("a server that is down is survived, and the next round tries again", async () => {
    const state = { ingresses: [ingress("grafana.rl.wave.example.com")] };
    const lines: string[] = [];
    let rounds = 0;

    await runOperator({
      kube: fakeCluster(state),
      // Nothing listens there.
      profile: await profileFor("http://127.0.0.1:1"),
      log: (message) => lines.push(message),
      sleep: async () => {
        rounds++;
      },
      until: () => rounds >= 2,
    });

    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("operator:");
  });
});
