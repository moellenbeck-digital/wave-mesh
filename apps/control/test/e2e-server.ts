/**
 * The real control server backed by an in-process Postgres, for the end-to-end
 * test. Same app, same routes, same middleware -- only the database driver
 * differs, and the PGlite/node-postgres parity is covered by the unit tests.
 */
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.ts";
import { createProviders } from "../src/auth/providers.ts";
import { waves } from "../src/db/schema.ts";
import { loadConfig } from "../src/env.ts";
import { resolveSigningKey } from "../src/netmap/signing-key.ts";
import { createAuthKey } from "../src/waves/auth-keys.ts";
import { createTestDb } from "./helpers.ts";

const config = loadConfig({ ...process.env, WAVE_DEV_AUTH: "1" });
const { db } = await createTestDb();
const app = createApp({
  db,
  config,
  providers: createProviders(config),
  signingKey: resolveSigningKey(config),
});

/**
 * What a production server does through its database or on a timer, reachable
 * here over HTTP because the database lives in this process and nowhere else:
 * `wave-admin` cannot reach it, and an hourly sweep is no use to a test.
 * Only in this file -- the server a deployment runs has none of it.
 */
const hooks: Record<string, (url: URL) => Promise<Response>> = {
  // The sweep index.ts runs hourly, now. `days` moves its clock forward past
  // the retention, which cannot be set to zero.
  "/__e2e/billing/sweep": async (url) => {
    const days = Number(url.searchParams.get("days") ?? 0);
    return Response.json({ deleted: await app.sweepBilling(new Date(Date.now() + days * 86_400_000)) });
  },
  // `wave-admin auth-key <wave>`: a single-use key, made by the wave's owner.
  "/__e2e/auth-key": async (url) => {
    const waveId = url.searchParams.get("wave") ?? "";
    const rows = await db
      .select({ owner: waves.ownerUserId })
      .from(waves)
      .where(eq(waves.id, waveId))
      .limit(1);
    const owner = rows[0]?.owner;
    if (!owner) return Response.json({ error: "no such wave" }, { status: 404 });
    const key = await createAuthKey(db, { waveId, userId: owner, label: "e2e" });
    return Response.json({ token: key.token });
  },
};

const server = Bun.serve({
  port: config.port,
  hostname: process.env.WAVE_HOST ?? "0.0.0.0",
  fetch: (request, bunServer) => {
    const url = new URL(request.url);
    const hook = request.method === "POST" ? hooks[url.pathname] : undefined;
    return hook ? hook(url) : app.fetch(request, bunServer);
  },
  websocket: app.websocket,
});
console.log(`e2e control server on ${config.baseUrl} (bound to ${server.hostname}:${server.port})`);
