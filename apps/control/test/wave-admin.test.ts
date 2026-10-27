import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { setPassword } from "../src/auth/password.ts";
import type { Database } from "../src/db/client.ts";
import { nodes, waveMembers, waves } from "../src/db/schema.ts";
import { isAmbiguous, resolveWave } from "../src/waves/lookup.ts";
import { addMember, listMembers, removeMember, roleOf } from "../src/waves/members.ts";
import { findNode, listNodes, removeNode } from "../src/waves/nodes.ts";
import { ensureWaveForUser } from "../src/waves/provision.ts";
import { createTestDb } from "./helpers.ts";

/**
 * What the operator commands in `admin.ts` stand on. The command line itself
 * needs a real Postgres, so this covers the parts that decide what it does:
 * which wave a selector means, and what adding or removing does.
 */
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

const user = async (email: string): Promise<string> =>
  (await setPassword(db, email, "correct horse battery")).userId;

async function waveFor(email: string): Promise<string> {
  const id = await user(email);
  const provisioned = await ensureWaveForUser(db, id, email);
  if (!provisioned.waveId) throw new Error("expected a wave");
  return provisioned.waveId;
}

describe("naming a wave on the command line", () => {
  test("by name, by id and by the owner's address", async () => {
    const waveId = await waveFor("robin@example.com");
    const named = await resolveWave(db, "robin");
    expect(isAmbiguous(named) ? null : named?.id).toBe(waveId);
    expect(isAmbiguous(named) ? null : named?.ownerEmail).toBe("robin@example.com");

    for (const selector of [waveId, "robin@example.com", " ROBIN@example.com "]) {
      const found = await resolveWave(db, selector);
      expect(isAmbiguous(found) ? null : found?.id).toBe(waveId);
    }
  });

  test("an unknown selector is null, not the first wave", async () => {
    await waveFor("robin@example.com");
    expect(await resolveWave(db, "nobody@example.com")).toBeNull();
    expect(await resolveWave(db, "")).toBeNull();
  });

  test("several matches are named, never picked", async () => {
    const owner = await user("robin@example.com");
    // Two waves of the same name: possible, since only the suffix is unique.
    for (const [id, suffix, prefix] of [
      ["w1", "one.wave.internal", "10.64.0.0/16"],
      ["w2", "two.wave.internal", "10.65.0.0/16"],
    ] as const) {
      await db.insert(waves).values({
        id,
        name: "shared",
        dnsSuffix: suffix,
        ownerUserId: owner,
        ipv4Prefix: prefix,
        ipv6Prefix: "fd7a:1:2::/48",
      });
      await db.insert(waveMembers).values({ waveId: id, userId: owner, role: "owner" });
    }

    const found = await resolveWave(db, "shared");
    expect(isAmbiguous(found)).toBe(true);
    expect(isAmbiguous(found) ? found.ambiguous.map((w) => w.id).sort() : []).toEqual(["w1", "w2"]);
  });
});

describe("adding and removing by hand", () => {
  test("adding twice changes the role instead of doubling the row", async () => {
    const waveId = await waveFor("robin@example.com");
    const ada = await user("ada@example.com");

    expect(await addMember(db, waveId, ada, "member")).toEqual({ added: true, role: "member" });
    expect(await addMember(db, waveId, ada, "member")).toEqual({ added: false, role: "member" });
    expect(await addMember(db, waveId, ada, "admin")).toEqual({ added: false, role: "admin" });
    expect(await listMembers(db, waveId)).toHaveLength(2);
    expect(await roleOf(db, waveId, ada)).toBe("admin");
  });

  test("the owner is never demoted by adding them again", async () => {
    const waveId = await waveFor("robin@example.com");
    const owner = (await listMembers(db, waveId))[0]?.userId ?? "";
    expect(await addMember(db, waveId, owner, "member")).toEqual({ added: false, role: "owner" });
    expect(await roleOf(db, waveId, owner)).toBe("owner");
  });

  test("removing says why it refuses", async () => {
    const waveId = await waveFor("robin@example.com");
    const owner = (await listMembers(db, waveId))[0]?.userId ?? "";
    const ada = await user("ada@example.com");
    await addMember(db, waveId, ada, "admin");

    expect(await removeMember(db, waveId, "owner", owner)).toBe("owner");
    expect(await removeMember(db, waveId, "owner", await user("grace@example.com"))).toBe("not-a-member");
    // An admin decides about members, the owner about admins.
    expect(await removeMember(db, waveId, "admin", ada)).toBe("forbidden");
    expect(await removeMember(db, waveId, "owner", ada)).toEqual({ removedNodes: 0 });
    expect(await roleOf(db, waveId, ada)).toBeNull();
  });

  test("a member count is per wave, not per account", async () => {
    const first = await waveFor("robin@example.com");
    const second = await waveFor("grace@example.com");
    const ada = await user("ada@example.com");
    await addMember(db, first, ada, "member");

    expect((await listMembers(db, first)).map((m) => m.email)).toEqual([
      "robin@example.com",
      "ada@example.com",
    ]);
    expect((await listMembers(db, second)).map((m) => m.email)).toEqual(["grace@example.com"]);
  });
});

describe("the devices of a wave on the command line", () => {
  /** A node as enrolment would leave it, without walking the browser flow. */
  async function device(waveId: string, userId: string, hostname: string, ipv4: string): Promise<string> {
    const id = `n_${hostname}`;
    await db.insert(nodes).values({
      id,
      waveId,
      userId,
      machineKey: `mk_${hostname}`,
      nodeKey: `nk_${hostname}`,
      discoKey: `dk_${hostname}`,
      hostname,
      os: "linux",
      ipv4,
      ipv6: "fd7a:1:2::1",
    });
    return id;
  }

  test("lists them with the address and whose they are", async () => {
    const waveId = await waveFor("robin@example.com");
    const owner = (await listMembers(db, waveId))[0]?.userId ?? "";
    const ada = await user("ada@example.com");
    await addMember(db, waveId, ada, "member");
    await device(waveId, owner, "laptop", "10.64.0.1");
    await device(waveId, ada, "phone", "10.64.0.2");

    expect((await listNodes(db, waveId)).map((n) => [n.hostname, n.ipv4, n.email])).toEqual([
      ["laptop", "10.64.0.1", "robin@example.com"],
      ["phone", "10.64.0.2", "ada@example.com"],
    ]);
  });

  test("names one by hostname or by id, and only inside its wave", async () => {
    const waveId = await waveFor("robin@example.com");
    const owner = (await listMembers(db, waveId))[0]?.userId ?? "";
    const id = await device(waveId, owner, "laptop", "10.64.0.1");
    const elsewhere = await waveFor("grace@example.com");

    expect((await findNode(db, waveId, "laptop"))?.id).toBe(id);
    expect((await findNode(db, waveId, id))?.hostname).toBe("laptop");
    expect(await findNode(db, waveId, "desktop")).toBeNull();
    // The same id, asked for in the wrong wave: not a device of that one.
    expect(await findNode(db, elsewhere, id)).toBeNull();
  });

  test("removing counts the wave's netmap up, and twice is null", async () => {
    const waveId = await waveFor("robin@example.com");
    const owner = (await listMembers(db, waveId))[0]?.userId ?? "";
    const id = await device(waveId, owner, "laptop", "10.64.0.1");
    const before = (await db.select().from(waves).where(eq(waves.id, waveId)))[0]?.netmapVersion ?? 0;

    expect(await removeNode(db, waveId, id)).toEqual({ id, hostname: "laptop", userId: owner });
    expect(await removeNode(db, waveId, id)).toBeNull();
    expect((await db.select().from(waves).where(eq(waves.id, waveId)))[0]?.netmapVersion).toBe(before + 1);
    expect(await listNodes(db, waveId)).toEqual([]);
  });
});
