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
const NEW_TAG = /^0022_/;

let client: PGlite;
let dir: string;
let db: Database;

/** The migration folder as the old image ships it: everything before 0022. */
function oldFolder(): string {
  const root = mkdtempSync(join(tmpdir(), "wave-old-migrations-"));
  mkdirSync(join(root, "meta"));
  const journal = JSON.parse(readFileSync(join(REAL, "meta", "_journal.json"), "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  const kept = journal.entries.filter((entry) => !NEW_TAG.test(entry.tag));
  expect(kept.length).toBe(journal.entries.length - 1);
  writeFileSync(join(root, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: kept }));
  for (const entry of kept) copyFileSync(join(REAL, `${entry.tag}.sql`), join(root, `${entry.tag}.sql`));
  return root;
}

async function structure() {
  const columns = await client.query<{ t: string; c: string; nullable: string; def: string | null }>(
    `select table_name as t, column_name as c, is_nullable as nullable, column_default as def
       from information_schema.columns where table_schema = 'public' order by 1, 2`,
  );
  const constraints = await client.query<{ n: string }>(
    `select conname as n from pg_constraint c join pg_namespace s on s.oid = c.connamespace
      where s.nspname = 'public' order by 1`,
  );
  const indexes = await client.query<{ n: string }>(
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
const digest = async () => {
  const out: Record<string, unknown[]> = {};
  for (const [table, columns] of Object.entries(OLD_COLUMNS)) {
    out[table] = (await client.query(`select ${columns} from ${table} order by 1, 2`)).rows;
  }
  return out;
};

beforeAll(async () => {
  dir = oldFolder();
  client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
});
afterAll(async () => {
  await client.close();
  rmSync(dir, { recursive: true, force: true });
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
    await migrate(drizzle(client), { migrationsFolder: REAL });
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
