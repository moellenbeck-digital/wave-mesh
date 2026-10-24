import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { buildAuthorizationHeader, generateKeyPair } from "@wave/crypto";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.ts";
import { listAudit } from "../src/audit.ts";
import { createProviders } from "../src/auth/providers.ts";
import type { Database } from "../src/db/client.ts";
import { aclPolicies, auditLog, nodes, waveInvites, waveMembers, waves } from "../src/db/schema.ts";
import { buildNetmap } from "../src/netmap/build.ts";
import { createInvite, revokeInvite } from "../src/waves/invites.ts";
import {
  approveDevice,
  CookieJar,
  createTestDb,
  createWaveAs,
  testConfig,
  testSigningKey,
} from "./helpers.ts";

let db: Database;
let close: () => Promise<void>;
let reset: () => Promise<void>;
let app: ReturnType<typeof createApp>;

const BASE_URL = "http://localhost:8080";

beforeAll(async () => {
  ({ db, close, reset } = await createTestDb());
});

afterAll(() => close());

beforeEach(async () => {
  await reset();
  const config = testConfig({ WAVE_BASE_URL: BASE_URL });
  app = createApp({ db, config, providers: createProviders(config), signingKey: testSigningKey() });
});

/** Signs in through the dev provider, which vouches for the address. */
async function login(email: string): Promise<CookieJar> {
  const jar = new CookieJar();
  const start = await app.request("/auth/dev/start");
  jar.absorb(start);
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
  const callback = await app.request(`/auth/dev/callback?code=${encodeURIComponent(email)}&state=${state}`, {
    headers: { cookie: jar.header() },
  });
  jar.absorb(callback);
  return jar;
}

/**
 * Signs in and makes a wave, which a login no longer does on its own -- the
 * suffix is its owner's choice now. Kept apart from `login` because half these
 * tests are about someone who has *no* wave: an invited colleague, a stranger.
 */
async function signUp(email: string): Promise<CookieJar> {
  const jar = await login(email);
  await createWaveAs((path, init) => app.request(path, init), jar, email);
  return jar;
}

/** The first half of `wave up`: a device asking to be let in. */
async function register(hostname: string): Promise<{ requestId: string; authPath: string }> {
  const machine = generateKeyPair("ed25519");
  const body = JSON.stringify({
    machineKey: machine.publicKey,
    nodeKey: generateKeyPair("x25519").publicKey,
    discoKey: generateKeyPair("x25519").publicKey,
    hostname,
    os: "linux" as const,
  });
  const res = await app.request("/v1/machine/register", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      authorization: buildAuthorizationHeader({
        machineKey: machine.publicKey,
        machinePrivateKey: machine.privateKey,
        method: "POST",
        path: "/v1/machine/register",
        body,
      }),
    },
  });
  const pending = (await res.json()) as { authUrl: string };
  const url = new URL(pending.authUrl);
  return { requestId: url.searchParams.get("request") ?? "", authPath: url.pathname + url.search };
}

async function enrol(hostname: string, jar: CookieJar): Promise<Response> {
  const { authPath } = await register(hostname);
  return approveDevice((path, init) => app.request(path, init), jar, authPath);
}

const me = async (jar: CookieJar) =>
  (await (await app.request("/api/me", { headers: { cookie: jar.header() } })).json()) as {
    waves: { id: string; name: string; dnsSuffix: string; role: string; billing: unknown }[];
    invites: { wave: string; role: string }[];
  };

const waveOf = async (jar: CookieJar) => {
  const wave = (await me(jar)).waves[0];
  if (!wave) throw new Error("this account was expected to have made a wave");
  return wave;
};

const members = async (waveId: string, jar: CookieJar) => {
  const res = await app.request(`/api/waves/${waveId}/members`, { headers: { cookie: jar.header() } });
  return {
    status: res.status,
    body: res.ok
      ? ((await res.json()) as {
          role: string;
          members: { email: string | null; role: string; nodeCount: number }[];
          invites: { id: string; email: string; role: string }[];
        })
      : null,
  };
};

const nodesOf = async (waveId: string, jar: CookieJar) =>
  (
    (await (
      await app.request(`/api/waves/${waveId}/nodes`, { headers: { cookie: jar.header() } })
    ).json()) as { nodes: { hostname: string }[] }
  ).nodes.map((node) => node.hostname);

/** An invitation straight from the module, for the tests that only need one. */
async function invite(
  waveId: string,
  email: string,
  inviter: string,
  role: "admin" | "member" = "member",
): Promise<string> {
  const created = await createInvite(db, {
    waveId,
    waveName: "test",
    email,
    role,
    invitedByUserId: inviter,
    baseUrl: BASE_URL,
  });
  return created.token;
}

const nodeId = async (hostname: string): Promise<string> => {
  const rows = await db.select({ id: nodes.id }).from(nodes).where(eq(nodes.hostname, hostname));
  return rows[0]?.id ?? "";
};

const userIdOf = async (jar: CookieJar) => {
  const body = (await (await app.request("/api/me", { headers: { cookie: jar.header() } })).json()) as {
    user: { id: string };
  };
  return body.user.id;
};

describe("a second user in the same wave", () => {
  test("the invitation link puts them in, and both sides see each other", async () => {
    const owner = await signUp("robin@example.com");
    await enrol("laptop", owner);
    const wave = await waveOf(owner);

    // The form the frontend posts; without a frontend the answer carries the link.
    const created = await app.request(`/waves/${wave.id}/invites`, {
      method: "POST",
      body: new URLSearchParams({ email: "Ada@Example.com", role: "member" }),
      headers: { cookie: owner.header() },
    });
    expect(created.status).toBe(200);
    const token = /\/invite\/([\w-]+)/.exec(await created.text())?.[1];
    expect(token).toBeTruthy();

    const ada = await login("ada@example.com");
    // Invited, so no wave of her own was made for her.
    expect((await me(ada)).waves).toHaveLength(0);
    expect((await me(ada)).invites).toHaveLength(1);

    const joined = await app.request(`/invite/${token}`, { headers: { cookie: ada.header() } });
    expect(joined.status).toBe(200);
    expect((await me(ada)).waves).toEqual([
      { id: wave.id, name: wave.name, dnsSuffix: expect.any(String), role: "member", billing: null },
    ]);

    // One membership each, so her device needs no question asked.
    expect((await enrol("phone", ada)).status).toBe(200);
    expect(await nodesOf(wave.id, owner)).toEqual(["laptop", "phone"]);

    // The point of all of it: the netmap of one user's node lists the other's.
    const netmap = await buildNetmap(db, await nodeId("laptop"));
    expect(netmap?.peers.map((peer) => peer.hostname)).toEqual(["phone"]);
  });

  test("the invitation is for one address and works once", async () => {
    const owner = await signUp("robin@example.com");
    const wave = await waveOf(owner);
    const token = await invite(wave.id, "ada@example.com", await userIdOf(owner));

    const mallory = await login("mallory@example.com");
    const refused = await app.request(`/invite/${token}`, { headers: { cookie: mallory.header() } });
    expect(refused.status).toBe(403);
    expect((await me(mallory)).waves.map((w) => w.id)).not.toContain(wave.id);

    const ada = await login("ada@example.com");
    expect((await app.request(`/invite/${token}`, { headers: { cookie: ada.header() } })).status).toBe(200);
    // Spent: a second click adds nothing and says so.
    expect((await app.request(`/invite/${token}`, { headers: { cookie: ada.header() } })).status).toBe(410);
  });

  test("a withdrawn invitation stops working", async () => {
    const owner = await signUp("robin@example.com");
    const wave = await waveOf(owner);
    const token = await invite(wave.id, "ada@example.com", await userIdOf(owner));

    expect(await revokeInvite(db, wave.id, { email: "ada@example.com" })).toBe(true);

    const ada = await login("ada@example.com");
    expect((await app.request(`/invite/${token}`, { headers: { cookie: ada.header() } })).status).toBe(410);
    // Not in the wave she was asked into. She does have one of her own: with
    // nothing waiting for the address any more, her login provisions it.
    expect((await me(ada)).waves.map((w) => w.id)).not.toContain(wave.id);
  });

  test("an address without an account sets a password on the link and is in", async () => {
    const owner = await signUp("robin@example.com");
    const wave = await waveOf(owner);
    const token = await invite(wave.id, "ada@example.com", await userIdOf(owner));

    const claimed = await app.request(`/invite/${token}/claim`, {
      method: "POST",
      body: new URLSearchParams({ password: "correct horse battery" }),
    });
    expect(claimed.status).toBe(303);

    const jar = new CookieJar();
    jar.absorb(claimed);
    expect((await me(jar)).waves.map((w) => w.id)).toEqual([wave.id]);

    // And the password is a real one from there on.
    const again = await app.request("/auth/password/login", {
      method: "POST",
      body: new URLSearchParams({ email: "ada@example.com", password: "correct horse battery" }),
    });
    expect(again.status).toBe(302);
  });

  test("a claim cannot take over an address that already has an account", async () => {
    const owner = await signUp("robin@example.com");
    const wave = await waveOf(owner);
    // Ada exists because she signed in once; the link must not reset her.
    await login("ada@example.com");
    const token = await invite(wave.id, "ada@example.com", await userIdOf(owner));

    const claimed = await app.request(`/invite/${token}/claim`, {
      method: "POST",
      body: new URLSearchParams({ password: "correct horse battery" }),
    });
    expect(claimed.status).toBe(409);
  });

  test("a short password is refused, and nothing is created", async () => {
    const owner = await signUp("robin@example.com");
    const wave = await waveOf(owner);
    const token = await invite(wave.id, "ada@example.com", await userIdOf(owner));

    const claimed = await app.request(`/invite/${token}/claim`, {
      method: "POST",
      body: new URLSearchParams({ password: "short" }),
    });
    expect(claimed.status).toBe(400);
    // Still open afterwards.
    const ada = await login("ada@example.com");
    expect((await app.request(`/invite/${token}`, { headers: { cookie: ada.header() } })).status).toBe(200);
  });
});

describe("who may administer a wave", () => {
  test("a plain member can look but not invite", async () => {
    const owner = await signUp("robin@example.com");
    const wave = await waveOf(owner);
    const token = await invite(wave.id, "ada@example.com", await userIdOf(owner));
    const ada = await login("ada@example.com");
    await app.request(`/invite/${token}`, { headers: { cookie: ada.header() } });

    const seen = await members(wave.id, ada);
    expect(seen.status).toBe(200);
    expect(seen.body?.members.map((m) => m.role)).toEqual(["owner", "member"]);
    // Who has been asked and not answered is a manager's business.
    expect(seen.body?.invites).toEqual([]);

    const tried = await app.request(`/waves/${wave.id}/invites`, {
      method: "POST",
      body: new URLSearchParams({ email: "mallory@example.com" }),
      headers: { cookie: ada.header() },
    });
    expect(tried.status).toBe(403);
  });

  test("an admin invites, and the owner is the one who cannot be removed", async () => {
    const owner = await signUp("robin@example.com");
    const wave = await waveOf(owner);
    const ownerId = await userIdOf(owner);
    const token = await invite(wave.id, "ada@example.com", ownerId, "admin");
    const ada = await login("ada@example.com");
    await app.request(`/invite/${token}`, { headers: { cookie: ada.header() } });

    const invited = await app.request(`/waves/${wave.id}/invites`, {
      method: "POST",
      body: new URLSearchParams({ email: "grace@example.com" }),
      headers: { cookie: ada.header() },
    });
    expect(invited.status).toBe(200);

    const refused = await app.request(`/waves/${wave.id}/members/${ownerId}/remove`, {
      method: "POST",
      headers: { cookie: ada.header() },
    });
    expect(refused.status).toBe(403);
    expect((await members(wave.id, owner)).body?.members).toHaveLength(2);
  });

  test("members of a wave are unknown to everyone else", async () => {
    const owner = await signUp("robin@example.com");
    const wave = await waveOf(owner);
    const mallory = await login("mallory@example.com");
    expect((await members(wave.id, mallory)).status).toBe(404);
    expect(
      (
        await app.request(`/waves/${wave.id}/invites`, {
          method: "POST",
          body: new URLSearchParams({ email: "mallory@example.com" }),
          headers: { cookie: mallory.header() },
        })
      ).status,
    ).toBe(404);
  });
});

describe("taking a member back out", () => {
  test("their devices go with them", async () => {
    const owner = await signUp("robin@example.com");
    await enrol("laptop", owner);
    const wave = await waveOf(owner);
    const token = await invite(wave.id, "ada@example.com", await userIdOf(owner));
    const ada = await login("ada@example.com");
    await app.request(`/invite/${token}`, { headers: { cookie: ada.header() } });
    await enrol("phone", ada);
    expect(await nodesOf(wave.id, owner)).toEqual(["laptop", "phone"]);

    const adaId = await userIdOf(ada);
    const removed = await app.request(`/waves/${wave.id}/members/${adaId}/remove`, {
      method: "POST",
      headers: { cookie: owner.header() },
    });
    expect(removed.status).toBe(303);

    // Gone from the wave, and the address is not a member anywhere.
    expect(await nodesOf(wave.id, owner)).toEqual(["laptop"]);
    expect((await me(ada)).waves).toHaveLength(0);
    expect((await members(wave.id, ada)).status).toBe(404);

    // And out of everyone else's netmap.
    expect((await buildNetmap(db, await nodeId("laptop")))?.peers).toEqual([]);
  });

  test("an invitation still open can be withdrawn from the list", async () => {
    const owner = await signUp("robin@example.com");
    const wave = await waveOf(owner);
    await invite(wave.id, "ada@example.com", await userIdOf(owner));

    const listed = (await members(wave.id, owner)).body?.invites ?? [];
    expect(listed).toHaveLength(1);

    const revoked = await app.request(`/waves/${wave.id}/invites/${listed[0]?.id}/revoke`, {
      method: "POST",
      headers: { cookie: owner.header() },
    });
    expect(revoked.status).toBe(303);
    expect((await members(wave.id, owner)).body?.invites).toEqual([]);
  });
});

describe("changing a member's role", () => {
  /** An owner and two others who joined by invitation, each with the role asked for. */
  async function setup() {
    const owner = await signUp("robin@example.com");
    const wave = await waveOf(owner);
    const ownerId = await userIdOf(owner);
    const join = async (email: string, role: "admin" | "member") => {
      const token = await invite(wave.id, email, ownerId, role);
      const jar = await login(email);
      await app.request(`/invite/${token}`, { headers: { cookie: jar.header() } });
      return { jar, id: await userIdOf(jar) };
    };
    const ada = await join("ada@example.com", "admin");
    const grace = await join("grace@example.com", "member");
    return { owner, ownerId, wave, ada, grace };
  }

  const setRole = (waveId: string, userId: string, jar: CookieJar, role: string) =>
    app.request(`/waves/${waveId}/members/${userId}/role`, {
      method: "POST",
      body: new URLSearchParams({ role }),
      headers: { cookie: jar.header() },
    });

  const roles = async (waveId: string, jar: CookieJar) =>
    Object.fromEntries(
      ((await members(waveId, jar)).body?.members ?? []).map((m) => [m.email, m.role] as const),
    );

  const netmapVersionOf = async (waveId: string) =>
    (await db.select({ v: waves.netmapVersion }).from(waves).where(eq(waves.id, waveId)))[0]?.v ?? 0;

  test("the owner takes an admin down to member and lifts a member up", async () => {
    const { owner, wave, ada, grace } = await setup();
    const before = await netmapVersionOf(wave.id);

    const down = await setRole(wave.id, ada.id, owner, "member");
    expect(down.status).toBe(303);
    expect(down.headers.get("location")).toBe("/");
    const up = await setRole(wave.id, grace.id, owner, "admin");
    expect(up.status).toBe(303);

    expect(await roles(wave.id, owner)).toEqual({
      "robin@example.com": "owner",
      "ada@example.com": "member",
      "grace@example.com": "admin",
    });
    // The role is what `role:` in the policy matches: the nodes need a new netmap.
    expect(await netmapVersionOf(wave.id)).toBe(before + 2);
  });

  test("an admin promotes a member", async () => {
    const { owner, wave, ada, grace } = await setup();
    const res = await setRole(wave.id, grace.id, ada.jar, "admin");
    expect(res.status).toBe(303);
    expect((await roles(wave.id, owner))["grace@example.com"]).toBe("admin");
  });

  test("an admin takes another admin down to member and up again", async () => {
    const { owner, wave, ada, grace } = await setup();
    await setRole(wave.id, grace.id, owner, "admin");
    const before = await netmapVersionOf(wave.id);

    const down = await setRole(wave.id, grace.id, ada.jar, "member");
    expect(down.status).toBe(303);
    expect((await roles(wave.id, owner))["grace@example.com"]).toBe("member");
    expect((await setRole(wave.id, grace.id, ada.jar, "admin")).status).toBe(303);
    expect((await roles(wave.id, owner))["grace@example.com"]).toBe("admin");
    expect(await netmapVersionOf(wave.id)).toBe(before + 2);

    const entries = (await listAudit(db, wave.id)).filter(
      (row) => row.action === "member.role" && row.actor === "ada@example.com",
    );
    expect(entries.map((row) => row.detail)).toEqual(
      expect.arrayContaining([
        { from: "admin", to: "member" },
        { from: "member", to: "admin" },
      ]),
    );
  });

  test("an admin cannot change the owner's role or their own", async () => {
    const { owner, ownerId, wave, ada } = await setup();
    expect((await setRole(wave.id, ownerId, ada.jar, "member")).status).toBe(403);
    expect((await setRole(wave.id, ownerId, ada.jar, "admin")).status).toBe(403);
    expect((await setRole(wave.id, ada.id, ada.jar, "member")).status).toBe(403);
    expect(await roles(wave.id, owner)).toMatchObject({
      "robin@example.com": "owner",
      "ada@example.com": "admin",
    });
  });

  test("an admin cannot hand out the owner role", async () => {
    const { owner, wave, ada, grace } = await setup();
    expect((await setRole(wave.id, grace.id, ada.jar, "owner")).status).toBe(400);
    expect((await roles(wave.id, owner))["grace@example.com"]).toBe("member");
  });

  test("a plain member may change nothing", async () => {
    const { owner, wave, ada, grace } = await setup();
    expect((await setRole(wave.id, ada.id, grace.jar, "member")).status).toBe(403);
    expect((await setRole(wave.id, grace.id, grace.jar, "admin")).status).toBe(403);
    expect(await roles(wave.id, owner)).toEqual({
      "robin@example.com": "owner",
      "ada@example.com": "admin",
      "grace@example.com": "member",
    });
  });

  test("the owner's role cannot be changed, nor handed out", async () => {
    const { owner, ownerId, wave, ada } = await setup();
    expect((await setRole(wave.id, ownerId, ada.jar, "member")).status).toBe(403);
    expect((await setRole(wave.id, ada.id, owner, "owner")).status).toBe(400);
    expect((await roles(wave.id, owner))["robin@example.com"]).toBe("owner");
    expect((await roles(wave.id, owner))["ada@example.com"]).toBe("admin");
  });

  test("nobody changes their own role, the owner included", async () => {
    const { owner, ownerId, wave, ada } = await setup();
    expect((await setRole(wave.id, ada.id, ada.jar, "member")).status).toBe(403);
    expect((await setRole(wave.id, ownerId, owner, "member")).status).toBe(403);
    expect(await roles(wave.id, owner)).toMatchObject({
      "robin@example.com": "owner",
      "ada@example.com": "admin",
    });
  });

  test("a role that does not exist is a bad request", async () => {
    const { owner, wave, grace } = await setup();
    expect((await setRole(wave.id, grace.id, owner, "root")).status).toBe(400);
    expect((await setRole(wave.id, grace.id, owner, "")).status).toBe(400);
    expect((await roles(wave.id, owner))["grace@example.com"]).toBe("member");
  });

  test("somebody who is not in the wave is unknown", async () => {
    const { owner, wave } = await setup();
    expect((await setRole(wave.id, "u_nobody", owner, "admin")).status).toBe(404);

    // And for a caller who is not in it either, the wave itself is unknown.
    const mallory = await login("mallory@example.com");
    expect((await setRole(wave.id, await userIdOf(owner), mallory, "member")).status).toBe(404);
  });

  test("the same role again changes nothing and leaves no trace", async () => {
    const { owner, wave, ada, grace } = await setup();
    const before = await netmapVersionOf(wave.id);

    expect((await setRole(wave.id, grace.id, owner, "member")).status).toBe(303);
    expect((await setRole(wave.id, ada.id, owner, "admin")).status).toBe(303);

    expect(await netmapVersionOf(wave.id)).toBe(before);
    expect((await listAudit(db, wave.id)).filter((row) => row.action === "member.role")).toEqual([]);
  });

  test("the change is audited with the old and the new role", async () => {
    const { owner, wave, ada } = await setup();
    await setRole(wave.id, ada.id, owner, "member");

    const entries = (await listAudit(db, wave.id)).filter((row) => row.action === "member.role");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actor: "robin@example.com",
      target: ada.id,
      detail: { from: "admin", to: "member" },
    });
  });

  test("the members list tells the viewer which row is theirs", async () => {
    const { owner, ownerId, wave, ada } = await setup();
    const res = await app.request(`/api/waves/${wave.id}/members`, { headers: { cookie: owner.header() } });
    expect(((await res.json()) as { userId: string }).userId).toBe(ownerId);
    const asAda = await app.request(`/api/waves/${wave.id}/members`, {
      headers: { cookie: ada.jar.header() },
    });
    expect(((await asAda.json()) as { userId: string }).userId).toBe(ada.id);
  });
});

describe("taking a device out", () => {
  test("an admin removes it, and it is gone from the wave and every netmap", async () => {
    const owner = await signUp("robin@example.com");
    await enrol("laptop", owner);
    const wave = await waveOf(owner);
    const token = await invite(wave.id, "ada@example.com", await userIdOf(owner));
    const ada = await login("ada@example.com");
    await app.request(`/invite/${token}`, { headers: { cookie: ada.header() } });
    await enrol("phone", ada);

    const removed = await app.request(`/waves/${wave.id}/nodes/${await nodeId("phone")}/remove`, {
      method: "POST",
      headers: { cookie: owner.header() },
    });
    expect(removed.status).toBe(303);

    expect(await nodesOf(wave.id, owner)).toEqual(["laptop"]);
    expect((await buildNetmap(db, await nodeId("laptop")))?.peers).toEqual([]);
    // Only the device: Ada herself stays in the wave.
    expect((await members(wave.id, owner)).body?.members.map((m) => m.role)).toEqual(["owner", "member"]);
  });

  test("a plain member may look at the devices but not remove one", async () => {
    const owner = await signUp("robin@example.com");
    await enrol("laptop", owner);
    const wave = await waveOf(owner);
    const token = await invite(wave.id, "ada@example.com", await userIdOf(owner));
    const ada = await login("ada@example.com");
    await app.request(`/invite/${token}`, { headers: { cookie: ada.header() } });

    const tried = await app.request(`/waves/${wave.id}/nodes/${await nodeId("laptop")}/remove`, {
      method: "POST",
      headers: { cookie: ada.header() },
    });
    expect(tried.status).toBe(403);
    expect(await nodesOf(wave.id, owner)).toEqual(["laptop"]);
  });

  test("a device of another wave cannot be reached through this one", async () => {
    const owner = await signUp("robin@example.com");
    const wave = await waveOf(owner);
    const stranger = await signUp("mallory@example.com");
    const strangersWave = await waveOf(stranger);
    await enrol("theirs", stranger);

    const tried = await app.request(`/waves/${wave.id}/nodes/${await nodeId("theirs")}/remove`, {
      method: "POST",
      headers: { cookie: owner.header() },
    });
    expect(tried.status).toBe(404);
    expect(await nodesOf(strangersWave.id, stranger)).toEqual(["theirs"]);
  });

  test("a wave the caller is not in is unknown, devices and all", async () => {
    const owner = await signUp("robin@example.com");
    await enrol("laptop", owner);
    const wave = await waveOf(owner);
    const mallory = await login("mallory@example.com");

    const tried = await app.request(`/waves/${wave.id}/nodes/${await nodeId("laptop")}/remove`, {
      method: "POST",
      headers: { cookie: mallory.header() },
    });
    expect(tried.status).toBe(404);
    expect(await nodesOf(wave.id, owner)).toEqual(["laptop"]);
  });

  test("a device that is already gone says so instead of pretending", async () => {
    const owner = await signUp("robin@example.com");
    await enrol("laptop", owner);
    const wave = await waveOf(owner);
    const id = await nodeId("laptop");

    expect(
      (
        await app.request(`/waves/${wave.id}/nodes/${id}/remove`, {
          method: "POST",
          headers: { cookie: owner.header() },
        })
      ).status,
    ).toBe(303);
    expect(
      (
        await app.request(`/waves/${wave.id}/nodes/${id}/remove`, {
          method: "POST",
          headers: { cookie: owner.header() },
        })
      ).status,
    ).toBe(404);
  });
});

describe("a device when the account is in several waves", () => {
  test("it is asked which wave, and lands in the one that was picked", async () => {
    const owner = await signUp("robin@example.com");
    const own = await waveOf(owner);

    // A second wave, someone else's, joined by invitation.
    const other = await signUp("grace@example.com");
    const otherWave = await waveOf(other);
    const token = await invite(otherWave.id, "robin@example.com", await userIdOf(other));
    await app.request(`/invite/${token}`, { headers: { cookie: owner.header() } });
    expect((await me(owner)).waves).toHaveLength(2);

    const { requestId, authPath } = await register("laptop");
    const asked = await app.request(authPath, { headers: { cookie: owner.header() } });
    expect(asked.status).toBe(200);
    const body = await asked.text();
    expect(body).toContain("Which wave");
    expect(body).toContain(own.id);
    expect(body).toContain(otherWave.id);
    // Nothing was created while the question was open.
    expect(await nodesOf(own.id, owner)).toEqual([]);

    const added = await app.request("/machine/authorize", {
      method: "POST",
      body: new URLSearchParams({ request: requestId, wave: otherWave.id }),
      headers: { cookie: owner.header() },
    });
    expect(added.status).toBe(200);
    expect(await nodesOf(otherWave.id, owner)).toEqual(["laptop"]);
    expect(await nodesOf(own.id, owner)).toEqual([]);
  });

  test("a wave the account is not in is asked again, never silently swapped", async () => {
    const owner = await signUp("robin@example.com");
    const own = await waveOf(owner);
    const stranger = await signUp("mallory@example.com");
    const strangersWave = await waveOf(stranger);

    const { requestId } = await register("laptop");
    const wrong = await app.request("/machine/authorize", {
      method: "POST",
      body: new URLSearchParams({ request: requestId, wave: strangersWave.id }),
      headers: { cookie: owner.header() },
    });
    // Asked again rather than placed: a stale form must not put the device
    // somewhere nobody chose, and not in a stranger's wave either. What comes
    // back is the form, offering only the wave the caller is actually in.
    expect(wrong.status).toBe(200);
    const asked = await wrong.text();
    expect(asked).toContain('method="post"');
    expect(asked).toContain(own.id);
    expect(asked).not.toContain(strangersWave.id);
    expect(await nodesOf(own.id, owner)).toEqual([]);
    expect((await members(strangersWave.id, owner)).status).toBe(404);

    // The id it does own works.
    const added = await app.request("/machine/authorize", {
      method: "POST",
      body: new URLSearchParams({ request: requestId, wave: own.id }),
      headers: { cookie: owner.header() },
    });
    expect(added.status).toBe(200);
    expect(await nodesOf(own.id, owner)).toEqual(["laptop"]);
  });
});

describe("a manager of one wave in another", () => {
  /**
   * Being owner or admin is a role *in* a wave, never a rank on the server.
   * Every route below is one an owner may take in their own wave; here each is
   * aimed at someone else's, directly and through the owner's own URL with a
   * foreign device or member, and none of them may leave a mark there. One
   * list, so the next route added is one line here and not a gap.
   */
  test("can change nothing there, and add no one", async () => {
    const robin = await signUp("robin@example.com");
    const own = await waveOf(robin);
    const mallory = await signUp("mallory@example.com");
    const theirs = await waveOf(mallory);
    await enrol("theirs", mallory);
    const theirNode = await nodeId("theirs");
    const malloryId = await userIdOf(mallory);
    const ada = await login("ada@example.com");
    const adaId = await userIdOf(ada);
    await db.insert(waveMembers).values({ waveId: theirs.id, userId: adaId, role: "member" });
    const inviteToken = await invite(theirs.id, "eve@example.com", malloryId);
    const theirInvite = (
      await db.select({ id: waveInvites.id }).from(waveInvites).where(eq(waveInvites.waveId, theirs.id))
    )[0]?.id;
    expect(inviteToken).toBeTruthy();

    const snapshot = async () => ({
      wave: await db.select().from(waves).where(eq(waves.id, theirs.id)),
      members: await db.select().from(waveMembers).where(eq(waveMembers.waveId, theirs.id)),
      invites: await db.select().from(waveInvites).where(eq(waveInvites.waveId, theirs.id)),
      nodes: await db.select().from(nodes).where(eq(nodes.waveId, theirs.id)),
      acl: await db.select().from(aclPolicies).where(eq(aclPolicies.waveId, theirs.id)),
      audit: await db.select().from(auditLog).where(eq(auditLog.waveId, theirs.id)),
    });
    const before = await snapshot();

    const form = (body: Record<string, string>) => ({
      method: "POST",
      body: new URLSearchParams(body),
      headers: { cookie: robin.header() },
    });
    const json = (method: string, body?: unknown) => ({
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: { cookie: robin.header(), "content-type": "application/json" },
    });
    const policy = { acls: [{ src: ["*"], dst: ["*"] }] };
    const attempts: [string, RequestInit][] = [
      [`/waves/${theirs.id}/name`, form({ name: "taken" })],
      [`/waves/${theirs.id}/domain`, form({ domain: "taken.wave.internal" })],
      [`/waves/${theirs.id}/invites`, form({ email: "friend@example.com", role: "admin" })],
      [`/waves/${theirs.id}/invites/${theirInvite}/revoke`, form({})],
      [`/waves/${theirs.id}/members/${adaId}/remove`, form({})],
      [`/waves/${theirs.id}/members/${adaId}/role`, form({ role: "admin" })],
      [`/waves/${theirs.id}/nodes/${theirNode}/name`, form({ name: "renamed" })],
      [`/waves/${theirs.id}/nodes/${theirNode}/remove`, form({})],
      [`/waves/${theirs.id}/delete`, form({ confirm: theirs.name })],
      [`/api/waves/${theirs.id}/members`, json("GET")],
      [`/api/waves/${theirs.id}/nodes`, json("GET")],
      [`/api/waves/${theirs.id}/acl`, json("GET")],
      [`/api/waves/${theirs.id}/acl`, json("PUT", policy)],
      [`/api/waves/${theirs.id}/acl`, json("DELETE")],
      [`/api/waves/${theirs.id}/acl/preview`, json("POST", { policy })],
      [`/api/waves/${theirs.id}/audit`, json("GET")],
      [`/api/waves/${theirs.id}/nodes/${theirNode}/tags`, json("PUT", { tags: ["tag:mine"] })],
      // Through the caller's own wave, naming what belongs to the other one.
      [`/waves/${own.id}/members/${adaId}/remove`, form({})],
      [`/waves/${own.id}/members/${adaId}/role`, form({ role: "admin" })],
      [`/waves/${own.id}/members/${malloryId}/remove`, form({})],
      [`/waves/${own.id}/nodes/${theirNode}/name`, form({ name: "renamed" })],
      [`/waves/${own.id}/nodes/${theirNode}/remove`, form({})],
      [`/api/waves/${own.id}/nodes/${theirNode}/tags`, json("PUT", { tags: ["tag:mine"] })],
    ];

    for (const [path, init] of attempts) {
      const res = await app.request(path, init);
      // Refused, whichever way: an unknown wave or member is 404, an
      // inapplicable one 400 or 403. What matters is that it is not a success.
      expect({ path, method: init.method, ok: res.status < 400 }).toEqual({
        path,
        method: init.method,
        ok: false,
      });
    }
    // Withdrawing what is already gone is no error on purpose, so this one
    // answers like a success. It must still touch nothing there, and leave no
    // entry here claiming it did.
    expect((await app.request(`/waves/${own.id}/invites/${theirInvite}/revoke`, form({}))).status).toBe(303);
    expect((await listAudit(db, own.id, 50)).map((entry) => entry.action)).not.toContain("invite.revoke");

    expect(await snapshot()).toEqual(before);
  });
});
