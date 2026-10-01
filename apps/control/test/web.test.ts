import { beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { setPassword } from "../src/auth/password.ts";
import { createProviders } from "../src/auth/providers.ts";
import type { Database } from "../src/db/client.ts";
import { CookieJar, createTestDb, createWaveAs, testConfig, testSigningKey } from "./helpers.ts";

const WEB_URL = "http://127.0.0.1:3000";

let db: Database;
let close: () => Promise<void>;

/** Records what the proxy asked the frontend for, and answers for it. */
function stubFrontend(answer: () => Response = () => new Response("page", { status: 200 })) {
  const seen: Request[] = [];
  const webFetch = (async (input: Request | string | URL) => {
    seen.push(input instanceof Request ? input : new Request(String(input)));
    return answer();
  }) as typeof fetch;
  return { seen, webFetch };
}

const build = (overrides: Record<string, string>, webFetch?: typeof fetch) => {
  const config = testConfig(overrides);
  return createApp({
    db,
    config,
    providers: createProviders(config),
    signingKey: testSigningKey(),
    webFetch,
  });
};

beforeEach(async () => {
  if (close) await close();
  ({ db, close } = await createTestDb());
});

describe("without a frontend", () => {
  test("the control server keeps rendering its own pages", async () => {
    const app = build({});
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("/auth/password/login");

    expect((await app.request("/auth/password/login")).status).toBe(200);
  });

  test("an unknown path is a 404, not a proxy target", async () => {
    expect((await build({}).request("/devices/connected")).status).toBe(404);
  });
});

describe("with a frontend", () => {
  test("anything the control server does not own is proxied there", async () => {
    const { seen, webFetch } = stubFrontend();
    const res = await build({ WAVE_WEB_URL: WEB_URL }, webFetch).request("/devices/connected?host=laptop", {
      headers: { cookie: "wave_session=abc", host: "control.example.com" },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("page");

    const forwarded = seen[0];
    // Path and query survive; only the origin is swapped.
    expect(forwarded?.url).toBe(`${WEB_URL}/devices/connected?host=laptop`);
    // Without the cookie the frontend cannot tell who is asking.
    expect(forwarded?.headers.get("cookie")).toBe("wave_session=abc");
    expect(forwarded?.headers.get("x-forwarded-host")).toBe("control.example.com");
  });

  test("a redirect from the frontend reaches the browser", async () => {
    const { seen, webFetch } = stubFrontend(
      () => new Response(null, { status: 307, headers: { location: "/login" } }),
    );
    const res = await build({ WAVE_WEB_URL: WEB_URL }, webFetch).request("/");

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/login");
    // Following it here would leave the browser on "/" showing the login page.
    expect(seen[0]?.redirect).toBe("manual");
  });

  test("the node API stays with the control server", async () => {
    const { seen, webFetch } = stubFrontend();
    const app = build({ WAVE_WEB_URL: WEB_URL }, webFetch);

    expect((await app.request("/healthz")).status).toBe(200);
    // No signature on this request, so the control server rejects it itself.
    expect((await app.request("/v1/netmap")).status).toBe(401);
    expect((await app.request("/api/me")).status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  test("a frontend that is down does not take the node API with it", async () => {
    const app = build({ WAVE_WEB_URL: WEB_URL }, (() => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch);

    expect((await app.request("/")).status).toBe(502);
    expect((await app.request("/healthz")).status).toBe(200);
  });

  test("the sign-in page is handed over, the POST is not", async () => {
    const { seen, webFetch } = stubFrontend();
    const app = build({ WAVE_WEB_URL: WEB_URL }, webFetch);

    const page = await app.request("/auth/password/login?next=%2Fdevices");
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe("/login?next=%2Fdevices");
    expect(seen).toHaveLength(0);
  });

  test("a failed login comes back as a reason in the query string", async () => {
    const app = build({ WAVE_WEB_URL: WEB_URL }, stubFrontend().webFetch);
    await setPassword(db, "robin@example.com", "correct horse battery staple");

    const res = await app.request("/auth/password/login", {
      method: "POST",
      body: new URLSearchParams({ email: "robin@example.com", password: "wrong" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?error=invalid");
  });

  test("an expired device link lands on the frontend's page", async () => {
    const app = build({ WAVE_WEB_URL: WEB_URL }, stubFrontend().webFetch);

    // Unauthenticated first: the link only works once someone is signed in.
    const anonymous = await app.request("/machine/authorize?request=gone");
    expect(anonymous.headers.get("location")).toStartWith("/login?next=");

    const jar = await devLogin(app);
    const res = await app.request("/machine/authorize?request=gone", { headers: { cookie: jar } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/devices/expired");
  });
});

/** Signs in through the dev provider and returns the cookie header. */
async function devLogin(app: ReturnType<typeof createApp>): Promise<string> {
  const jar = new CookieJar();
  const start = await app.request("/auth/dev/start");
  jar.absorb(start);
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
  const callback = await app.request(`/auth/dev/callback?code=robin%40example.com&state=${state}`, {
    headers: { cookie: jar.header() },
  });
  jar.absorb(callback);
  // Signing in no longer makes a wave; its DNS suffix is its owner's choice.
  await createWaveAs((path, init) => app.request(path, init), jar, "robin@example.com");
  return jar.header();
}
