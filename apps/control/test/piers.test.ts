import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { buildAuthorizationHeader, canonicalJson, generateKeyPair, verify } from "@wave/crypto";
import { type Netmap, Netmap as NetmapSchema, SignedNetmap } from "@wave/proto";
import { eq } from "drizzle-orm";
import { setPolicy } from "../src/acl/store.ts";
import { createApp } from "../src/app.ts";
import { listAudit } from "../src/audit.ts";
import { createProviders } from "../src/auth/providers.ts";
import type { Database } from "../src/db/client.ts";
import { nodes, users, waveMembers, wavePiers, waves } from "../src/db/schema.ts";
import { storeDnsCredential } from "../src/dns/credentials.ts";
import { buildNetmap, signNetmap } from "../src/netmap/build.ts";
import { createAuthKey } from "../src/waves/auth-keys.ts";
import { listNodes } from "../src/waves/nodes.ts";
import {
  pierLeaving,
  publishPierZone,
  unpublishLeavingPier,
  unpublishPierZone,
} from "../src/waves/pier-dns.ts";
import { clearPierHost, setPierAllowed, setPierHost } from "../src/waves/piers.ts";
import { syncServices } from "../src/waves/services.ts";
import { CookieJar, createTestDb, createWaveAs, testConfig, testSigningKey } from "./helpers.ts";

/**
 * The pier (D12): a name a device puts into the open network.
 *
 * Held to here: the two locks, the pier zone, the one wildcard record, and what
 * the netmap says to whom -- above all that a wave without piers signs exactly
 * the document it always did.
 */

const DNS_KEY = Buffer.alloc(32, 7);
const SUFFIX = "wave.example.com";
const ZONE = `pier.${SUFFIX}`;
const WILDCARD = `*.${ZONE}`;
const PIER_V4 = "203.0.113.10";
const PIER_V6 = "2001:db8::10";

let db: Database;
let close: () => Promise<void>;
let reset: () => Promise<void>;
let app: ReturnType<typeof createApp>;
let signingKey: ReturnType<typeof testSigningKey>;
let zone: FakeZone;

/** A Cloudflare zone that keeps its records, so what was written can be read back. */
class FakeZone {
  records = new Map<string, { type: string; name: string; content: string }>();
  calls: string[] = [];
  refuse = false;
  private next = 0;

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    this.calls.push(`${method} ${url.pathname}${url.search}`);
    const ok = (result: unknown) => Response.json({ success: true, errors: [], result });
    if (this.refuse) {
      return Response.json(
        { success: false, errors: [{ code: 1, message: "zone is locked" }] },
        { status: 403 },
      );
    }
    if (url.pathname === "/client/v4/zones") {
      const name = url.searchParams.get("name");
      return ok(name === SUFFIX ? [{ id: "z1", name }] : []);
    }
    if (url.pathname === "/client/v4/zones/z1/dns_records" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { type: string; name: string; content: string };
      const id = `r${++this.next}`;
      this.records.set(id, body);
      return ok({ id });
    }
    if (url.pathname === "/client/v4/zones/z1/dns_records") {
      const type = url.searchParams.get("type");
      const name = url.searchParams.get("name");
      return ok(
        [...this.records]
          .filter(([, record]) => record.type === type && record.name === name)
          .map(([id, record]) => ({ id, ...record })),
      );
    }
    if (method === "DELETE") {
      this.records.delete(url.pathname.split("/").pop() ?? "");
      return ok({});
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  at(name: string): string[] {
    return [...this.records.values()]
      .filter((record) => record.name === name)
      .map((record) => `${record.type} ${record.content}`)
      .sort();
  }
}

beforeAll(async () => {
  ({ db, close, reset } = await createTestDb());
});

afterAll(() => close());

beforeEach(async () => {
  await reset();
  zone = new FakeZone();
  const config = testConfig({ WAVE_DNS_SECRET: DNS_KEY.toString("base64") });
  signingKey = testSigningKey();
  app = createApp({ db, config, providers: createProviders(config), signingKey, dnsFetch: zone.fetch });
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
    body: method === "GET" || method === "DELETE" ? undefined : payload,
    headers: {
      "content-type": "application/json",
      authorization: buildAuthorizationHeader({
        machineKey: machine.machine.publicKey,
        machinePrivateKey: machine.machine.privateKey,
        method,
        path,
        body: method === "GET" || method === "DELETE" ? "" : payload,
      }),
    },
  });
};

/** A wave with a pier node, two devices, and a provider that writes the zone. */
async function home(options: { suffix?: string; provider?: "cloudflare" | "manual" | "none" } = {}) {
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
  await createWaveAs((path, init) => app.request(path, init), jar, email, {
    suffix: options.suffix ?? SUFFIX,
  });

  const [member] = await db.select().from(waveMembers).limit(1);
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!member || !user) throw new Error("no wave");
  const waveId = member.waveId;

  const key = await createAuthKey(db, { waveId, userId: user.id, reusable: true });
  const machines: Record<string, Machine> = {};
  for (const hostname of ["pier", "laptop", "nas"]) {
    machines[hostname] = makeMachine(hostname);
    await signed(machines[hostname] as Machine, "POST", "/v1/machine/register", {
      ...(machines[hostname] as Machine).body,
      authKey: key.token,
    });
  }
  const rows = await db.select().from(nodes);
  const node = (hostname: string) => {
    const found = rows.find((row) => row.hostname === hostname);
    if (!found) throw new Error(`${hostname} did not enrol`);
    return found;
  };

  const provider = options.provider ?? "cloudflare";
  if (provider === "cloudflare") {
    await storeDnsCredential(db, { waveId, provider, token: "token", key: DNS_KEY });
  } else if (provider === "manual") {
    await storeDnsCredential(db, { waveId, provider });
  }

  return {
    waveId,
    userId: user.id,
    pier: node("pier"),
    laptop: node("laptop"),
    nas: node("nas"),
    pierMachine: machines.pier as Machine,
    laptopMachine: machines.laptop as Machine,
    nasMachine: machines.nas as Machine,
  };
}

type Home = Awaited<ReturnType<typeof home>>;

/** The pier made, and the laptop allowed to use it: both locks open. */
async function open(wave: Home) {
  const host = await setPierHost(db, {
    waveId: wave.waveId,
    nodeId: wave.pier.id,
    ipv4: PIER_V4,
    ipv6: PIER_V6,
  });
  if (!("host" in host)) throw new Error("no pier");
  await setPierAllowed(db, wave.waveId, wave.laptop.id, true);
}

const expose = (wave: Home, name: string, port = 8443, as: Machine = wave.laptopMachine) =>
  signed(as, "POST", "/v1/piers", { name, port });

const netmapOf = async (nodeId: string): Promise<Netmap> => {
  const netmap = await buildNetmap(db, nodeId);
  if (!netmap) throw new Error("no netmap");
  return netmap;
};

const versionOf = async (waveId: string) =>
  (await db.select().from(waves).where(eq(waves.id, waveId)))[0]?.netmapVersion;

describe("the first lock: the operator", () => {
  test("a device the operator has not allowed gets a clear refusal", async () => {
    const wave = await home();
    await setPierHost(db, { waveId: wave.waveId, nodeId: wave.pier.id, ipv4: PIER_V4 });

    const res = await expose(wave, "app");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("admin.ts allow-pier");
    expect(await db.select().from(wavePiers)).toEqual([]);
  });

  test("the default is off for every device", async () => {
    const wave = await home();
    expect(wave.laptop.pierAllowed).toBe(false);
  });

  test("taking the permission back takes the names back", async () => {
    const wave = await home();
    await open(wave);
    await expose(wave, "app");
    await expose(wave, "git", 9443);

    const before = await versionOf(wave.waveId);
    const denied = await setPierAllowed(db, wave.waveId, wave.laptop.id, false);
    expect(denied?.taken.map((pier) => pier.name).sort()).toEqual(["app", "git"]);
    expect(await versionOf(wave.waveId)).toBe((before ?? 0) + 1);

    expect((await expose(wave, "app")).status).toBe(403);
    expect(await db.select().from(wavePiers)).toEqual([]);
  });
});

describe("claiming a name", () => {
  test("is one name under the pier zone, and nothing from elsewhere", async () => {
    const wave = await home();
    await open(wave);

    expect((await expose(wave, "app.elsewhere.example")).status).toBe(400);
    expect((await expose(wave, "")).status).toBe(400);
    expect((await expose(wave, "-bad-")).status).toBe(400);
    // Under the wave's suffix but not under the pier zone: the wildcard would
    // not cover it, so it is not a name the pier could serve.
    expect((await expose(wave, `app.${SUFFIX}`)).status).toBe(400);
    expect((await expose(wave, `a.b.${ZONE}`)).status).toBe(400);
    // What the internet and a CA are offered: one DNS label at most, and no
    // punycode -- the way a look-alike of someone else's name would get in.
    expect((await expose(wave, "a".repeat(64))).status).toBe(400);
    expect((await expose(wave, "xn--pypal-4ve")).status).toBe(400);
    expect((await expose(wave, "ab--cd")).status).toBe(400);
    expect((await expose(wave, "a".repeat(63))).status).toBe(200);
    // Fully qualified under the pier zone is the same name as the bare label.
    const res = await expose(wave, `App.${ZONE}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "app", dnsName: `app.${ZONE}`, port: 8443 });
  });

  test("a name to take back that is not one is a 400, not a 500", async () => {
    const wave = await home();
    await open(wave);
    expect((await signed(wave.laptopMachine, "DELETE", "/v1/piers/%E0")).status).toBe(400);
    expect((await signed(wave.laptopMachine, "DELETE", "/v1/piers/a%20b")).status).toBe(400);
  });

  test("a claim without the permission behind it is not in any netmap", async () => {
    const wave = await home();
    await open(wave);
    await expose(wave, "app");
    // As if a claim had outlived its permission: the netmap checks once more.
    await db.update(nodes).set({ pierAllowed: false }).where(eq(nodes.id, wave.laptop.id));
    expect((await netmapOf(wave.pier.id)).piers).toBeUndefined();
  });

  test("needs a port that is one", async () => {
    const wave = await home();
    await open(wave);
    expect((await expose(wave, "app", 0)).status).toBe(400);
    expect((await expose(wave, "app", 70000)).status).toBe(400);
  });

  test("a wave that is still on its placeholder domain cannot be reached from outside", async () => {
    const wave = await home({ suffix: "robin.wave.internal" });
    // `set-pier` refuses such a wave already; a pier set before the domain
    // went back to a placeholder must not be a way around it.
    await db.update(nodes).set({ pierIpv4: PIER_V4 }).where(eq(nodes.id, wave.pier.id));
    await setPierAllowed(db, wave.waveId, wave.laptop.id, true);
    const res = await expose(wave, "app");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("placeholder");
  });

  test("a wave without a pier says so", async () => {
    const wave = await home();
    await setPierAllowed(db, wave.waveId, wave.laptop.id, true);
    const res = await expose(wave, "app");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("set-pier");
  });

  test("has a namespace of its own: device and service names are free in it", async () => {
    const wave = await home();
    await open(wave);
    await syncServices(db, { waveId: wave.waveId, viaNodeId: wave.nas.id, names: ["grafana"] });
    expect((await expose(wave, "laptop", 443)).status).toBe(200);
    expect((await expose(wave, "nas")).status).toBe(200);
    expect((await expose(wave, "grafana")).status).toBe(200);
  });

  test("a name another device has put out is taken", async () => {
    const wave = await home();
    await open(wave);
    await setPierAllowed(db, wave.waveId, wave.nas.id, true);
    expect((await expose(wave, "app")).status).toBe(200);
    expect((await expose(wave, "app", 8443, wave.nasMachine)).status).toBe(409);
  });

  test("a service may carry a label that is put out: they are different names", async () => {
    const wave = await home();
    await open(wave);
    await expose(wave, "app");
    const synced = await syncServices(db, { waveId: wave.waveId, viaNodeId: wave.nas.id, names: ["app"] });
    expect("conflict" in synced).toBe(false);
  });

  test("changing the port is a change, saying the same again is none", async () => {
    const wave = await home();
    await open(wave);
    await expose(wave, "app", 8443);
    const v1 = await versionOf(wave.waveId);

    await expose(wave, "app", 8443);
    expect(await versionOf(wave.waveId)).toBe(v1);

    const res = await expose(wave, "app", 9000);
    expect(res.status).toBe(200);
    expect(await versionOf(wave.waveId)).toBe((v1 ?? 0) + 1);
    expect((await db.select().from(wavePiers))[0]?.port).toBe(9000);
  });

  test("is written into the audit log", async () => {
    const wave = await home();
    await open(wave);
    await expose(wave, "app");
    await signed(wave.laptopMachine, "DELETE", "/v1/piers/app");

    const actions = (await listAudit(db, wave.waveId)).map((entry) => `${entry.action} ${entry.target}`);
    expect(actions).toContain(`pier.expose app.${ZONE}`);
    expect(actions).toContain(`pier.unexpose app.${ZONE}`);
  });
});

describe("the public record", () => {
  const dns = () => ({ db, dnsSecret: DNS_KEY, http: zone.fetch });
  const host = { publicIpv4: PIER_V4, publicIpv6: PIER_V6 };

  test("is one wildcard for the zone, pointing at the pier and never at a wave address", async () => {
    const wave = await home();
    await open(wave);
    const outcome = await publishPierZone(dns(), { waveId: wave.waveId, zone: ZONE, host });

    expect(outcome.state).toBe("published");
    expect(zone.at(WILDCARD)).toEqual([`A ${PIER_V4}`, `AAAA ${PIER_V6}`]);
    for (const record of zone.records.values()) {
      expect([wave.laptop.ipv4, wave.laptop.ipv6]).not.toContain(record.content);
    }
  });

  test("a claim writes nothing to DNS, and ending one removes nothing", async () => {
    const wave = await home();
    await open(wave);
    await expose(wave, "app");
    await signed(wave.laptopMachine, "DELETE", "/v1/piers/app");
    expect(zone.calls).toEqual([]);
  });

  test("writing it again does not pile records up", async () => {
    const wave = await home();
    await publishPierZone(dns(), { waveId: wave.waveId, zone: ZONE, host });
    await publishPierZone(dns(), { waveId: wave.waveId, zone: ZONE, host });
    expect(zone.at(WILDCARD)).toEqual([`A ${PIER_V4}`, `AAAA ${PIER_V6}`]);
  });

  test("a pier that moves leaves no old address behind", async () => {
    const wave = await home();
    await publishPierZone(dns(), { waveId: wave.waveId, zone: ZONE, host });
    await publishPierZone(dns(), {
      waveId: wave.waveId,
      zone: ZONE,
      host: { publicIpv4: "198.51.100.7", publicIpv6: null },
    });
    // IPv4 replaced; the IPv6 the pier no longer has is gone, not left to
    // send half of the clients to the old address.
    expect(zone.at(WILDCARD)).toEqual(["A 198.51.100.7"]);
  });

  test("ending the pier removes it", async () => {
    const wave = await home();
    await publishPierZone(dns(), { waveId: wave.waveId, zone: ZONE, host });
    const outcome = await unpublishPierZone(dns(), { waveId: wave.waveId, zone: ZONE, host });
    expect(outcome.state).toBe("published");
    expect(zone.at(WILDCARD)).toEqual([]);
  });

  test("removing the pier node takes the wildcard with it, removing another device does not", async () => {
    const wave = await home();
    await open(wave);
    await publishPierZone(dns(), { waveId: wave.waveId, zone: ZONE, host });

    expect(await pierLeaving(db, { waveId: wave.waveId, leaving: { nodeId: wave.laptop.id } })).toBeNull();
    expect(await unpublishLeavingPier(dns(), null)).toBeNull();
    expect(zone.at(WILDCARD)).toHaveLength(2);

    const pier = await pierLeaving(db, { waveId: wave.waveId, leaving: { nodeId: wave.pier.id } });
    expect(pier).toEqual({ waveId: wave.waveId, zone: ZONE, host });
    const gone = await unpublishLeavingPier(dns(), pier);
    expect(gone?.name).toBe(WILDCARD);
    expect(zone.at(WILDCARD)).toEqual([]);
  });

  test("the pier's member and the whole wave going count as the pier going", async () => {
    const wave = await home();
    await open(wave);
    expect(await pierLeaving(db, { waveId: wave.waveId, leaving: { userId: wave.userId } })).not.toBeNull();
    expect(await pierLeaving(db, { waveId: wave.waveId, leaving: { userId: "someone-else" } })).toBeNull();
    expect(await pierLeaving(db, { waveId: wave.waveId, leaving: { wholeWave: true } })).not.toBeNull();
  });

  test("the pier logging itself out takes the wildcard away", async () => {
    const wave = await home();
    await open(wave);
    await publishPierZone(dns(), { waveId: wave.waveId, zone: ZONE, host });
    expect(zone.at(WILDCARD)).toHaveLength(2);

    expect((await signed(wave.laptopMachine, "POST", "/v1/node/logout", {})).status).toBe(200);
    expect(zone.at(WILDCARD)).toHaveLength(2);

    expect((await signed(wave.pierMachine, "POST", "/v1/node/logout", {})).status).toBe(200);
    expect(zone.at(WILDCARD)).toEqual([]);
  });

  test("a wave that writes its zone by hand is told which record to create", async () => {
    const wave = await home({ provider: "manual" });
    const outcome = await publishPierZone(dns(), { waveId: wave.waveId, zone: ZONE, host });
    expect(outcome.state).toBe("manual");
    expect(outcome.records).toEqual([
      { type: "A", name: WILDCARD, value: PIER_V4 },
      { type: "AAAA", name: WILDCARD, value: PIER_V6 },
    ]);
    expect(zone.calls).toEqual([]);
  });

  test("a wave with no DNS credential gets the same request, and says why nothing was written", async () => {
    const wave = await home({ provider: "none" });
    const outcome = await publishPierZone(dns(), { waveId: wave.waveId, zone: ZONE, host });
    expect(outcome.state).toBe("unconfigured");
    expect(outcome.records).toHaveLength(2);
  });

  test("a provider that refuses says so", async () => {
    const wave = await home();
    zone.refuse = true;
    const outcome = await publishPierZone(dns(), { waveId: wave.waveId, zone: ZONE, host });
    expect(outcome.state).toBe("failed");
    expect(outcome.error).toContain("zone is locked");
  });

  test("only the device that put a name out can end it", async () => {
    const wave = await home();
    await open(wave);
    await expose(wave, "app");
    expect((await signed(wave.nasMachine, "DELETE", "/v1/piers/app")).status).toBe(404);
    expect((await db.select().from(wavePiers)).length).toBe(1);
    expect((await signed(wave.laptopMachine, "DELETE", "/v1/piers/app")).status).toBe(200);
    expect((await signed(wave.laptopMachine, "DELETE", "/v1/piers/app")).status).toBe(404);
  });
});

describe("one pier per wave", () => {
  test("a second node cannot be the pier as well", async () => {
    const wave = await home();
    await open(wave);
    const second = await setPierHost(db, { waveId: wave.waveId, nodeId: wave.nas.id, ipv4: "198.51.100.1" });
    expect("conflict" in second).toBe(true);
  });

  test("a pier needs an address, and one that is the kind it says", async () => {
    const wave = await home();
    expect("invalid" in (await setPierHost(db, { waveId: wave.waveId, nodeId: wave.pier.id }))).toBe(true);
    expect(
      "invalid" in
        (await setPierHost(db, { waveId: wave.waveId, nodeId: wave.pier.id, ipv4: "2001:db8::1" })),
    ).toBe(true);
    expect(
      "invalid" in
        (await setPierHost(db, { waveId: wave.waveId, nodeId: wave.pier.id, ipv6: "203.0.113.1" })),
    ).toBe(true);
  });

  test("clearing it leaves the names, and the netmaps lose the pier zone", async () => {
    const wave = await home();
    await open(wave);
    await expose(wave, "app");
    expect((await netmapOf(wave.laptop.id)).pier).toEqual({
      nodeId: wave.pier.id,
      zone: ZONE,
    } as Netmap["pier"]);

    const cleared = await clearPierHost(db, wave.waveId);
    expect(cleared?.zone).toBe(ZONE);
    expect((await db.select().from(wavePiers)).length).toBe(1);
    expect("pier" in (await netmapOf(wave.laptop.id))).toBe(false);
    expect("pier" in (await netmapOf(wave.pier.id))).toBe(false);
    // The name still resolves inside the wave: it is the owner's either way.
    expect((await netmapOf(wave.nas.id)).piers?.map((pier) => pier.dnsName)).toEqual([`app.${ZONE}`]);
  });

  test("the zone has a label of its own, and it moves only while nobody holds a name in it", async () => {
    const wave = await home();
    await open(wave);
    const moved = await setPierHost(db, {
      waveId: wave.waveId,
      nodeId: wave.pier.id,
      ipv4: PIER_V4,
      label: "Pub",
    });
    expect(moved).toMatchObject({ zone: `pub.${SUFFIX}`, previousZone: ZONE });
    expect((await (await expose(wave, "app")).json()) as unknown).toMatchObject({
      dnsName: `app.pub.${SUFFIX}`,
    });

    const again = await setPierHost(db, {
      waveId: wave.waveId,
      nodeId: wave.pier.id,
      ipv4: PIER_V4,
      label: "pier",
    });
    expect("conflict" in again && again.conflict).toContain(`app.pub.${SUFFIX}`);
    // The same label is no move.
    const same = await setPierHost(db, {
      waveId: wave.waveId,
      nodeId: wave.pier.id,
      ipv4: PIER_V4,
      label: "pub",
    });
    expect(same).toMatchObject({ zone: `pub.${SUFFIX}`, previousZone: null });

    expect(
      "invalid" in
        (await setPierHost(db, { waveId: wave.waveId, nodeId: wave.pier.id, ipv4: PIER_V4, label: "a.b" })),
    ).toBe(true);
  });

  test("a wave on its placeholder domain cannot have a pier", async () => {
    const wave = await home({ suffix: "robin.wave.internal" });
    const set = await setPierHost(db, { waveId: wave.waveId, nodeId: wave.pier.id, ipv4: PIER_V4 });
    expect("invalid" in set && set.invalid).toContain("placeholder");
  });
});

describe("what the netmap says", () => {
  test("the pier gets every name and the address of its target, in the target's allowed IPs", async () => {
    const wave = await home();
    await open(wave);
    await expose(wave, "app", 8443);

    const netmap = await netmapOf(wave.pier.id);
    expect(netmap.piers).toEqual([
      {
        name: "app",
        dnsName: `app.${ZONE}`,
        nodeId: wave.laptop.id,
        ipv4: wave.laptop.ipv4,
        ipv6: wave.laptop.ipv6,
        port: 8443,
      },
    ] as Netmap["piers"]);
    const target = netmap.peers.find((peer) => peer.id === wave.laptop.id);
    expect(target?.allowedIps).toContain(`${wave.laptop.ipv4}/32`);
  });

  test("the owner gets its own names, and the pier as a peer", async () => {
    const wave = await home();
    await open(wave);
    await expose(wave, "app");

    const netmap = await netmapOf(wave.laptop.id);
    expect(netmap.piers?.map((pier) => pier.name)).toEqual(["app"]);
    expect(netmap.peers.map((peer) => peer.id as string)).toContain(wave.pier.id);
  });

  test("every other device is told too, with the owner's wave address, for its resolver", async () => {
    const wave = await home();
    await open(wave);
    await expose(wave, "app");
    const netmap = await netmapOf(wave.nas.id);
    expect(netmap.piers?.map(({ dnsName, ipv4, ipv6 }) => ({ dnsName, ipv4, ipv6 }))).toEqual([
      { dnsName: `app.${ZONE}`, ipv4: wave.laptop.ipv4, ipv6: wave.laptop.ipv6 },
    ]);
    expect(netmap.pier).toEqual({ nodeId: wave.pier.id, zone: ZONE } as Netmap["pier"]);
  });

  test("devices that own names see each other's", async () => {
    const wave = await home();
    await open(wave);
    await setPierAllowed(db, wave.waveId, wave.nas.id, true);
    await expose(wave, "app");
    await expose(wave, "files", 445, wave.nasMachine);

    expect((await netmapOf(wave.laptop.id)).piers?.map((pier) => pier.name)).toEqual(["app", "files"]);
    expect((await netmapOf(wave.nas.id)).piers?.map((pier) => pier.name)).toEqual(["app", "files"]);
    expect((await netmapOf(wave.pier.id)).piers?.map((pier) => pier.name)).toEqual(["app", "files"]);
  });

  test("a wave that never heard of piers signs the document it always did", async () => {
    const wave = await home();
    const netmap = await netmapOf(wave.laptop.id);
    expect("piers" in netmap).toBe(false);
    expect("pier" in netmap).toBe(false);

    const signedMap = signNetmap(netmap, signingKey);
    // What a client does: parse, then canonicalise what came out.
    const parsed = SignedNetmap.parse(JSON.parse(JSON.stringify(signedMap)));
    expect(canonicalJson(parsed.netmap)).toBe(canonicalJson(netmap));
    expect(verify(parsed.keyId, canonicalJson(parsed.netmap), parsed.signature)).toBe(true);
  });

  test("a netmap with piers verifies after the round trip too", async () => {
    const wave = await home();
    await open(wave);
    await expose(wave, "app");

    for (const id of [wave.pier.id, wave.laptop.id]) {
      const netmap = await netmapOf(id);
      const parsed = SignedNetmap.parse(JSON.parse(JSON.stringify(signNetmap(netmap, signingKey))));
      expect(canonicalJson(parsed.netmap)).toBe(canonicalJson(netmap));
      expect(verify(parsed.keyId, canonicalJson(parsed.netmap), parsed.signature)).toBe(true);
    }
  });

  // Version skew in the other direction: a client from before piers parses the
  // netmap with a schema that has never heard of the field, and `looseObject`
  // keeps it, so the canonical form still matches what was signed.
  test("a reader that does not know piers keeps them, so the signature still holds", async () => {
    const wave = await home();
    await open(wave);
    await expose(wave, "app");
    const netmap = await netmapOf(wave.pier.id);

    const { piers: _dropped, pier: _zone, ...withoutField } = NetmapSchema.shape;
    const old = (await import("zod")).z.looseObject(withoutField);
    const parsed = old.parse(JSON.parse(JSON.stringify(netmap)));
    expect(canonicalJson(parsed)).toBe(canonicalJson(netmap));
  });

  test("a device that is not approved has no names in anybody's netmap", async () => {
    const wave = await home();
    await open(wave);
    await expose(wave, "app");
    await db.update(nodes).set({ approved: false }).where(eq(nodes.id, wave.laptop.id));
    expect("piers" in (await netmapOf(wave.pier.id))).toBe(false);
  });

  describe("under a policy", () => {
    test("the claim is the grant: pier and device see each other, for that port only", async () => {
      const wave = await home();
      await open(wave);
      // Default deny: nobody reaches anybody.
      await setPolicy(db, wave.waveId, { acls: [] }, null);
      await expose(wave, "app", 8443);

      const pier = await netmapOf(wave.pier.id);
      expect(pier.peers.map((peer) => peer.id as string)).toEqual([wave.laptop.id]);

      const laptop = await netmapOf(wave.laptop.id);
      expect(laptop.peers.map((peer) => peer.id as string)).toEqual([wave.pier.id]);
      expect(laptop.packetFilter).toEqual([
        {
          src: [`${wave.pier.ipv4}/32`, `${wave.pier.ipv6}/128`],
          dst: [`${wave.laptop.ipv4}/32`, `${wave.laptop.ipv6}/128`],
          ports: [{ proto: "tcp", from: 8443, to: 8443 }],
        },
      ]);

      // The one who owns nothing is not pulled in by it, nor told a name
      // whose owner it may not reach.
      const nas = await netmapOf(wave.nas.id);
      expect(nas.peers).toEqual([]);
      expect(nas.packetFilter).toEqual([]);
      expect("piers" in nas).toBe(false);
    });

    test("without a policy nothing is added to the filter", async () => {
      const wave = await home();
      await open(wave);
      await expose(wave, "app");
      expect("packetFilter" in (await netmapOf(wave.laptop.id))).toBe(false);
    });
  });
});

describe("listing", () => {
  test("a device is told whether it may, where the pier is, and what it has put out", async () => {
    const wave = await home();
    await open(wave);
    await expose(wave, "app", 8443);

    const body = (await (await signed(wave.laptopMachine, "GET", "/v1/piers")).json()) as {
      allowed: boolean;
      zone: string;
      pier: { publicIpv4: string | null; publicIpv6: string | null } | null;
      piers: { name: string; dnsName: string; port: number }[];
    };
    expect(body.allowed).toBe(true);
    expect(body.zone).toBe(ZONE);
    expect(body.pier).toEqual({ publicIpv4: PIER_V4, publicIpv6: PIER_V6 });
    expect(body.piers).toEqual([{ name: "app", dnsName: `app.${ZONE}`, port: 8443 }]);

    const nas = (await (await signed(wave.nasMachine, "GET", "/v1/piers")).json()) as {
      allowed: boolean;
      piers: unknown[];
    };
    expect(nas.allowed).toBe(false);
    expect(nas.piers).toEqual([]);
  });

  test("an unsigned request is refused", async () => {
    await home();
    expect((await app.request("/v1/piers", { method: "GET" })).status).toBe(401);
    expect((await app.request("/v1/piers", { method: "POST", body: "{}" })).status).toBe(401);
  });
});

describe("the device list", () => {
  test("shows who may use the pier and which node is it", async () => {
    const wave = await home();
    await open(wave);
    const devices = await listNodes(db, wave.waveId);
    const byName = (hostname: string) => devices.find((device) => device.hostname === hostname);

    expect(byName("laptop")?.pierAllowed).toBe(true);
    expect(byName("nas")?.pierAllowed).toBe(false);
    expect(byName("pier")?.pierIpv4).toBe(PIER_V4);
    expect(byName("pier")?.pierIpv6).toBe(PIER_V6);
    expect(byName("laptop")?.pierIpv4).toBeNull();
  });
});
