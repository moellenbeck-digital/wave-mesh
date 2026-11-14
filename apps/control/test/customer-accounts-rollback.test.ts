import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { migrateAccounts } from "../src/billing/migrate-accounts.ts";
import type { Database } from "../src/db/client.ts";
import { schema, waves } from "../src/db/schema.ts";

/**
 * The fallback procedure: the **old control image must keep running against
 * the new schema**. The migration (`0022_*`) runs as an init container of the
 * new image; if the rollout is rolled back, the old image starts on a database
 * that already has it.
 *
 * Proven here with what the old image does and cannot know about: a database
 * migrated up to 0021 gets filled the way the old code fills it, then 0022 is
 * applied, and the old code's statements -- written out as SQL with exactly
 * the columns the old schema knows -- are run against it. The old migrator is
 * covered by drizzle itself: it applies what is newer than the last applied
 * migration and finds nothing.
 */

const REAL = new URL("../drizzle", import.meta.url).pathname;
/** Later migrations belong to other releases: this file is about 0022, and the second part about 0024. */
const migrationNumber = (tag: string) => Number.parseInt(tag.slice(0, 4), 10);

let client: PGlite;
let dir: string;
let newDir: string;
let db: Database;

/**
 * The migration folder as an image ships it: every migration up to `last`.
 * The old image has everything before 0022; the image that brings 0022 has
 * everything through it -- not the migrations that came after.
 */
function folderThrough(last: number): string {
  const root = mkdtempSync(join(tmpdir(), "wave-old-migrations-"));
  mkdirSync(join(root, "meta"));
  const journal = JSON.parse(readFileSync(join(REAL, "meta", "_journal.json"), "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  const kept = journal.entries.filter((entry) => migrationNumber(entry.tag) <= last);
  expect(kept.length).toBe(last + 1);
  writeFileSync(join(root, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: kept }));
  for (const entry of kept) copyFileSync(join(REAL, `${entry.tag}.sql`), join(root, `${entry.tag}.sql`));
  return root;
}

async function structure(c: PGlite = client) {
  const columns = await c.query<{ t: string; c: string; nullable: string; def: string | null }>(
    `select table_name as t, column_name as c, is_nullable as nullable, column_default as def
       from information_schema.columns where table_schema = 'public' order by 1, 2`,
  );
  const constraints = await c.query<{ n: string }>(
    `select conname as n from pg_constraint c join pg_namespace s on s.oid = c.connamespace
      where s.nspname = 'public' order by 1`,
  );
  const indexes = await c.query<{ n: string }>(
    `select indexname as n from pg_indexes where schemaname = 'public' order by 1`,
  );
  return {
    columns: columns.rows,
    constraints: constraints.rows.map((r) => r.n),
    indexes: indexes.rows.map((r) => r.n),
  };
}

/** What the old image's tables hold, by the columns it knows. */
const OLD_COLUMNS = {
  users: "id, email, email_verified, name, password_hash, created_at",
  waves:
    "id, name, dns_suffix, owner_user_id, ipv4_prefix, ipv6_prefix, netmap_version, pier_label, created_at",
  wave_members: "wave_id, user_id, role, created_at",
  wave_billing: "wave_id, subscription_id, seats, state, delete_after, state_as_of, created_at, updated_at",
  nodes: "id, wave_id, user_id, hostname, ipv4, ipv6, approved",
};
const digest = async (c: PGlite = client, tables: Record<string, string> = OLD_COLUMNS) => {
  const out: Record<string, unknown[]> = {};
  for (const [table, columns] of Object.entries(tables)) {
    out[table] = (await c.query(`select ${columns} from ${table} order by 1, 2`)).rows;
  }
  return out;
};

beforeAll(async () => {
  dir = folderThrough(21);
  newDir = folderThrough(22);
  client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
});
afterAll(async () => {
  await client.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(newDir, { recursive: true, force: true });
});

describe("the old image against the new schema", () => {
  let oldStructure: Awaited<ReturnType<typeof structure>>;
  let oldDigest: Awaited<ReturnType<typeof digest>>;

  test("a database as the old image left it (migrations up to 0021)", async () => {
    await migrate(drizzle(client), { migrationsFolder: dir });
    // What the old code writes: no account anywhere.
    await client.exec(`
      insert into users (id, email, email_verified) values ('u_anna', 'anna@acme.example', true);
      insert into users (id, email, email_verified) values ('u_ben', 'ben@beta.example', false);
      insert into waves (id, name, dns_suffix, owner_user_id, ipv4_prefix, ipv6_prefix)
        values ('w_1', 'acme', 'acme.wave.example.com', 'u_anna', '10.64.0.0/16', 'fd7a:1:1::/48');
      insert into waves (id, name, dns_suffix, owner_user_id, ipv4_prefix, ipv6_prefix)
        values ('w_2', 'beta', 'beta.wave.example.com', 'u_ben', '10.65.0.0/16', 'fd7a:1:2::/48');
      insert into wave_members (wave_id, user_id, role) values ('w_1', 'u_anna', 'owner');
      insert into wave_members (wave_id, user_id, role) values ('w_2', 'u_ben', 'owner');
      insert into wave_billing (wave_id, subscription_id, seats, state) values ('w_1', 'sub_1', 3, 'active');
      insert into wave_billing (wave_id, subscription_id, seats, state) values ('w_2', 'sub_2', 2, 'suspended');
      insert into nodes (id, wave_id, user_id, machine_key, node_key, disco_key, hostname, os, ipv4, ipv6, approved)
        values ('n_1', 'w_1', 'u_anna', 'mk', 'nk', 'dk', 'laptop', 'linux', '10.64.0.10', 'fd7a:1:1::10', true);
    `);
    oldStructure = await structure();
    oldDigest = await digest();
    expect((await client.query(`select to_regclass('public.customer_accounts') as t`)).rows[0]).toEqual({
      t: null,
    });
  });

  test("0022 only adds: one table, one nullable column, nothing existing is touched", async () => {
    await migrate(drizzle(client), { migrationsFolder: newDir });
    const now = await structure();

    // No existing column changed or went; the only new ones are the table's and waves.account_id.
    const key = (c: { t: string; c: string }) => `${c.t}.${c.c}`;
    const oldByKey = new Map(oldStructure.columns.map((c) => [key(c), c]));
    for (const column of oldStructure.columns) {
      expect(now.columns.find((c) => key(c) === key(column))).toEqual(column);
    }
    const added = now.columns.filter((c) => !oldByKey.has(key(c))).map(key);
    expect(added.sort()).toEqual([
      "customer_accounts.created_at",
      "customer_accounts.id",
      "customer_accounts.owner_user_id",
      "waves.account_id",
    ]);
    expect(now.columns.find((c) => key(c) === "waves.account_id")).toMatchObject({
      nullable: "YES",
      def: null,
    });
    // Constraints and indexes: everything old is still there.
    for (const name of oldStructure.constraints) expect(now.constraints).toContain(name);
    for (const name of oldStructure.indexes) expect(now.indexes).toContain(name);
    // The data the old image knows, byte for byte.
    expect(await digest()).toEqual(oldDigest);
  });

  test("the old image's statements still run: insert, update, move owner, delete", async () => {
    // A new wave and its rows, the way the old createBilledWave writes them: no account column.
    await client.exec(`
      insert into users (id, email, email_verified) values ('u_cy', 'cy@gamma.example', false);
      insert into waves (id, name, dns_suffix, owner_user_id, ipv4_prefix, ipv6_prefix)
        values ('w_3', 'gamma', 'gamma.wave.example.com', 'u_cy', '10.66.0.0/16', 'fd7a:1:3::/48');
      insert into wave_members (wave_id, user_id, role) values ('w_3', 'u_cy', 'owner');
      insert into wave_billing (wave_id, subscription_id, seats, state, state_as_of)
        values ('w_3', 'sub_3', 5, 'active', 1000);
    `);
    // applySubscription: state and seats change on the billing row.
    await client.exec(
      `update wave_billing set state = 'suspended', seats = 4, updated_at = now() where wave_id = 'w_3'`,
    );
    await client.exec(`update waves set netmap_version = netmap_version + 1 where id = 'w_3'`);
    // The old reads, with only the columns it knows.
    expect((await client.query(`select ${OLD_COLUMNS.waves} from waves where id = 'w_3'`)).rows).toHaveLength(
      1,
    );
    // moveTo of the old image: owner and membership go to another user, the placeholder is deleted.
    await client.exec(`
      update waves set owner_user_id = 'u_anna' where owner_user_id = 'u_cy';
      update wave_members set user_id = 'u_anna' where user_id = 'u_cy';
      delete from users where id = 'u_cy';
    `);
    expect((await client.query(`select owner_user_id from waves where id = 'w_3'`)).rows).toEqual([
      { owner_user_id: "u_anna" },
    ]);
    // deleteWave of the old image.
    await client.exec(`delete from waves where id = 'w_3'`);
    expect((await client.query(`select id from waves where id = 'w_3'`)).rows).toEqual([]);
  });

  test("rows of the new image do no harm to the old one: deleting a user or a wave with an account", async () => {
    // As the new image leaves them: accounts, waves under them.
    await client.exec(`
      insert into customer_accounts (id, owner_user_id) values ('ca_anna', 'u_anna');
      insert into customer_accounts (id, owner_user_id) values ('ca_ben', 'u_ben');
      update waves set account_id = 'ca_anna' where id = 'w_1';
      update waves set account_id = 'ca_ben' where id = 'w_2';
    `);
    // The old deleteWave: the account stays.
    await client.exec(`delete from waves where id = 'w_2'`);
    expect((await client.query(`select id from customer_accounts order by 1`)).rows).toEqual([
      { id: "ca_anna" },
      { id: "ca_ben" },
    ]);
    // The old image deleting a user it moved everything away from: the account row goes with the
    // user (cascade), a wave under it stays and is simply unassigned.
    await client.exec(`
      insert into users (id, email, email_verified) values ('u_dee', 'dee@delta.example', false);
      insert into waves (id, name, dns_suffix, owner_user_id, ipv4_prefix, ipv6_prefix, account_id)
        values ('w_4', 'delta', 'delta.wave.example.com', 'u_anna', '10.67.0.0/16', 'fd7a:1:4::/48', null);
      insert into customer_accounts (id, owner_user_id) values ('ca_dee', 'u_dee');
      update waves set account_id = 'ca_dee' where id = 'w_4';
      delete from users where id = 'u_dee';
    `);
    expect((await client.query(`select id, account_id from waves where id = 'w_4'`)).rows).toEqual([
      { id: "w_4", account_id: null },
    ]);
    expect((await client.query(`select id from customer_accounts where id = 'ca_dee'`)).rows).toEqual([]);
  });

  test("rolling forward again: waves the old image made meanwhile are picked up by the command", async () => {
    // The old image running after a rollback made a billed wave without an account.
    await client.exec(`
      insert into waves (id, name, dns_suffix, owner_user_id, ipv4_prefix, ipv6_prefix)
        values ('w_5', 'epsilon', 'epsilon.wave.example.com', 'u_anna', '10.68.0.0/16', 'fd7a:1:5::/48');
      insert into wave_members (wave_id, user_id, role) values ('w_5', 'u_anna', 'owner');
      insert into wave_billing (wave_id, subscription_id, seats, state) values ('w_5', 'sub_5', 1, 'active');
    `);
    const result = await migrateAccounts(db);
    expect(result.kind).toBe("migrated");
    const wave = (await db.select().from(waves).where(eq(waves.id, "w_5")))[0];
    expect(wave?.accountId).toBe("ca_anna");
    expect((await migrateAccounts(db)).kind).toBe("nothing");
  });
});

/**
 * The same, one migration later (ticket #117): the old control image -- the one
 * that knows `customer_accounts` but not `account_subscriptions` -- must keep
 * running against a database that has `0024`. Rolling back is a tag, not a
 * `down` step.
 *
 * What it can and cannot know: the new table is additive, nothing existing
 * changes, and the new image's rows (an account subscription) must do no harm
 * to the statements the old image runs -- above all deleting a user or an
 * account, which cascades into the new table.
 */
describe("the old image against 0024 (account subscriptions)", () => {
  const COLUMNS_0023 = {
    ...OLD_COLUMNS,
    customer_accounts: "id, owner_user_id, created_at",
  };
  let c24: PGlite;
  let before: string;
  let after: string;
  let oldStructure: Awaited<ReturnType<typeof structure>>;
  let oldDigest: Awaited<ReturnType<typeof digest>>;

  beforeAll(async () => {
    before = folderThrough(23);
    after = folderThrough(24);
    c24 = new PGlite();
  });
  afterAll(async () => {
    await c24.close();
    rmSync(before, { recursive: true, force: true });
    rmSync(after, { recursive: true, force: true });
  });

  test("a database as the old image left it (migrations up to 0023), with a free account and a billed one", async () => {
    await migrate(drizzle(c24), { migrationsFolder: before });
    await c24.exec(`
      insert into users (id, email, email_verified) values ('u_anna', 'anna@acme.example', true);
      insert into users (id, email, email_verified) values ('u_ben', 'ben@beta.example', true);
      insert into customer_accounts (id, owner_user_id) values ('ca_anna', 'u_anna');
      insert into customer_accounts (id, owner_user_id) values ('ca_ben', 'u_ben');
      insert into waves (id, name, dns_suffix, owner_user_id, ipv4_prefix, ipv6_prefix, account_id)
        values ('w_1', 'acme', 'acme.wave.example.com', 'u_anna', '10.64.0.0/16', 'fd7a:1:1::/48', 'ca_anna');
      insert into waves (id, name, dns_suffix, owner_user_id, ipv4_prefix, ipv6_prefix, account_id)
        values ('w_2', 'beta', 'beta.wave.example.com', 'u_ben', '10.65.0.0/16', 'fd7a:1:2::/48', 'ca_ben');
      insert into wave_members (wave_id, user_id, role) values ('w_1', 'u_anna', 'owner');
      insert into wave_members (wave_id, user_id, role) values ('w_2', 'u_ben', 'owner');
      insert into wave_billing (wave_id, subscription_id, seats, state) values ('w_2', 'sub_2', 2, 'active');
      insert into nodes (id, wave_id, user_id, machine_key, node_key, disco_key, hostname, os, ipv4, ipv6, approved)
        values ('n_1', 'w_1', 'u_anna', 'mk', 'nk', 'dk', 'laptop', 'linux', '10.64.0.10', 'fd7a:1:1::10', true);
    `);
    oldStructure = await structure(c24);
    oldDigest = await digest(c24, COLUMNS_0023);
    expect((await c24.query(`select to_regclass('public.account_subscriptions') as t`)).rows[0]).toEqual({
      t: null,
    });
  });

  test("0024 only adds one table: nothing existing is touched, nothing changes on any row", async () => {
    await migrate(drizzle(c24), { migrationsFolder: after });
    const now = await structure(c24);

    const key = (col: { t: string; c: string }) => `${col.t}.${col.c}`;
    const oldByKey = new Map(oldStructure.columns.map((col) => [key(col), col]));
    for (const column of oldStructure.columns) {
      expect(now.columns.find((col) => key(col) === key(column))).toEqual(column);
    }
    expect(
      now.columns
        .filter((col) => !oldByKey.has(key(col)))
        .map(key)
        .sort(),
    ).toEqual([
      "account_subscriptions.account_id",
      "account_subscriptions.created_at",
      "account_subscriptions.delete_after",
      "account_subscriptions.id",
      "account_subscriptions.seats",
      "account_subscriptions.state",
      "account_subscriptions.state_as_of",
      "account_subscriptions.subscription_id",
      "account_subscriptions.updated_at",
    ]);
    for (const name of oldStructure.constraints) expect(now.constraints).toContain(name);
    for (const name of oldStructure.indexes) expect(now.indexes).toContain(name);
    expect(await digest(c24, COLUMNS_0023)).toEqual(oldDigest);
    // One live subscription per account is the table's own rule, a partial index.
    expect(now.indexes).toContain("account_subscriptions_one_live_idx");
    expect(now.indexes).toContain("account_subscriptions_subscription_idx");
  });

  test("the old image's statements still run: waves, billing rows, members, devices, owner moves", async () => {
    await c24.exec(`
      insert into users (id, email, email_verified) values ('u_cy', 'cy@gamma.example', false);
      insert into waves (id, name, dns_suffix, owner_user_id, ipv4_prefix, ipv6_prefix)
        values ('w_3', 'gamma', 'gamma.wave.example.com', 'u_cy', '10.66.0.0/16', 'fd7a:1:3::/48');
      insert into wave_members (wave_id, user_id, role) values ('w_3', 'u_cy', 'owner');
      insert into wave_billing (wave_id, subscription_id, seats, state, state_as_of)
        values ('w_3', 'sub_3', 5, 'active', 1000);
      update wave_billing set state = 'suspended', seats = 4, updated_at = now() where wave_id = 'w_3';
      update waves set owner_user_id = 'u_anna' where owner_user_id = 'u_cy';
      update wave_members set user_id = 'u_anna' where user_id = 'u_cy';
      delete from users where id = 'u_cy';
      delete from waves where id = 'w_3';
    `);
    expect((await c24.query(`select id from waves where id = 'w_3'`)).rows).toEqual([]);
    // And it still reads what it knows.
    expect((await c24.query(`select ${OLD_COLUMNS.waves} from waves where id = 'w_1'`)).rows).toHaveLength(1);
  });

  test("account subscriptions of the new image do the old one no harm: deleting a user or an account takes them along", async () => {
    await c24.exec(`
      insert into account_subscriptions (id, subscription_id, account_id, seats, state)
        values ('as_1', 'asub_1', 'ca_anna', 5, 'active');
      insert into account_subscriptions (id, subscription_id, account_id, seats, state, delete_after)
        values ('as_2', 'asub_2', 'ca_anna', 5, 'ended', now());
    `);
    // The old image removing a user it moved everything away from: the account row goes by cascade,
    // and so do the subscription rows under it -- no error, and the waves stay.
    await c24.exec(`
      insert into users (id, email, email_verified) values ('u_dee', 'dee@delta.example', false);
      insert into customer_accounts (id, owner_user_id) values ('ca_dee', 'u_dee');
      insert into account_subscriptions (id, subscription_id, account_id, seats, state)
        values ('as_3', 'asub_3', 'ca_dee', 1, 'active');
      insert into waves (id, name, dns_suffix, owner_user_id, ipv4_prefix, ipv6_prefix, account_id)
        values ('w_4', 'delta', 'delta.wave.example.com', 'u_anna', '10.67.0.0/16', 'fd7a:1:4::/48', 'ca_dee');
      delete from users where id = 'u_dee';
    `);
    expect((await c24.query(`select id from account_subscriptions order by 1`)).rows).toEqual([
      { id: "as_1" },
      { id: "as_2" },
    ]);
    expect((await c24.query(`select id, account_id from waves where id = 'w_4'`)).rows).toEqual([
      { id: "w_4", account_id: null },
    ]);
    // The old image deleting a wave leaves the account and its subscription alone.
    await c24.exec(`delete from waves where id = 'w_1'`);
    expect((await c24.query(`select id from customer_accounts where id = 'ca_anna'`)).rows).toHaveLength(1);
    expect(
      (await c24.query(`select id from account_subscriptions where account_id = 'ca_anna'`)).rows,
    ).toHaveLength(2);
  });

  test("rolling forward again: the account command finds the waves the old image made, whatever subscriptions exist", async () => {
    await c24.exec(`
      insert into waves (id, name, dns_suffix, owner_user_id, ipv4_prefix, ipv6_prefix)
        values ('w_5', 'epsilon', 'epsilon.wave.example.com', 'u_anna', '10.68.0.0/16', 'fd7a:1:5::/48');
      insert into wave_members (wave_id, user_id, role) values ('w_5', 'u_anna', 'owner');
      insert into wave_billing (wave_id, subscription_id, seats, state) values ('w_5', 'sub_5', 1, 'active');
    `);
    const result = await migrateAccounts(drizzle(c24, { schema }) as unknown as Database);
    expect(result.kind).toBe("migrated");
    expect((await c24.query(`select account_id from waves where id = 'w_5'`)).rows).toEqual([
      { account_id: "ca_anna" },
    ]);
    // Account subscriptions are not the command's business: they are still exactly what they were.
    expect((await c24.query(`select id from account_subscriptions order by 1`)).rows).toHaveLength(2);
  });
});
