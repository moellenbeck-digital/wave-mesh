import { beforeEach, describe, expect, test } from "bun:test";
import { buildAuthorizationHeader, generateKeyPair } from "@wave/crypto";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.ts";
import { setPassword, verifyLogin } from "../src/auth/password.ts";
import { createProviders } from "../src/auth/providers.ts";
import { SeatLimitError } from "../src/billing/seats.ts";
import type { Database } from "../src/db/client.ts";
import {
  identities,
  nodes,
  passwordSetups,
  users,
  waveBilling,
  waveMembers,
  waves,
} from "../src/db/schema.ts";
import { buildNetmap } from "../src/netmap/build.ts";
import { createAuthKey } from "../src/waves/auth-keys.ts";
import { createInvite } from "../src/waves/invites.ts";
import { addMember } from "../src/waves/members.ts";
import { approveDevice, CookieJar, createTestDb, testConfig, testSigningKey } from "./helpers.ts";

/**
 * The control-server half of selling waves: what wave-mesh.org calls when
 * Stripe reports a payment, a pause or an end, and the link the owner of a
 * freshly paid wave sets a password with.
 *
 * What is held here is mostly what must *not* happen: a second wave for a
 * repeated event, a paused wave whose devices still reach each other, an
 * account that a payer could take over by typing someone else's address.
 */

const TOKEN = "t".repeat(40);
let db: Database;
let close: () => Promise<void>;
let app: ReturnType<typeof createApp>;

function makeApp(overrides: Record<string, string> = { WAVE_BILLING_TOKEN: TOKEN }) {
  const config = testConfig(overrides);
  return createApp({ db, config, providers: createProviders(config), signingKey: testSigningKey() });
}

beforeEach(async () => {
  if (close) await close();
  ({ db, close } = await createTestDb());
  app = makeApp();
});

const put = (subscriptionId: string, body: unknown, token = TOKEN) =>
  app.request(`/api/billing/subscriptions/${subscriptionId}`, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  });

const ownerLink = (subscriptionId: string) =>
  app.request(`/api/billing/subscriptions/${subscriptionId}/owner-link`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
  });

interface View {
  waveId: string;
  waveName: string;
  dnsSuffix: string;
  created: boolean;
  state: string;
  seats: number;
}

async function buy(subscriptionId = "sub_1", email = "anna@acme.example", name = "Acme GmbH"): Promise<View> {
  const res = await put(subscriptionId, { email, name, seats: 3, state: "active" });
  expect(res.status).toBe(200);
  return (await res.json()) as View;
}

async function device(waveId: string, id: string, last: number): Promise<void> {
  const owner = await db.select({ id: waves.ownerUserId }).from(waves).where(eq(waves.id, waveId));
  await db.insert(nodes).values({
    id,
    waveId,
    userId: owner[0]?.id ?? "",
    machineKey: `mk-${id}`,
    nodeKey: `nk-${id}`,
    discoKey: `dk-${id}`,
    hostname: id,
    os: "linux",
    ipv4: `10.64.0.${last}`,
    ipv6: `fd7a:1:2::${last}`,
    approved: true,
  });
}

const netmapVersion = async (waveId: string): Promise<number> =>
  (await db.select({ v: waves.netmapVersion }).from(waves).where(eq(waves.id, waveId)))[0]?.v ?? 0;

describe("the billing API", () => {
  test("does not exist without a token", async () => {
    app = makeApp({});
    expect((await put("sub_1", { email: "a@b.example", name: "x", seats: 1, state: "active" })).status).toBe(
      404,
    );
  });

  test("refuses a wrong token, of any length", async () => {
    const body = { email: "a@b.example", name: "x", seats: 1, state: "active" };
    expect((await put("sub_1", body, "wrong")).status).toBe(401);
    expect((await put("sub_1", body, `${TOKEN}x`)).status).toBe(401);
    const none = await app.request("/api/billing/subscriptions/sub_1", { method: "PUT", body: "{}" });
    expect(none.status).toBe(401);
  });

  test("refuses a token too short to be a secret at start", () => {
    expect(() => testConfig({ WAVE_BILLING_TOKEN: "short" })).toThrow(/at least 32/);
  });

  test("a checkout makes a wave owned by the address that paid, not verified", async () => {
    const view = await buy();
    expect(view).toMatchObject({
      waveName: "acme-gmbh",
      dnsSuffix: "acme-gmbh.wave.internal",
      created: true,
    });
    expect(view.state).toBe("active");
    expect(view.seats).toBe(3);

    const owner = await db
      .select({ email: users.email, verified: users.emailVerified, hash: users.passwordHash })
      .from(users)
      .innerJoin(waves, eq(waves.ownerUserId, users.id))
      .where(eq(waves.id, view.waveId));
    expect(owner[0]).toEqual({ email: "anna@acme.example", verified: false, hash: null });
    const members = await db.select().from(waveMembers).where(eq(waveMembers.waveId, view.waveId));
    expect(members.map((m) => m.role)).toEqual(["owner"]);
  });

  test("the same event twice is one wave, and the second changes nothing", async () => {
    const first = await buy();
    const version = await netmapVersion(first.waveId);
    const second = await buy();
    expect(second.waveId).toBe(first.waveId);
    expect(second.created).toBe(false);
    expect(await db.select().from(waves)).toHaveLength(1);
    expect(await netmapVersion(first.waveId)).toBe(version);
  });

  test("two deliveries racing make one wave", async () => {
    const [a, b] = await Promise.all([buy(), buy()]);
    expect(a.waveId).toBe(b.waveId);
    expect(await db.select().from(waveBilling)).toHaveLength(1);
  });

  test("an event for an unknown subscription without the checkout's details is a 404", async () => {
    const res = await put("sub_unknown", { seats: 2, state: "active" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown-subscription" });
  });

  test("an invalid body is a 400", async () => {
    expect((await put("sub_1", { seats: 0, state: "active" })).status).toBe(400);
    expect((await put("sub_1", { seats: 2, state: "gone" })).status).toBe(400);
    expect((await put("sub_1", { email: "not-mail", name: "x", seats: 1, state: "active" })).status).toBe(
      400,
    );
  });

  test("two customers with the same name get two suffixes", async () => {
    const one = await buy("sub_1", "a@one.example", "Acme");
    const two = await buy("sub_2", "b@two.example", "Acme");
    expect(one.dnsSuffix).toBe("acme.wave.internal");
    expect(two.dnsSuffix).not.toBe(one.dnsSuffix);
  });

  test("an existing account becomes the owner instead of a second one", async () => {
    const { userId } = await setPassword(db, "anna@acme.example", "correct horse battery");
    const view = await buy();
    const wave = await db.select({ owner: waves.ownerUserId }).from(waves).where(eq(waves.id, view.waveId));
    expect(wave[0]?.owner).toBe(userId);
    expect(await db.select().from(users)).toHaveLength(1);
  });
});

describe("a paused wave", () => {
  test("keeps its devices and stops the mesh, and comes back with it", async () => {
    const { waveId } = await buy();
    await device(waveId, "laptop", 2);
    await device(waveId, "nas", 3);
    expect((await buildNetmap(db, "laptop"))?.peers).toHaveLength(1);

    const before = await netmapVersion(waveId);
    const paused = await put("sub_1", { seats: 3, state: "suspended" });
    expect(paused.status).toBe(200);
    const view = await buildNetmap(db, "laptop");
    expect(view?.peers).toEqual([]);
    expect(view?.services).toEqual([]);
    expect(await db.select().from(nodes).where(eq(nodes.waveId, waveId))).toHaveLength(2);
    expect(await netmapVersion(waveId)).toBe(before + 1);

    // Saying it again is not news for the devices.
    await put("sub_1", { seats: 3, state: "suspended" });
    expect(await netmapVersion(waveId)).toBe(before + 1);

    await put("sub_1", { seats: 3, state: "active" });
    expect((await buildNetmap(db, "laptop"))?.peers.map((p) => p.hostname)).toEqual(["nas"]);
    expect(await netmapVersion(waveId)).toBe(before + 2);
  });

  test("lets no device in through the browser", async () => {
    await setPassword(db, "anna@acme.example", "correct horse battery");
    await buy();
    await put("sub_1", { seats: 3, state: "suspended" });

    const machine = generateKeyPair("ed25519");
    const payload = JSON.stringify({
      machineKey: machine.publicKey,
      nodeKey: generateKeyPair("x25519").publicKey,
      discoKey: generateKeyPair("x25519").publicKey,
      hostname: "late",
      os: "linux",
    });
    const pending = (await (
      await app.request("/v1/machine/register", {
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
      })
    ).json()) as { authUrl: string };

    const jar = new CookieJar();
    const start = await app.request("/auth/dev/start");
    jar.absorb(start);
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    jar.absorb(
      await app.request(`/auth/dev/callback?code=anna%40acme.example&state=${state}`, {
        headers: { cookie: jar.header() },
      }),
    );

    const refused = await approveDevice((p, i) => app.request(p, i), jar, pending.authUrl);
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("paused");
    expect(await db.select().from(nodes)).toHaveLength(0);
  });

  test("lets no device in with a pre-auth key, and does not spend it", async () => {
    const { waveId } = await buy();
    const owner = (await db.select({ id: waves.ownerUserId }).from(waves))[0]?.id ?? "";
    const key = await createAuthKey(db, { waveId, userId: owner });
    await put("sub_1", { seats: 3, state: "suspended" });

    const register = () => {
      const machine = generateKeyPair("ed25519");
      const payload = JSON.stringify({
        machineKey: machine.publicKey,
        nodeKey: generateKeyPair("x25519").publicKey,
        discoKey: generateKeyPair("x25519").publicKey,
        hostname: "connector",
        os: "linux",
        authKey: key.token,
      });
      return app.request("/v1/machine/register", {
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
    };

    expect((await register()).status).toBe(403);
    await put("sub_1", { seats: 3, state: "active" });
    // A single-use key still has its one use.
    expect((await register()).status).toBe(200);
  });
});

describe("an ended subscription", () => {
  test("is kept for the retention, then deleted by the sweep", async () => {
    const { waveId } = await buy();
    await device(waveId, "laptop", 2);
    await put("sub_1", { seats: 3, state: "ended" });

    const row = (await db.select().from(waveBilling))[0];
    const deleteAfter = row?.deleteAfter?.getTime() ?? 0;
    expect(deleteAfter - Date.now()).toBeGreaterThan(29 * 24 * 3600 * 1000);
    expect((await buildNetmap(db, "laptop"))?.peers).toEqual([]);

    // A repeated "ended" does not push the date out.
    await put("sub_1", { seats: 3, state: "ended" });
    expect((await db.select().from(waveBilling))[0]?.deleteAfter?.getTime()).toBe(deleteAfter);

    expect(await app.sweepBilling(new Date(deleteAfter - 1000))).toBe(0);
    expect(await db.select().from(waves)).toHaveLength(1);
    expect(await app.sweepBilling(new Date(deleteAfter + 1000))).toBe(1);
    expect(await db.select().from(waves)).toHaveLength(0);
    expect(await db.select().from(nodes)).toHaveLength(0);
  });

  test("taken back before the sweep is a live wave again", async () => {
    const { waveId } = await buy();
    await put("sub_1", { seats: 3, state: "ended" });
    await put("sub_1", { seats: 3, state: "active" });
    expect((await db.select().from(waveBilling))[0]?.deleteAfter).toBeNull();
    expect(await app.sweepBilling(new Date(Date.now() + 365 * 24 * 3600 * 1000))).toBe(0);
    expect(await db.select().from(waves).where(eq(waves.id, waveId))).toHaveLength(1);
  });

  test("leaves self-hosted waves alone", async () => {
    const { userId } = await setPassword(db, "self@host.example", "correct horse battery");
    await db.insert(waves).values({
      id: "w_self",
      name: "self",
      dnsSuffix: "self.wave.internal",
      ownerUserId: userId,
      ipv4Prefix: "10.70.0.0/16",
      ipv6Prefix: "fd7a:9:9::/48",
    });
    expect(await app.sweepBilling(new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000))).toBe(0);
    expect(await db.select().from(waves)).toHaveLength(1);
  });
});

describe("seats", () => {
  test("members and open invitations together cannot exceed the booking", async () => {
    const { waveId, waveName } = await buy();
    const owner = (await db.select({ id: waves.ownerUserId }).from(waves))[0]?.id ?? "";
    const invite = (email: string) =>
      createInvite(db, {
        waveId,
        waveName,
        email,
        role: "member",
        invitedByUserId: owner,
        baseUrl: "http://x",
      });

    // Three seats: the owner and two invitations.
    await invite("b@acme.example");
    await invite("c@acme.example");
    await expect(invite("d@acme.example")).rejects.toBeInstanceOf(SeatLimitError);
    // Inviting the same address again replaces its invitation, it takes no seat.
    await invite("c@acme.example");

    await put("sub_1", { seats: 4, state: "active" });
    await invite("d@acme.example");
  });

  test("counts members who already joined", async () => {
    const { waveId, waveName } = await buy();
    const owner = (await db.select({ id: waves.ownerUserId }).from(waves))[0]?.id ?? "";
    await put("sub_1", { seats: 2, state: "active" });
    const { userId } = await setPassword(db, "b@acme.example", "correct horse battery");
    await addMember(db, waveId, userId, "member");
    await expect(
      createInvite(db, {
        waveId,
        waveName,
        email: "c@acme.example",
        role: "member",
        invitedByUserId: owner,
        baseUrl: "http://x",
      }),
    ).rejects.toBeInstanceOf(SeatLimitError);
  });

  test("do not apply to a wave nobody pays for", async () => {
    const { userId } = await setPassword(db, "self@host.example", "correct horse battery");
    await db.insert(waves).values({
      id: "w_self",
      name: "self",
      dnsSuffix: "self.wave.internal",
      ownerUserId: userId,
      ipv4Prefix: "10.70.0.0/16",
      ipv6Prefix: "fd7a:9:9::/48",
    });
    for (const n of [1, 2, 3, 4, 5]) {
      await createInvite(db, {
        waveId: "w_self",
        waveName: "self",
        email: `p${n}@host.example`,
        role: "member",
        invitedByUserId: userId,
        baseUrl: "http://x",
      });
    }
  });
});

describe("the owner's way in", () => {
  test("a new account gets a setup link that sets the password once and verifies the address", async () => {
    await buy();
    const res = await ownerLink("sub_1");
    const access = (await res.json()) as { url: string; email: string; hasPassword: boolean };
    expect(access.email).toBe("anna@acme.example");
    expect(access.hasPassword).toBe(false);
    const path = new URL(access.url).pathname;
    expect(path).toMatch(/^\/account\/setup\/[\w-]{43}$/);

    expect((await app.request(path)).status).toBe(200);
    const short = await app.request(path, {
      method: "POST",
      body: new URLSearchParams({ password: "short" }),
    });
    expect(short.status).toBe(400);

    const set = await app.request(path, {
      method: "POST",
      body: new URLSearchParams({ password: "correct horse battery" }),
    });
    expect(set.status).toBe(303);
    expect(set.headers.getSetCookie().join(";")).toContain("wave_session");

    const user = (await db.select().from(users).where(eq(users.email, "anna@acme.example")))[0];
    expect(user?.emailVerified).toBe(true);
    expect(await verifyLogin(db, "anna@acme.example", "correct horse battery")).toEqual({
      userId: user?.id ?? "",
    });
    expect(await db.select().from(identities).where(eq(identities.provider, "password"))).toHaveLength(1);

    // Spent: neither the page nor the form works again.
    expect((await app.request(path)).status).toBe(410);
    const again = await app.request(path, {
      method: "POST",
      body: new URLSearchParams({ password: "another long password" }),
    });
    expect(again.status).toBe(410);
    expect(await verifyLogin(db, "anna@acme.example", "correct horse battery")).not.toBeNull();
  });

  test("no link for an account that already has a way in", async () => {
    await setPassword(db, "anna@acme.example", "correct horse battery");
    await buy();
    expect(await (await ownerLink("sub_1")).json()).toEqual({
      url: null,
      email: "anna@acme.example",
      hasPassword: true,
    });
  });

  test("a new link replaces the old one", async () => {
    await buy();
    const first = new URL(((await (await ownerLink("sub_1")).json()) as { url: string }).url).pathname;
    const second = new URL(((await (await ownerLink("sub_1")).json()) as { url: string }).url).pathname;
    expect((await app.request(first)).status).toBe(410);
    expect((await app.request(second)).status).toBe(200);
  });

  test("an expired link is gone", async () => {
    await buy();
    const path = new URL(((await (await ownerLink("sub_1")).json()) as { url: string }).url).pathname;
    await db.update(passwordSetups).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await app.request(path)).status).toBe(410);
  });

  test("an unknown subscription has no owner", async () => {
    expect((await ownerLink("sub_nope")).status).toBe(404);
  });
});
