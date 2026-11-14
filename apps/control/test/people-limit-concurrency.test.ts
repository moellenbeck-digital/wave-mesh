import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import EmbeddedPostgres from "embedded-postgres";
import { Pool } from "pg";
import {
  accountPlan,
  accountRoster,
  countPeople,
  DEFAULT_FREE_LIMITS,
  seatRule,
} from "../src/billing/plan.ts";
import { AccountSeatLimitError } from "../src/billing/seats.ts";
import type { Database } from "../src/db/client.ts";
import { customerAccounts, schema, users, waveMembers, waves } from "../src/db/schema.ts";
import { acceptInvite, createInvite, revokeInvite } from "../src/waves/invites.ts";
import { addMember, removeMember } from "../src/waves/members.ts";

/**
 * Ticket #115: two callers for the last seat, against a real Postgres.
 *
 * PGlite has one connection and runs transactions one after the other, so it
 * can say nothing about locks. These tests start an actual server
 * (`embedded-postgres`, no Docker, PostgreSQL 17 like the compose file) and
 * talk to it through a `pg` pool, the way production does. Several connections,
 * real `SELECT ... FOR UPDATE`.
 *
 * What is held: at 2 of 3 places taken, exactly one of two simultaneous
 * newcomers gets in, whichever way each one comes (invitation in another or in
 * the same wave, a member added by hand), and accepting an invitation while a
 * new one is written never opens a fourth place. The last test pins *why* the
 * acceptance is safe: it takes the account's lock, in the order the others do,
 * so nothing waits in a circle.
 */

const LIMIT = DEFAULT_FREE_LIMITS.people;

let server: EmbeddedPostgres;
let dataDir: string;
let pool: Pool;
let db: Database;

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port")),
      );
    });
  });

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "wave-pg-"));
  const port = await freePort();
  server = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "wave",
    password: "wave",
    port,
    persistent: false,
    onLog: () => {},
    onError: () => {},
  });
  await server.initialise();
  await server.start();
  await server.createDatabase("wave");
  pool = new Pool({ connectionString: `postgres://wave:wave@127.0.0.1:${port}/wave`, max: 12 });
  const real = drizzle(pool, { schema });
  await migrate(real, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
  db = real as unknown as Database;
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await server?.stop();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
}, 60_000);

beforeEach(async () => {
  await pool.query(
    "truncate users, customer_accounts, waves, wave_members, wave_invites, nodes restart identity cascade",
  );
});

/** Anna's free account with two waves, plus one more person: 2 of 3 places taken. */
async function twoOfThree() {
  await db.insert(users).values({ id: "u_anna", email: "u_anna@x.example", emailVerified: true });
  await db.insert(customerAccounts).values({ id: "ca_anna", ownerUserId: "u_anna" });
  const ids: string[] = [];
  for (const [n, name] of ["alpha", "beta"].entries()) {
    const id = `w_${name}`;
    ids.push(id);
    await db.insert(waves).values({
      id,
      name,
      dnsSuffix: `${name}.wave.example.com`,
      ownerUserId: "u_anna",
      accountId: "ca_anna",
      ipv4Prefix: `10.${64 + n}.0.0/16`,
      ipv6Prefix: `fd7a:${n}:1::/48`,
    });
    await db.insert(waveMembers).values({ waveId: id, userId: "u_anna", role: "owner" });
  }
  await person("u_ben");
  await db.insert(waveMembers).values({ waveId: "w_alpha", userId: "u_ben", role: "member" });
  return ids as [string, string];
}

const person = (id: string, email = `${id}@x.example`) =>
  db.insert(users).values({ id, email, emailVerified: true });

const invite = (waveId: string, email: string) =>
  createInvite(db, {
    waveId,
    waveName: "w",
    email,
    role: "member",
    invitedByUserId: "u_anna",
    baseUrl: "http://localhost",
  });

const people = async () =>
  countPeople(
    await accountRoster(db, "ca_anna"),
    seatRule(await accountPlan(db, "ca_anna"), DEFAULT_FREE_LIMITS).mode,
  );

/** What each of the simultaneous calls came to: `ok`, or the way it was refused. */
const settle = (calls: Promise<unknown>[]) =>
  Promise.all(
    calls.map((call) =>
      call.then(
        () => "ok" as const,
        (error: unknown) => error,
      ),
    ),
  );

const outcome = (results: unknown[]) => ({
  ok: results.filter((result) => result === "ok").length,
  refused: results.filter((result) => result instanceof AccountSeatLimitError).length,
  other: results.filter((result) => result !== "ok" && !(result instanceof AccountSeatLimitError)),
});

const ROUNDS = 8;

describe("two at once for the last of three places", () => {
  test("two invitations in two different waves: exactly one is written", async () => {
    const [alpha, beta] = await twoOfThree();
    for (let round = 0; round < ROUNDS; round++) {
      await pool.query("delete from wave_invites");
      const results = await settle([
        invite(alpha, `c${round}@x.example`),
        invite(beta, `d${round}@x.example`),
      ]);
      expect(outcome(results)).toEqual({ ok: 1, refused: 1, other: [] });
      expect(await people()).toBe(LIMIT);
    }
  });

  test("two invitations in the same wave: exactly one is written", async () => {
    const [alpha] = await twoOfThree();
    for (let round = 0; round < ROUNDS; round++) {
      await pool.query("delete from wave_invites");
      const results = await settle([
        invite(alpha, `c${round}@x.example`),
        invite(alpha, `d${round}@x.example`),
      ]);
      expect(outcome(results)).toEqual({ ok: 1, refused: 1, other: [] });
      expect(await people()).toBe(LIMIT);
    }
  });

  test("the same address twice at once is one person: both are fine, one invitation stays open", async () => {
    const [alpha, beta] = await twoOfThree();
    const results = await settle([invite(alpha, "c@x.example"), invite(beta, "C@x.example")]);
    expect(outcome(results)).toEqual({ ok: 2, refused: 0, other: [] });
    expect(await people()).toBe(LIMIT);
  });

  test("an invitation against a member added by hand: exactly one", async () => {
    const [alpha, beta] = await twoOfThree();
    for (let round = 0; round < ROUNDS; round++) {
      await pool.query("delete from wave_invites");
      await pool.query("delete from wave_members where user_id like 'u_dora%'");
      await pool.query("delete from users where id like 'u_dora%'");
      await person(`u_dora${round}`);
      const results = await settle([
        invite(alpha, `c${round}@x.example`),
        addMember(db, beta, `u_dora${round}`, "member"),
      ]);
      expect(outcome(results)).toEqual({ ok: 1, refused: 1, other: [] });
      expect(await people()).toBe(LIMIT);
    }
  });

  test("two members added by hand: exactly one", async () => {
    const [alpha, beta] = await twoOfThree();
    for (let round = 0; round < ROUNDS; round++) {
      await pool.query("delete from wave_members where user_id like 'u_new%'");
      await pool.query("delete from users where id like 'u_new%'");
      await person(`u_new${round}a`);
      await person(`u_new${round}b`);
      const results = await settle([
        addMember(db, alpha, `u_new${round}a`, "member"),
        addMember(db, beta, `u_new${round}b`, "member"),
      ]);
      expect(outcome(results)).toEqual({ ok: 1, refused: 1, other: [] });
      expect(await people()).toBe(LIMIT);
    }
  });
});

describe("accepting against a new invitation", () => {
  test("at 3 of 3 with one invitation open, the acceptance never makes room for a fourth", async () => {
    const [alpha, beta] = await twoOfThree();
    for (let round = 0; round < 20; round++) {
      await pool.query("delete from wave_invites");
      await pool.query("delete from wave_members where user_id like 'u_cara%'");
      await pool.query("delete from users where id like 'u_cara%'");
      const sent = await invite(alpha, `cara${round}@x.example`);
      await person(`u_cara${round}`, `cara${round}@x.example`);
      expect(await people()).toBe(LIMIT);

      const results = await settle([
        acceptInvite(db, sent.token, {
          id: `u_cara${round}`,
          email: `cara${round}@x.example`,
          emailVerified: true,
        }),
        invite(beta, `dora${round}@x.example`),
      ]);
      // The acceptance is fine; the newcomer is refused every time, whichever
      // statement of the count the other commit falls between.
      expect(results[0]).not.toBeInstanceOf(Error);
      expect(results[1]).toBeInstanceOf(AccountSeatLimitError);
      expect(await people()).toBe(LIMIT);
    }
  });

  test("an acceptance and a member added by hand at 3 of 3: the member is refused", async () => {
    const [alpha, beta] = await twoOfThree();
    for (let round = 0; round < 10; round++) {
      await pool.query("delete from wave_invites");
      await pool.query("delete from wave_members where user_id like 'u_cara%' or user_id like 'u_dora%'");
      await pool.query("delete from users where id like 'u_cara%' or id like 'u_dora%'");
      const sent = await invite(alpha, `cara${round}@x.example`);
      await person(`u_cara${round}`, `cara${round}@x.example`);
      await person(`u_dora${round}`);
      const results = await settle([
        acceptInvite(db, sent.token, {
          id: `u_cara${round}`,
          email: `cara${round}@x.example`,
          emailVerified: true,
        }),
        addMember(db, beta, `u_dora${round}`, "member"),
      ]);
      expect(results[0]).not.toBeInstanceOf(Error);
      expect(results[1]).toBeInstanceOf(AccountSeatLimitError);
      expect(await people()).toBe(LIMIT);
    }
  });

  test("two clicks on one link: one membership", async () => {
    const [alpha] = await twoOfThree();
    const sent = await invite(alpha, "cara@x.example");
    await person("u_cara", "cara@x.example");
    const user = { id: "u_cara", email: "cara@x.example", emailVerified: true };
    const results = await Promise.all([
      acceptInvite(db, sent.token, user),
      acceptInvite(db, sent.token, user),
    ]);
    expect(results.filter((result) => typeof result === "object")).toHaveLength(1);
    expect(results.filter((result) => result === "gone")).toHaveLength(1);
    expect(await people()).toBe(LIMIT);
  });
});

describe("the locks", () => {
  /** A second connection that holds the account's row, as a counting caller would. */
  async function holdAccount() {
    const client = await pool.connect();
    await client.query("begin");
    await client.query("select id from customer_accounts where id = 'ca_anna' for update");
    return {
      release: async () => {
        await client.query("commit");
        client.release();
      },
    };
  }

  const pending = async (promise: Promise<unknown>) => {
    const state = await Promise.race([
      promise.then(() => "done"),
      new Promise((r) => setTimeout(() => r("waiting"), 400)),
    ]);
    return state === "waiting";
  };

  test("accepting waits for whoever holds the account, and goes through after", async () => {
    const [alpha] = await twoOfThree();
    const sent = await invite(alpha, "cara@x.example");
    await person("u_cara", "cara@x.example");

    const held = await holdAccount();
    const accepting = acceptInvite(db, sent.token, {
      id: "u_cara",
      email: "cara@x.example",
      emailVerified: true,
    });
    // The count that holds the account cannot be run over by the swap of invitation for member.
    expect(await pending(accepting)).toBe(true);
    await held.release();
    expect(await accepting).toMatchObject({ waveId: alpha });
  });

  test("an invitation waits the same way", async () => {
    const [alpha] = await twoOfThree();
    const held = await holdAccount();
    const inviting = invite(alpha, "cara@x.example");
    expect(await pending(inviting)).toBe(true);
    await held.release();
    expect((await inviting).email).toBe("cara@x.example");
  });

  test("a mix of everything at once ends: no deadlock, no error but the refusal, never a fourth person", async () => {
    for (let round = 0; round < 10; round++) {
      await pool.query(
        "truncate users, customer_accounts, waves, wave_members, wave_invites, nodes restart identity cascade",
      );
      const [alpha, beta] = await twoOfThree();
      await person("u_new0", "new0@x.example");
      await person("u_new1", "new1@x.example");
      await person("u_new2", "new2@x.example");
      const sent = await invite(alpha, "new0@x.example");

      const calls = [
        acceptInvite(db, sent.token, { id: "u_new0", email: "new0@x.example", emailVerified: true }),
        invite(beta, "late0@x.example"),
        invite(alpha, "late1@x.example"),
        addMember(db, beta, "u_new1", "member"),
        addMember(db, alpha, "u_new2", "member"),
        removeMember(db, alpha, "owner", "u_ben"),
        revokeInvite(db, beta, { email: "late0@x.example" }),
      ];
      const done = await Promise.race([
        settle(calls),
        new Promise<"stuck">((resolve) => setTimeout(() => resolve("stuck"), 30_000)),
      ]);
      if (done === "stuck") throw new Error("deadlock: the calls did not finish");
      // Refusals are the only way a call may fail.
      expect(outcome(done).other).toEqual([]);
      // Removing Ben can free a place for a newcomer, but no interleaving
      // leaves more than three people.
      expect(await people()).toBeLessThanOrEqual(LIMIT);
    }
  }, 120_000);
});
