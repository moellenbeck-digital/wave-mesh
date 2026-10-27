import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { buildAuthorizationHeader, generateKeyPair } from "@wave/crypto";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.ts";
import { setPassword, verifyLogin } from "../src/auth/password.ts";
import { createProviders } from "../src/auth/providers.ts";
import { SeatLimitError } from "../src/billing/seats.ts";
import { ownerAccess } from "../src/billing/setup-links.ts";
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
import { addMember, removeMember } from "../src/waves/members.ts";
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
let reset: () => Promise<void>;
let app: ReturnType<typeof createApp>;

function makeApp(overrides: Record<string, string> = { WAVE_BILLING_TOKEN: TOKEN }) {
  const config = testConfig(overrides);
  return createApp({ db, config, providers: createProviders(config), signingKey: testSigningKey() });
}

beforeAll(async () => {
  ({ db, close, reset } = await createTestDb());
});

afterAll(() => close());

beforeEach(async () => {
  await reset();
  app = makeApp();
});

const put = (subscriptionId: string, body: unknown, token = TOKEN) =>
  app.request(`/api/billing/subscriptions/${subscriptionId}`, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  });

const ownerLink = (subscriptionId: string, key?: string) =>
  app.request(`/api/billing/subscriptions/${subscriptionId}/owner-link`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    ...(key ? { body: JSON.stringify({ key }) } : {}),
  });

const linkPath = async (subscriptionId: string, key?: string): Promise<string> =>
  new URL(((await (await ownerLink(subscriptionId, key)).json()) as { url: string }).url).pathname;

/** Signs in through the dev provider, which vouches for the address like Google does. */
async function signInWithProvider(email: string): Promise<CookieJar> {
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

interface View {
  waveId: string;
  waveName: string;
  dnsSuffix: string;
  created: boolean;
  state: string;
  seats: number;
  members: number;
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

  test("stays ended: a later active is a stale read, and saying ended again moves nothing", async () => {
    await buy();
    await put("sub_1", { seats: 3, state: "ended" });
    const deleteAfter = (await db.select().from(waveBilling))[0]?.deleteAfter?.getTime();
    expect(deleteAfter).toBeNumber();

    const revived = await put("sub_1", { seats: 3, state: "active" });
    expect(revived.status).toBe(409);
    expect(await revived.json()).toEqual({ error: "ended" });
    expect((await put("sub_1", { seats: 3, state: "suspended" })).status).toBe(409);

    const again = await put("sub_1", { seats: 3, state: "ended" });
    expect(again.status).toBe(200);
    const row = (await db.select().from(waveBilling))[0];
    expect(row?.state).toBe("ended");
    expect(row?.deleteAfter?.getTime()).toBe(deleteAfter);
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
      signInUrl: "http://localhost:8080",
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

describe("the contract the site relies on", () => {
  test("answers with the members in the wave", async () => {
    const view = await buy();
    expect(view.members).toBe(1);
    const owner = (await db.select({ id: waves.ownerUserId }).from(waves))[0]?.id ?? "";
    const { userId } = await setPassword(db, "bob@acme.example", "correct horse battery");
    await addMember(db, view.waveId, userId, "member");
    const again = (await (await put("sub_1", { seats: 3, state: "active" })).json()) as View;
    expect(again.members).toBe(2);
    expect(owner).not.toBe(userId);
  });

  test("creates nothing for a subscription that is not active", async () => {
    for (const state of ["suspended", "ended"]) {
      const res = await put(`sub_${state}`, { email: "a@b.example", name: "Late", seats: 1, state });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "unknown-subscription" });
    }
    expect(await db.select().from(waves)).toHaveLength(0);
    expect(await db.select().from(users)).toHaveLength(0);
  });

  test("a state read before the last one applied is not applied", async () => {
    await put("sub_1", { email: "anna@acme.example", name: "Acme", seats: 3, state: "active", asOf: 1000 });
    expect((await put("sub_1", { seats: 3, state: "suspended", asOf: 3000 })).status).toBe(200);
    const stale = await put("sub_1", { seats: 9, state: "active", asOf: 2000 });
    expect(stale.status).toBe(200);
    expect(((await stale.json()) as View).state).toBe("suspended");
    const row = (await db.select().from(waveBilling))[0];
    expect(row?.state).toBe("suspended");
    expect(row?.seats).toBe(3);
    expect(row?.stateAsOf).toBe(3000);
    // Without asOf the site is trusted as before.
    expect(((await (await put("sub_1", { seats: 3, state: "active" })).json()) as View).state).toBe("active");
  });

  test("the deletion date exists only while ended", async () => {
    await buy();
    await put("sub_1", { seats: 3, state: "suspended" });
    expect((await db.select().from(waveBilling))[0]?.deleteAfter).toBeNull();
  });

  test("a full server says so instead of failing as an error", async () => {
    app = makeApp({ WAVE_BILLING_TOKEN: TOKEN, WAVE_IPV4_CONTAINER: "10.64.0.0/16" });
    await buy("sub_1", "a@one.example", "One");
    const full = await put("sub_2", { email: "b@two.example", name: "Two", seats: 1, state: "active" });
    expect(full.status).toBe(507);
    expect(await full.json()).toEqual({ error: "no-capacity" });
  });

  test("without a token the prefix is as unknown as any path, and never reaches the frontend", async () => {
    const proxied: string[] = [];
    const config = testConfig({ WAVE_WEB_URL: "http://web.internal:3000" });
    const off = createApp({
      db,
      config,
      providers: createProviders(config),
      signingKey: testSigningKey(),
      webFetch: async (input: string | URL | Request) => {
        proxied.push(String(input));
        return new Response("frontend");
      },
    } as Parameters<typeof createApp>[0]);
    const res = await off.request("/api/billing/subscriptions/sub_1", { method: "PUT", body: "{}" });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("404 Not Found");

    const onConfig = testConfig({ WAVE_WEB_URL: "http://web.internal:3000", WAVE_BILLING_TOKEN: TOKEN });
    const on = createApp({
      db,
      config: onConfig,
      providers: createProviders(onConfig),
      signingKey: testSigningKey(),
      webFetch: async (input: string | URL | Request) => {
        proxied.push(String(input));
        return new Response("frontend");
      },
    } as Parameters<typeof createApp>[0]);
    const stray = await on.request("/api/billing/whatever", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(stray.status).toBe(404);
    expect(proxied).toEqual([]);
  });

  test("retention: empty means the default, zero is refused", () => {
    expect(
      testConfig({ WAVE_BILLING_TOKEN: TOKEN, WAVE_BILLING_RETENTION_DAYS: "" }).billing?.retentionDays,
    ).toBe(30);
    expect(() => testConfig({ WAVE_BILLING_TOKEN: TOKEN, WAVE_BILLING_RETENTION_DAYS: "0" })).toThrow();
  });
});

describe("whose wave it is", () => {
  test("an unverified account with a login is never the owner of a paid wave", async () => {
    // Someone signed up under the address at a provider that does not vouch for it.
    await db.insert(users).values({ id: "u_squat", email: "anna@acme.example", emailVerified: false });
    await db.insert(identities).values({
      id: "i_squat",
      userId: "u_squat",
      provider: "oidc:https://sloppy.example",
      subject: "1",
      email: "anna@acme.example",
    });
    const view = await buy();
    const owner = (
      await db.select({ id: waves.ownerUserId }).from(waves).where(eq(waves.id, view.waveId))
    )[0];
    expect(owner?.id).not.toBe("u_squat");
    const link = (await (await ownerLink("sub_1")).json()) as { url: string | null };
    expect(link.url).not.toBeNull();
  });

  test("two subscriptions for one new address share one placeholder", async () => {
    await buy("sub_1", "new@acme.example", "One");
    await buy("sub_2", "new@acme.example", "Two");
    expect(await db.select().from(users).where(eq(users.email, "new@acme.example"))).toHaveLength(1);
  });

  test("a verified provider login before the setup link takes the wave, not a second account", async () => {
    const view = await buy();
    const path = await linkPath("sub_1", "cs_1");
    const jar = await signInWithProvider("anna@acme.example");

    const accounts = await db.select().from(users).where(eq(users.email, "anna@acme.example"));
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.emailVerified).toBe(true);
    const me = (await (await app.request("/api/me", { headers: { cookie: jar.header() } })).json()) as {
      waves: { id: string; billing: { state: string; deleteAfter: string | null } | null }[];
    };
    expect(me.waves.map((w) => w.id)).toEqual([view.waveId]);
    expect(me.waves[0]?.billing).toEqual({ state: "active", deleteAfter: null });

    // The link sent earlier must not set a password on an account that has a way in now.
    const late = await app.request(path, {
      method: "POST",
      body: new URLSearchParams({ password: "correct horse battery" }),
    });
    expect(late.status).toBe(410);
    expect(await late.text()).toContain("already has a way in");
    expect((await db.select().from(users))[0]?.passwordHash).toBeNull();
    expect(((await (await ownerLink("sub_1")).json()) as { url: string | null }).url).toBeNull();
  });

  test("a password set by the operator after the link was sent is not overwritten by it", async () => {
    await buy();
    const path = await linkPath("sub_1");
    await setPassword(db, "anna@acme.example", "the operator's password");
    const late = await app.request(path, {
      method: "POST",
      body: new URLSearchParams({ password: "correct horse battery" }),
    });
    expect(late.status).toBe(410);
    expect(await verifyLogin(db, "anna@acme.example", "the operator's password")).not.toBeNull();
  });

  test("the password login finds the account that has one", async () => {
    await db.insert(users).values({ id: "u_old", email: "anna@acme.example", emailVerified: true });
    const { userId } = await setPassword(db, "other@acme.example", "correct horse battery");
    await db.update(users).set({ email: "anna@acme.example" }).where(eq(users.id, userId));
    expect(await verifyLogin(db, "anna@acme.example", "correct horse battery")).toEqual({ userId });
  });
});

describe("the setup link", () => {
  test("after the billing secret changed, the same key gets a fresh link that works", async () => {
    await buy();
    const owner = (await db.select({ id: waves.ownerUserId }).from(waves))[0]?.id ?? "";
    const base = { baseUrl: "https://wave.example", key: "cs_1" };
    const before = await ownerAccess(db, owner, { ...base, secret: "s".repeat(40) });
    const after = await ownerAccess(db, owner, { ...base, secret: "r".repeat(40) });
    expect(after?.url).not.toBe(before?.url);
    // The link mailed after the rotation is one the server recognises.
    expect((await app.request(new URL(after?.url ?? "").pathname)).status).toBe(200);
    expect((await app.request(new URL(before?.url ?? "").pathname)).status).toBe(410);
  });

  test("a link that comes back after its address got a verified account moves the wave there", async () => {
    const view = await buy();
    const path = await linkPath("sub_1", "cs_1");
    const placeholder = (await db.select({ id: waves.ownerUserId }).from(waves))[0]?.id ?? "";
    // The race: a first Google login and the payment, each seeing nobody yet.
    await db.insert(users).values({ id: "u_google", email: "anna@acme.example", emailVerified: true });
    await db.insert(identities).values({
      id: "i_google",
      userId: "u_google",
      provider: "google",
      subject: "g-1",
      email: "anna@acme.example",
    });
    await device(view.waveId, "n_pre", 9);

    const res = await app.request(path, {
      method: "POST",
      body: new URLSearchParams({ password: "correct horse battery" }),
    });
    expect(res.status).toBe(410);
    expect(await res.text()).toContain("already has a way in");

    expect((await db.select().from(waves))[0]?.ownerUserId).toBe("u_google");
    expect(await db.select().from(waveMembers).where(eq(waveMembers.waveId, view.waveId))).toEqual([
      expect.objectContaining({ userId: "u_google", role: "owner" }),
    ]);
    expect((await db.select().from(nodes))[0]?.userId).toBe("u_google");
    expect(await db.select().from(users).where(eq(users.id, placeholder))).toEqual([]);
    // No password was set on the account that signs in with Google.
    expect((await db.select().from(users).where(eq(users.id, "u_google")))[0]?.passwordHash).toBeNull();
  });

  test("the same key gets the same link while it is unused; another key replaces it", async () => {
    await buy();
    const first = await linkPath("sub_1", "cs_1");
    expect(await linkPath("sub_1", "cs_1")).toBe(first);
    expect((await app.request(first)).status).toBe(200);

    const other = await linkPath("sub_1", "cs_2");
    expect(other).not.toBe(first);
    expect((await app.request(first)).status).toBe(410);
    expect((await app.request(other)).status).toBe(200);
  });

  test("a used link is not handed out again for its key", async () => {
    await buy();
    const first = await linkPath("sub_1", "cs_1");
    await app.request(first, {
      method: "POST",
      body: new URLSearchParams({ password: "correct horse battery" }),
    });
    expect(((await (await ownerLink("sub_1", "cs_1")).json()) as { url: string | null }).url).toBeNull();
  });

  test("is refused from another site's form", async () => {
    await buy();
    const path = await linkPath("sub_1");
    const foreign: Record<string, string>[] = [
      { origin: "https://evil.example" },
      { "sec-fetch-site": "cross-site" },
      { origin: "null" },
    ];
    for (const headers of foreign) {
      const res = await app.request(path, {
        method: "POST",
        body: new URLSearchParams({ password: "correct horse battery" }),
        headers,
      });
      expect(res.status).toBe(403);
    }
    // Still usable from its own page.
    const ok = await app.request(path, {
      method: "POST",
      body: new URLSearchParams({ password: "correct horse battery" }),
      headers: { origin: "http://localhost:8080", "sec-fetch-site": "same-origin" },
    });
    expect(ok.status).toBe(303);
  });
});

describe("a booked wave", () => {
  test("is not deleted by its owner while the subscription runs", async () => {
    const view = await buy();
    const jar = await signInWithProvider("anna@acme.example");
    const form = new FormData();
    form.set("name", view.waveName);
    const refused = await app.request(`/waves/${view.waveId}/delete`, {
      method: "POST",
      body: form,
      headers: { cookie: jar.header() },
    });
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("deleted 30 days after it ends");
    expect(await db.select().from(waves)).toHaveLength(1);

    await put("sub_1", { seats: 3, state: "ended" });
    // The owner is told the date, not a number of days that is a server setting.
    const me = (await (await app.request("/api/me", { headers: { cookie: jar.header() } })).json()) as {
      waves: { billing: { state: string; deleteAfter: string | null } | null }[];
    };
    const row = (await db.select().from(waveBilling))[0];
    expect(me.waves[0]?.billing).toEqual({
      state: "ended",
      deleteAfter: row?.deleteAfter?.toISOString() ?? "",
    });
    const form2 = new FormData();
    form2.set("name", view.waveName);
    const allowed = await app.request(`/waves/${view.waveId}/delete`, {
      method: "POST",
      body: form2,
      headers: { cookie: jar.header() },
    });
    expect(allowed.status).toBe(303);
    expect(await db.select().from(waves)).toHaveLength(0);
  });

  test("the sweep deletes each wave on its own and skips one taken off the list", async () => {
    await buy("sub_1", "a@one.example", "One");
    await buy("sub_2", "b@two.example", "Two");
    await put("sub_1", { seats: 3, state: "ended" });
    await put("sub_2", { seats: 3, state: "ended" });
    // Due, but no longer ended by the time the sweep gets to it.
    await db.update(waveBilling).set({ state: "suspended" }).where(eq(waveBilling.subscriptionId, "sub_2"));
    expect(await app.sweepBilling(new Date(Date.now() + 365 * 24 * 3600 * 1000))).toBe(1);
    expect((await db.select({ name: waves.name }).from(waves)).map((w) => w.name)).toEqual(["two"]);
  });
});

describe("waves where they are sold", () => {
  const createWave = (jar: CookieJar) =>
    app.request("/waves", {
      method: "POST",
      body: new URLSearchParams({ name: "free", suffix: "free.wave.internal" }),
      headers: { cookie: jar.header() },
    });

  const waveCount = async (): Promise<number> => (await db.select({ id: waves.id }).from(waves)).length;

  test("someone removed from a booked seat does not get one of their own", async () => {
    const { waveId } = await buy();
    const jar = await signInWithProvider("ben@acme.example");
    const ben = (await db.select({ id: users.id }).from(users).where(eq(users.email, "ben@acme.example")))[0];
    await addMember(db, waveId, ben?.id ?? "", "member");
    await removeMember(db, waveId, "owner", ben?.id ?? "");

    const res = await createWave(jar);
    expect(res.status).toBe(403);
    expect(await waveCount()).toBe(1);
  });

  test("nor does anyone still on one", async () => {
    await buy();
    const jar = await signInWithProvider("anna@acme.example");
    expect((await createWave(jar)).status).toBe(403);
    expect(await waveCount()).toBe(1);
  });

  test("the form and /api/me say why instead of offering one", async () => {
    const jar = await signInWithProvider("ben@acme.example");
    const form = await app.request("/waves/new", { headers: { cookie: jar.header() } });
    expect(form.status).toBe(200);
    expect(await form.text()).not.toContain('action="/waves"');

    const me = (await (await app.request("/api/me", { headers: { cookie: jar.header() } })).json()) as {
      canCreateWave: boolean;
    };
    expect(me.canCreateWave).toBe(false);
  });

  test("on a server without billing nothing changes", async () => {
    app = makeApp({});
    const jar = await signInWithProvider("ben@acme.example");
    expect((await createWave(jar)).status).toBe(303);
    const me = (await (await app.request("/api/me", { headers: { cookie: jar.header() } })).json()) as {
      canCreateWave: boolean;
    };
    expect(me.canCreateWave).toBe(true);
  });
});
