import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.ts";
import { listAudit } from "../src/audit.ts";
import { createProviders } from "../src/auth/providers.ts";
import type { Database } from "../src/db/client.ts";
import { dnsCredentials, users, waveMembers } from "../src/db/schema.ts";
import { loadDnsMode, openSecret } from "../src/dns/credentials.ts";
import { addMember } from "../src/waves/members.ts";
import { CookieJar, createTestDb, createWaveAs, testConfig, testSigningKey } from "./helpers.ts";

/**
 * The DNS provider from the browser: the same setting as `admin.ts
 * set-dns-provider`, now in the hands of whoever manages the wave. What has to
 * hold is what holds on the shell -- nothing unverified is stored, nothing is
 * stored in the clear -- plus what a browser adds: members may not, and the
 * credential never comes back out.
 */
let db: Database;
let close: () => Promise<void>;
let reset: () => Promise<void>;
let app: ReturnType<typeof createApp>;
let zone: FakeZone;

const DNS_KEY = Buffer.alloc(32, 7);
const SUFFIX = "wave.example.com";

/** A Cloudflare zone for SUFFIX that keeps its records and remembers every call. */
class FakeZone {
  records = new Map<string, { type: string; name: string; content: string }>();
  calls: string[] = [];
  refuse = false;
  private next = 0;

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    this.calls.push(`${method} ${url.pathname}`);
    const ok = (result: unknown) => Response.json({ success: true, errors: [], result });
    if (this.refuse) {
      return Response.json(
        { success: false, errors: [{ code: 10000, message: "Authentication error" }] },
        { status: 403 },
      );
    }
    if (url.pathname === "/client/v4/zones") {
      const name = url.searchParams.get("name");
      return ok(name === SUFFIX ? [{ id: "z1", name }] : []);
    }
    if (url.pathname === "/client/v4/zones/z1/dns_records" && method === "POST") {
      const id = `r${++this.next}`;
      this.records.set(id, JSON.parse(String(init?.body)));
      return ok({ id });
    }
    if (url.pathname === "/client/v4/zones/z1/dns_records") {
      const type = url.searchParams.get("type");
      const name = url.searchParams.get("name");
      return ok(
        [...this.records]
          .filter(([, record]) => record.type === type && record.name === name)
          .map(([id, record]) => ({ id, ...record })),
      );
    }
    if (method === "DELETE") {
      this.records.delete(url.pathname.split("/").pop() ?? "");
      return ok({});
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
}

beforeAll(async () => {
  ({ db, close, reset } = await createTestDb());
});

afterAll(() => close());

function start(overrides: Record<string, string> = { WAVE_DNS_SECRET: DNS_KEY.toString("base64") }) {
  zone = new FakeZone();
  const config = testConfig(overrides);
  app = createApp({
    db,
    config,
    providers: createProviders(config),
    signingKey: testSigningKey(),
    dnsFetch: zone.fetch,
  });
}

beforeEach(async () => {
  await reset();
  start();
});

async function login(email: string): Promise<CookieJar> {
  const jar = new CookieJar();
  const begin = await app.request("/auth/dev/start");
  jar.absorb(begin);
  const state = new URL(begin.headers.get("location") ?? "").searchParams.get("state");
  jar.absorb(
    await app.request(`/auth/dev/callback?code=${encodeURIComponent(email)}&state=${state}`, {
      headers: { cookie: jar.header() },
    }),
  );
  return jar;
}

/** An owner's wave on SUFFIX (or another suffix), and a way in for any role. */
async function home(suffix = SUFFIX) {
  const owner = await login("owner@example.com");
  await createWaveAs((path, init) => app.request(path, init), owner, "owner@example.com", { suffix });
  const [member] = await db.select().from(waveMembers).limit(1);
  if (!member) throw new Error("no wave");
  const as = async (email: string, role: "admin" | "member") => {
    const jar = await login(email);
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) throw new Error(`${email} did not sign in`);
    await addMember(db, member.waveId, user.id, role);
    return jar;
  };
  return { waveId: member.waveId, owner, as };
}

const put = (jar: CookieJar, waveId: string, body: unknown) =>
  app.request(`/api/waves/${waveId}/dns`, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { cookie: jar.header(), "content-type": "application/json" },
  });

const get = (jar: CookieJar, waveId: string) =>
  app.request(`/api/waves/${waveId}/dns`, { headers: { cookie: jar.header() } });

const stored = async (waveId: string) =>
  (await db.select().from(dnsCredentials).where(eq(dnsCredentials.waveId, waveId)).limit(1))[0];

describe("who may", () => {
  test("the owner and an administrator set the provider; a member does not even see it", async () => {
    const { waveId, owner, as } = await home();
    const admin = await as("admin@example.com", "admin");
    const member = await as("member@example.com", "member");

    expect((await put(owner, waveId, { provider: "manual" })).status).toBe(200);
    expect((await put(admin, waveId, { provider: "cloudflare", token: "cf-token" })).status).toBe(200);
    expect((await get(member, waveId)).status).toBe(403);
    expect((await put(member, waveId, { provider: "manual" })).status).toBe(403);
    expect(
      (
        await app.request(`/api/waves/${waveId}/dns`, {
          method: "DELETE",
          headers: { cookie: member.header() },
        })
      ).status,
    ).toBe(403);
    expect((await stored(waveId))?.provider).toBe("cloudflare");
  });

  test("someone outside the wave gets the same 404 as a wave that does not exist", async () => {
    const { waveId } = await home();
    const stranger = await login("stranger@example.com");
    expect((await get(stranger, waveId)).status).toBe(404);
    expect((await put(stranger, waveId, { provider: "manual" })).status).toBe(404);
  });

  test("a form post from another site is not JSON and is refused", async () => {
    const { waveId, owner } = await home();
    const form = new FormData();
    form.set("provider", "manual");
    const res = await app.request(`/api/waves/${waveId}/dns`, {
      method: "PUT",
      body: form,
      headers: { cookie: owner.header() },
    });
    expect(res.status).toBe(415);
    expect(await stored(waveId)).toBeUndefined();
  });
});

describe("what is stored", () => {
  test("a token is tried against the zone, then sealed -- and never handed back", async () => {
    const { waveId, owner } = await home();
    const res = await put(owner, waveId, { provider: "cloudflare", token: "  cf-token  " });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      provider: "cloudflare",
      dnsSuffix: SUFFIX,
      placeholder: false,
      sealing: true,
    });
    expect(JSON.stringify(body)).not.toContain("cf-token");

    // Written and taken away again: the proof of owning the zone leaves nothing behind.
    expect(zone.calls.some((call) => call.startsWith("POST"))).toBe(true);
    expect(zone.records.size).toBe(0);

    const row = await stored(waveId);
    expect(row?.tokenSealed).not.toContain("cf-token");
    expect(openSecret(row?.tokenSealed ?? "", DNS_KEY)).toBe("cf-token");
    expect((await loadDnsMode(db, waveId, DNS_KEY, zone.fetch))?.kind).toBe("automatic");

    const entries = await listAudit(db, waveId, 10);
    expect(entries.find((entry) => entry.action === "dns.provider")?.target).toBe("cloudflare");
    expect(JSON.stringify(entries)).not.toContain("cf-token");
  });

  test("a token that cannot write the zone is not kept, and the page learns why", async () => {
    const { waveId, owner } = await home();
    zone.refuse = true;
    const res = await put(owner, waveId, { provider: "cloudflare", token: "wrong" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toContain(SUFFIX);
    expect(await stored(waveId)).toBeUndefined();
  });

  test("a bad token does not replace a good one", async () => {
    const { waveId, owner } = await home();
    await put(owner, waveId, { provider: "cloudflare", token: "good" });
    zone.refuse = true;
    expect((await put(owner, waveId, { provider: "cloudflare", token: "bad" })).status).toBe(422);
    expect(openSecret((await stored(waveId))?.tokenSealed ?? "", DNS_KEY)).toBe("good");
  });

  test("INWX without a password is no account and is not stored", async () => {
    const { waveId, owner } = await home();
    const missing = await put(owner, waveId, { provider: "inwx", user: "robin" });
    expect(missing.status).toBe(400);
    expect(await stored(waveId)).toBeUndefined();
  });

  test("manual needs neither a credential nor the sealing key", async () => {
    await reset();
    start({});
    const { waveId, owner } = await home();
    const res = await put(owner, waveId, { provider: "manual" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ provider: "manual", sealing: false });
    expect((await stored(waveId))?.tokenSealed).toBeNull();
    expect(zone.calls).toEqual([]);
  });

  test("without WAVE_DNS_SECRET a token is refused before it reaches the provider", async () => {
    await reset();
    start({});
    const { waveId, owner } = await home();
    const res = await put(owner, waveId, { provider: "cloudflare", token: "cf-token" });
    expect(res.status).toBe(409);
    expect(zone.calls).toEqual([]);
    expect(await stored(waveId)).toBeUndefined();
  });

  test("the placeholder domain cannot have a provider at all", async () => {
    const { waveId, owner } = await home("owner.wave.internal");
    const res = await put(owner, waveId, { provider: "manual" });
    expect(res.status).toBe(409);
    expect(((await (await get(owner, waveId)).json()) as { placeholder: boolean }).placeholder).toBe(true);
    expect(await stored(waveId)).toBeUndefined();
  });

  test("an unknown provider and a missing token are a 400", async () => {
    const { waveId, owner } = await home();
    expect((await put(owner, waveId, { provider: "route53", token: "x" })).status).toBe(400);
    expect((await put(owner, waveId, { provider: "hetzner" })).status).toBe(400);
    expect(zone.calls).toEqual([]);
  });

  test("removing takes the credential away and says so in the history", async () => {
    const { waveId, owner } = await home();
    await put(owner, waveId, { provider: "cloudflare", token: "cf-token" });
    const del = () =>
      app.request(`/api/waves/${waveId}/dns`, { method: "DELETE", headers: { cookie: owner.header() } });
    const res = await del();
    expect(res.status).toBe(200);
    expect(((await res.json()) as { provider: string | null }).provider).toBeNull();
    expect(await stored(waveId)).toBeUndefined();
    expect((await del()).status).toBe(404);
    expect((await listAudit(db, waveId, 10)).some((entry) => entry.action === "dns.provider.remove")).toBe(
      true,
    );
  });
});
