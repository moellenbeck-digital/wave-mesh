import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.ts";
import { setPassword } from "../src/auth/password.ts";
import { createProviders } from "../src/auth/providers.ts";
import type { Database } from "../src/db/client.ts";
import { nodes, users, waveInvites, waveMembers, waves } from "../src/db/schema.ts";
import { createInvite } from "../src/waves/invites.ts";
import { addMember } from "../src/waves/members.ts";
import { createWave, deleteWave, waveSetup } from "../src/waves/provision.ts";
import { CookieJar, createTestDb, testConfig, testSigningKey } from "./helpers.ts";

/**
 * Deleting a wave, which only its owner may do.
 *
 * It is the one cut with nothing on the other side of it: removing a member or
 * a device is undone by letting them back in, this is not undone at all. What
 * is pinned down here is therefore as much about what does *not* happen -- on
 * a wrong name, from an administrator, from someone who is not in it.
 */
let db: Database;
let close: () => Promise<void>;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  if (close) await close();
  ({ db, close } = await createTestDb());
  const config = testConfig();
  app = createApp({ db, config, providers: createProviders(config), signingKey: testSigningKey() });
});

const user = async (email: string): Promise<string> =>
  (await setPassword(db, email, "correct horse battery")).userId;

async function wave(ownerId: string, name = "robin"): Promise<string> {
  const made = await createWave(db, { userId: ownerId, name, dnsSuffix: `${name}.wave.internal` });
  if ("conflict" in made) throw new Error("the fixture collided with itself");
  return made.waveId;
}

async function device(waveId: string, userId: string, id: string, hostname: string): Promise<void> {
  await db.insert(nodes).values({
    id,
    waveId,
    userId,
    machineKey: `mk-${id}`,
    nodeKey: `nk-${id}`,
    discoKey: `dk-${id}`,
    hostname,
    os: "linux",
    ipv4: `10.64.0.${id.length + hostname.length}`,
    ipv6: `fd7a:1:2::${id.length + hostname.length}`,
  });
}

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

const del = (jar: CookieJar, waveId: string, name: string) =>
  app.request(`/waves/${waveId}/delete`, {
    method: "POST",
    body: new URLSearchParams({ name }),
    headers: { cookie: jar.header() },
  });

const countOf = async (waveId: string): Promise<{ waves: number; members: number; nodes: number }> => ({
  waves: (await db.select({ id: waves.id }).from(waves).where(eq(waves.id, waveId))).length,
  members: (
    await db.select({ id: waveMembers.userId }).from(waveMembers).where(eq(waveMembers.waveId, waveId))
  ).length,
  nodes: (await db.select({ id: nodes.id }).from(nodes).where(eq(nodes.waveId, waveId))).length,
});

describe("deleteWave", () => {
  test("takes the devices, the members and the open invitations with it", async () => {
    const owner = await user("robin@example.com");
    const guest = await user("sam@example.com");
    const waveId = await wave(owner);
    await addMember(db, waveId, guest, "member");
    await device(waveId, owner, "n1", "laptop");
    await device(waveId, guest, "n2", "phone");
    await createInvite(db, {
      waveId,
      waveName: "robin",
      email: "kim@example.com",
      role: "member",
      invitedByUserId: owner,
      baseUrl: "https://wave.example.com",
    });

    const deleted = await deleteWave(db, waveId);
    // The ids come back because the database cannot tell the devices: their
    // control connections are still open and the caller has to cut them.
    expect(deleted?.name).toBe("robin");
    expect(deleted?.nodeIds.sort()).toEqual(["n1", "n2"]);
    expect(await countOf(waveId)).toEqual({ waves: 0, members: 0, nodes: 0 });
    expect(
      (await db.select({ id: waveInvites.id }).from(waveInvites).where(eq(waveInvites.waveId, waveId)))
        .length,
    ).toBe(0);
  });

  test("leaves the accounts standing", async () => {
    // A wave is a network, not a tenancy: its members keep their logins, and
    // the owner can make another one straight away.
    const owner = await user("robin@example.com");
    const guest = await user("sam@example.com");
    const waveId = await wave(owner);
    await addMember(db, waveId, guest, "member");

    await deleteWave(db, waveId);
    expect((await db.select({ id: users.id }).from(users)).length).toBe(2);
  });

  test("gives the suffix back", async () => {
    // It carries a unique index, so a wave that still held one would make the
    // name unusable for good.
    const owner = await user("robin@example.com");
    const waveId = await wave(owner);
    await deleteWave(db, waveId);
    expect(
      await createWave(db, { userId: owner, name: "robin", dnsSuffix: "robin.wave.internal" }),
    ).toHaveProperty("waveId");
  });

  test("a wave that is not there is not an error to report twice", async () => {
    expect(await deleteWave(db, "w_nope")).toBeNull();
  });

  test("sends the owner back to the form that makes one", async () => {
    const owner = await user("robin@example.com");
    const waveId = await wave(owner);
    await deleteWave(db, waveId);
    expect(await waveSetup(db, owner, "robin@example.com")).toEqual({ state: "needed" });
  });
});

describe("deleting one from the browser", () => {
  test("the owner types the name and it goes", async () => {
    const owner = await user("robin@example.com");
    const waveId = await wave(owner);
    await device(waveId, owner, "n1", "laptop");

    const jar = await signIn("robin@example.com");
    const res = await del(jar, waveId, "robin");
    expect(res.status).toBe(303);
    expect(await countOf(waveId)).toEqual({ waves: 0, members: 0, nodes: 0 });
  });

  test("a name that does not match deletes nothing", async () => {
    // The whole point of the confirmation: a misplaced click costs an evening
    // of re-enrolling machines, and the wave's own name cannot be typed by
    // accident.
    const owner = await user("robin@example.com");
    const waveId = await wave(owner);
    const jar = await signIn("robin@example.com");

    for (const attempt of ["", "Robin", "robi", "yes"]) {
      const res = await del(jar, waveId, attempt);
      expect(res.status).toBe(400);
    }
    expect((await countOf(waveId)).waves).toBe(1);
    // Surrounding space is not a typo worth refusing over: it is what a copied
    // name brings with it, and it cannot turn one wave's name into another's.
    expect((await del(jar, waveId, "  robin  ")).status).toBe(303);
  });

  test("an administrator may not", async () => {
    // Everything else an admin does is undone by doing the opposite. This is
    // not, so it stays with the one account the wave hangs off.
    const owner = await user("robin@example.com");
    const admin = await user("sam@example.com");
    const waveId = await wave(owner);
    await addMember(db, waveId, admin, "admin");

    const jar = await signIn("sam@example.com");
    const res = await del(jar, waveId, "robin");
    expect(res.status).toBe(403);
    expect((await countOf(waveId)).waves).toBe(1);
  });

  test("someone who is not in it gets the same answer as for a wave that is not there", async () => {
    // Who is a member of what is not public, so it is 404 and not 403.
    const owner = await user("robin@example.com");
    const waveId = await wave(owner);
    await user("outsider@example.com");

    const jar = await signIn("outsider@example.com");
    const res = await del(jar, waveId, "robin");
    expect(res.status).toBe(404);
    expect((await countOf(waveId)).waves).toBe(1);
  });

  test("signed out, it is refused before anything is read", async () => {
    const owner = await user("robin@example.com");
    const waveId = await wave(owner);
    const res = await app.request(`/waves/${waveId}/delete`, {
      method: "POST",
      body: new URLSearchParams({ name: "robin" }),
    });
    expect(res.status).toBe(401);
    expect((await countOf(waveId)).waves).toBe(1);
  });
});
