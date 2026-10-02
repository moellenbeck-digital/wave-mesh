import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { previewPolicy } from "../src/acl/preview.ts";
import { checkPolicy } from "../src/acl/validate.ts";
import { createApp } from "../src/app.ts";
import { setPassword } from "../src/auth/password.ts";
import { createProviders } from "../src/auth/providers.ts";
import type { Database } from "../src/db/client.ts";
import { createTestDb, testConfig, testSigningKey } from "./helpers.ts";

let db: Database;
let close: () => Promise<void>;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  if (close) await close();
  ({ db, close } = await createTestDb());
  const config = testConfig();
  app = createApp({ db, config, providers: createProviders(config), signingKey: testSigningKey() });
});

const wrongPassword = (headers: Record<string, string>) =>
  app.request("/auth/password/login", {
    method: "POST",
    body: new URLSearchParams({ email: "robin@example.com", password: "nope" }),
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
  });

describe("the language of a browser request", () => {
  test("German when the browser asks for it, with the page saying so", async () => {
    await setPassword(db, "robin@example.com", "correct horse battery staple");
    const res = await wrongPassword({ "accept-language": "de-DE,de;q=0.9,en;q=0.8" });
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toContain("E-Mail oder Passwort ist falsch.");
    expect(body).toContain('<html lang="de">');
  });

  test("the switcher's cookie beats the browser's list", async () => {
    const res = await wrongPassword({ "accept-language": "de", cookie: "wave_lang=en" });
    expect(await res.text()).toContain("Wrong email or password.");
    const de = await wrongPassword({ "accept-language": "en-US", cookie: "wave_lang=de" });
    expect(await de.text()).toContain("E-Mail oder Passwort ist falsch.");
  });

  test("error pages the web app's forms land on", async () => {
    const de = await app.request("/invite/not-a-token", { headers: { "accept-language": "de" } });
    expect(de.status).toBe(410);
    expect(await de.text()).toContain("Diese Einladung gibt es nicht mehr");
    // A request that names no language gets English, exactly as before.
    expect(await (await app.request("/invite/not-a-token")).text()).toContain("This invitation is gone");
  });

  test("JSON errors the web shows, without touching the status", async () => {
    const de = await app.request("/api/waves/w_x/acl", { headers: { "accept-language": "de" } });
    expect(de.status).toBe(401);
    expect(await de.json()).toEqual({ error: "nicht angemeldet" });
    const en = await app.request("/api/waves/w_x/acl");
    expect(await en.json()).toEqual({ error: "unauthenticated" });
  });
});

describe("policy checks in German", () => {
  const subjects = {
    nodes: [{ id: "n1", hostname: "laptop", email: "robin@example.com", role: "owner" as const, tags: [] }],
    services: [{ name: "grafana", viaNodeId: "n1" }],
  };

  test("the same judgement, other words", () => {
    const policy = {
      acls: [{ src: ["group:ghosts", "svc:grafana"], dst: ["tag:printer"] }],
    };
    const en = checkPolicy(policy, subjects);
    const de = checkPolicy(policy, subjects, "de");
    expect(de.errors.length).toBe(en.errors.length);
    expect(de.errors).toContain("acls.0: group:ghosts ist unter groups nicht definiert");
    expect(de.errors).toContain("acls.0.src: svc:grafana ist ein Dienst und nie eine Quelle");
    expect(de.warnings).toEqual(["(noch) kein Gerät trägt tag:printer"]);
  });

  test("the preview passes its language on", () => {
    const res = previewPolicy({ acls: [{ src: ["*"], dst: ["*"] }] }, subjects, { n1: ["nas"] }, [], "de");
    expect(res.errors).toEqual(["laptop: kein Tag: nas"]);
  });
});

describe("wave-admin", () => {
  const usage = (lang: string) =>
    Bun.spawnSync(["bun", join(import.meta.dir, "../src/admin.ts")], {
      env: { ...process.env, WAVE_LANG: lang },
    });

  test("speaks the machine's language", () => {
    const de = usage("de");
    expect(de.exitCode).toBe(1);
    expect(de.stderr.toString()).toStartWith("Aufruf:");
    expect(de.stderr.toString()).toContain("ist ein Wave-Name");
    expect(usage("en").stderr.toString()).toStartWith("usage:");
  });
});
