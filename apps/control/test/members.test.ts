import { beforeEach, describe, expect, test } from "bun:test";
import { buildAuthorizationHeader, generateKeyPair } from "@wave/crypto";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.ts";
import { createProviders } from "../src/auth/providers.ts";
import type { Database } from "../src/db/client.ts";
import { nodes } from "../src/db/schema.ts";
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
let app: ReturnType<typeof createApp>;

const BASE_URL = "http://localhost:8080";

beforeEach(async () => {
  if (close) await close();
  ({ db, close } = await createTestDb());
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
