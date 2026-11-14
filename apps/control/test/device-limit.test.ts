import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { buildAuthorizationHeader, generateKeyPair } from "@wave/crypto";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.ts";
import { createProviders } from "../src/auth/providers.ts";
import { accountDeviceCount, DeviceLimitError, ensureDeviceSlot } from "../src/billing/device-limit.ts";
import type { Database } from "../src/db/client.ts";
import {
  customerAccounts,
  nodes,
  users,
  waveAuthKeys,
  waveBilling,
  waveMembers,
  waves,
} from "../src/db/schema.ts";
import { loadConfig } from "../src/env.ts";
import { createAuthKey } from "../src/waves/auth-keys.ts";
import { CookieJar, createTestDb, createWaveAs, testConfig, testSigningKey } from "./helpers.ts";

/**
 * The device limit of a free hosted account (ticket #116).
 *
 * A device is a distinct `machine_key` over all the waves of one customer
 * account. These tests hold on to the three edges of that sentence: a device
 * that is already in the account takes no new place in another wave, a wave
 * without an account (self-hosted) has no limit, and a refused registration
 * leaves everything as it was -- above all the pre-auth key.
 */

const LIMIT = 3;

let db: Database;
let close: () => Promise<void>;
let reset: () => Promise<void>;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  ({ db, close, reset } = await createTestDb());
});

afterAll(() => close());

beforeEach(async () => {
  await reset();
  const config = testConfig({ WAVE_FREE_DEVICE_LIMIT: String(LIMIT) });
  app = createApp({ db, config, providers: createProviders(config), signingKey: testSigningKey() });
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

const signed = (machine: Machine, method: string, path: string, payload: string, wave?: string) => ({
  method,
  ...(method === "GET" ? {} : { body: payload }),
  headers: {
    "content-type": "application/json",
    ...(wave ? { "x-wave-id": wave } : {}),
    authorization: buildAuthorizationHeader({
      machineKey: machine.machine.publicKey,
      machinePrivateKey: machine.machine.privateKey,
      method,
      path,
      body: payload,
    }),
  },
});

const register = (machine: Machine, authKey?: string, wave?: string) => {
  const payload = JSON.stringify({ ...machine.body, ...(authKey ? { authKey } : {}) });
  return app.request("/v1/machine/register", signed(machine, "POST", "/v1/machine/register", payload, wave));
};

const netmapOf = (machine: Machine, wave?: string) =>
  app.request("/v1/netmap", signed(machine, "GET", "/v1/netmap", "", wave));

async function login(email: string): Promise<{ jar: CookieJar; userId: string }> {
  const jar = new CookieJar();
  const start = await app.request("/auth/dev/start");
  jar.absorb(start);
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
  jar.absorb(
    await app.request(`/auth/dev/callback?code=${encodeURIComponent(email)}&state=${state}`, {
      headers: { cookie: jar.header() },
    }),
  );
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user) throw new Error("no user");
  return { jar, userId: user.id };
}

/**
 * Waves of one person, under one customer account when `free` is true: the
 * account row and `waves.account_id` are what billing leaves behind, and no
 * `wave_billing` row is what makes it free.
 */
async function setup(options: { waves?: number; account?: boolean } = {}) {
  const { jar, userId } = await login("robin@example.com");
  const count = options.waves ?? 1;
  for (let i = 0; i < count; i++) {
    await createWaveAs((path, init) => app.request(path, init), jar, "robin@example.com", {
      suffix: `w${i}.wave.example.com`,
    });
  }
  const rows = await db.select().from(waves).orderBy(waves.createdAt, waves.id);
  const accountId = options.account === false ? null : "ca_robin";
  if (accountId) {
    await db.insert(customerAccounts).values({ id: accountId, ownerUserId: userId });
    await db.update(waves).set({ accountId });
  }
  return { jar, userId, accountId, waveIds: rows.map((row) => row.id) };
}

const enrol = async (waveId: string, userId: string, name: string, machine = makeMachine(name)) => {
  const key = await createAuthKey(db, { waveId, userId, reusable: true });
  return { machine, key, res: await register(machine, key.token) };
};

const usesOf = async (id: string) =>
  (await db.select().from(waveAuthKeys).where(eq(waveAuthKeys.id, id)).limit(1))[0]?.uses;

describe("a free account", () => {
  test("takes devices up to the limit and turns the next one away", async () => {
    const { waveIds, userId, accountId } = await setup();
    const wave = waveIds[0] ?? "";
    for (const name of ["a", "b", "c"]) {
      expect((await enrol(wave, userId, name)).res.status).toBe(200);
    }

    const { res, key } = await enrol(wave, userId, "d");

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; code: string; limit: number };
    expect(body.code).toBe("device_limit");
    expect(body.limit).toBe(LIMIT);
    expect(body.error).toContain(`${LIMIT} devices`);
    expect(await db.select().from(nodes)).toHaveLength(LIMIT);
    expect(await accountDeviceCount(db, accountId ?? "")).toBe(LIMIT);
    // The refusal does not spend the key: it is still as unused as it was made.
    expect(await usesOf(key.id)).toBe(0);
  });

  test("keeps a key usable for a device that fits once a place is free", async () => {
    const { waveIds, userId } = await setup();
    const wave = waveIds[0] ?? "";
    for (const name of ["a", "b", "c"]) await enrol(wave, userId, name);
    const { machine, key, res } = await enrol(wave, userId, "d");
    expect(res.status).toBe(403);

    // Removing a device is all it takes: nothing is counted but the rows there are.
    const [gone] = await db.select().from(nodes).limit(1);
    await db.delete(nodes).where(eq(nodes.id, gone?.id ?? ""));

    expect((await register(machine, key.token)).status).toBe(200);
    expect(await usesOf(key.id)).toBe(1);
  });

  test("does not turn away a device that is already in the wave", async () => {
    const { waveIds, userId } = await setup();
    const wave = waveIds[0] ?? "";
    const first = await enrol(wave, userId, "a");
    for (const name of ["b", "c"]) await enrol(wave, userId, name);

    // Registering again only refreshes its keys; it is not a new device.
    const again = await register(first.machine);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { status: string }).status).toBe("authorized");
  });

  test("counts a device once when it is in two waves of the account", async () => {
    const { waveIds, userId, accountId } = await setup({ waves: 2 });
    const [one = "", two = ""] = waveIds;
    const shared = await enrol(one, userId, "shared");
    await enrol(one, userId, "b");
    await enrol(one, userId, "c");
    expect(await accountDeviceCount(db, accountId ?? "")).toBe(3);

    // The account is full, and the device it already has still goes into the other wave.
    const key = await createAuthKey(db, { waveId: two, userId });
    const second = await register(shared.machine, key.token);
    expect(second.status).toBe(200);
    expect(await db.select().from(nodes)).toHaveLength(4);
    expect(await accountDeviceCount(db, accountId ?? "")).toBe(3);

    // A new one still does not.
    expect((await enrol(two, userId, "d")).res.status).toBe(403);
  });

  test("counts across the waves of the account, not per wave", async () => {
    const { waveIds, userId } = await setup({ waves: 2 });
    const [one = "", two = ""] = waveIds;
    await enrol(one, userId, "a");
    await enrol(one, userId, "b");
    await enrol(two, userId, "c");

    expect((await enrol(two, userId, "d")).res.status).toBe(403);
    expect((await enrol(one, userId, "e")).res.status).toBe(403);
  });

  test("lets two devices race for the last place with exactly one winner", async () => {
    const { waveIds, userId } = await setup({ waves: 2 });
    const [one = "", two = ""] = waveIds;
    await enrol(one, userId, "a");
    await enrol(one, userId, "b");
    const keyOne = await createAuthKey(db, { waveId: one, userId });
    const keyTwo = await createAuthKey(db, { waveId: two, userId });

    const results = await Promise.all([
      register(makeMachine("x"), keyOne.token),
      register(makeMachine("y"), keyTwo.token),
    ]);

    expect(results.map((res) => res.status).sort()).toEqual([200, 403]);
    expect(await db.select().from(nodes)).toHaveLength(LIMIT);
    // The loser's key was given back.
    expect(((await usesOf(keyOne.id)) ?? 0) + ((await usesOf(keyTwo.id)) ?? 0)).toBe(1);
  });
});

describe("what has no limit", () => {
  test("a wave without an account (self-hosted)", async () => {
    const { waveIds, userId } = await setup({ account: false });
    for (const name of ["a", "b", "c", "d", "e"]) {
      expect((await enrol(waveIds[0] ?? "", userId, name)).res.status).toBe(200);
    }
  });

  test("an account with a subscription in any of its waves", async () => {
    const { waveIds, userId } = await setup({ waves: 2 });
    const [one = "", two = ""] = waveIds;
    await db.insert(waveBilling).values({ waveId: two, subscriptionId: "sub_1", seats: 1, state: "active" });

    // Also in the wave that is not the billed one: the account is what is paid for.
    for (const name of ["a", "b", "c", "d", "e"]) {
      expect((await enrol(one, userId, name)).res.status).toBe(200);
    }
  });

  test("the limit is a setting, 100 unless the server says otherwise", () => {
    expect(loadConfig({ WAVE_ENV: "test" }).freeDeviceLimit).toBe(100);
    expect(loadConfig({ WAVE_ENV: "test", WAVE_FREE_DEVICE_LIMIT: "" }).freeDeviceLimit).toBe(100);
    expect(loadConfig({ WAVE_ENV: "test", WAVE_FREE_DEVICE_LIMIT: "7" }).freeDeviceLimit).toBe(7);
    expect(() => loadConfig({ WAVE_ENV: "test", WAVE_FREE_DEVICE_LIMIT: "0" })).toThrow();
  });
});

describe("the check itself", () => {
  test("the hundred-and-first device of a default account is refused", async () => {
    const { waveIds, userId, accountId } = await setup();
    const wave = waveIds[0] ?? "";
    const rows = Array.from({ length: 100 }, (_, i) => ({
      id: `n_${i}`,
      waveId: wave,
      userId,
      machineKey: `mk_${i}`,
      nodeKey: `nk_${i}`,
      discoKey: `dk_${i}`,
      hostname: `h${i}`,
      os: "linux" as const,
      ipv4: `10.64.0.${i + 2}`,
      ipv6: `fd00::${i + 2}`,
    }));
    await db.insert(nodes).values(rows);

    const error = await ensureDeviceSlot(db, { waveId: wave, machineKey: "mk_new", limit: 100 }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DeviceLimitError);
    expect((error as DeviceLimitError).accountId).toBe(accountId ?? "");
    // One of the hundred is not new.
    await ensureDeviceSlot(db, { waveId: wave, machineKey: "mk_7", limit: 100 });
  });

  test("devices over the limit that were there before stay", async () => {
    const { waveIds, userId } = await setup();
    const wave = waveIds[0] ?? "";
    for (const name of ["a", "b", "c"]) await enrol(wave, userId, name);
    // The account was assigned its waves after they had grown: the limit applies to what comes next.
    const small = testConfig({ WAVE_FREE_DEVICE_LIMIT: "1" });
    app = createApp({ db, config: small, providers: createProviders(small), signingKey: testSigningKey() });

    expect((await enrol(wave, userId, "d")).res.status).toBe(403);
    expect(await db.select().from(nodes)).toHaveLength(3);
  });
});

describe("one device in several waves", () => {
  test("names its wave in the header, and is asked to when it does not", async () => {
    const { waveIds, userId } = await setup({ waves: 2, account: false });
    const [one = "", two = ""] = waveIds;
    const shared = await enrol(one, userId, "shared");
    const key = await createAuthKey(db, { waveId: two, userId });
    expect((await register(shared.machine, key.token)).status).toBe(200);

    const rows = await db.select().from(nodes).where(eq(nodes.machineKey, shared.machine.machine.publicKey));
    expect(rows.map((row) => row.waveId).sort()).toEqual([one, two].sort());
    expect(new Set(rows.map((row) => row.ipv4)).size).toBe(2);

    const ambiguous = await netmapOf(shared.machine);
    expect(ambiguous.status).toBe(409);
    expect(((await ambiguous.json()) as { error: string }).error).toContain("x-wave-id");

    expect((await netmapOf(shared.machine, one)).status).toBe(200);
    expect((await netmapOf(shared.machine, two)).status).toBe(200);
    // A wave the device is not in finds nothing; the header cannot reach another device's node.
    expect((await netmapOf(shared.machine, "w_elsewhere")).status).toBe(404);
  });

  test("logging out of one wave leaves the other", async () => {
    const { waveIds, userId } = await setup({ waves: 2, account: false });
    const [one = "", two = ""] = waveIds;
    const shared = await enrol(one, userId, "shared");
    await register(shared.machine, (await createAuthKey(db, { waveId: two, userId })).token);

    const payload = "{}";
    const out = await app.request(
      "/v1/node/logout",
      signed(shared.machine, "POST", "/v1/node/logout", payload, one),
    );
    expect(out.status).toBe(200);
    const rows = await db.select().from(nodes);
    expect(rows.map((row) => row.waveId)).toEqual([two]);
  });
});

describe("approving in the browser", () => {
  async function askToJoin(machine: Machine): Promise<string> {
    const res = await register(machine);
    const pending = (await res.json()) as { status: string; authUrl: string };
    expect(pending.status).toBe("pending");
    return new URL(pending.authUrl).searchParams.get("request") ?? "";
  }

  const approve = (jar: CookieJar, request: string, language?: string) => {
    const form = new FormData();
    form.set("request", request);
    return app.request("/machine/authorize", {
      method: "POST",
      body: form,
      headers: { cookie: jar.header(), ...(language ? { "accept-language": language } : {}) },
    });
  };

  test("says why in the reader's language, and adds nothing", async () => {
    const { waveIds, userId, jar } = await setup();
    for (const name of ["a", "b", "c"]) await enrol(waveIds[0] ?? "", userId, name);
    const request = await askToJoin(makeMachine("late"));

    const german = await approve(jar, request, "de");
    expect(german.status).toBe(403);
    const page = await german.text();
    expect(page).toContain("Gerätegrenze erreicht");
    expect(page).toContain(`${LIMIT} Geräte`);

    const english = await approve(jar, request, "en");
    expect(english.status).toBe(403);
    expect(await english.text()).toContain("Device limit reached");
    expect(await db.select().from(nodes)).toHaveLength(LIMIT);
  });

  test("lets the same link finish once a place is free", async () => {
    const { waveIds, userId, jar } = await setup();
    for (const name of ["a", "b", "c"]) await enrol(waveIds[0] ?? "", userId, name);
    const request = await askToJoin(makeMachine("late"));
    expect((await approve(jar, request)).status).toBe(403);

    const [gone] = await db.select().from(nodes).limit(1);
    await db.delete(nodes).where(eq(nodes.id, gone?.id ?? ""));

    expect((await approve(jar, request)).status).toBe(200);
    expect(await db.select().from(nodes)).toHaveLength(LIMIT);
  });

  test("takes a device that is new to an unlimited wave at any count", async () => {
    const { waveIds, userId, jar } = await setup({ account: false });
    for (const name of ["a", "b", "c"]) await enrol(waveIds[0] ?? "", userId, name);
    const request = await askToJoin(makeMachine("late"));

    expect((await approve(jar, request)).status).toBe(200);
    expect(await db.select().from(nodes)).toHaveLength(LIMIT + 1);
  });
});

test("the members of the account are not what is counted", async () => {
  // A second member bringing a device counts like anyone: the account is the unit.
  const { waveIds, userId } = await setup();
  const wave = waveIds[0] ?? "";
  const { userId: other } = await login("kim@example.com");
  await db.insert(waveMembers).values({ waveId: wave, userId: other, role: "member" });
  await enrol(wave, userId, "a");
  await enrol(wave, other, "b");
  await enrol(wave, other, "c");

  expect((await enrol(wave, userId, "d")).res.status).toBe(403);
});
