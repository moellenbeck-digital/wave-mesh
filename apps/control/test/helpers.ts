import { PGlite } from "@electric-sql/pglite";
import { generateKeyPair } from "@wave/crypto";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Database } from "../src/db/client.ts";
import { schema } from "../src/db/schema.ts";
import { loadConfig } from "../src/env.ts";

export type TestDb = {
  db: Database;
  /** Shuts the instance down; once per file, in `afterAll`. */
  close: () => Promise<void>;
  /** Back to the state right after the migrations; in `beforeEach`. */
  reset: () => Promise<void>;
};

/**
 * In-process Postgres: real dialect semantics, no container to start.
 *
 * Every instance carries its own WebAssembly heap and a full migration run, and
 * a closed one does not give that memory back to the process. A test file
 * therefore makes one instance in `beforeAll` and calls `reset()` before each
 * test, instead of building a new database per test:
 *
 *     let db: Database;
 *     let close: () => Promise<void>;
 *     let reset: () => Promise<void>;
 *
 *     beforeAll(async () => {
 *       ({ db, close, reset } = await createTestDb());
 *     });
 *     afterAll(() => close());
 *     beforeEach(() => reset());
 */
export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

  let truncate: string | undefined;
  return {
    db: db as unknown as Database,
    close: () => client.close(),
    // The migrations insert no rows, so emptying every table in `public` equals
    // a fresh database. The migration journal lives in the `drizzle` schema and stays.
    reset: async () => {
      if (truncate === undefined) {
        const { rows } = await client.query<{ name: string }>(
          "select format('%I.%I', schemaname, tablename) as name from pg_tables where schemaname = 'public'",
        );
        truncate = `truncate ${rows.map((row) => row.name).join(", ")} restart identity cascade`;
      }
      await client.exec(truncate);
    },
  };
}

export const testConfig = (overrides: Record<string, string> = {}) =>
  loadConfig({ WAVE_ENV: "test", WAVE_DEV_AUTH: "1", ...overrides });

/** Fresh netmap signing key per test run. */
export const testSigningKey = () => generateKeyPair("ed25519");

/** Collects cookies across requests the way a browser would. */
export class CookieJar {
  private jar = new Map<string, string>();

  absorb(res: Response): void {
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(";");
      const eq = pair?.indexOf("=") ?? -1;
      if (!pair || eq < 0) continue;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (value === "" || /max-age=0/i.test(raw)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  header(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  get(name: string): string | undefined {
    return this.jar.get(name);
  }
}

/** How a test reaches the server: in process for most, over HTTP for a few. */
export type Requester = (path: string, init?: RequestInit) => Response | Promise<Response>;

/**
 * Approves a pending device the way a browser does.
 *
 * Opening the link only shows the form; the POST is what adds the device. It
 * used to be the other way round, which made a cross-site navigation an
 * enrolment -- machine-approval.test.ts is where that is pinned down. Tests go
 * through here so the two cannot drift, the same reason `approve_device` in
 * test/e2e/lib.sh exists.
 */
export async function approveDevice(request: Requester, jar: CookieJar, authUrl: string): Promise<Response> {
  const form = new FormData();
  form.set("request", new URL(authUrl, "http://localhost").searchParams.get("request") ?? "");
  return request("/machine/authorize", {
    method: "POST",
    body: form,
    headers: { cookie: jar.header() },
  });
}

/**
 * Makes the wave a login no longer makes by itself.
 *
 * Signing in stopped provisioning one the moment the DNS suffix became the
 * owner's choice. Every test that needs a network therefore creates it the way
 * the form does, and by default with the name and placeholder suffix the old
 * automatic path would have picked -- so the names these tests assert on are
 * unchanged.
 */
export async function createWaveAs(
  request: Requester,
  jar: CookieJar,
  email: string,
  options: { suffix?: string; next?: string } = {},
): Promise<Response> {
  const name =
    email
      .split("@")[0]
      ?.toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-") || "wave";
  const form = new FormData();
  form.set("name", name);
  form.set("suffix", options.suffix ?? `${name}.wave.internal`);
  if (options.next) form.set("next", options.next);
  const res = await request("/waves", {
    method: "POST",
    body: form,
    headers: { cookie: jar.header() },
  });
  if (res.status !== 303) throw new Error(`creating a wave for ${email} answered ${res.status}`);
  return res;
}
