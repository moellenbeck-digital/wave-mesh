import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { buildAuthorizationHeader, canonicalJson, generateKeyPair, verify } from "@wave/crypto";
import { type Netmap, SignedNetmap } from "@wave/proto";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.ts";
import { createProviders } from "../src/auth/providers.ts";
import type { Database } from "../src/db/client.ts";
import { nodes, users, waveMembers, waveServices, waves } from "../src/db/schema.ts";
import { buildNetmap, signNetmap } from "../src/netmap/build.ts";
import { createAuthKey } from "../src/waves/auth-keys.ts";
import { serviceLabel, syncServices } from "../src/waves/services.ts";
import { CookieJar, createTestDb, createWaveAs, testConfig, testSigningKey } from "./helpers.ts";

/**
 * Services in a wave (D11): names that are not devices.
 *
 * What these tests hold on to is the mechanism, not the Kubernetes around it --
 * a service is an address in somebody's `allowedIps`, and that is what makes
 * every device route it without learning a new concept.
 */

let db: Database;
let close: () => Promise<void>;
let reset: () => Promise<void>;
let app: ReturnType<typeof createApp>;
let signingKey: ReturnType<typeof testSigningKey>;

beforeAll(async () => {
  ({ db, close, reset } = await createTestDb());
});

afterAll(() => close());

beforeEach(async () => {
  await reset();
  const config = testConfig();
  signingKey = testSigningKey();
  app = createApp({ db, config, providers: createProviders(config), signingKey });
});

function makeMachine(hostname: string) {
  const machine = generateKeyPair("ed25519");
  return {
    machine,
    body: {
      machineKey: machine.publicKey,
      nodeKey: generateKeyPair("x25519").publicKey,
      discoKey: generateKeyPair("x25519").publicKey,
      hostname,
      os: "linux" as const,
    },
  };
}

type Machine = ReturnType<typeof makeMachine>;

const signed = (machine: Machine, method: string, path: string, body?: unknown) => {
  const payload = body === undefined ? "" : JSON.stringify(body);
  return app.request(path, {
    method,
    body: method === "GET" ? undefined : payload,
    headers: {
      "content-type": "application/json",
      authorization: buildAuthorizationHeader({
        machineKey: machine.machine.publicKey,
        machinePrivateKey: machine.machine.privateKey,
        method,
        path,
        body: payload,
      }),
    },
  });
};

/** A wave with a connector in it, enrolled the way a cluster does: with a key. */
async function cluster(suffix = "robin.wave.internal") {
  const email = "robin@example.com";
  const jar = new CookieJar();
  const start = await app.request("/auth/dev/start");
  jar.absorb(start);
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
  jar.absorb(
    await app.request(`/auth/dev/callback?code=${encodeURIComponent(email)}&state=${state}`, {
      headers: { cookie: jar.header() },
    }),
  );
  await createWaveAs((path, init) => app.request(path, init), jar, email, { suffix });

  const [member] = await db.select().from(waveMembers).limit(1);
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!member || !user) throw new Error("no wave");

  const key = await createAuthKey(db, { waveId: member.waveId, userId: user.id, reusable: true });
  const connector = makeMachine("connector");
  await signed(connector, "POST", "/v1/machine/register", { ...connector.body, authKey: key.token });
  const laptop = makeMachine("laptop");
  await signed(laptop, "POST", "/v1/machine/register", { ...laptop.body, authKey: key.token });

  const rows = await db.select().from(nodes);
  const connectorNode = rows.find((node) => node.hostname === "connector");
  const laptopNode = rows.find((node) => node.hostname === "laptop");
  if (!connectorNode || !laptopNode) throw new Error("the cluster did not enrol");
  return { waveId: member.waveId, connector, laptop, connectorNode, laptopNode, suffix };
}

/** A netmap with everything in it, for the version-skew tests below. */
const sampleNetmap = () => ({
  version: 1,
  waveId: "w_1",
  self: {
    id: "n_1",
    nodeKey: "A".repeat(43) + "=",
    discoKey: "B".repeat(43) + "=",
    hostname: "laptop",
    dnsName: "laptop.wave.example.com",
    ipv4: "10.77.0.1",
    ipv6: "fd7a:1:2::1",
    allowedIps: ["10.77.0.1/32"],
    candidates: [],
    online: true,
    keyExpiresAt: null,
    addresses: ["10.77.0.1/32"],
  },
  peers: [],
  services: [],
  dns: { suffix: "wave.example.com", resolverAddress: "10.77.0.1", routes: [], upstream: [] },
  relays: [],
  issuedAt: "2026-09-19T12:00:00.000Z",
});

const netmapOf = async (nodeId: string): Promise<Netmap> => {
  const netmap = await buildNetmap(db, nodeId);
  if (!netmap) throw new Error("no netmap");
  return netmap;
};

describe("declaring what a cluster answers for", () => {
  test("gives every name an address out of the wave's own block", async () => {
    const { connector } = await cluster();
    const res = await signed(connector, "POST", "/v1/services", { names: ["grafana", "git"] });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { services: { name: string; ipv4: string }[] };
    expect(body.services.map((service) => service.name).sort()).toEqual(["git", "grafana"]);
    // The wave's /16, not a cluster CIDR: two clusters can do this and never
    // collide, and `overlap.ts` gets nothing new to do.
    for (const service of body.services) expect(service.ipv4.startsWith("10.")).toBe(true);
  });

  test("an ingress host counts as the name it is", async () => {
    const { connector, suffix } = await cluster();
    const res = await signed(connector, "POST", "/v1/services", { names: [`grafana.${suffix}`] });
    const body = (await res.json()) as { services: { name: string }[] };
    expect(body.services[0]?.name).toBe("grafana");
  });

  test("a name from another zone is refused, because the host header decides", async () => {
    const { connector } = await cluster();
    const res = await signed(connector, "POST", "/v1/services", { names: ["grafana.elsewhere.example"] });
    expect(res.status).toBe(409);
  });

  // The whole set at once: a cluster's objects come and go, and a missed delete
  // would leave a name in the wave that nothing answers for.
  test("declaring again removes what is no longer named", async () => {
    const { connector } = await cluster();
    await signed(connector, "POST", "/v1/services", { names: ["grafana", "git"] });
    await signed(connector, "POST", "/v1/services", { names: ["grafana"] });

    const res = await signed(connector, "GET", "/v1/services");
    const body = (await res.json()) as { services: { name: string }[] };
    expect(body.services.map((service) => service.name)).toEqual(["grafana"]);
  });

  test("a name that is already a device is refused", async () => {
    const { connector } = await cluster();
    const res = await signed(connector, "POST", "/v1/services", { names: ["laptop"] });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("is a device");
  });

  test("addresses are not handed out twice, whoever holds them", async () => {
    const { connector, connectorNode, laptopNode } = await cluster();
    await signed(connector, "POST", "/v1/services", { names: ["a", "b", "c"] });

    const netmap = await netmapOf(connectorNode.id);
    const addresses = [
      connectorNode.ipv4,
      laptopNode.ipv4,
      ...(netmap.services ?? []).map((service) => service.ipv4),
    ];
    expect(new Set(addresses).size).toBe(addresses.length);
  });

  test("an unsigned declaration gets nowhere", async () => {
    await cluster();
    const res = await app.request("/v1/services", { method: "POST", body: JSON.stringify({ names: [] }) });
    expect(res.status).toBe(401);
  });
});

describe("what the netmap makes of it", () => {
  test("every device routes the service through the connector", async () => {
    const { connector, connectorNode, laptopNode } = await cluster();
    await signed(connector, "POST", "/v1/services", { names: ["grafana"] });

    const netmap = await netmapOf(laptopNode.id);
    const service = netmap.services?.[0];
    expect(service?.dnsName).toBe("grafana.robin.wave.internal");

    // The mechanism: not a peer of its own, but an address in the connector's
    // allowedIps -- which is what desiredRoutes() on every device turns into a
    // route without knowing what a service is.
    const peer = netmap.peers.find((entry) => entry.id === connectorNode.id);
    expect(peer?.allowedIps).toContain(`${service?.ipv4}/32`);
    expect(peer?.allowedIps).toContain(`${service?.ipv6}/128`);
    expect(netmap.peers.some((entry) => entry.hostname === "grafana")).toBe(false);
  });

  test("the connector learns from its own netmap which addresses to wear", async () => {
    const { connector, connectorNode } = await cluster();
    await signed(connector, "POST", "/v1/services", { names: ["grafana"] });

    const netmap = await netmapOf(connectorNode.id);
    const service = netmap.services?.[0];
    expect(netmap.self.addresses).toContain(`${service?.ipv4}/32`);
  });

  test("a device that fronts nothing carries nothing extra", async () => {
    const { connector, laptopNode } = await cluster();
    await signed(connector, "POST", "/v1/services", { names: ["grafana"] });

    const netmap = await netmapOf(laptopNode.id);
    expect(netmap.self.addresses).toHaveLength(2);
  });

  // Adding a field to a signed document is where a protocol breaks quietly:
  // a schema that dropped what it did not know would canonicalise something
  // else and call a perfectly good netmap forged.
  test("a client that does not know `services` still verifies the signature", async () => {
    const { connector, connectorNode } = await cluster();
    await signed(connector, "POST", "/v1/services", { names: ["grafana"] });

    const document = signNetmap(await netmapOf(connectorNode.id), signingKey);
    const overTheWire = JSON.parse(JSON.stringify(document));
    const parsed = SignedNetmap.parse(overTheWire);

    expect(verify(signingKey.publicKey, canonicalJson(parsed.netmap), parsed.signature)).toBe(true);
  });
});

describe("a signed netmap and a version skew", () => {
  // Both directions of the same rule: nothing in a signed document may be
  // dropped, and nothing may be invented. The first breaks an old client
  // against a new server, the second a new client against an old one -- and
  // both say "signature does not verify", which reads like an attack.
  test("a field the reader does not know survives the parse", () => {
    const netmap = { ...sampleNetmap(), fromALaterVersion: { anything: true } };
    const document = signNetmap(netmap as never, signingKey);
    const parsed = SignedNetmap.parse(JSON.parse(JSON.stringify(document)));

    expect(parsed.netmap).toHaveProperty("fromALaterVersion");
    expect(verify(signingKey.publicKey, canonicalJson(parsed.netmap), parsed.signature)).toBe(true);
  });

  test("a field the sender never sent is not added", () => {
    // What an older server's netmap looks like: no `services` at all.
    const { services, ...withoutServices } = sampleNetmap();
    expect(services).toBeDefined();
    const document = signNetmap(withoutServices as never, signingKey);
    const parsed = SignedNetmap.parse(JSON.parse(JSON.stringify(document)));

    expect("services" in parsed.netmap).toBe(false);
    expect(verify(signingKey.publicKey, canonicalJson(parsed.netmap), parsed.signature)).toBe(true);
  });
});

describe("service names", () => {
  test("take a bare label or the whole host", () => {
    expect(serviceLabel("grafana", "wave.example.com")).toBe("grafana");
    expect(serviceLabel("grafana.wave.example.com", "wave.example.com")).toBe("grafana");
    expect(serviceLabel("GRAFANA.Wave.Example.com", "wave.example.com")).toBe("grafana");
  });

  test("refuse anything that is not one label under this wave", () => {
    expect(serviceLabel("a.b", "wave.example.com")).toBeNull();
    expect(serviceLabel("grafana.elsewhere.example", "wave.example.com")).toBeNull();
    expect(serviceLabel("-nope", "wave.example.com")).toBeNull();
    expect(serviceLabel("", "wave.example.com")).toBeNull();
  });
});

describe("a device joining a wave that already has services", () => {
  test("gets none of their addresses", async () => {
    // One numbering for both kinds of name. A device on a service's address
    // ends up in the connector's allowedIps too, and the route for it collides
    // with the host route the device puts on its own interface -- a tunnel that
    // comes up everywhere except for that one address.
    const { connector, waveId } = await cluster();
    await signed(connector, "POST", "/v1/services", { names: ["grafana", "argo", "harbor"] });
    const services = await db.select().from(waveServices).where(eq(waveServices.waveId, waveId));
    expect(services.length).toBe(3);

    const [user] = await db.select().from(users).limit(1);
    const key = await createAuthKey(db, { waveId, userId: user?.id ?? "", reusable: true });
    const desktop = makeMachine("desktop");
    await signed(desktop, "POST", "/v1/machine/register", { ...desktop.body, authKey: key.token });

    const [node] = await db.select().from(nodes).where(eq(nodes.hostname, "desktop"));
    expect(node).toBeDefined();
    expect(services.map((service) => service.ipv4)).not.toContain(node?.ipv4);
    expect(services.map((service) => service.ipv6)).not.toContain(node?.ipv6);
  });

  test("gets none of their names either", async () => {
    const { connector, waveId } = await cluster();
    await signed(connector, "POST", "/v1/services", { names: ["grafana"] });

    const [user] = await db.select().from(users).limit(1);
    const key = await createAuthKey(db, { waveId, userId: user?.id ?? "", reusable: true });
    const impostor = makeMachine("grafana");
    await signed(impostor, "POST", "/v1/machine/register", { ...impostor.body, authKey: key.token });

    const [node] = await db.select().from(nodes).where(eq(nodes.machineKey, impostor.machine.publicKey));
    expect(node?.hostname).toBe("grafana-2");
  });
});

describe("the same name from two directions", () => {
  test("another node cannot take over a service", async () => {
    const { connector, laptopNode, waveId } = await cluster();
    await signed(connector, "POST", "/v1/services", { names: ["grafana"] });

    const stolen = await syncServices(db, { waveId, viaNodeId: laptopNode.id, names: ["grafana"] });
    expect(stolen).toEqual({ conflict: "grafana.robin.wave.internal is served by another node" });
  });
});

describe("which protocol a service is served on", () => {
  const schemeOf = async (name: string) => {
    const [row] = await db.select().from(waveServices).where(eq(waveServices.name, name)).limit(1);
    return row?.scheme;
  };
  const versionOf = async (waveId: string) => {
    const [row] = await db.select().from(waves).where(eq(waves.id, waveId)).limit(1);
    return row?.netmapVersion;
  };

  // Only the cluster knows, so only the cluster may say. What it says is the
  // subset of the set it just declared.
  test("a name the cluster calls secure is https, the rest is http", async () => {
    const { connector } = await cluster();
    await signed(connector, "POST", "/v1/services", {
      names: ["grafana", "git"],
      secure: ["grafana"],
    });
    expect(await schemeOf("grafana")).toBe("https");
    expect(await schemeOf("git")).toBe("http");
  });

  // An operator from before schemes sends names alone. Reading that as "none of
  // them are secure" would turn every existing service into a broken link.
  test("an operator that says nothing leaves every name on https", async () => {
    const { connector } = await cluster();
    await signed(connector, "POST", "/v1/services", { names: ["grafana"] });
    expect(await schemeOf("grafana")).toBe("https");
  });

  test("the whole host may be given, as in an Ingress", async () => {
    const { connector, suffix } = await cluster();
    await signed(connector, "POST", "/v1/services", {
      names: [`grafana.${suffix}`],
      secure: [`grafana.${suffix}`],
    });
    expect(await schemeOf("grafana")).toBe("https");
  });

  // A certificate put on an existing Ingress changes how the name is shown and
  // nothing else -- the netmap has no scheme in it. Bumping its version would
  // push an identical document to every device in the wave.
  test("a scheme that flips is stored without a new netmap", async () => {
    const { connector, waveId } = await cluster();
    await signed(connector, "POST", "/v1/services", { names: ["grafana"], secure: [] });
    const before = await versionOf(waveId);

    await signed(connector, "POST", "/v1/services", { names: ["grafana"], secure: ["grafana"] });
    expect(await schemeOf("grafana")).toBe("https");
    expect(await versionOf(waveId)).toBe(before as number);
  });

  test("a secure name that is not in the set means nothing", async () => {
    const { connector } = await cluster();
    await signed(connector, "POST", "/v1/services", { names: ["git"], secure: ["grafana"] });
    expect(await schemeOf("grafana")).toBeUndefined();
    expect(await schemeOf("git")).toBe("http");
  });
});
