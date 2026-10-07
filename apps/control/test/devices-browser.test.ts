import { beforeEach, describe, expect, test } from "bun:test";
import { buildAuthorizationHeader, generateKeyPair } from "@wave/crypto";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.ts";
import { createProviders } from "../src/auth/providers.ts";
import type { Database } from "../src/db/client.ts";
import { nodes } from "../src/db/schema.ts";
import { addMember, roleOf } from "../src/waves/members.ts";
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

beforeEach(async () => {
  if (close) await close();
  ({ db, close } = await createTestDb());
  const config = testConfig();
  app = createApp({ db, config, providers: createProviders(config), signingKey: testSigningKey() });
});

async function login(email: string): Promise<CookieJar> {
  const jar = new CookieJar();
  const start = await app.request("/auth/dev/start");
  jar.absorb(start);
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
  const callback = await app.request(`/auth/dev/callback?code=${encodeURIComponent(email)}&state=${state}`, {
    headers: { cookie: jar.header() },
  });
  jar.absorb(callback);
  // Signing in no longer makes a wave; its DNS suffix is its owner's choice.
  await createWaveAs((path, init) => app.request(path, init), jar, email);
  return jar;
}

/** Signs in without making a wave: somebody invited into another one. */
async function loginOnly(email: string): Promise<CookieJar> {
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

const meOf = async (jar: CookieJar) =>
  (await (await app.request("/api/me", { headers: { cookie: jar.header() } })).json()) as {
    user: { id: string };
  };

/** Enrols a device the way `wave up` does: register, approve, done. */
async function enrol(hostname: string, jar: CookieJar): Promise<void> {
  const machine = generateKeyPair("ed25519");
  const body = {
    machineKey: machine.publicKey,
    nodeKey: generateKeyPair("x25519").publicKey,
    discoKey: generateKeyPair("x25519").publicKey,
    hostname,
    os: "linux" as const,
  };
  const payload = JSON.stringify(body);
  const res = await app.request("/v1/machine/register", {
    method: "POST",
    body: payload,
    headers: {
      "content-type": "application/json",
      authorization: buildAuthorizationHeader({
        machineKey: machine.publicKey,
        machinePrivateKey: machine.privateKey,
        method: "POST",
        path: "/v1/machine/register",
        body: payload,
      }),
    },
  });

  const pending = (await res.json()) as { authUrl: string };
  const approve = await approveDevice((path, init) => app.request(path, init), jar, pending.authUrl);
  expect(approve.status).toBe(200);
}

const waveOf = async (jar: CookieJar): Promise<{ id: string; name: string }> => {
  const me = (await (await app.request("/api/me", { headers: { cookie: jar.header() } })).json()) as {
    waves: { id: string; name: string }[];
  };
  const wave = me.waves[0];
  if (!wave) throw new Error("the dev login should have provisioned a wave");
  return wave;
};

type Listed = { id: string; hostname: string; os: string; clientPlatform: string | null; userId: string };

const devicesOf = async (jar: CookieJar, waveId: string): Promise<Listed[]> =>
  (
    (await (
      await app.request(`/api/waves/${waveId}/nodes`, { headers: { cookie: jar.header() } })
    ).json()) as {
      nodes: Listed[];
    }
  ).nodes;

const post = (jar: CookieJar, path: string, form: Record<string, string> = {}) =>
  app.request(path, {
    method: "POST",
    body: new URLSearchParams(form),
    headers: { cookie: jar.header(), "content-type": "application/x-www-form-urlencoded" },
  });

describe("devices and members, from the browser", () => {
  // A phone can only ask for a name at enrolment, and since iOS 16 that name
  // is "iPhone". This is how it gets one people recognise.
  test("whoever brought a device in renames it, under the enrolment's rules", async () => {
    const robin = await login("robin@example.com");
    const wave = await waveOf(robin);
    await enrol("iPhone", robin);
    await enrol("laptop", robin);
    const [phone, laptop] = (await devicesOf(robin, wave.id)).sort((a, b) =>
      a.hostname.localeCompare(b.hostname),
    );
    if (!phone || !laptop) throw new Error("two devices expected");

    expect(
      (await post(robin, `/waves/${wave.id}/nodes/${phone.id}/name`, { name: "Max' iPhone" })).status,
    ).toBe(303);
    // Taken names get a number, as at enrolment, rather than a refusal.
    expect(
      (await post(robin, `/waves/${wave.id}/nodes/${laptop.id}/name`, { name: "max-iphone" })).status,
    ).toBe(303);

    const names = (await devicesOf(robin, wave.id)).map((device) => device.hostname).sort();
    expect(names).toEqual(["max-iphone", "max-iphone-2"]);
  });

  test("a member cannot rename somebody else's device", async () => {
    const robin = await login("robin@example.com");
    const wave = await waveOf(robin);
    await enrol("laptop", robin);
    const sam = await loginOnly("sam@example.com");
    await addMember(db, wave.id, (await meOf(sam)).user.id, "member");
    const [laptop] = await devicesOf(robin, wave.id);
    if (!laptop) throw new Error("a device expected");

    expect((await post(sam, `/waves/${wave.id}/nodes/${laptop.id}/name`, { name: "mine" })).status).toBe(403);
    expect((await devicesOf(robin, wave.id))[0]?.hostname).toBe("laptop");
  });

  // Before, a member who wanted out had to ask a manager.
  test("a member leaves by themselves; the owner cannot", async () => {
    const robin = await login("robin@example.com");
    const wave = await waveOf(robin);
    const sam = await loginOnly("sam@example.com");
    const samId = (await meOf(sam)).user.id;
    await addMember(db, wave.id, samId, "member");

    expect((await post(sam, `/waves/${wave.id}/leave`)).status).toBe(303);
    expect(await roleOf(db, wave.id, samId)).toBeNull();
    expect((await post(robin, `/waves/${wave.id}/leave`)).status).toBe(403);
  });

  // The phones register as "other" and say what they are in their hello; the
  // list has to carry that, or every phone is "unknown".
  test("the device list carries the platform a device said it is, and its owner", async () => {
    const robin = await login("robin@example.com");
    const wave = await waveOf(robin);
    await enrol("iphone", robin);
    const [phone] = await devicesOf(robin, wave.id);
    if (!phone) throw new Error("a device expected");
    await db.update(nodes).set({ clientPlatform: "ios" }).where(eq(nodes.id, phone.id));

    const [listed] = await devicesOf(robin, wave.id);
    expect(listed?.clientPlatform).toBe("ios");
    expect(listed?.userId).toBe((await meOf(robin)).user.id);
  });
});
