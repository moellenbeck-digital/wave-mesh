import { afterEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { createProviders } from "../src/auth/providers.ts";
import { loadConfig } from "../src/env.ts";
import { createTestDb, testSigningKey } from "./helpers.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

/** A real port, because the restriction looks at the peer's socket address. */
async function startServer(devAuthFrom?: string) {
  const { db, close } = await createTestDb();
  const config = loadConfig({
    WAVE_ENV: "test",
    WAVE_DEV_AUTH: "1",
    ...(devAuthFrom ? { WAVE_DEV_AUTH_FROM: devAuthFrom } : {}),
  });
  const app = createApp({ db, config, providers: createProviders(config), signingKey: testSigningKey() });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch, websocket: app.websocket });
  cleanup.push(() => {
    server.stop(true);
    return close();
  });
  return `http://127.0.0.1:${server.port}`;
}

describe("development login exposure", () => {
  test("is open when no ranges are configured", async () => {
    const base = await startServer();
    const res = await fetch(`${base}/auth/dev/start`, { redirect: "manual" });
    expect(res.status).toBe(302);
  });

  test("serves a caller inside an allowed range", async () => {
    const base = await startServer("127.0.0.0/8");
    const res = await fetch(`${base}/auth/dev/start`, { redirect: "manual" });
    expect(res.status).toBe(302);
  });

  test("hides itself from a caller outside every range", async () => {
    const base = await startServer("100.64.0.0/10");
    const res = await fetch(`${base}/auth/dev/start`, { redirect: "manual" });
    expect(res.status).toBe(404);
    // Indistinguishable from a provider that does not exist.
    expect(await res.json()).toMatchObject({ error: "unknown provider" });
  });

  test("covers the login form and the callback, not just the start", async () => {
    const base = await startServer("100.64.0.0/10");
    expect((await fetch(`${base}/auth/dev/login`)).status).toBe(404);
    expect((await fetch(`${base}/auth/dev/callback?code=a%40b.c&state=x`)).status).toBe(404);
  });

  test("leaves the node API reachable, which authenticates differently", async () => {
    const base = await startServer("100.64.0.0/10");
    const res = await fetch(`${base}/v1/netmap`);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "missing-signature" });
  });
});
