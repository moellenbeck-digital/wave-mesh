import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Database } from "../src/db/client.ts";
import { nodes, users, waves } from "../src/db/schema.ts";
import { newId } from "../src/ids.ts";
import { allocatePrefix } from "../src/net/addressing.ts";
import { ensureWaveForUser } from "../src/waves/provision.ts";
import { createTestDb } from "./helpers.ts";

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

const CONTAINER = "10.64.0.0/10";

describe("allocatePrefix", () => {
  test("hands out the lowest free block", () => {
    expect(allocatePrefix(CONTAINER, 16, [])).toBe("10.64.0.0/16");
    expect(allocatePrefix(CONTAINER, 16, ["10.64.0.0/16"])).toBe("10.65.0.0/16");
  });

  test("fills a gap rather than counting on past the end", () => {
    expect(allocatePrefix(CONTAINER, 16, ["10.64.0.0/16", "10.66.0.0/16"])).toBe("10.65.0.0/16");
  });

  test("leaves a block that is already spoken for alone", () => {
    // The deployment's wave sits at 10.77.0.0/16 and keeps it; the next wave
    // gets the lowest block that is actually free.
    expect(allocatePrefix(CONTAINER, 16, ["10.77.0.0/16"])).toBe("10.64.0.0/16");
    expect(allocatePrefix(CONTAINER, 16, ["10.64.0.0/16", "10.77.0.0/16"])).toBe("10.65.0.0/16");
  });

  test("ignores blocks that are not in the container at all", () => {
    // A wave left over in the CGNAT range holds nothing here.
    expect(allocatePrefix(CONTAINER, 16, ["100.64.0.0/16"])).toBe("10.64.0.0/16");
  });

  test("says what the limit is when the container is full", () => {
    const taken = Array.from({ length: 64 }, (_, i) => `10.${64 + i}.0.0/16`);
    expect(() => allocatePrefix(CONTAINER, 16, taken)).toThrow(/64 blocks of \/16/);
  });

  test("refuses a block larger than the container", () => {
    expect(() => allocatePrefix("10.64.0.0/16", 10, [])).toThrow(/does not fit/);
  });
});

describe("provisioning", () => {
  test("gives every wave a block of its own", async () => {
    await ensureWaveForUser(db, await user("robin@example.com"), "robin@example.com");
    await ensureWaveForUser(db, await user("mallory@example.com"), "mallory@example.com");

    const rows = await db.select({ prefix: waves.ipv4Prefix }).from(waves);
    const prefixes = rows.map((row) => row.prefix).sort();
    expect(prefixes).toEqual(["10.64.0.0/16", "10.65.0.0/16"]);
  });

  test("a second login does not hand out a second block", async () => {
    const userId = await user("robin@example.com");
    const first = await ensureWaveForUser(db, userId, "robin@example.com");
    const again = await ensureWaveForUser(db, userId, "robin@example.com");

    expect(again).toEqual({ waveId: first.waveId, created: false, deferred: false });
    expect(await db.select().from(waves)).toHaveLength(1);
  });
});

describe("the migration back out of the CGNAT range", () => {
  /**
   * 0003 put the deployment's wave on 100.64.0.0/16, where another mesh VPN on
   * the same machine drops its traffic; 0004 puts it back. Both have already run by the time the test db
   * is handed over, so this recreates the state 0004 was written for and
   * replays it.
   */
  test("restores the prefix and every device's number", async () => {
    const ownerUserId = await user("robin@example.com");
    const waveId = newId("w");
    await db.insert(waves).values({
      id: waveId,
      name: "rl",
      dnsSuffix: "rl.wave.internal",
      ownerUserId,
      ipv4Prefix: "100.64.0.0/16",
      ipv6Prefix: "fd7a:8b47:c285::/48",
    });

    for (const [index, ipv4] of ["100.64.0.1", "100.64.0.2", "100.64.0.3"].entries()) {
      await db.insert(nodes).values({
        id: newId("n"),
        waveId,
        userId: ownerUserId,
        machineKey: `machine-${index}`,
        nodeKey: `node-${index}`,
        discoKey: `disco-${index}`,
        hostname: `host-${index}`,
        os: "linux",
        ipv4,
        ipv6: `fd7a:8b47:c285::${index + 1}`,
      });
    }

    await moveBack(db);

    const wave = (await db.select().from(waves).where(eq(waves.id, waveId)))[0];
    expect(wave?.ipv4Prefix).toBe("10.77.0.0/16");
    // Bumped, so every connected node fetches the new map.
    expect(wave?.netmapVersion).toBe(2);

    const moved = await db.select({ ipv4: nodes.ipv4 }).from(nodes).orderBy(nodes.ipv4);
    expect(moved.map((row) => row.ipv4)).toEqual(["10.77.0.1", "10.77.0.2", "10.77.0.3"]);
  });

  test("a wave somewhere else is not touched", async () => {
    const ownerUserId = await user("other@example.com");
    await db.insert(waves).values({
      id: newId("w"),
      name: "other",
      dnsSuffix: "other.wave.internal",
      ownerUserId,
      ipv4Prefix: "10.65.0.0/16",
      ipv6Prefix: "fd7a:1:2::/48",
    });

    await moveBack(db);

    const rows = await db.select({ prefix: waves.ipv4Prefix }).from(waves);
    expect(rows.map((row) => row.prefix)).toEqual(["10.65.0.0/16"]);
  });
});

/** The data half of drizzle/0004, run against an already-migrated database. */
async function moveBack(db: Database): Promise<void> {
  await db.execute(`
    UPDATE nodes SET ipv4 = host('10.77.0.0'::inet + (nodes.ipv4::inet - '100.64.0.0'::inet))
    FROM waves w
    WHERE w.id = nodes.wave_id AND w.ipv4_prefix = '100.64.0.0/16'`);

  await db.execute(`
    UPDATE waves SET ipv4_prefix = '10.77.0.0/16', netmap_version = netmap_version + 1
    WHERE ipv4_prefix = '100.64.0.0/16'`);
}
