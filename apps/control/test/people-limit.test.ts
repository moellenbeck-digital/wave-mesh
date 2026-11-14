import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  accountPlan,
  accountRoster,
  countPeople,
  DEFAULT_FREE_LIMITS,
  seatRule,
} from "../src/billing/plan.ts";
import { AccountSeatLimitError } from "../src/billing/seats.ts";
import type { Database } from "../src/db/client.ts";
import {
  accountSubscriptions,
  customerAccounts,
  nodes,
  users,
  waveInvites,
  waveMembers,
  waves,
} from "../src/db/schema.ts";
import { acceptInvite, createInvite, revokeInvite } from "../src/waves/invites.ts";
import { addMember, removeMember } from "../src/waves/members.ts";
import { createWave } from "../src/waves/provision.ts";
import { createTestDb } from "./helpers.ts";

/**
 * Ticket #115: three people per free hosted account, across all its waves.
 *
 * The rule itself is #117 (`billing/plan.ts`, `billing/seats.ts`). These tests
 * pin what the ticket asks to be certain of: how a person is recognised, where
 * the limit applies and where it cannot, that a seat comes back when the last
 * way in is gone, and that what is already there is never taken away. The
 * races (two at once for the last seat) need a real Postgres and are in
 * `people-limit-concurrency.test.ts`.
 *
 * Every way into `wave_members` and `wave_invites`, and why each is covered:
 *
 * | Where                                         | Limit there                                                  |
 * |-----------------------------------------------|--------------------------------------------------------------|
 * | invite: browser, JSON API, `wave-admin invite`| `createInvite` -> `ensureSeatFor`; the three only call it     |
 * | accept: both routes -> `acceptInvite`         | none of its own: the invitation was the seat; locks the account |
 * | `wave-admin add-member`                       | `addMember` -> `ensureSeatFor` (central since #115)          |
 * | `addMember` from anywhere else                | the same                                                     |
 * | `createWave` (owner)                          | none, safe: the owner of the account is counted already      |
 * | `setup-links` `moveTo`, `account-link` merge  | none, safe: swaps one person for one, never adds             |
 * | `migrate-accounts`                            | writes no member or invitation, only `waves.account_id`      |
 */

let db: Database;
let close: () => Promise<void>;
let reset: () => Promise<void>;

beforeAll(async () => {
  ({ db, close, reset } = await createTestDb());
});
afterAll(() => close());
beforeEach(() => reset());

let waveCounter = 0;

/** An account with its owner and waves, written the way the code leaves them. */
async function account(owner = "u_anna", accountId = "ca_anna", names: string[] = ["alpha", "beta"]) {
  await db.insert(users).values({ id: owner, email: `${owner}@x.example`, emailVerified: true });
  await db.insert(customerAccounts).values({ id: accountId, ownerUserId: owner });
  const ids: string[] = [];
  for (const name of names) {
    const n = ++waveCounter;
    const id = `w_${name}`;
    ids.push(id);
    await db.insert(waves).values({
      id,
      name,
      dnsSuffix: `${name}.wave.example.com`,
      ownerUserId: owner,
      accountId,
      ipv4Prefix: `10.${64 + n}.0.0/16`,
      ipv6Prefix: `fd7a:${n}:1::/48`,
    });
    await db.insert(waveMembers).values({ waveId: id, userId: owner, role: "owner" });
  }
  return { owner, accountId, waves: ids as [string, string] };
}

const person = async (id: string, options: { email?: string | null; verified?: boolean } = {}) => {
  const email = options.email === undefined ? `${id}@x.example` : options.email;
  await db.insert(users).values({ id, email, emailVerified: options.verified ?? true });
  return id;
};

const join = async (waveId: string, userId: string) =>
  db.insert(waveMembers).values({ waveId, userId, role: "member" });

const invite = (waveId: string, email: string, by = "u_anna") =>
  createInvite(db, {
    waveId,
    waveName: "w",
    email,
    role: "member",
    invitedByUserId: by,
    baseUrl: "http://localhost",
  });

const refused = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error) => error,
  );

const peopleNow = async (accountId = "ca_anna") => {
  const plan = await accountPlan(db, accountId);
  return countPeople(await accountRoster(db, accountId), seatRule(plan, DEFAULT_FREE_LIMITS).mode);
};

describe("who counts as one person", () => {
  test("case and blanks around an address make no second person", async () => {
    const {
      waves: [w1],
    } = await account();
    await person("u_ben");
    await join(w1, "u_ben");
    // Anna, Ben, and one invitation -- written three ways, it stays one.
    await invite(w1, "C@X.example");
    await invite(w1, "  c@x.EXAMPLE ");
    await invite(w1, "c@x.example");
    expect(await peopleNow()).toBe(3);
    expect(await db.select().from(waveInvites).where(eq(waveInvites.email, "c@x.example"))).toHaveLength(3);
    expect(await refused(invite(w1, " D@x.example"))).toBeInstanceOf(AccountSeatLimitError);
  });

  test("the same user in two waves is one person; an address of a member in another wave costs nothing", async () => {
    const {
      waves: [w1, w2],
    } = await account();
    await person("u_ben");
    await join(w1, "u_ben");
    await join(w2, "u_ben");
    await invite(w1, "c@x.example");
    expect(await peopleNow()).toBe(3);
    // Ben is a member of both already; his address, however written, is no one new.
    await invite(w2, "u_ben@x.example");
    await invite(w2, "  U_BEN@X.EXAMPLE");
    expect(await peopleNow()).toBe(3);
    expect(await refused(invite(w2, "d@x.example"))).toBeInstanceOf(AccountSeatLimitError);
  });

  test("two open invitations for one address in two waves are one person", async () => {
    const {
      waves: [w1, w2],
    } = await account();
    await invite(w1, "b@x.example");
    await invite(w2, "B@x.example");
    expect(await peopleNow()).toBe(2);
    await invite(w2, "c@x.example");
    expect(await refused(invite(w1, "d@x.example"))).toBeInstanceOf(AccountSeatLimitError);
  });

  test("a member without an address counts, by user id, and in a second wave costs nothing", async () => {
    const {
      waves: [w1, w2],
    } = await account();
    await person("u_nomail", { email: null, verified: false });
    await join(w1, "u_nomail");
    await invite(w1, "c@x.example");
    expect(await peopleNow()).toBe(3);
    expect(await refused(invite(w1, "d@x.example"))).toBeInstanceOf(AccountSeatLimitError);
    // Known by id: one more wave is no one more.
    expect(await addMember(db, w2, "u_nomail", "member")).toEqual({ added: true, role: "member" });
    expect(await peopleNow()).toBe(3);
  });

  test("a member with an unconfirmed address counts, but the address does not make an invitation free", async () => {
    const {
      waves: [w1, w2],
    } = await account();
    await person("u_ben", { verified: false });
    await join(w1, "u_ben");
    // Ben's address is not confirmed, so it is not him: the invitation is a seat of its own.
    await invite(w2, "u_ben@x.example");
    expect(await peopleNow()).toBe(3);
    expect(await refused(invite(w2, "d@x.example"))).toBeInstanceOf(AccountSeatLimitError);
  });

  test("...which keeps another user with that address from walking in as a fourth person", async () => {
    // `users.email` is not unique: an unconfirmed row can carry an address that
    // belongs to someone else. Had it made the invitation free, the person the
    // address really belongs to could have accepted it as a fourth person.
    const {
      waves: [w1, w2],
    } = await account();
    await person("u_squat", { email: "ben@x.example", verified: false });
    await join(w1, "u_squat");
    await person("u_cara");
    await join(w1, "u_cara");
    expect(await peopleNow()).toBe(3);
    expect(await refused(invite(w2, "ben@x.example"))).toBeInstanceOf(AccountSeatLimitError);
    expect(await db.select().from(waveInvites)).toHaveLength(0);
  });

  test("an unconfirmed address cannot take the invitation, whatever the count says", async () => {
    const {
      waves: [w1],
    } = await account();
    const sent = await invite(w1, "ben@x.example");
    const ben = await person("u_ben", { email: "ben@x.example", verified: false });
    expect(
      await acceptInvite(db, sent.token, { id: ben, email: "ben@x.example", emailVerified: false }),
    ).toBe("unverified-address");
    expect(await peopleNow()).toBe(2);
  });

  test("an invitation the person accepts is the same seat: nothing is gained or lost", async () => {
    const {
      waves: [w1],
    } = await account();
    const sent = await invite(w1, "b@x.example");
    await invite(w1, "c@x.example");
    expect(await peopleNow()).toBe(3);
    const ben = await person("u_ben", { email: "b@x.example" });
    // Accepting needs no seat -- the invitation was one -- and the account is
    // still full afterwards: the fourth person is refused before and after.
    expect(await refused(invite(w1, "d@x.example"))).toBeInstanceOf(AccountSeatLimitError);
    expect(
      await acceptInvite(db, sent.token, { id: ben, email: "B@x.example ", emailVerified: true }),
    ).toMatchObject({
      waveId: w1,
    });
    expect(await peopleNow()).toBe(3);
    expect(await refused(invite(w1, "d@x.example"))).toBeInstanceOf(AccountSeatLimitError);
  });
});

describe("where the limit applies", () => {
  test("adding a member by hand (wave-admin add-member goes through addMember) is held to it", async () => {
    const {
      waves: [w1, w2],
    } = await account();
    for (const id of ["u_ben", "u_cara", "u_dora"]) await person(id);
    await addMember(db, w1, "u_ben", "member");
    await addMember(db, w2, "u_cara", "member");
    const error = await refused(addMember(db, w2, "u_dora", "member"));
    expect(error).toBeInstanceOf(AccountSeatLimitError);
    expect(error).toMatchObject({ accountId: "ca_anna", limit: 3, plan: "free", used: 3 });
    // Nothing was written for the one who was refused.
    expect(await db.select().from(waveMembers).where(eq(waveMembers.userId, "u_dora"))).toHaveLength(0);
    // Someone who is in already takes no new seat, in another wave or when only the role changes.
    expect(await addMember(db, w1, "u_cara", "member")).toEqual({ added: true, role: "member" });
    expect(await addMember(db, w1, "u_ben", "admin")).toEqual({ added: false, role: "admin" });
  });

  test("an open invitation holds its seat against a member added by hand", async () => {
    const {
      waves: [w1, w2],
    } = await account();
    await person("u_ben");
    await person("u_cara");
    await invite(w1, "x@x.example");
    await addMember(db, w2, "u_ben", "member");
    expect(await refused(addMember(db, w2, "u_cara", "member"))).toBeInstanceOf(AccountSeatLimitError);
  });

  test("adding the person an invitation is for does not cost a second seat", async () => {
    const {
      waves: [w1, w2],
    } = await account();
    await person("u_ben");
    await invite(w1, "u_ben@x.example");
    await invite(w1, "c@x.example");
    expect(await peopleNow()).toBe(3);
    // Ben holds a seat through his invitation; making him a member of the other wave is the same person.
    expect(await addMember(db, w2, "u_ben", "member")).toEqual({ added: true, role: "member" });
    expect(await peopleNow()).toBe(3);
  });

  test("a wave without an account has no limit, by invitation or by hand", async () => {
    await db.insert(users).values({ id: "u_owner", email: "owner@x.example", emailVerified: true });
    const made = await createWave(db, { userId: "u_owner", name: "home", dnsSuffix: "home.wave.internal" });
    if (!("waveId" in made)) throw new Error("expected a wave");
    await db.insert(users).values({ id: "u_x", email: "x@x.example", emailVerified: true });
    for (const email of ["a@x.example", "b@x.example", "c@x.example", "d@x.example", "e@x.example"]) {
      await createInvite(db, {
        waveId: made.waveId,
        waveName: "home",
        email,
        role: "member",
        invitedByUserId: "u_owner",
        baseUrl: "http://localhost",
      });
    }
    expect(await addMember(db, made.waveId, "u_x", "member")).toMatchObject({ added: true });
  });

  test("a new wave of the account's owner adds nobody: the owner is counted already", async () => {
    const { owner, accountId } = await account("u_anna", "ca_anna", ["alpha"]);
    await person("u_ben");
    await person("u_cara");
    await join("w_alpha", "u_ben");
    await join("w_alpha", "u_cara");
    expect(await peopleNow()).toBe(3);
    const made = await createWave(db, {
      userId: owner,
      name: "gamma",
      dnsSuffix: "gamma.wave.example.com",
      accountId,
    });
    expect("waveId" in made).toBe(true);
    expect(await peopleNow()).toBe(3);
  });

  test("an account with a subscription counts the seats it has, not three", async () => {
    const {
      waves: [w1],
    } = await account();
    await db.insert(accountSubscriptions).values({
      id: "as_1",
      subscriptionId: "sub_1",
      accountId: "ca_anna",
      seats: 5,
      state: "active",
    });
    for (const email of ["b", "c", "d", "e"]) await invite(w1, `${email}@x.example`);
    expect(await refused(invite(w1, "f@x.example"))).toBeInstanceOf(AccountSeatLimitError);
    expect(await refused(invite(w1, "f@x.example"))).toMatchObject({ limit: 5, plan: "paid" });
  });
});

describe("a seat comes back", () => {
  test("removing the last membership of a person frees the seat; staying in another wave keeps it", async () => {
    const {
      waves: [w1, w2],
    } = await account();
    for (const id of ["u_ben", "u_cara"]) await person(id);
    await join(w1, "u_ben");
    await join(w2, "u_ben");
    await join(w1, "u_cara");
    expect(await refused(invite(w1, "d@x.example"))).toBeInstanceOf(AccountSeatLimitError);

    // Ben leaves one wave and is still in the other: the seat stays taken.
    expect(await removeMember(db, w1, "owner", "u_ben")).toMatchObject({ removedNodes: 0 });
    expect(await refused(invite(w1, "d@x.example"))).toBeInstanceOf(AccountSeatLimitError);

    // Ben's last membership: the fourth person fits.
    await removeMember(db, w2, "owner", "u_ben");
    await invite(w1, "d@x.example");
    expect(await peopleNow()).toBe(3);
  });

  test("revoking the last invitation for an address frees the seat; another invitation for it keeps it", async () => {
    const {
      waves: [w1, w2],
    } = await account();
    await invite(w1, "b@x.example");
    await invite(w2, "b@x.example");
    await invite(w1, "c@x.example");
    expect(await refused(invite(w1, "d@x.example"))).toBeInstanceOf(AccountSeatLimitError);

    expect(await revokeInvite(db, w1, { email: " B@x.example" })).toBe(true);
    expect(await refused(invite(w1, "d@x.example"))).toBeInstanceOf(AccountSeatLimitError);

    expect(await revokeInvite(db, w2, { email: "b@x.example" })).toBe(true);
    await invite(w1, "d@x.example");
  });

  test("an invitation that has expired no longer holds its seat", async () => {
    const {
      waves: [w1],
    } = await account();
    await invite(w1, "b@x.example");
    await invite(w1, "c@x.example");
    await db
      .update(waveInvites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(waveInvites.email, "c@x.example"));
    await invite(w1, "d@x.example");
  });
});

describe("what is there stays", () => {
  const device = (waveId: string, userId: string, n: number) =>
    db.insert(nodes).values({
      id: `n-${n}`,
      waveId,
      userId,
      machineKey: `mk-${n}`,
      nodeKey: `nk-${n}`,
      discoKey: `dk-${n}`,
      hostname: `h${n}`,
      os: "linux",
      ipv4: `10.64.0.${n}`,
      ipv6: `fd7a:1:2::${n}`,
      approved: true,
    });

  test("at the limit nothing is cut: the fourth is refused, members, devices and invitations are untouched", async () => {
    const {
      waves: [w1],
    } = await account();
    await person("u_ben");
    await join(w1, "u_ben");
    await invite(w1, "c@x.example");
    await device(w1, "u_anna", 1);
    await device(w1, "u_ben", 2);
    const membersBefore = await db.select().from(waveMembers);
    expect(await refused(invite(w1, "d@x.example"))).toBeInstanceOf(AccountSeatLimitError);
    expect(await db.select().from(waveMembers)).toEqual(membersBefore);
    expect(await db.select().from(nodes)).toHaveLength(2);
    expect(await db.select().from(waveInvites).where(eq(waveInvites.email, "c@x.example"))).toHaveLength(1);
  });

  test("after a downgrade with more people than free allows: all stay, only the new are refused, a sent invitation still works", async () => {
    const {
      waves: [w1, w2],
    } = await account();
    await db.insert(accountSubscriptions).values({
      id: "as_1",
      subscriptionId: "sub_1",
      accountId: "ca_anna",
      seats: 6,
      state: "active",
    });
    let n = 0;
    for (const id of ["u_ben", "u_cara", "u_dora", "u_emil"]) {
      await person(id);
      await join(id === "u_emil" ? w2 : w1, id);
      await device(id === "u_emil" ? w2 : w1, id, ++n);
    }
    const pending = await invite(w1, "f@x.example");
    expect(await peopleNow()).toBe(6);

    // The subscription ends; the account is free again, five people and an invitation over the limit.
    await db.update(accountSubscriptions).set({ state: "ended" }).where(eq(accountSubscriptions.id, "as_1"));
    expect(await accountPlan(db, "ca_anna")).toEqual({ kind: "free" });

    const membersBefore = await db.select().from(waveMembers);
    const nodesBefore = await db.select().from(nodes);
    expect(membersBefore).toHaveLength(6);
    expect(nodesBefore).toHaveLength(4);

    // New ones are refused, by invitation and by hand, with the real number.
    expect(await refused(invite(w1, "g@x.example"))).toMatchObject({ limit: 3, used: 6, plan: "free" });
    await person("u_gero");
    expect(await refused(addMember(db, w1, "u_gero", "member"))).toBeInstanceOf(AccountSeatLimitError);

    // What was promised is kept: the invitation is accepted, and nothing else moved.
    const ferdi = await person("u_ferdi", { email: "f@x.example" });
    expect(
      await acceptInvite(db, pending.token, { id: ferdi, email: "f@x.example", emailVerified: true }),
    ).toMatchObject({
      waveId: w1,
    });
    expect(await db.select().from(nodes)).toHaveLength(4);
    expect(await db.select().from(waveMembers)).toHaveLength(7);
    // Members that were there before are all still there.
    const after = new Set((await db.select().from(waveMembers)).map((m) => `${m.waveId}/${m.userId}`));
    for (const m of membersBefore) expect(after.has(`${m.waveId}/${m.userId}`)).toBe(true);
  });
});
