import { beforeEach, describe, expect, test } from "bun:test";
import { buildAuthorizationHeader, generateKeyPair } from "@wave/crypto";
import type { AclPolicy, Netmap } from "@wave/proto";
import { eq } from "drizzle-orm";
import { describeEnforcement, describeReach } from "../src/acl/describe.ts";
import { type AclNode, type AclService, compilePolicy, visibleTo } from "../src/acl/evaluate.ts";
import { previewPolicy } from "../src/acl/preview.ts";
import { invalidTags, removePolicy, setPolicy, setTags } from "../src/acl/store.ts";
import { checkPolicy } from "../src/acl/validate.ts";
import { createApp } from "../src/app.ts";
import { audit, shellActor } from "../src/audit.ts";
import { createProviders } from "../src/auth/providers.ts";
import type { Database } from "../src/db/client.ts";
import { nodes, users, waveMembers, waves } from "../src/db/schema.ts";
import { buildNetmap } from "../src/netmap/build.ts";
import { createAuthKey } from "../src/waves/auth-keys.ts";
import { addMember } from "../src/waves/members.ts";
import { syncServices } from "../src/waves/services.ts";
import { CookieJar, createTestDb, createWaveAs, testConfig, testSigningKey } from "./helpers.ts";

/**
 * ACLs, stage one (M7): who may see whom is decided by what goes into each
 * node's netmap. A peer left out is not a WireGuard peer, and that is the
 * protection -- so these tests read netmaps, not a policy engine's opinion.
 */

const robin = (id: string, role: AclNode["role"] = "owner"): AclNode => ({
  id,
  email: "robin@example.com",
  role,
  tags: [],
});
const tagged = (id: string, ...tags: string[]): AclNode => ({
  id,
  email: "robin@example.com",
  role: "owner",
  tags,
});

describe("evaluating a policy", () => {
  const laptop = robin("laptop");
  const phone = robin("phone");
  const nas = tagged("nas", "tag:nas");
  const connector = tagged("connector", "tag:connector");
  const services: AclService[] = [{ name: "grafana", viaNodeId: "connector" }];
  const all = [laptop, phone, nas, connector];

  test("a grant makes both ends visible to each other, and nobody else", () => {
    const policy: AclPolicy = {
      acls: [{ src: ["user:robin@example.com"], dst: ["tag:nas"], ports: ["445"] }],
    };
    const compiled = compilePolicy(policy, all, services);

    expect([...visibleTo(compiled, "laptop", services).peers].sort()).toEqual(["nas"]);
    // The NAS has to know the laptop, or it could not answer.
    expect([...visibleTo(compiled, "nas", services).peers].sort()).toEqual(["laptop", "phone"]);
    expect([...visibleTo(compiled, "connector", services).peers]).toEqual([]);
  });

  test("a tagged device is not its owner's", () => {
    // The connector was enrolled with robin's key. A rule for robin's devices
    // that included it would hand a cluster everything robin may reach.
    const policy: AclPolicy = {
      acls: [{ src: ["user:robin@example.com"], dst: ["user:robin@example.com"] }],
    };
    const compiled = compilePolicy(policy, all, services);
    expect([...visibleTo(compiled, "laptop", services).peers]).toEqual(["phone"]);
    expect([...visibleTo(compiled, "connector", services).peers]).toEqual([]);
  });

  test("a service brings its connector along, and the connector its callers", () => {
    const policy: AclPolicy = { acls: [{ src: ["user:robin@example.com"], dst: ["svc:grafana"] }] };
    const compiled = compilePolicy(policy, all, services);

    const fromLaptop = visibleTo(compiled, "laptop", services);
    expect([...fromLaptop.services]).toEqual(["grafana"]);
    expect([...fromLaptop.peers]).toEqual(["connector"]);
    expect([...visibleTo(compiled, "connector", services).peers].sort()).toEqual(["laptop", "phone"]);
    expect([...visibleTo(compiled, "nas", services).services]).toEqual([]);
  });

  test("* covers every device and every service", () => {
    const compiled = compilePolicy({ acls: [{ src: ["*"], dst: ["*"] }] }, all, services);
    expect(visibleTo(compiled, "nas", services).peers.size).toBe(3);
    expect([...visibleTo(compiled, "nas", services).services]).toEqual(["grafana"]);
  });

  test("groups and roles resolve to their members' devices", () => {
    const guest: AclNode = { id: "guest", email: "guest@example.com", role: "member", tags: [] };
    const policy: AclPolicy = {
      groups: { "group:family": ["Guest@Example.com"] },
      acls: [
        { src: ["group:family"], dst: ["tag:nas"] },
        { src: ["role:owner"], dst: ["group:family"] },
      ],
    };
    const compiled = compilePolicy(policy, [...all, guest], services);
    expect([...visibleTo(compiled, "guest", services).peers].sort()).toEqual(["laptop", "nas", "phone"]);
  });

  test("an empty policy is a wave where nobody sees anybody", () => {
    const compiled = compilePolicy({ acls: [] }, all, services);
    for (const node of all) expect(visibleTo(compiled, node.id, services).peers.size).toBe(0);
    // Except its own services: a connector fronts them whoever may reach them.
    expect([...visibleTo(compiled, "connector", services).services]).toEqual(["grafana"]);
  });
});

describe("saying who reaches whom", () => {
  test("one line per device, ports folded, and nothing said as nothing", () => {
    const nodes = [
      { ...robin("laptop"), hostname: "laptop" },
      { ...tagged("nas", "tag:nas"), hostname: "nas" },
    ];
    const compiled = compilePolicy(
      { acls: [{ src: ["user:robin@example.com"], dst: ["tag:nas"], ports: ["445", "tcp:5000-5001"] }] },
      nodes,
      [],
    );
    expect(describeReach(compiled, nodes)).toEqual([
      "  laptop        -> nas (445, tcp:5000-5001)",
      "  nas [tag:nas] -> nothing",
    ]);
  });
});

describe("saying who holds the ports", () => {
  test("names those that do not, and why, and tells never-said from said-no", () => {
    expect(
      describeEnforcement([
        { hostname: "laptop", filterEnforced: true, filterReason: null },
        { hostname: "mac", filterEnforced: false, filterReason: "ports are not enforced on macOS yet" },
        { hostname: "old", filterEnforced: null, filterReason: null },
      ]),
    ).toEqual([
      "  mac: ports NOT enforced (ports are not enforced on macOS yet)",
      "  old: ports not reported (a client too old to enforce them)",
    ]);
  });
});

describe("tags", () => {
  test("look like tag:<name>, and nothing else does", () => {
    expect(invalidTags(["tag:nas", "tag:k8s-connector"])).toEqual([]);
    expect(invalidTags(["nas", "tag:", "tag:NAS", "tag:a b"])).toEqual(["nas", "tag:", "tag:NAS", "tag:a b"]);
  });
});

describe("checking a policy", () => {
  const subjects = {
    nodes: [robin("laptop"), tagged("nas", "tag:nas")],
    services: [{ name: "grafana", viaNodeId: "connector" }],
  };

  test("takes a good one and says what it points at that is not there yet", () => {
    const check = checkPolicy(
      {
        acls: [
          { src: ["user:someone@example.com"], dst: ["tag:printer", "svc:grafana"], ports: ["tcp:631"] },
        ],
      },
      subjects,
    );
    expect(check.errors).toEqual([]);
    expect(check.policy).not.toBeNull();
    expect(check.warnings.sort()).toEqual([
      "no device wears tag:printer (yet)",
      "user:someone@example.com has no untagged device in this wave (yet)",
    ]);
  });

  test("refuses selectors, ports and groups it cannot mean", () => {
    expect(checkPolicy({ acls: [{ src: ["laptop"], dst: ["*"] }] }, subjects).policy).toBeNull();
    expect(checkPolicy({ acls: [{ src: ["*"], dst: ["*"], ports: ["70000"] }] }, subjects).policy).toBeNull();
    expect(checkPolicy({ acls: [{ src: ["*"], dst: ["*"], ports: ["20-10"] }] }, subjects).policy).toBeNull();
    const undefinedGroup = checkPolicy({ acls: [{ src: ["group:ghosts"], dst: ["*"] }] }, subjects);
    expect(undefinedGroup.errors).toEqual(["acls.0: group:ghosts is not defined under groups"]);
  });

  test("refuses a service as a source", () => {
    const check = checkPolicy({ acls: [{ src: ["svc:grafana"], dst: ["*"] }] }, subjects);
    expect(check.policy).toBeNull();
    expect(check.errors[0]).toContain("never a source");
  });
});

describe("the netmap under a policy", () => {
  let db: Database;
  let close: () => Promise<void>;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    if (close) await close();
    ({ db, close } = await createTestDb());
    const config = testConfig();
    app = createApp({ db, config, providers: createProviders(config), signingKey: testSigningKey() });
  });

  const machine = (hostname: string) => {
    const keys = generateKeyPair("ed25519");
    return {
      keys,
      body: {
        machineKey: keys.publicKey,
        nodeKey: generateKeyPair("x25519").publicKey,
        discoKey: generateKeyPair("x25519").publicKey,
        hostname,
        os: "linux" as const,
      },
    };
  };

  /** A wave with a laptop, a NAS and a connector fronting grafana. */
  async function home() {
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
    await createWaveAs((path, init) => app.request(path, init), jar, email);
    const [member] = await db.select().from(waveMembers).limit(1);
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!member || !user) throw new Error("no wave");

    const key = await createAuthKey(db, { waveId: member.waveId, userId: user.id, reusable: true });
    for (const hostname of ["laptop", "nas", "connector"]) {
      const m = machine(hostname);
      const payload = JSON.stringify({ ...m.body, authKey: key.token });
      await app.request("/v1/machine/register", {
        method: "POST",
        body: payload,
        headers: {
          "content-type": "application/json",
          authorization: buildAuthorizationHeader({
            machineKey: m.keys.publicKey,
            machinePrivateKey: m.keys.privateKey,
            method: "POST",
            path: "/v1/machine/register",
            body: payload,
          }),
        },
      });
    }
    const rows = await db.select().from(nodes);
    const id = (hostname: string) => {
      const found = rows.find((row) => row.hostname === hostname);
      if (!found) throw new Error(`${hostname} did not enrol`);
      return found.id;
    };
    const ids = { laptop: id("laptop"), nas: id("nas"), connector: id("connector") };
    await syncServices(db, { waveId: member.waveId, viaNodeId: ids.connector, names: ["grafana"] });
    await setTags(db, member.waveId, ids.nas, ["tag:nas"]);
    await setTags(db, member.waveId, ids.connector, ["tag:connector"]);
    return { waveId: member.waveId, ...ids };
  }

  const netmapOf = async (nodeId: string): Promise<Netmap> => {
    const netmap = await buildNetmap(db, nodeId);
    if (!netmap) throw new Error("no netmap");
    return netmap;
  };
  const peersOf = (netmap: Netmap) => netmap.peers.map((peer) => peer.hostname).sort();

  test("without a policy, everybody sees everybody", async () => {
    const wave = await home();
    expect(peersOf(await netmapOf(wave.laptop))).toEqual(["connector", "nas"]);
    expect(peersOf(await netmapOf(wave.nas))).toEqual(["connector", "laptop"]);
  });

  test("the connector does not see the NAS, and nothing reaches past what was granted", async () => {
    const wave = await home();
    await setPolicy(
      db,
      wave.waveId,
      {
        acls: [
          { src: ["user:robin@example.com"], dst: ["tag:nas"], ports: ["445"] },
          { src: ["user:robin@example.com"], dst: ["svc:grafana"] },
        ],
      },
      null,
    );

    const laptop = await netmapOf(wave.laptop);
    expect(peersOf(laptop)).toEqual(["connector", "nas"]);
    expect(laptop.services?.map((service) => service.name)).toEqual(["grafana"]);

    // The whole point of the scan that started this: the machine in the
    // cluster has no way to the NAS, not even a route.
    const connector = await netmapOf(wave.connector);
    expect(peersOf(connector)).toEqual(["laptop"]);
    expect(peersOf(await netmapOf(wave.nas))).toEqual(["laptop"]);

    // A connector still answers for everything it fronts.
    const grafana = laptop.services?.[0];
    expect(connector.self.addresses).toContain(`${grafana?.ipv4}/32`);
  });

  test("a service left out is neither resolved nor routed, although its connector is a peer", async () => {
    const wave = await home();
    await syncServices(db, { waveId: wave.waveId, viaNodeId: wave.connector, names: ["grafana", "vault"] });
    await setPolicy(
      db,
      wave.waveId,
      { acls: [{ src: ["user:robin@example.com"], dst: ["svc:grafana"] }] },
      null,
    );

    const laptop = await netmapOf(wave.laptop);
    expect(laptop.services?.map((service) => service.name)).toEqual(["grafana"]);
    const connector = laptop.peers.find((peer) => peer.hostname === "connector");
    const all = (await netmapOf(wave.connector)).self.addresses;
    const vault = all.filter((address) => !connector?.allowedIps.includes(address));
    // Two addresses the laptop's netmap does not route: vault's IPv4 and IPv6.
    expect(vault).toHaveLength(2);
  });

  test("every change moves the netmap, and removing the policy brings the mesh back", async () => {
    const wave = await home();
    const version = async () =>
      (await db.select({ v: waves.netmapVersion }).from(waves).where(eq(waves.id, wave.waveId)))[0]?.v ?? 0;

    const before = await version();
    await setPolicy(db, wave.waveId, { acls: [] }, null);
    expect(await version()).toBe(before + 1);
    expect(peersOf(await netmapOf(wave.laptop))).toEqual([]);

    expect(await removePolicy(db, wave.waveId)).toBe(true);
    expect(await version()).toBe(before + 2);
    expect(peersOf(await netmapOf(wave.laptop))).toEqual(["connector", "nas"]);
  });
});

describe("previewing a draft", () => {
  const subjects = {
    nodes: [
      { ...robin("laptop"), hostname: "laptop" },
      { ...robin("phone"), hostname: "phone" },
      { ...tagged("nas", "tag:nas"), hostname: "nas" },
    ],
    services: [{ name: "grafana", viaNodeId: "nas" }],
  };

  test("draft tags change what a selector covers and who reaches whom", () => {
    const policy = { acls: [{ src: ["user:robin@example.com"], dst: ["tag:nas"], ports: ["445"] }] };
    const before = previewPolicy(policy, subjects, {}, ["user:robin@example.com", "tag:nas"]);
    expect(before.covers["user:robin@example.com"]?.nodes).toEqual(["laptop", "phone"]);
    expect(before.reach).toEqual([
      { from: "laptop", to: "nas", ports: "445" },
      { from: "phone", to: "nas", ports: "445" },
    ]);

    // Tagging the phone takes it out of robin's devices, without saving anything.
    const after = previewPolicy(policy, subjects, { phone: ["tag:nas"] }, [
      "user:robin@example.com",
      "tag:nas",
    ]);
    expect(after.covers["user:robin@example.com"]?.nodes).toEqual(["laptop"]);
    expect(after.covers["tag:nas"]?.nodes).toEqual(["phone", "nas"]);
    expect(after.reach).toEqual([
      { from: "laptop", to: "nas", ports: "445" },
      { from: "laptop", to: "phone", ports: "445" },
    ]);
    expect(subjects.nodes[1]?.tags).toEqual([]);
  });

  test("a draft that does not hold says why, and still says what the selectors cover", () => {
    const res = previewPolicy(
      { acls: [{ src: ["group:family"], dst: ["*"] }] },
      subjects,
      { laptop: ["nas"] },
      ["*", "not-a-selector"],
    );
    expect(res.errors).toEqual([
      "laptop: not a tag: nas",
      "acls.0: group:family is not defined under groups",
    ]);
    expect(res.reach).toBeNull();
    expect(res.covers["*"]).toEqual({ nodes: ["laptop", "phone", "nas"], services: ["grafana"] });
    expect(res.covers["not-a-selector"]).toBeUndefined();
  });

  test("groups count from the draft, and the full mesh compiles nothing", () => {
    const groups = { groups: { "group:family": ["robin@example.com"] }, acls: [] };
    expect(previewPolicy(groups, subjects, {}, ["group:family"]).covers["group:family"]?.nodes).toEqual([
      "laptop",
      "phone",
    ]);
    const mesh = previewPolicy(null, subjects, {}, ["svc:grafana"]);
    expect(mesh.reach).toBeNull();
    expect(mesh.covers["svc:grafana"]).toEqual({ nodes: [], services: ["grafana"] });
  });
});

describe("the policy over HTTP", () => {
  let db: Database;
  let close: () => Promise<void>;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    if (close) await close();
    ({ db, close } = await createTestDb());
    const config = testConfig();
    app = createApp({ db, config, providers: createProviders(config), signingKey: testSigningKey() });
  });

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

  const put = (jar: CookieJar, path: string, body: unknown, type = "application/json") =>
    app.request(path, {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { cookie: jar.header(), "content-type": type },
    });

  async function owned() {
    const owner = await signIn("robin@example.com");
    await createWaveAs((path, init) => app.request(path, init), owner, "robin@example.com");
    const [wave] = await db.select().from(waves).limit(1);
    if (!wave) throw new Error("no wave");
    return { owner, waveId: wave.id };
  }

  test("an owner sets, reads and removes it", async () => {
    const { owner, waveId } = await owned();
    const set = await put(owner, `/api/waves/${waveId}/acl`, { acls: [{ src: ["*"], dst: ["tag:nas"] }] });
    expect(set.status).toBe(200);
    const body = (await set.json()) as { version: number; warnings: string[] };
    expect(body.version).toBe(1);
    expect(body.warnings).toEqual(["no device wears tag:nas (yet)"]);

    const read = await app.request(`/api/waves/${waveId}/acl`, { headers: { cookie: owner.header() } });
    expect(((await read.json()) as { policy: AclPolicy }).policy.acls).toHaveLength(1);

    const removed = await app.request(`/api/waves/${waveId}/acl`, {
      method: "DELETE",
      headers: { cookie: owner.header() },
    });
    expect(removed.status).toBe(200);
  });

  test("a preview judges the draft and writes nothing", async () => {
    const { owner, waveId } = await owned();
    const preview = (jar: CookieJar, body: unknown) =>
      app.request(`/api/waves/${waveId}/acl/preview`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { cookie: jar.header(), "content-type": "application/json" },
      });

    const res = await preview(owner, {
      policy: { acls: [{ src: ["role:owner"], dst: ["tag:nas"] }] },
      selectors: ["role:owner"],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { errors: string[]; warnings: string[]; reach: unknown[] };
    expect(body.errors).toEqual([]);
    expect(body.warnings).toEqual(["no device wears tag:nas (yet)"]);
    expect(body.reach).toEqual([]);

    const read = await app.request(`/api/waves/${waveId}/acl`, { headers: { cookie: owner.header() } });
    const view = (await read.json()) as { policy: unknown; members: { email: string; role: string }[] };
    expect(view.policy).toBeNull();
    expect(view.members).toEqual([{ email: "robin@example.com", role: "owner" }]);

    const member = await signIn("guest@example.com");
    const [guest] = await db.select().from(users).where(eq(users.email, "guest@example.com"));
    await addMember(db, waveId, guest?.id ?? "", "member");
    expect((await preview(member, { policy: null })).status).toBe(403);
  });

  test("a policy it cannot mean is refused with the reasons", async () => {
    const { owner, waveId } = await owned();
    const res = await put(owner, `/api/waves/${waveId}/acl`, {
      acls: [{ src: ["group:ghosts"], dst: ["*"] }],
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { errors: string[] }).errors).toEqual([
      "acls.0: group:ghosts is not defined under groups",
    ]);
  });

  test("only as JSON: a form from another page cannot send one", async () => {
    const { owner, waveId } = await owned();
    const res = await put(owner, `/api/waves/${waveId}/acl`, { acls: [] }, "text/plain");
    expect(res.status).toBe(415);
  });

  test("a member may not, and someone outside does not learn the wave exists", async () => {
    const { waveId } = await owned();
    const member = await signIn("guest@example.com");
    const [guest] = await db.select().from(users).where(eq(users.email, "guest@example.com"));
    if (!guest) throw new Error("no guest");

    const outside = await put(member, `/api/waves/${waveId}/acl`, { acls: [] });
    expect(outside.status).toBe(404);

    await addMember(db, waveId, guest.id, "member");
    const inside = await put(member, `/api/waves/${waveId}/acl`, { acls: [] });
    expect(inside.status).toBe(403);
  });

  test("every change leaves an entry, and only managers read them", async () => {
    const { owner, waveId } = await owned();
    await put(owner, `/api/waves/${waveId}/acl`, { acls: [{ src: ["*"], dst: ["*"] }] });
    await app.request(`/api/waves/${waveId}/acl`, { method: "DELETE", headers: { cookie: owner.header() } });

    const res = await app.request(`/api/waves/${waveId}/audit`, { headers: { cookie: owner.header() } });
    const { entries } = (await res.json()) as {
      entries: {
        actor: string;
        action: string;
        target: string | null;
        detail: { policy?: unknown } | null;
      }[];
    };
    // Newest first.
    expect(entries.map((entry) => entry.action)).toEqual(["acl.remove", "acl.set"]);
    expect(entries[1]?.actor).toBe("robin@example.com");
    expect(entries[1]?.target).toBe("version 1");
    // The whole document, so two entries can be compared.
    expect(entries[1]?.detail?.policy).toEqual({ acls: [{ src: ["*"], dst: ["*"] }] });

    const member = await signIn("guest@example.com");
    const [guest] = await db.select().from(users).where(eq(users.email, "guest@example.com"));
    await addMember(db, waveId, guest?.id ?? "", "member");
    const refused = await app.request(`/api/waves/${waveId}/audit`, { headers: { cookie: member.header() } });
    expect(refused.status).toBe(403);
  });

  test("an entry that cannot be written does not undo the change", async () => {
    // A wave that does not exist: the insert fails on its foreign key.
    await expect(audit(db, "w_gone", shellActor(), { action: "acl.set" })).resolves.toBeUndefined();
  });

  test("tags a device, and refuses what is not a tag", async () => {
    const { owner, waveId } = await owned();
    const [user] = await db.select().from(users).where(eq(users.email, "robin@example.com"));
    const key = await createAuthKey(db, { waveId, userId: user?.id ?? "", reusable: false });
    const keys = generateKeyPair("ed25519");
    const payload = JSON.stringify({
      machineKey: keys.publicKey,
      nodeKey: generateKeyPair("x25519").publicKey,
      discoKey: generateKeyPair("x25519").publicKey,
      hostname: "nas",
      os: "linux",
      authKey: key.token,
    });
    await app.request("/v1/machine/register", {
      method: "POST",
      body: payload,
      headers: {
        "content-type": "application/json",
        authorization: buildAuthorizationHeader({
          machineKey: keys.publicKey,
          machinePrivateKey: keys.privateKey,
          method: "POST",
          path: "/v1/machine/register",
          body: payload,
        }),
      },
    });
    const [nas] = await db.select().from(nodes).where(eq(nodes.hostname, "nas"));
    if (!nas) throw new Error("no nas");

    const tagged = await put(owner, `/api/waves/${waveId}/nodes/${nas.id}/tags`, { tags: ["tag:nas"] });
    expect(tagged.status).toBe(200);
    expect(((await tagged.json()) as { tags: string[] }).tags).toEqual(["tag:nas"]);

    const bad = await put(owner, `/api/waves/${waveId}/nodes/${nas.id}/tags`, { tags: ["nas"] });
    expect(bad.status).toBe(400);
  });
});
