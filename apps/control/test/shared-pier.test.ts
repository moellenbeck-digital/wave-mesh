import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { buildAuthorizationHeader, generateKeyPair } from "@wave/crypto";
import type { Netmap } from "@wave/proto";
import { eq } from "drizzle-orm";
import { setPolicy } from "../src/acl/store.ts";
import { createApp } from "../src/app.ts";
import { createProviders } from "../src/auth/providers.ts";
import { checkNames } from "../src/certs/issue.ts";
import type { Database } from "../src/db/client.ts";
import { nodes, users, waveMembers, waves } from "../src/db/schema.ts";
import { storeDnsCredential } from "../src/dns/credentials.ts";
import { buildNetmap, netmapVersionOf } from "../src/netmap/build.ts";
import { createAuthKey } from "../src/waves/auth-keys.ts";
import { addMember } from "../src/waves/members.ts";
import { pierLeaving, unpublishLeavingPier } from "../src/waves/pier-dns.ts";
import {
  pierLabel,
  pierZone,
  randomPierName,
  setPierAllowed,
  setPierHost,
  setPierZoneMode,
  setSharedPierHost,
} from "../src/waves/piers.ts";
import { CookieJar, createTestDb, createWaveAs, testConfig, testSigningKey } from "./helpers.ts";

/**
 * The shared pier: one pier for every wave of a server that has none of its
 * own. Held to here: the random zone and who writes its record, that the pier
 * is a peer of exactly the devices that hold a name -- and of those only once
 * they enforce the filter that keeps it to their claimed ports --, the composed
 * netmap version, one wave per machine, the choice of zone, and that owners and
 * admins open the first lock.
 */

const DNS_KEY = Buffer.alloc(32, 7);
const DOMAIN = "wavepier.test";
const OWN_SUFFIX = "wave.example.com";
const PIER_V4 = "203.0.113.20";
const PIER_V6 = "2001:db8::20";

let db: Database;
let close: () => Promise<void>;
let reset: () => Promise<void>;
let app: ReturnType<typeof createApp>;
let zones: FakeZones;
let config: ReturnType<typeof testConfig>;

/** Cloudflare with two zones -- the shared pier's and a wave's own -- keeping what is written. */
class FakeZones {
  records = new Map<string, { zone: string; type: string; name: string; content: string }>();
  private next = 0;
  private readonly ids = new Map([
    ["z-shared", DOMAIN],
    ["z-own", OWN_SUFFIX],
  ]);

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const ok = (result: unknown) => Response.json({ success: true, errors: [], result });
    if (url.pathname === "/client/v4/zones") {
      const name = url.searchParams.get("name");
      const found = [...this.ids].find(([, zone]) => zone === name);
      return ok(found ? [{ id: found[0], name }] : []);
    }
    const match = url.pathname.match(/^\/client\/v4\/zones\/([^/]+)\/dns_records(?:\/(.+))?$/);
    if (!match) return new Response("unexpected", { status: 500 });
    const zone = match[1] as string;
    if (method === "POST") {
      const body = JSON.parse(String(init?.body)) as { type: string; name: string; content: string };
      this.records.set(`r${++this.next}`, { zone, ...body });
      return ok({ id: `r${this.next}` });
    }
    if (method === "DELETE") {
      this.records.delete(match[2] ?? "");
      return ok({});
    }
    const type = url.searchParams.get("type");
    const name = url.searchParams.get("name");
    return ok(
      [...this.records]
        .filter(([, record]) => record.zone === zone && record.type === type && record.name === name)
        .map(([id, record]) => ({ id, ...record })),
    );
  }) as typeof fetch;

  at(name: string): string[] {
    return [...this.records.values()]
      .filter((record) => record.name === name)
      .map((record) => `${record.zone} ${record.type} ${record.content}`)
      .sort();
  }
}

beforeAll(async () => {
  ({ db, close, reset } = await createTestDb());
});

afterAll(() => close());

beforeEach(async () => {
  await reset();
  zones = new FakeZones();
  config = testConfig({
    WAVE_DNS_SECRET: DNS_KEY.toString("base64"),
    WAVE_SHARED_PIER_DOMAIN: DOMAIN,
    WAVE_SHARED_PIER_DNS_PROVIDER: "cloudflare",
    WAVE_SHARED_PIER_DNS_TOKEN: "server-token",
  });
  app = createApp({
    db,
    config,
    providers: createProviders(config),
    signingKey: testSigningKey(),
    dnsFetch: zones.fetch,
  });
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

const signed = (machine: Machine, method: string, path: string, body?: unknown, waveId?: string) => {
  const payload = body === undefined || method === "GET" || method === "DELETE" ? "" : JSON.stringify(body);
  return app.request(path, {
    method,
    body: payload || undefined,
    headers: {
      "content-type": "application/json",
      ...(waveId ? { "x-wave-id": waveId } : {}),
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

async function signIn(email: string): Promise<CookieJar> {
  const jar = new CookieJar();
  const start = await app.request("/auth/dev/start");
  jar.absorb(start);
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
  jar.absorb(
    await app.request(`/auth/dev/callback?code=${encodeURIComponent(email)}&state=${state}`, {
      headers: { cookie: jar.header() },
    }),
  );
  return jar;
}

/** A wave of its own owner, with the named devices enrolled through a pre-auth key. */
async function wave(email: string, suffix: string, hostnames: string[], reuse: Record<string, Machine> = {}) {
  const jar = await signIn(email);
  await createWaveAs((path, init) => app.request(path, init), jar, email, { suffix });
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user) throw new Error("no user");
  const [row] = await db.select().from(waves).where(eq(waves.dnsSuffix, suffix)).limit(1);
  if (!row) throw new Error("no wave");
  const key = await createAuthKey(db, { waveId: row.id, userId: user.id, reusable: true });
  const machines: Record<string, Machine> = {};
  for (const hostname of hostnames) {
    const machine = reuse[hostname] ?? makeMachine(hostname);
    machines[hostname] = machine;
    const res = await signed(machine, "POST", "/v1/machine/register", {
      ...machine.body,
      authKey: key.token,
    });
    if (!res.ok) throw new Error(`${hostname} did not enrol: ${await res.text()}`);
  }
  const rows = await db.select().from(nodes).where(eq(nodes.waveId, row.id));
  const node = (hostname: string) => {
    const found = rows.find((entry) => entry.hostname === hostname);
    if (!found) throw new Error(`${hostname} did not enrol`);
    return found;
  };
  return { id: row.id, userId: user.id, jar, machines, node };
}

/** The hosting wave with its pier, made the shared pier of the server. */
async function hosting() {
  const hostingWave = await wave("ops@example.com", "pier-host.wave.internal", ["pier"]);
  const set = await setSharedPierHost(db, {
    waveId: hostingWave.id,
    nodeId: hostingWave.node("pier").id,
    ipv4: PIER_V4,
    ipv6: PIER_V6,
  });
  if (!("host" in set)) throw new Error("no shared pier");
  return hostingWave;
}

const netmapOf = async (nodeId: string): Promise<Netmap> => {
  const netmap = await buildNetmap(db, nodeId, [], DOMAIN);
  if (!netmap) throw new Error("no netmap");
  return netmap;
};

const enforce = (nodeId: string) =>
  db.update(nodes).set({ filterEnforced: true }).where(eq(nodes.id, nodeId));

describe("the shared zone", () => {
  test("a wave without a domain of its own puts a name out under a random label", async () => {
    await hosting();
    const a = await wave("a@example.com", "a.wave.internal", ["laptop"]);
    await setPierAllowed(db, a.id, a.node("laptop").id, true);

    const res = await signed(a.machines.laptop as Machine, "POST", "/v1/piers", { name: "app", port: 8443 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dnsName: string };
    const label = body.dnsName.split(".")[1] as string;
    expect(body.dnsName).toBe(`app.${label}.${DOMAIN}`);
    // Three words from unique-names-generator: `brave-teal-otter`.
    expect(label).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);

    // Written by the server's token into its own zone, pointing at the pier.
    expect(zones.at(`*.${label}.${DOMAIN}`)).toEqual([`z-shared A ${PIER_V4}`, `z-shared AAAA ${PIER_V6}`]);

    // The label is kept: the list and a second name say the same zone.
    const list = (await (await signed(a.machines.laptop as Machine, "GET", "/v1/piers")).json()) as {
      zone: string;
    };
    expect(list.zone).toBe(`${label}.${DOMAIN}`);
  });

  test("a random name is three words and always a valid label under the zone", () => {
    for (let i = 0; i < 500; i++) {
      const name = randomPierName();
      expect(name).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
      expect(name.length).toBeLessThanOrEqual(63);
      expect(pierLabel(name, DOMAIN)).toBe(name);
    }
  });

  test("two waves get two labels", async () => {
    await hosting();
    const a = await wave("a@example.com", "a.wave.internal", ["laptop"]);
    const b = await wave("b@example.com", "b.wave.internal", ["laptop"]);
    const zoneOf = async (machine: Machine) =>
      ((await (await signed(machine, "GET", "/v1/piers")).json()) as { zone: string }).zone;
    const za = await zoneOf(a.machines.laptop as Machine);
    const zb = await zoneOf(b.machines.laptop as Machine);
    expect(za).not.toBe(zb);
    expect(za.endsWith(`.${DOMAIN}`)).toBe(true);
  });

  test("without a shared pier nothing changes: a placeholder wave still has no pier", async () => {
    const a = await wave("a@example.com", "a.wave.internal", ["laptop"]);
    await setPierAllowed(db, a.id, a.node("laptop").id, true);
    const res = await signed(a.machines.laptop as Machine, "POST", "/v1/piers", { name: "app", port: 8443 });
    expect(res.status).toBe(409);
  });

  test("a certificate for a name under the shared zone is allowed on a placeholder suffix, mixed orders are not", () => {
    const pierName = `app.brave-teal-otter.${DOMAIN}`;
    const input = {
      hostname: "laptop",
      dnsSuffix: "a.wave.internal",
      wildcardAllowed: false,
      pierNames: [pierName],
    };
    expect(checkNames({ ...input, names: [pierName] })).toBeNull();
    expect(checkNames({ ...input, names: [pierName, "laptop.a.wave.internal"] })?.status).toBe(400);
  });
});

describe("the netmaps", () => {
  async function claimed() {
    const host = await hosting();
    const a = await wave("a@example.com", "a.wave.internal", ["laptop", "nas"]);
    const b = await wave("b@example.com", "b.wave.internal", ["phone"]);
    await setPierAllowed(db, a.id, a.node("laptop").id, true);
    const res = await signed(a.machines.laptop as Machine, "POST", "/v1/piers", { name: "app", port: 8443 });
    const { dnsName } = (await res.json()) as { dnsName: string };
    return { host, a, b, dnsName };
  }

  test("a device holding a name gets a filter at once, and the pier only once it enforces it", async () => {
    const { host, a } = await claimed();
    const laptop = a.node("laptop");
    const [aRow] = await db.select().from(waves).where(eq(waves.id, a.id));

    const before = await netmapOf(laptop.id);
    expect(before.peers.map((peer) => peer.id)).not.toContain(host.node("pier").id);
    expect(before.packetFilter).toEqual([
      {
        src: [aRow?.ipv4Prefix as string, aRow?.ipv6Prefix as string],
        dst: [`${laptop.ipv4}/32`, `${laptop.ipv6}/128`],
        ports: [{ proto: "any", from: 1, to: 65535 }],
      },
      {
        src: [`${host.node("pier").ipv4}/32`, `${host.node("pier").ipv6}/128`],
        dst: [`${laptop.ipv4}/32`, `${laptop.ipv6}/128`],
        ports: [{ proto: "tcp", from: 8443, to: 8443 }],
      },
    ]);
    expect(before.pier?.nodeId as string | undefined).toBe(host.node("pier").id);

    await enforce(laptop.id);
    const after = await netmapOf(laptop.id);
    const pierPeer = after.peers.find((peer) => peer.id === host.node("pier").id);
    expect(pierPeer?.allowedIps).toEqual([`${host.node("pier").ipv4}/32`, `${host.node("pier").ipv6}/128`]);
  });

  test("a device without a name sees neither the pier nor a filter", async () => {
    const { host, a } = await claimed();
    const nas = await netmapOf(a.node("nas").id);
    expect(nas.peers.map((peer) => peer.id)).not.toContain(host.node("pier").id);
    expect(nas.packetFilter).toBeUndefined();
  });

  test("the pier sees exactly the enforcing holders, by their own addresses and full names", async () => {
    const { host, a, b, dnsName } = await claimed();
    const pierId = host.node("pier").id;
    expect((await netmapOf(pierId)).peers).toEqual([]);

    await enforce(a.node("laptop").id);
    const pier = await netmapOf(pierId);
    expect(pier.peers.map((peer) => peer.hostname)).toEqual(["laptop"]);
    expect(pier.peers[0]?.allowedIps).toEqual([
      `${a.node("laptop").ipv4}/32`,
      `${a.node("laptop").ipv6}/128`,
    ]);
    expect(pier.piers?.map((entry) => entry.dnsName)).toEqual([dnsName]);
    expect(pier.pier).toEqual({ nodeId: pierId as never, zone: DOMAIN });
    // Nothing of the other wave, and nothing of the device that holds no name.
    expect(pier.peers.map((peer) => peer.id)).not.toContain(b.node("phone").id);
    expect(pier.peers.map((peer) => peer.id)).not.toContain(a.node("nas").id);
  });

  test("under a policy the device keeps its policy and gains the pier's one port", async () => {
    const { host, a } = await claimed();
    await setPolicy(db, a.id, { acls: [{ src: ["*"], dst: ["*"], ports: ["22"] }] }, null);
    const laptop = await netmapOf(a.node("laptop").id);
    const pierRule = laptop.packetFilter?.find((rule) => rule.src[0] === `${host.node("pier").ipv4}/32`);
    expect(pierRule?.ports).toEqual([{ proto: "tcp", from: 8443, to: 8443 }]);
    expect(
      laptop.packetFilter?.some((rule) => rule.ports.some((p) => p.proto === "any" && p.to === 65535)),
    ).toBe(false);
  });

  test("the version a netmap carries is the one the heartbeat compares, across both waves", async () => {
    const { host, a } = await claimed();
    await enforce(a.node("laptop").id);
    const laptopId = a.node("laptop").id;
    const pierId = host.node("pier").id;
    expect(await netmapVersionOf(db, laptopId)).toBe((await netmapOf(laptopId)).version);
    expect(await netmapVersionOf(db, pierId)).toBe((await netmapOf(pierId)).version);

    const pierBefore = (await netmapOf(pierId)).version;
    await signed(a.machines.laptop as Machine, "POST", "/v1/piers", { name: "other", port: 9443 });
    expect((await netmapOf(pierId)).version).toBeGreaterThan(pierBefore);
  });
});

describe("one wave per machine", () => {
  test("a machine that holds a name through the shared pier in one wave cannot in another", async () => {
    await hosting();
    const a = await wave("a@example.com", "a.wave.internal", ["laptop"]);
    const b = await wave("b@example.com", "b.wave.internal", ["laptop"], {
      laptop: a.machines.laptop as Machine,
    });
    await setPierAllowed(db, a.id, a.node("laptop").id, true);
    await setPierAllowed(db, b.id, b.node("laptop").id, true);
    const laptop = a.machines.laptop as Machine;

    expect((await signed(laptop, "POST", "/v1/piers", { name: "app", port: 8443 }, a.id)).status).toBe(200);
    const second = await signed(laptop, "POST", "/v1/piers", { name: "app", port: 8443 }, b.id);
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toContain("one wave only");
  });
});

describe("names in a wave with a pier of its own", () => {
  test("do not count against the one wave a machine may use the shared pier in", async () => {
    // The laptop holds names behind its own wave's pier and puts one out
    // through the shared pier in another wave: two piers, two addresses, no
    // conflict.
    await hosting();
    const own = await wave("own@example.com", OWN_SUFFIX, ["laptop", "edge"]);
    const set = await setPierHost(db, { waveId: own.id, nodeId: own.node("edge").id, ipv4: "198.51.100.1" });
    expect("host" in set).toBe(true);
    const b = await wave("b@example.com", "b.wave.internal", ["laptop"], {
      laptop: own.machines.laptop as Machine,
    });
    await setPierAllowed(db, own.id, own.node("laptop").id, true);
    await setPierAllowed(db, b.id, b.node("laptop").id, true);
    const laptop = own.machines.laptop as Machine;

    const first = await signed(laptop, "POST", "/v1/piers", { name: "app", port: 8443 }, own.id);
    expect(((await first.json()) as { dnsName: string }).dnsName).toBe(`app.pier.${OWN_SUFFIX}`);
    const second = await signed(laptop, "POST", "/v1/piers", { name: "app", port: 8443 }, b.id);
    expect(second.status).toBe(200);
    expect(((await second.json()) as { dnsName: string }).dnsName.endsWith(`.${DOMAIN}`)).toBe(true);
  });
});

describe("the zone a wave chooses", () => {
  test("own: the names go under pier.<own domain>, written by the wave's provider", async () => {
    await hosting();
    const a = await wave("a@example.com", OWN_SUFFIX, ["laptop"]);
    await storeDnsCredential(db, { waveId: a.id, provider: "cloudflare", token: "wave-token", key: DNS_KEY });
    expect("mode" in (await setPierZoneMode(db, { waveId: a.id, mode: "own", sharedDomain: DOMAIN }))).toBe(
      true,
    );
    await setPierAllowed(db, a.id, a.node("laptop").id, true);

    const res = await signed(a.machines.laptop as Machine, "POST", "/v1/piers", { name: "app", port: 8443 });
    expect(((await res.json()) as { dnsName: string }).dnsName).toBe(`app.pier.${OWN_SUFFIX}`);
    expect(zones.at(`*.pier.${OWN_SUFFIX}`)).toEqual([`z-own A ${PIER_V4}`, `z-own AAAA ${PIER_V6}`]);
  });

  test("own needs a domain the open network can resolve, and no zone moves while names are out", async () => {
    await hosting();
    const a = await wave("a@example.com", "a.wave.internal", ["laptop"]);
    const refused = await setPierZoneMode(db, { waveId: a.id, mode: "own", sharedDomain: DOMAIN });
    expect("error" in refused && refused.status).toBe(409);

    await setPierAllowed(db, a.id, a.node("laptop").id, true);
    await signed(a.machines.laptop as Machine, "POST", "/v1/piers", { name: "app", port: 8443 });
    await db.update(waves).set({ dnsSuffix: "a.example.org" }).where(eq(waves.id, a.id));
    const moving = await setPierZoneMode(db, { waveId: a.id, mode: "own", sharedDomain: DOMAIN });
    expect("error" in moving && moving.error).toContain("remove them");
  });

  test("a pier of the wave's own takes it to its own zone, and is refused while shared names are out", async () => {
    await hosting();
    const a = await wave("a@example.com", OWN_SUFFIX, ["laptop", "edge"]);
    await setPierAllowed(db, a.id, a.node("laptop").id, true);
    await signed(a.machines.laptop as Machine, "POST", "/v1/piers", { name: "app", port: 8443 });
    const refused = await setPierHost(db, { waveId: a.id, nodeId: a.node("edge").id, ipv4: "198.51.100.1" });
    expect("conflict" in refused).toBe(true);

    await signed(a.machines.laptop as Machine, "DELETE", "/v1/piers/app");
    const set = await setPierHost(db, { waveId: a.id, nodeId: a.node("edge").id, ipv4: "198.51.100.1" });
    expect("host" in set).toBe(true);
    const [row] = await db.select().from(waves).where(eq(waves.id, a.id));
    expect(pierZone(row as never, DOMAIN)).toBe(`pier.${OWN_SUFFIX}`);
  });
});

describe("the wave going", () => {
  test("takes its random zone's wildcard with it", async () => {
    await hosting();
    const a = await wave("a@example.com", "a.wave.internal", ["laptop"]);
    await setPierAllowed(db, a.id, a.node("laptop").id, true);
    const res = await signed(a.machines.laptop as Machine, "POST", "/v1/piers", { name: "app", port: 8443 });
    const { dnsName } = (await res.json()) as { dnsName: string };
    const wildcard = `*.${dnsName.split(".").slice(1).join(".")}`;
    expect(zones.at(wildcard)).toHaveLength(2);

    const leaving = await pierLeaving(db, { waveId: a.id, leaving: { wholeWave: true } }, DOMAIN);
    await db.delete(waves).where(eq(waves.id, a.id));
    await unpublishLeavingPier(
      { db, dnsSecret: DNS_KEY, sharedPier: config.sharedPier, http: zones.fetch },
      leaving,
    );
    expect(zones.at(wildcard)).toEqual([]);
  });
});

describe("the first lock, opened in the browser", () => {
  const put = (jar: CookieJar, waveId: string, nodeId: string, allowed: unknown) =>
    app.request(`/api/waves/${waveId}/nodes/${nodeId}/pier`, {
      method: "PUT",
      headers: { cookie: jar.header(), "content-type": "application/json" },
      body: JSON.stringify({ allowed }),
    });

  test("an owner opens and closes it; closing takes the names back", async () => {
    await hosting();
    const a = await wave("a@example.com", "a.wave.internal", ["laptop"]);
    const laptop = a.node("laptop");

    expect((await put(a.jar, a.id, laptop.id, true)).status).toBe(200);
    expect(
      (await signed(a.machines.laptop as Machine, "POST", "/v1/piers", { name: "app", port: 8443 })).status,
    ).toBe(200);
    const closed = await put(a.jar, a.id, laptop.id, false);
    expect(((await closed.json()) as { removed: number }).removed).toBe(1);
    const [row] = await db.select().from(nodes).where(eq(nodes.id, laptop.id));
    expect(row?.pierAllowed).toBe(false);
  });

  test("a member may not, a stranger does not see the wave, and the body has to say true or false", async () => {
    await hosting();
    const a = await wave("a@example.com", "a.wave.internal", ["laptop"]);
    const laptop = a.node("laptop");

    const memberJar = await signIn("m@example.com");
    const [member] = await db.select().from(users).where(eq(users.email, "m@example.com"));
    await addMember(db, a.id, member?.id as string, "member");
    expect((await put(memberJar, a.id, laptop.id, true)).status).toBe(403);

    const strangerJar = await signIn("s@example.com");
    expect((await put(strangerJar, a.id, laptop.id, true)).status).toBe(404);

    expect((await put(a.jar, a.id, laptop.id, "yes")).status).toBe(400);
    expect((await db.select().from(waveMembers).where(eq(waveMembers.waveId, a.id))).length).toBe(2);
  });
});
