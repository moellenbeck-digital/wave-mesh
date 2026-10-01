import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.ts";
import { setPassword } from "../src/auth/password.ts";
import { createProviders } from "../src/auth/providers.ts";
import type { Database } from "../src/db/client.ts";
import { nodes, users, waves } from "../src/db/schema.ts";
import { buildNetmap } from "../src/netmap/build.ts";
import { addMember } from "../src/waves/members.ts";
import {
  createWave,
  DEFAULT_DNS_BASE,
  ensureWaveForUser,
  normaliseDnsSuffix,
  normaliseWaveName,
  setWaveDomain,
  suggestWave,
  waveSetup,
} from "../src/waves/provision.ts";
import { CookieJar, createTestDb, testConfig, testSigningKey } from "./helpers.ts";

/**
 * The wave's own domain: chosen when it is made, changed when its owner moves
 * it onto a real one. It is the one property that renames every device in the
 * wave, which is why both ends of it are pinned down here.
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

const suffixOf = async (waveId: string): Promise<string | undefined> =>
  (await db.select({ suffix: waves.dnsSuffix }).from(waves).where(eq(waves.id, waveId)).limit(1))[0]?.suffix;

const versionOf = async (waveId: string): Promise<number | undefined> =>
  (await db.select({ v: waves.netmapVersion }).from(waves).where(eq(waves.id, waveId)).limit(1))[0]?.v;

describe("what counts as a domain", () => {
  test("case, surrounding dots and spaces are not part of it", () => {
    expect(normaliseDnsSuffix("  Wave.Example.COM.  ")).toBe("wave.example.com");
    expect(normaliseDnsSuffix(".wave.example.com")).toBe("wave.example.com");
  });

  test("a single label is not a domain", () => {
    // `localhost` or a bare hostname would make every node name a sibling of
    // whatever else the machine resolves that way.
    for (const bad of ["localhost", "wave", "", ".", "wave example.com", "-wave.example.com"]) {
      expect(() => normaliseDnsSuffix(bad)).toThrow(/not a domain name/);
    }
  });

  test("it has to leave room for a device name in front of it", () => {
    expect(() => normaliseDnsSuffix(`${`${"a".repeat(60)}.`.repeat(4)}example.com`)).toThrow();
  });

  test("a wave name stays a slug, because it is also a selector", () => {
    expect(normaliseWaveName("  Robins Netz  ")).toBe("robins-netz");
    for (const bad of ["", "42", "-", "---"]) expect(() => normaliseWaveName(bad)).toThrow(/not a wave name/);
  });

  test("the suggestion is the address, under the placeholder domain", () => {
    expect(suggestWave("robin@example.com")).toEqual({
      name: "robin",
      dnsSuffix: `robin.${DEFAULT_DNS_BASE}`,
    });
  });
});

describe("choosing the domain when the wave is made", () => {
  test("the wave answers for exactly what was asked for", async () => {
    const owner = await user("robin@example.com");
    const created = await createWave(db, { userId: owner, name: "home", dnsSuffix: "wave.example.com" });
    if (!("waveId" in created)) throw new Error(`expected a wave, got ${JSON.stringify(created)}`);
    expect(await suffixOf(created.waveId)).toBe("wave.example.com");
  });

  test("a second wave cannot answer for the same zone", async () => {
    const first = await user("robin@example.com");
    await createWave(db, { userId: first, name: "home", dnsSuffix: "wave.example.com" });

    const second = await user("ada@example.com");
    const refused = await createWave(db, { userId: second, name: "hers", dnsSuffix: "wave.example.com" });
    // Told apart from the prefix race on purpose: retrying never frees a zone.
    expect(refused).toEqual({ conflict: "suffix" });
  });

  test("an account without a browser still gets the placeholder", async () => {
    const id = await user("robin@example.com");
    const provisioned = await ensureWaveForUser(db, id, "robin@example.com");
    expect(provisioned.created).toBe(true);
    expect(await suffixOf(provisioned.waveId ?? "")).toBe(`robin.${DEFAULT_DNS_BASE}`);
  });

  test("setup says which of the three states an account is in", async () => {
    const id = await user("robin@example.com");
    expect(await waveSetup(db, id, "robin@example.com")).toEqual({ state: "needed" });
    const provisioned = await ensureWaveForUser(db, id, "robin@example.com");
    expect(await waveSetup(db, id, "robin@example.com")).toEqual({
      state: "ready",
      waveId: provisioned.waveId ?? "",
    });
  });
});

describe("moving a wave onto another domain", () => {
  test("every device name follows, and the netmap version says so", async () => {
    const owner = await user("robin@example.com");
    const provisioned = await ensureWaveForUser(db, owner, "robin@example.com");
    const waveId = provisioned.waveId ?? "";
    await db.insert(nodes).values({
      id: "n1",
      waveId,
      userId: owner,
      machineKey: "mk",
      nodeKey: "nk",
      discoKey: "dk",
      hostname: "laptop",
      os: "linux",
      ipv4: "10.64.0.1",
      ipv6: "fd7a:1:2::1",
    });

    const before = await versionOf(waveId);
    expect(await setWaveDomain(db, waveId, "Wave.Example.com")).toMatchObject({ name: "robin" });
    expect(await suffixOf(waveId)).toBe("wave.example.com");
    // Every device holds a netmap naming the old zone; without the bump they
    // would keep answering for one the wave has left.
    expect(await versionOf(waveId)).toBe((before ?? 0) + 1);
    expect((await buildNetmap(db, "n1"))?.self.dnsName).toBe("laptop.wave.example.com");
  });

  test("a zone another wave already answers for is refused, not forced", async () => {
    const first = await user("robin@example.com");
    const taken = await createWave(db, { userId: first, name: "home", dnsSuffix: "wave.example.com" });
    const second = await user("ada@example.com");
    const mine = await ensureWaveForUser(db, second, "ada@example.com");

    expect(await setWaveDomain(db, mine.waveId ?? "", "wave.example.com")).toEqual({ conflict: "suffix" });
    expect(await suffixOf(mine.waveId ?? "")).toBe(`ada.${DEFAULT_DNS_BASE}`);
    expect(await suffixOf("waveId" in taken ? taken.waveId : "")).toBe("wave.example.com");
  });

  test("setting the domain it already has is not a conflict with itself", async () => {
    const owner = await user("robin@example.com");
    const provisioned = await ensureWaveForUser(db, owner, "robin@example.com");
    const waveId = provisioned.waveId ?? "";
    const before = await versionOf(waveId);
    expect(await setWaveDomain(db, waveId, `robin.${DEFAULT_DNS_BASE}`)).toMatchObject({ id: waveId });
    // Nothing changed, so nothing has to be fetched again.
    expect(await versionOf(waveId)).toBe(before ?? 0);
  });
});

describe("the domain form", () => {
  /** Signs in through the dev provider and makes a wave for the address. */
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

  const post = (jar: CookieJar, waveId: string, domain: string) =>
    app.request(`/waves/${waveId}/domain`, {
      method: "POST",
      body: new URLSearchParams({ domain }),
      headers: { cookie: jar.header() },
    });

  const userIdByEmail = async (email: string): Promise<string> =>
    (await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1))[0]?.id ?? "";

  const waveIdOf = async (jar: CookieJar): Promise<string> => {
    const me = (await (await app.request("/api/me", { headers: { cookie: jar.header() } })).json()) as {
      waves: { id: string }[];
    };
    return me.waves[0]?.id ?? "";
  };

  async function makeWave(jar: CookieJar, name: string, suffix: string) {
    const res = await app.request("/waves", {
      method: "POST",
      body: new URLSearchParams({ name, suffix }),
      headers: { cookie: jar.header() },
    });
    expect(res.status).toBe(303);
  }

  test("the owner moves it", async () => {
    const owner = await signIn("robin@example.com");
    await makeWave(owner, "robin", `robin.${DEFAULT_DNS_BASE}`);
    const waveId = await waveIdOf(owner);

    expect((await post(owner, waveId, "wave.example.com")).status).toBe(303);
    expect(await suffixOf(waveId)).toBe("wave.example.com");
  });

  test("a member may look but not move", async () => {
    const owner = await signIn("robin@example.com");
    await makeWave(owner, "robin", `robin.${DEFAULT_DNS_BASE}`);
    const waveId = await waveIdOf(owner);

    const ada = await signIn("ada@example.com");
    await addMember(db, waveId, await userIdByEmail("ada@example.com"), "member");
    expect((await post(ada, waveId, "hers.example.com")).status).toBe(403);
    expect(await suffixOf(waveId)).toBe(`robin.${DEFAULT_DNS_BASE}`);
  });

  test("someone outside the wave gets the same answer as for one that is not there", async () => {
    const owner = await signIn("robin@example.com");
    await makeWave(owner, "robin", `robin.${DEFAULT_DNS_BASE}`);
    const waveId = await waveIdOf(owner);

    const stranger = await signIn("mallory@example.com");
    expect((await post(stranger, waveId, "mine.example.com")).status).toBe(404);
    expect((await post(stranger, "does-not-exist", "mine.example.com")).status).toBe(404);
  });

  test("what is not a domain is refused before the wave is touched", async () => {
    const owner = await signIn("robin@example.com");
    await makeWave(owner, "robin", `robin.${DEFAULT_DNS_BASE}`);
    const waveId = await waveIdOf(owner);

    expect((await post(owner, waveId, "localhost")).status).toBe(400);
    expect(await suffixOf(waveId)).toBe(`robin.${DEFAULT_DNS_BASE}`);
  });
});

/**
 * The other half of the same card, and the cheap one: the name is a label for
 * people. Changing it moves nothing -- no device carries it.
 */
describe("the name form", () => {
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

  const post = (jar: CookieJar, waveId: string, name: string) =>
    app.request(`/waves/${waveId}/name`, {
      method: "POST",
      body: new URLSearchParams({ name }),
      headers: { cookie: jar.header() },
    });

  const nameOf = async (waveId: string): Promise<string | undefined> =>
    (await db.select({ name: waves.name }).from(waves).where(eq(waves.id, waveId)).limit(1))[0]?.name;

  const userIdOf = async (email: string): Promise<string> =>
    (await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1))[0]?.id ?? "";

  const waveIdOf = async (jar: CookieJar): Promise<string> => {
    const me = (await (await app.request("/api/me", { headers: { cookie: jar.header() } })).json()) as {
      waves: { id: string }[];
    };
    return me.waves[0]?.id ?? "";
  };

  async function makeWave(jar: CookieJar) {
    const res = await app.request("/waves", {
      method: "POST",
      body: new URLSearchParams({ name: "robin", suffix: `robin.${DEFAULT_DNS_BASE}` }),
      headers: { cookie: jar.header() },
    });
    expect(res.status).toBe(303);
    return await waveIdOf(jar);
  }

  test("an admin renames it, and it stays a slug", async () => {
    const owner = await signIn("robin@example.com");
    const waveId = await makeWave(owner);

    const ada = await signIn("ada@example.com");
    await addMember(db, waveId, await userIdOf("ada@example.com"), "admin");

    expect((await post(ada, waveId, "Robins Netz")).status).toBe(303);
    expect(await nameOf(waveId)).toBe("robins-netz");
  });

  // The point of the whole thing: unlike the suffix, this reaches no device,
  // so nothing is pushed and no netmap is invalidated.
  test("no device has to hear about it", async () => {
    const owner = await signIn("robin@example.com");
    const waveId = await makeWave(owner);
    const before = await versionOf(waveId);

    expect((await post(owner, waveId, "zuhause")).status).toBe(303);
    expect(await versionOf(waveId)).toBe(before);
    expect(await suffixOf(waveId)).toBe(`robin.${DEFAULT_DNS_BASE}`);
  });

  test("a member may look but not rename", async () => {
    const owner = await signIn("robin@example.com");
    const waveId = await makeWave(owner);

    const ada = await signIn("ada@example.com");
    await addMember(db, waveId, await userIdOf("ada@example.com"), "member");
    expect((await post(ada, waveId, "hers")).status).toBe(403);
    expect(await nameOf(waveId)).toBe("robin");
  });

  test("someone outside gets the answer for a wave that is not there", async () => {
    const owner = await signIn("robin@example.com");
    const waveId = await makeWave(owner);

    const stranger = await signIn("mallory@example.com");
    expect((await post(stranger, waveId, "mine")).status).toBe(404);
    expect(await nameOf(waveId)).toBe("robin");
  });

  test("a name that is nothing but punctuation is refused", async () => {
    const owner = await signIn("robin@example.com");
    const waveId = await makeWave(owner);

    expect((await post(owner, waveId, "---")).status).toBe(400);
    expect(await nameOf(waveId)).toBe("robin");
  });
});
