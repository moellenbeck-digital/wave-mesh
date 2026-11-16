import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.ts";
import { deleteAccount } from "../src/auth/delete-account.ts";
import { setPassword } from "../src/auth/password.ts";
import { requestReset } from "../src/auth/password-reset.ts";
import { createSession } from "../src/auth/session.ts";
import { newTotpSecret, TOTP_STEP_MS, totp } from "../src/auth/totp.ts";
import { regenerateRecoveryCodes } from "../src/auth/two-factor.ts";
import type { Database } from "../src/db/client.ts";
import {
  accountSubscriptions,
  auditLog,
  customerAccounts,
  identities,
  nodes,
  passwordResets,
  sessions,
  totpRecoveryCodes,
  users,
  waveBilling,
  waveInvites,
  waveMembers,
  waves,
} from "../src/db/schema.ts";
import { createInvite } from "../src/waves/invites.ts";
import { addMember, changeRole } from "../src/waves/members.ts";
import { createWave } from "../src/waves/provision.ts";
import { createTestDb, testConfig, testSigningKey } from "./helpers.ts";

/**
 * Deleting one's own account (ticket #31). What matters is what it refuses and
 * what it leaves standing: another person's wave must survive its owner, a
 * wave with others in it must not lose its last administrator, and a stolen
 * session must not be enough to erase an account with a second factor.
 */
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
  app = createApp({ db, config: testConfig(), providers: new Map(), signingKey: testSigningKey() });
});

const user = async (email: string): Promise<string> =>
  (await setPassword(db, email, "correct horse battery")).userId;

async function wave(ownerId: string, name: string): Promise<string> {
  const made = await createWave(db, { userId: ownerId, name, dnsSuffix: `${name}.wave.internal` });
  if ("conflict" in made) throw new Error("the fixture collided with itself");
  return made.waveId;
}

let counter = 0;
async function device(waveId: string, userId: string, id: string): Promise<void> {
  counter += 1;
  await db.insert(nodes).values({
    id,
    waveId,
    userId,
    machineKey: `mk-${id}`,
    nodeKey: `nk-${id}`,
    discoKey: `dk-${id}`,
    hostname: `host-${id}`,
    os: "linux",
    ipv4: `10.64.0.${counter}`,
    ipv6: `fd7a:1:2::${counter}`,
  });
}

/** A browser session for a user, without going through a login. */
async function cookieOf(userId: string): Promise<string> {
  const { token } = await createSession(db, userId);
  return `wave_session=${token}`;
}

const post = (cookie: string, body: unknown, type = "application/json") =>
  app.request("/api/me/delete", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": type, cookie },
  });

const exists = async (userId: string) =>
  (await db.select({ id: users.id }).from(users).where(eq(users.id, userId))).length === 1;
const waveExists = async (waveId: string) =>
  (await db.select({ id: waves.id }).from(waves).where(eq(waves.id, waveId))).length === 1;

describe("POST /api/me/delete: who may ask", () => {
  test("a request without a session is refused", async () => {
    expect((await post("", { email: "robin@example.com" })).status).toBe(401);
  });

  test("only JSON is taken, which no foreign form can send", async () => {
    const id = await user("robin@example.com");
    const res = await post(
      await cookieOf(id),
      { email: "robin@example.com" },
      "application/x-www-form-urlencoded",
    );
    expect(res.status).toBe(415);
    expect(await exists(id)).toBe(true);
  });

  test("another address, or none, deletes nothing", async () => {
    const id = await user("robin@example.com");
    const cookie = await cookieOf(id);
    expect((await post(cookie, { email: "sam@example.com" })).status).toBe(400);
    expect((await post(cookie, {})).status).toBe(400);
    expect((await post(cookie, { email: "DELETE" })).status).toBe(400);
    expect(await exists(id)).toBe(true);
  });

  test("the address is compared without regard to case, and the answer ends the session", async () => {
    const id = await user("robin@example.com");
    await db.insert(identities).values({ id: "id1", userId: id, provider: "google", subject: "g-1" });
    const cookie = await cookieOf(id);
    const res = await post(cookie, { email: "  Robin@Example.COM " });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().join(";")).toMatch(/wave_session=;|Max-Age=0/i);
    expect(await exists(id)).toBe(false);
    expect((await db.select().from(sessions)).length).toBe(0);
    expect((await db.select().from(identities)).length).toBe(0);
    // The session is gone for good.
    expect((await app.request("/api/me/delete-preview", { headers: { cookie } })).status).toBe(401);
  });

  test("an account without an address confirms with DELETE", async () => {
    await db.insert(users).values({ id: "u_insta", email: null, name: "insta" });
    const cookie = await cookieOf("u_insta");
    const preview = (await (await app.request("/api/me/delete-preview", { headers: { cookie } })).json()) as {
      confirmation: string;
      word: string;
    };
    expect(preview.confirmation).toBe("word");
    expect(preview.word).toBe("DELETE");
    expect((await post(cookie, { email: "delete" })).status).toBe(400);
    expect((await post(cookie, { email: "DELETE" })).status).toBe(200);
    expect(await exists("u_insta")).toBe(false);
  });
});

describe("the waves of the account", () => {
  test("a wave the user is alone in goes with them, devices included", async () => {
    const id = await user("robin@example.com");
    const waveId = await wave(id, "robin");
    await device(waveId, id, "n1");
    const hub = spyOn(app.hub, "disconnect");

    expect((await post(await cookieOf(id), { email: "robin@example.com" })).status).toBe(200);
    expect(await waveExists(waveId)).toBe(false);
    expect((await db.select().from(nodes)).length).toBe(0);
    expect(hub).toHaveBeenCalledWith(waveId, "n1", "node-removed");
  });

  test("a wave with another administrator stays and gets a new owner", async () => {
    const owner = await user("robin@example.com");
    const admin = await user("sam@example.com");
    const guest = await user("kim@example.com");
    const waveId = await wave(owner, "robin");
    await addMember(db, waveId, guest, "member");
    await addMember(db, waveId, admin, "admin");
    await device(waveId, owner, "n1");
    await device(waveId, guest, "n2");
    const before = (await db.select().from(waves).where(eq(waves.id, waveId)))[0]?.netmapVersion ?? 0;
    const hub = spyOn(app.hub, "disconnect");
    const broadcast = spyOn(app.hub, "broadcast");

    expect((await post(await cookieOf(owner), { email: "robin@example.com" })).status).toBe(200);

    const kept = (await db.select().from(waves).where(eq(waves.id, waveId)))[0];
    expect(kept?.ownerUserId).toBe(admin);
    expect(kept?.netmapVersion).toBeGreaterThan(before);
    const members = await db.select().from(waveMembers).where(eq(waveMembers.waveId, waveId));
    expect(members.map((m) => [m.userId, m.role]).sort()).toEqual(
      [
        [admin, "owner"],
        [guest, "member"],
      ].sort(),
    );
    // Only the deleted user's device went; the rest is told.
    expect((await db.select().from(nodes)).map((n) => n.id)).toEqual(["n2"]);
    expect(hub).toHaveBeenCalledWith(waveId, "n1", "node-removed");
    expect(broadcast).toHaveBeenCalledWith(waveId);
  });

  test("an owner among the remaining administrators is preferred, else the oldest admin", async () => {
    const leaving = await user("robin@example.com");
    const first = await user("sam@example.com");
    const second = await user("kim@example.com");
    const waveId = await wave(leaving, "robin");
    await addMember(db, waveId, first, "admin");
    await addMember(db, waveId, second, "admin");
    expect((await post(await cookieOf(leaving), { email: "robin@example.com" })).status).toBe(200);
    expect((await db.select().from(waves).where(eq(waves.id, waveId)))[0]?.ownerUserId).toBe(first);
  });

  test("the last administrator of a wave with others in it is refused, naming the wave", async () => {
    const owner = await user("robin@example.com");
    const guest = await user("sam@example.com");
    const waveId = await wave(owner, "robin");
    const alone = await wave(owner, "solo");
    await addMember(db, waveId, guest, "member");
    await device(waveId, owner, "n1");
    const cookie = await cookieOf(owner);

    const res = await post(cookie, { email: "robin@example.com" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string;
      waves: { id: string; name: string }[];
      message: string;
    };
    expect(body.error).toBe("last-admin");
    expect(body.waves).toEqual([{ id: waveId, name: "robin" }]);
    expect(body.message).toContain("robin");
    // Nothing happened: not even the wave the user is alone in.
    expect(await exists(owner)).toBe(true);
    expect(await waveExists(waveId)).toBe(true);
    expect(await waveExists(alone)).toBe(true);
    expect((await db.select().from(nodes)).length).toBe(1);

    const preview = (await (await app.request("/api/me/delete-preview", { headers: { cookie } })).json()) as {
      blockers: { name: string }[];
      deleted: { name: string }[];
    };
    expect(preview.blockers.map((w) => w.name)).toEqual(["robin"]);
    expect(preview.deleted.map((w) => w.name)).toEqual(["solo"]);

    // Handed over (here: the guest is made an admin), it goes through.
    await changeRole(db, waveId, owner, guest, "admin");
    expect((await post(cookie, { email: "robin@example.com" })).status).toBe(200);
    expect((await db.select().from(waves).where(eq(waves.id, waveId)))[0]?.ownerUserId).toBe(guest);
    expect(await waveExists(alone)).toBe(false);
  });

  test("a plain member just leaves; their devices go and the wave is untouched", async () => {
    const owner = await user("robin@example.com");
    const guest = await user("sam@example.com");
    const waveId = await wave(owner, "robin");
    await addMember(db, waveId, guest, "member");
    await device(waveId, guest, "n2");

    expect((await post(await cookieOf(guest), { email: "sam@example.com" })).status).toBe(200);
    expect((await db.select().from(waves).where(eq(waves.id, waveId)))[0]?.ownerUserId).toBe(owner);
    expect((await db.select().from(waveMembers)).map((m) => m.userId)).toEqual([owner]);
    expect((await db.select().from(nodes)).length).toBe(0);
  });
});

describe("a pier", () => {
  test("its wildcard is handed back for the zone, whether the wave goes or stays", async () => {
    const owner = await user("robin@example.com");
    const guest = await user("sam@example.com");
    const gone = await wave(owner, "solo");
    await device(gone, owner, "n1");
    await db.update(nodes).set({ pierIpv4: "203.0.113.7" }).where(eq(nodes.id, "n1"));
    const kept = await wave(guest, "sam");
    await addMember(db, kept, owner, "admin");
    await device(kept, owner, "n2");
    await db.update(nodes).set({ pierIpv4: "203.0.113.8" }).where(eq(nodes.id, "n2"));

    const result = await deleteAccount(db, owner);
    if (result.kind !== "deleted") throw new Error(`expected a deletion, got ${result.kind}`);
    expect(result.piers.map((p) => [p.waveId, p.host.publicIpv4]).sort()).toEqual(
      [
        [gone, "203.0.113.7"],
        [kept, "203.0.113.8"],
      ].sort(),
    );
  });
});

describe("audit and what the address left behind", () => {
  test("every wave that stays says what happened, without the person in it", async () => {
    const owner = await user("robin@example.com");
    const guest = await user("sam@example.com");
    const waveId = await wave(owner, "robin");
    await addMember(db, waveId, guest, "admin");
    await device(waveId, owner, "n1");
    await device(waveId, owner, "n3");

    await post(await cookieOf(owner), { email: "robin@example.com" });
    const entries = (await db.select().from(auditLog).where(eq(auditLog.action, "account.delete"))) ?? [];
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatchObject({
      waveId,
      actor: "deleted-account",
      actorUserId: null,
      target: null,
      detail: { role: "owner", removedDevices: 2 },
    });
    expect(JSON.stringify(entries)).not.toContain("robin@example.com");
    expect(JSON.stringify(entries)).not.toContain(owner);
  });

  test("older entries lose the address, and invitations to it are withdrawn", async () => {
    const owner = await user("robin@example.com");
    const guest = await user("sam@example.com");
    const waveId = await wave(guest, "sam");
    await addMember(db, waveId, owner, "admin");
    await db.insert(auditLog).values([
      { id: "a1", waveId, actorUserId: owner, actor: "robin@example.com", action: "acl.set" },
      {
        id: "a2",
        waveId,
        actorUserId: guest,
        actor: "sam@example.com",
        action: "member.remove",
        target: owner,
      },
      {
        id: "a3",
        waveId,
        actorUserId: guest,
        actor: "sam@example.com",
        action: "invite.create",
        target: "robin@example.com",
      },
    ]);
    await createInvite(db, {
      waveId,
      waveName: "sam",
      email: "robin@example.com",
      role: "member",
      invitedByUserId: guest,
      baseUrl: "https://wave.example.com",
    });

    await post(await cookieOf(owner), { email: "robin@example.com" });
    const log = await db.select().from(auditLog);
    expect(JSON.stringify(log)).not.toContain("robin@example.com");
    expect(log.find((e) => e.id === "a1")?.actor).toBe("deleted-account");
    expect(log.find((e) => e.id === "a2")?.target).toBe("deleted-account");
    expect(log.find((e) => e.id === "a2")?.actor).toBe("sam@example.com");
    expect((await db.select().from(waveInvites)).length).toBe(0);
  });
});

describe("an open password reset", () => {
  test("goes with the account: no row for the address, and no address in the audit or console log", async () => {
    const id = await user("robin@example.com");
    const other = await user("sam@example.com");
    expect((await requestReset(db, { email: "robin@example.com" })).kind).toBe("pending");
    // A link that was issued to the address under another user id (the address
    // changed hands) is not removed by the cascade of the account's own rows.
    await db.insert(passwordResets).values({
      id: "pr_stale",
      userId: other,
      email: "robin@example.com",
      tokenHash: "stale-hash",
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect((await db.select().from(passwordResets)).length).toBe(2);

    const log = spyOn(console, "log").mockImplementation(() => {});
    log.mockClear();
    try {
      expect((await post(await cookieOf(id), { email: "robin@example.com" })).status).toBe(200);
      expect(log.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain("robin@example.com");
    } finally {
      log.mockRestore();
    }
    expect(await db.select().from(passwordResets)).toEqual([]);
    expect(JSON.stringify(await db.select().from(auditLog))).not.toContain("robin@example.com");
    expect(await exists(other)).toBe(true);
  });
});

describe("a billed wave", () => {
  test("is deleted with the account, is named beforehand, and the orphaned subscription is logged without a person", async () => {
    const id = await user("robin@example.com");
    const waveId = await wave(id, "robin");
    await db.insert(waveBilling).values({ waveId, subscriptionId: "sub_wave", seats: 3, state: "active" });
    await db.insert(customerAccounts).values({ id: "ca_1", ownerUserId: id });
    await db.update(waves).set({ accountId: "ca_1" }).where(eq(waves.id, waveId));
    await db
      .insert(accountSubscriptions)
      .values({ id: "as_1", subscriptionId: "sub_account", accountId: "ca_1", seats: 5, state: "active" });
    const cookie = await cookieOf(id);

    const preview = (await (await app.request("/api/me/delete-preview", { headers: { cookie } })).json()) as {
      billed: { id: string; name: string; outcome: string }[];
      accountSubscription: boolean;
    };
    expect(preview.billed).toEqual([{ id: waveId, name: "robin", outcome: "delete" }]);
    expect(preview.accountSubscription).toBe(true);

    const log = spyOn(console, "log").mockImplementation(() => {});
    // An earlier file may have left a spy on console.log; spyOn then returns
    // that one with its calls. Only the lines of this request count.
    log.mockClear();
    try {
      expect((await post(cookie, { email: "robin@example.com" })).status).toBe(200);
      const lines = log.mock.calls.map((call) => String(call[0]));
      expect(lines.some((l) => l.includes("sub_wave") && l.includes(waveId))).toBe(true);
      expect(lines.some((l) => l.includes("sub_account") && l.includes("ca_1"))).toBe(true);
      expect(lines.join("\n")).not.toContain("robin@example.com");
    } finally {
      log.mockRestore();
    }
    expect(await waveExists(waveId)).toBe(false);
    expect((await db.select().from(customerAccounts)).length).toBe(0);
    expect((await db.select().from(accountSubscriptions)).length).toBe(0);
  });

  test("a billed wave that is handed over keeps its billing row and loses the customer account link", async () => {
    const owner = await user("robin@example.com");
    const admin = await user("sam@example.com");
    const waveId = await wave(owner, "robin");
    await addMember(db, waveId, admin, "admin");
    await db.insert(waveBilling).values({ waveId, subscriptionId: "sub_wave", seats: 3, state: "active" });
    await db.insert(customerAccounts).values({ id: "ca_1", ownerUserId: owner });
    await db.update(waves).set({ accountId: "ca_1" }).where(eq(waves.id, waveId));

    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect((await post(await cookieOf(owner), { email: "robin@example.com" })).status).toBe(200);
    } finally {
      log.mockRestore();
    }
    const kept = (await db.select().from(waves).where(eq(waves.id, waveId)))[0];
    expect(kept?.ownerUserId).toBe(admin);
    expect(kept?.accountId).toBeNull();
    expect((await db.select().from(waveBilling)).length).toBe(1);
  });
});

describe("with a second factor", () => {
  const email = "robin@example.com";
  let id: string;
  let secret: string;
  let cookie: string;

  beforeEach(async () => {
    id = await user(email);
    secret = newTotpSecret();
    await db
      .update(users)
      .set({ totpSecret: secret, totpEnabledAt: new Date(), totpLastStep: null })
      .where(eq(users.id, id));
    cookie = await cookieOf(id);
  });

  test("a code is required, and a wrong one is refused and counted", async () => {
    expect((await post(cookie, { email })).status).toBe(400);
    const wrong = await post(cookie, { email, code: "000000" });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: string }).error).toBe("invalid-code");
    expect(await exists(id)).toBe(true);
  });

  test("ten wrong codes throttle the account", async () => {
    for (let i = 0; i < 10; i++) await post(cookie, { email, code: "000000" });
    const res = await post(cookie, { email, code: totp(secret, Date.now()) });
    expect(res.status).toBe(429);
    expect(await exists(id)).toBe(true);
  });

  test("a right code deletes the account", async () => {
    expect((await post(cookie, { email, code: totp(secret, Date.now()) })).status).toBe(200);
    expect(await exists(id)).toBe(false);
  });

  test("a recovery code works, and a refusal before it does not spend it", async () => {
    const recovery = (await regenerateRecoveryCodes(db, id, totp(secret, Date.now() + TOTP_STEP_MS)))?.[0];
    expect(recovery).toBeDefined();
    const guest = await user("sam@example.com");
    const waveId = await wave(id, "robin");
    await addMember(db, waveId, guest, "member");

    // Refused for the wave before the code is looked at: it stays unused.
    expect((await post(cookie, { email, code: recovery })).status).toBe(409);
    const unused = await db.select().from(totpRecoveryCodes).where(eq(totpRecoveryCodes.userId, id));
    expect(unused.filter((row) => row.usedAt !== null).length).toBe(0);

    await changeRole(db, waveId, id, guest, "admin");
    expect((await post(cookie, { email, code: recovery })).status).toBe(200);
    expect(await exists(id)).toBe(false);
  });
});
