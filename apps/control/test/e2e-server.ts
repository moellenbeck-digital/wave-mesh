/**
 * The real control server backed by an in-process Postgres, for the end-to-end
 * test. Same app, same routes, same middleware -- only the database driver
 * differs, and the PGlite/node-postgres parity is covered by the unit tests.
 */
import { createApp } from "../src/app.ts";
import { createProviders } from "../src/auth/providers.ts";
import { loadConfig } from "../src/env.ts";
import { resolveSigningKey } from "../src/netmap/signing-key.ts";
import { createTestDb } from "./helpers.ts";

const config = loadConfig({ ...process.env, WAVE_DEV_AUTH: "1" });
const { db } = await createTestDb();
const app = createApp({
  db,
  config,
  providers: createProviders(config),
  signingKey: resolveSigningKey(config),
});
const server = Bun.serve({
  port: config.port,
  hostname: process.env.WAVE_HOST ?? "0.0.0.0",
  fetch: app.fetch,
  websocket: app.websocket,
});
console.log(`e2e control server on ${config.baseUrl} (bound to ${server.hostname}:${server.port})`);
