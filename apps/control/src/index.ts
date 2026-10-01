import { createApp } from "./app.ts";
import { createProviders } from "./auth/providers.ts";
import { createDb } from "./db/client.ts";
import { loadConfig } from "./env.ts";
import { resolveSigningKey } from "./netmap/signing-key.ts";

const config = loadConfig();
const { db } = createDb(config.databaseUrl);
const providers = createProviders(config);
const signingKey = resolveSigningKey(config);

if (providers.size === 0) {
  console.warn("no login providers configured — set GOOGLE_CLIENT_ID/SECRET or WAVE_DEV_AUTH=1");
}

const app = createApp({ db, config, providers, signingKey });
const server = Bun.serve({
  port: config.port,
  hostname: process.env.WAVE_HOST ?? "0.0.0.0",
  fetch: app.fetch,
  websocket: app.websocket,
});
console.log(
  `control server on ${config.baseUrl} (listening on :${server.port}, providers: ${[...providers.keys()].join(", ") || "none"})`,
);
