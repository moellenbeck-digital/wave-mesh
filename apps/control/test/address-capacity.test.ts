import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.ts";
import { createProviders } from "../src/auth/providers.ts";
import { createWaveForUser, creationPolicyOf, NoWaveCapacityError } from "../src/billing/free-account.ts";
import { applySubscription } from "../src/billing/subscriptions.ts";
import type { Database } from "../src/db/client.ts";
import { customerAccounts, users, waves } from "../src/db/schema.ts";
import { checkFreePrefixLength, loadConfig } from "../src/env.ts";
import { newId } from "../src/ids.ts";
import {
  allocatePrefix,
  allocatesFromTop,
  type CapacityReport,
  ContainerFullError,
  capacityOf,
  freeBlocks,
  parseIpv4Cidr,
  usableAddresses,
} from "../src/net/addressing.ts";
import { serverCapacity } from "../src/net/capacity.ts";
import { CapacityReserveError, createWave, IPV4_PREFIX_LENGTH } from "../src/waves/provision.ts";
import { CookieJar, createTestDb, testConfig, testSigningKey } from "./helpers.ts";

/**
 * Ticket #118: address capacity for many hosted waves. A free wave gets a /24,
 * a billed one stays a /16, and the two sizes share one container without ever
 * overlapping.
 */

const CONTAINER = "10.64.0.0/10";

describe("allocatePrefix with blocks of mixed sizes", () => {
  test("small blocks are numbered from the top, large ones from the bottom", () => {
    expect(allocatesFromTop(24)).toBe(true);
    expect(allocatesFromTop(16)).toBe(false);
    expect(allocatePrefix(CONTAINER, 24, [])).toBe("10.127.255.0/24");
    expect(allocatePrefix(CONTAINER, 24, ["10.127.255.0/24"])).toBe("10.127.254.0/24");
    expect(allocatePrefix(CONTAINER, 16, ["10.127.255.0/24"])).toBe("10.64.0.0/16");
  });

  test("a /16 still takes the lowest free block, whatever the /24s do", () => {
    const small: string[] = [];
    for (let i = 0; i < 300; i++) small.push(allocatePrefix(CONTAINER, 24, small));
    expect(allocatePrefix(CONTAINER, 16, small)).toBe("10.64.0.0/16");
    expect(allocatePrefix(CONTAINER, 16, ["10.64.0.0/16", ...small])).toBe("10.65.0.0/16");
  });

  test("300 free waves chip at two /16s from the top and leave the other 62 whole", () => {
    const taken: string[] = [];
    for (let i = 0; i < 300; i++) taken.push(allocatePrefix(CONTAINER, 24, taken));
    expect(freeBlocks(CONTAINER, 16, taken)).toBe(62);
    expect(taken).toContain("10.127.0.0/24");
    expect(taken).toContain("10.126.212.0/24");
    expect(new Set(taken).size).toBe(300);
  });

  test("a /16 is refused where a /24 sits inside it, and moves on to the next", () => {
    expect(allocatePrefix(CONTAINER, 16, ["10.64.5.0/24"])).toBe("10.65.0.0/16");
    expect(allocatePrefix(CONTAINER, 16, ["10.64.0.0/24", "10.65.255.0/24"])).toBe("10.66.0.0/16");
  });

  test("a /24 is refused where a larger block contains it", () => {
    expect(allocatePrefix(CONTAINER, 24, ["10.127.0.0/16"])).toBe("10.126.255.0/24");
    // Taken from the top, so the /17 holds the top half of the highest /16.
    expect(allocatePrefix(CONTAINER, 24, ["10.127.128.0/17"])).toBe("10.127.127.0/24");
  });

  test("a /24 skips over a /20 and a /22 that cover the top", () => {
    expect(allocatePrefix(CONTAINER, 24, ["10.127.240.0/20"])).toBe("10.127.239.0/24");
    expect(allocatePrefix(CONTAINER, 24, ["10.127.252.0/22", "10.127.251.0/24"])).toBe("10.127.250.0/24");
  });

  test("a block is only offered at an address aligned to its own size", () => {
    // Free space starts at an odd /24: a /23 may not start there.
    const container = "10.0.0.0/22";
    expect(allocatePrefix(container, 23, ["10.0.0.0/24"])).toBe("10.0.2.0/23");
    expect(() => allocatePrefix(container, 22, ["10.0.0.0/24"])).toThrow(ContainerFullError);
    // Bottom-up: the /20 at 10.0.16.0 spoils the /19 at 10.0.0.0, the next one is 10.0.32.0.
    expect(allocatePrefix("10.0.0.0/18", 19, ["10.0.16.0/20"])).toBe("10.0.32.0/19");
  });

  test("ignores blocks outside the container and clips one that holds all of it", () => {
    expect(allocatePrefix("10.64.0.0/16", 24, ["10.200.0.0/16", "100.64.0.0/10"])).toBe("10.64.255.0/24");
    // 10.0.0.0/8 reaches over the whole container: nothing is left.
    expect(() => allocatePrefix("10.64.0.0/16", 24, ["10.0.0.0/8"])).toThrow(ContainerFullError);
    // A /17 inside the container takes only its half of it.
    expect(allocatePrefix("10.64.0.0/16", 17, ["10.64.0.0/17"])).toBe("10.64.128.0/17");
  });

  test("a full container says the size and that nothing is free", () => {
    const container = "10.64.0.0/22";
    const taken = ["10.64.0.0/24", "10.64.1.0/24", "10.64.2.0/24", "10.64.3.0/24"];
    expect(() => allocatePrefix(container, 24, taken)).toThrow(ContainerFullError);
    expect(() => allocatePrefix(container, 24, taken)).toThrow(/\/24.*4 blocks of \/24: 0 free, 4 taken/);
    // A /23 is blocked by the /24s inside it too.
    expect(() => allocatePrefix(container, 23, ["10.64.1.0/24", "10.64.3.0/24"])).toThrow(
      /2 blocks of \/23: 0 free/,
    );
  });

  test("a container full of /24s answers fast", () => {
    const all = Array.from({ length: 16384 }, (_, i) => `10.${64 + (i >> 8)}.${i & 255}.0/24`);
    const started = performance.now();
    expect(() => allocatePrefix(CONTAINER, 24, all)).toThrow(ContainerFullError);
    expect(() => allocatePrefix(CONTAINER, 16, all)).toThrow(ContainerFullError);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("rejects a length that is not a prefix length", () => {
    expect(() => allocatePrefix(CONTAINER, 33, [])).toThrow(/prefix length/);
    expect(() => allocatePrefix(CONTAINER, 16.5, [])).toThrow(/prefix length/);
  });
});

describe("capacity figures", () => {
  test("counts free blocks per size, a block shared by two taken ones once", () => {
    const taken = ["10.64.0.0/16", "10.127.255.0/24", "10.127.254.0/24"];
    expect(freeBlocks(CONTAINER, 16, taken)).toBe(62);
    expect(freeBlocks(CONTAINER, 24, taken)).toBe(16384 - 256 - 2);
    expect(freeBlocks(CONTAINER, 16, [])).toBe(64);
    expect(freeBlocks("10.64.0.0/24", 16, [])).toBe(0);
  });

  test("reports what is held and what is left", () => {
    const report: CapacityReport = capacityOf(CONTAINER, [
      "10.64.0.0/16",
      "10.127.255.0/24",
      "10.127.254.0/24",
      "100.64.0.0/16",
    ]);
    expect(report.totalAddresses).toBe(2 ** 22);
    expect(report.usedAddresses).toBe(2 ** 16 + 2 * 256);
    expect(report.usedShare).toBeCloseTo((2 ** 16 + 512) / 2 ** 22, 10);
    expect(report.used).toEqual([
      { prefixLength: 16, blocks: 1 },
      { prefixLength: 24, blocks: 2 },
    ]);
    expect(report.free).toEqual([
      { prefixLength: 16, blocks: 62, total: 64 },
      { prefixLength: 24, blocks: 16384 - 256 - 2, total: 16384 },
    ]);
  });

  test("an empty container is entirely free", () => {
    const report = capacityOf(CONTAINER, []);
    expect(report.usedAddresses).toBe(0);
    expect(report.used).toEqual([]);
    expect(report.free[0]).toEqual({ prefixLength: 16, blocks: 64, total: 64 });
  });
});

describe("how small a free block may be", () => {
  test("takes network, broadcast and the resolver's address off", () => {
    expect(usableAddresses(24)).toEqual({ usable: 253, resolverFits: true });
    expect(usableAddresses(16)).toEqual({ usable: 65533, resolverFits: true });
    expect(usableAddresses(26)).toEqual({ usable: 61, resolverFits: true });
    expect(usableAddresses(27)).toEqual({ usable: 30, resolverFits: false });
  });

  test("a /27 is refused at start: no room for the resolver's address", () => {
    expect(() => checkFreePrefixLength(27, 10, CONTAINER)).toThrow(/cannot hold the wave's resolver address/);
  });

  test("a block too small for the device limit is refused, with the numbers", () => {
    expect(() => checkFreePrefixLength(26, 100, CONTAINER)).toThrow(/leaves 61 usable addresses.*=100/);
    expect(() => checkFreePrefixLength(26, 61, CONTAINER)).not.toThrow();
    expect(() => checkFreePrefixLength(24, 100, CONTAINER)).not.toThrow();
  });

  test("a block larger than the container is refused", () => {
    expect(() => checkFreePrefixLength(16, 100, "10.64.0.0/24")).toThrow(/does not fit/);
  });

  test("loadConfig applies the check and defaults to a /24 and a reserve", () => {
    const config = loadConfig({ WAVE_ENV: "test" });
    expect(config.freeIpv4PrefixLength).toBe(24);
    expect(config.capacityReserve).toBe(4);
    expect(loadConfig({ WAVE_ENV: "test", WAVE_FREE_IPV4_PREFIX_LENGTH: "25" }).freeIpv4PrefixLength).toBe(
      25,
    );
    expect(loadConfig({ WAVE_ENV: "test", WAVE_FREE_IPV4_PREFIX_LENGTH: "" }).freeIpv4PrefixLength).toBe(24);
    expect(() => loadConfig({ WAVE_ENV: "test", WAVE_FREE_IPV4_PREFIX_LENGTH: "27" })).toThrow(/too small/);
    expect(() =>
      loadConfig({ WAVE_ENV: "test", WAVE_FREE_IPV4_PREFIX_LENGTH: "26", WAVE_FREE_DEVICE_LIMIT: "100" }),
    ).toThrow(/too small/);
    expect(() => loadConfig({ WAVE_ENV: "test", WAVE_FREE_IPV4_PREFIX_LENGTH: "8" })).toThrow();
    expect(loadConfig({ WAVE_ENV: "test", WAVE_CAPACITY_RESERVE: "0" }).capacityReserve).toBe(0);
  });
});

describe("numbering waves in the database", () => {
  let db: Database;
  let close: () => Promise<void>;
  let reset: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close, reset } = await createTestDb());
  });
  afterAll(() => close());
  beforeEach(async () => {
    await reset();
  });

  const user = async (email: string): Promise<string> => {
    const id = newId("u");
    await db.insert(users).values({ id, email });
    return id;
  };

  const prefixes = async (): Promise<string[]> =>
    (await db.select({ prefix: waves.ipv4Prefix }).from(waves)).map((row) => row.prefix).sort();

  const overlaps = (a: string, b: string): boolean => {
    const x = parseIpv4Cidr(a);
    const y = parseIpv4Cidr(b);
    return x.base < y.base + y.size && y.base < x.base + x.size;
  };

  const assertDisjoint = (all: string[]): void => {
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        expect(overlaps(all[i] as string, all[j] as string)).toBe(false);
      }
    }
  };

  test("waves of both sizes get blocks that never overlap", async () => {
    const owner = await user("robin@example.com");
    await createWave(db, { userId: owner, name: "big", dnsSuffix: "big.wave.internal" });
    await createWave(db, {
      userId: owner,
      name: "small",
      dnsSuffix: "small.wave.internal",
      prefixLength: 24,
    });
    await createWave(db, { userId: owner, name: "big2", dnsSuffix: "big2.wave.internal" });
    expect(await prefixes()).toEqual(["10.127.255.0/24", "10.64.0.0/16", "10.65.0.0/16"].sort());
  });

  test("parallel creation of mixed waves never makes overlapping blocks", async () => {
    const owner = await user("robin@example.com");
    const made = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        createWave(db, {
          userId: owner,
          name: `w${i}`,
          dnsSuffix: `w${i}.wave.internal`,
          prefixLength: i % 4 === 0 ? 16 : 24,
        }),
      ),
    );
    expect(made.every((result) => "waveId" in result)).toBe(true);
    const all = await prefixes();
    expect(all).toHaveLength(40);
    expect(new Set(all).size).toBe(40);
    assertDisjoint(all);
  });

  test("a wave and its owner membership come together, or not at all", async () => {
    const owner = await user("robin@example.com");
    await createWave(db, { userId: owner, name: "taken", dnsSuffix: "same.wave.internal" });
    const again = await createWave(db, { userId: owner, name: "other", dnsSuffix: "same.wave.internal" });
    expect(again).toEqual({ conflict: "suffix" });
    expect(await prefixes()).toHaveLength(1);
  });

  test("a full container is a ContainerFullError and leaves nothing behind", async () => {
    const owner = await user("robin@example.com");
    const container = "10.64.0.0/23";
    await createWave(db, {
      userId: owner,
      name: "a",
      dnsSuffix: "a.wave.internal",
      container,
      prefixLength: 24,
    });
    await createWave(db, {
      userId: owner,
      name: "b",
      dnsSuffix: "b.wave.internal",
      container,
      prefixLength: 24,
    });
    await expect(
      createWave(db, { userId: owner, name: "c", dnsSuffix: "c.wave.internal", container, prefixLength: 24 }),
    ).rejects.toBeInstanceOf(ContainerFullError);
    expect(await prefixes()).toHaveLength(2);
  });

  test("the reserve refuses what would leave too few whole /16s, and says so in the log", async () => {
    const owner = await user("robin@example.com");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      // 64 whole /16s; keeping all 64 leaves no room for even one /24.
      await expect(
        createWave(db, {
          userId: owner,
          name: "a",
          dnsSuffix: "a.wave.internal",
          prefixLength: 24,
          reserve: { blocks: 64, enforce: true },
        }),
      ).rejects.toBeInstanceOf(CapacityReserveError);
      expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/below reserve.*63 whole \/16/);
      expect(await prefixes()).toHaveLength(0);

      // Without enforcement the wave is made and the warning is all there is.
      warn.mockClear();
      const made = await createWave(db, {
        userId: owner,
        name: "b",
        dnsSuffix: "b.wave.internal",
        prefixLength: 24,
        reserve: { blocks: 64, enforce: false },
      });
      expect("waveId" in made).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);

      // A reserve that still holds is silent.
      warn.mockClear();
      await createWave(db, {
        userId: owner,
        name: "c",
        dnsSuffix: "c.wave.internal",
        prefixLength: 24,
        reserve: { blocks: 4, enforce: true },
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("a /24 in the last /16 does not eat a whole /16 each time", async () => {
    const owner = await user("robin@example.com");
    for (let i = 0; i < 10; i++) {
      await createWave(db, {
        userId: owner,
        name: `f${i}`,
        dnsSuffix: `f${i}.wave.internal`,
        prefixLength: 24,
        reserve: { blocks: 63, enforce: true },
      });
    }
    expect((await serverCapacity(db, testConfig())).reserve.free).toBe(63);
  });

  test("the capacity report reads the database", async () => {
    const owner = await user("robin@example.com");
    await createWave(db, { userId: owner, name: "big", dnsSuffix: "big.wave.internal" });
    await createWave(db, {
      userId: owner,
      name: "small",
      dnsSuffix: "small.wave.internal",
      prefixLength: 24,
    });
    const report = await serverCapacity(db, testConfig({ WAVE_CAPACITY_RESERVE: "63" }));
    expect(report.container).toBe(CONTAINER);
    expect(report.used).toEqual([
      { prefixLength: 16, blocks: 1 },
      { prefixLength: 24, blocks: 1 },
    ]);
    expect(report.free.find((e) => e.prefixLength === 16)).toEqual({
      prefixLength: 16,
      blocks: 62,
      total: 64,
    });
    expect(report.reserve).toEqual({ blocks: 63, free: 62, below: true });
    expect(report.outside).toBe(0);

    const ok = await serverCapacity(db, testConfig());
    expect(ok.reserve.below).toBe(false);
  });

  test("a wave outside the container is reported, not counted", async () => {
    const owner = await user("robin@example.com");
    await db.insert(waves).values({
      id: newId("w"),
      name: "old",
      dnsSuffix: "old.wave.internal",
      ownerUserId: owner,
      ipv4Prefix: "100.64.0.0/16",
      ipv6Prefix: "fd7a:1:2::/48",
    });
    const report = await serverCapacity(db, testConfig());
    expect(report.outside).toBe(1);
    expect(report.usedAddresses).toBe(0);
  });

  test("self-hosted creation (no billing) stays a /16", async () => {
    const owner = await user("robin@example.com");
    const policy = creationPolicyOf(testConfig());
    expect(policy.hosted).toBe(false);
    const made = await createWaveForUser(db, policy, {
      userId: owner,
      name: "home",
      dnsSuffix: "home.wave.internal",
    });
    expect(made.kind).toBe("created");
    expect(await prefixes()).toEqual(["10.64.0.0/16"]);
    expect(IPV4_PREFIX_LENGTH).toBe(16);
  });
});

describe("free sign-up and capacity", () => {
  let db: Database;
  let close: () => Promise<void>;
  let reset: () => Promise<void>;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    ({ db, close, reset } = await createTestDb());
  });
  afterAll(() => close());

  const makeApp = (overrides: Record<string, string> = {}) => {
    const config = testConfig({ WAVE_BILLING_TOKEN: "x".repeat(32), ...overrides });
    app = createApp({ db, config, providers: createProviders(config), signingKey: testSigningKey() });
  };

  beforeEach(async () => {
    await reset();
    makeApp();
  });

  async function dev(email: string): Promise<CookieJar> {
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

  const create = (jar: CookieJar, name: string) =>
    app.request("/waves", {
      method: "POST",
      body: new URLSearchParams({ name, suffix: `${name}.wave.internal` }),
      headers: { cookie: jar.header(), accept: "application/json" },
    });

  const prefixes = async () =>
    (await db.select({ prefix: waves.ipv4Prefix }).from(waves)).map((r) => r.prefix);

  test("a free wave is a /24 from the top, a billed one a /16 from the bottom", async () => {
    const res = await create(await dev("anna@acme.example"), "alpha");
    expect(res.status).toBe(303);
    const paid = await applySubscription(db, "sub_1", {
      email: "pay@corp.example",
      name: "corp",
      seats: 3,
      state: "active",
    });
    expect(paid.kind).toBe("applied");
    expect((await prefixes()).sort()).toEqual(["10.127.255.0/24", "10.64.0.0/16"].sort());
  });

  test("the free length is configurable", async () => {
    makeApp({ WAVE_FREE_IPV4_PREFIX_LENGTH: "25" });
    await create(await dev("anna@acme.example"), "alpha");
    expect(await prefixes()).toEqual(["10.127.255.128/25"]);
  });

  test("below the reserve nothing is made: no wave, no account, the existing refusal", async () => {
    makeApp({ WAVE_CAPACITY_RESERVE: "64" });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const jar = await dev("anna@acme.example");
      const res = await create(jar, "alpha");
      expect(res.status).toBe(507);
      expect(await res.json()).toEqual({ error: "no-capacity" });
      expect(await db.select().from(waves)).toHaveLength(0);
      expect(await db.select().from(customerAccounts)).toHaveLength(0);
      expect(error.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(
        /NO CAPACITY.*address reserve reached/,
      );
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  test("a full container refuses the next free sign-up and keeps the earlier ones", async () => {
    makeApp({ WAVE_IPV4_CONTAINER: "10.64.0.0/24" });
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await create(await dev("one@acme.example"), "one")).status).toBe(303);
      const second = await dev("two@acme.example");
      const res = await create(second, "two");
      expect(res.status).toBe(507);
      expect(await res.json()).toEqual({ error: "no-capacity" });
      expect(await prefixes()).toEqual(["10.64.0.0/24"]);
      // One account, the first user's; none for the refused one.
      const accounts = await db.select().from(customerAccounts);
      expect(accounts).toHaveLength(1);
      const [two] = await db.select().from(users).where(eq(users.email, "two@acme.example"));
      expect(accounts[0]?.ownerUserId).not.toBe(two?.id);
    } finally {
      error.mockRestore();
    }
  });

  test("createWaveForUser throws NoWaveCapacityError with the reason, and rolls the account back", async () => {
    const config = testConfig({ WAVE_BILLING_TOKEN: "x".repeat(32), WAVE_CAPACITY_RESERVE: "64" });
    const owner = newId("u");
    await db.insert(users).values({ id: owner, email: "anna@acme.example", emailVerified: true });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const attempt = createWaveForUser(db, creationPolicyOf(config), {
        userId: owner,
        name: "alpha",
        dnsSuffix: "alpha.wave.internal",
      });
      await expect(attempt).rejects.toBeInstanceOf(NoWaveCapacityError);
      await attempt.catch((error) => expect((error as NoWaveCapacityError).detail).toMatch(/reserve/));
      expect(await db.select().from(customerAccounts)).toHaveLength(0);
      expect(await db.select().from(waves)).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  test("a customer who has paid is never refused for the reserve, only logged", async () => {
    makeApp({ WAVE_CAPACITY_RESERVE: "64" });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const paid = await applySubscription(
        db,
        "sub_1",
        { email: "pay@corp.example", name: "corp", seats: 3, state: "active" },
        { capacityReserve: 64 },
      );
      expect(paid.kind).toBe("applied");
      expect(await prefixes()).toEqual(["10.64.0.0/16"]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
