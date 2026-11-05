import { describe, expect, test } from "bun:test";
import {
  handlePlausible,
  MAX_EVENT_BYTES,
  normalizePath,
  PLAUSIBLE_UPSTREAM,
  type PlausibleConfig,
  plausibleConfig,
  sanitizeEvent,
  scriptAttributes,
} from "../../apps/web/src/lib/plausible.ts";

const ORIGIN = "https://control.wave-mesh.net";
const CONFIG: PlausibleConfig = {
  domain: "control.wave-mesh.net",
  src: "/_plausible/js/script.js",
  apiHost: "/_plausible",
};

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

/** A stand-in for Plausible that records what it was asked and answers as told. */
function upstream(answer: () => Response | Promise<Response> = () => new Response("ok", { status: 202 })) {
  const calls: Call[] = [];
  const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
    });
    return answer();
  }) as typeof fetch;
  return { calls, fetch: fetchStub };
}

const serve = (
  request: Request,
  stub: ReturnType<typeof upstream>,
  config: PlausibleConfig | null = CONFIG,
) => handlePlausible(request, { config, fetch: stub.fetch });

const pageview = (overrides: Record<string, unknown> = {}) => ({
  n: "pageview",
  u: `${ORIGIN}/`,
  d: CONFIG.domain,
  r: null,
  w: 1280,
  ...overrides,
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/_plausible/api/event`, {
    method: "POST",
    headers: { "content-type": "text/plain", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("configuration", () => {
  test("a domain and a script switch tracking on", () => {
    expect(
      plausibleConfig({
        NEXT_PUBLIC_PLAUSIBLE_DOMAIN: "control.wave-mesh.net",
        NEXT_PUBLIC_PLAUSIBLE_SRC: "/_plausible/js/script.js",
        NEXT_PUBLIC_PLAUSIBLE_API_HOST: "/_plausible/",
      }),
    ).toEqual(CONFIG);
  });

  test("without one of them there is no tracking", () => {
    expect(plausibleConfig({})).toBeNull();
    expect(plausibleConfig({ NEXT_PUBLIC_PLAUSIBLE_DOMAIN: "a.example" })).toBeNull();
    expect(plausibleConfig({ NEXT_PUBLIC_PLAUSIBLE_SRC: "/_plausible/js/script.js" })).toBeNull();
    expect(
      plausibleConfig({ NEXT_PUBLIC_PLAUSIBLE_DOMAIN: " ", NEXT_PUBLIC_PLAUSIBLE_SRC: "/x.js" }),
    ).toBeNull();
  });

  test("the API host is optional", () => {
    const config = plausibleConfig({
      NEXT_PUBLIC_PLAUSIBLE_DOMAIN: "a.example",
      NEXT_PUBLIC_PLAUSIBLE_SRC: "/x.js",
    });
    expect(config).toEqual({ domain: "a.example", src: "/x.js" });
    expect(scriptAttributes(config as PlausibleConfig)).toEqual({
      defer: true,
      "data-domain": "a.example",
      src: "/x.js",
    });
  });

  test("the script tag carries domain, API endpoint and source", () => {
    expect(scriptAttributes(CONFIG)).toEqual({
      defer: true,
      "data-domain": "control.wave-mesh.net",
      "data-api": "/_plausible/api/event",
      src: "/_plausible/js/script.js",
    });
  });
});

describe("the script", () => {
  test("is fetched from the fixed upstream and answered with 200, a type and a cache header", async () => {
    const stub = upstream(
      () => new Response("/* plausible */", { status: 200, headers: { "set-cookie": "x=1" } }),
    );
    const res = await serve(new Request(`${ORIGIN}/_plausible/js/script.js`), stub);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("/* plausible */");
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    // Nothing of the upstream's own headers is passed on.
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.url).toBe(`${PLAUSIBLE_UPSTREAM}/js/script.js`);
    expect(stub.calls[0]?.method).toBe("GET");
  });

  test("an upstream that answers anything but 200 is a 502", async () => {
    for (const status of [404, 500, 302]) {
      const stub = upstream(() => new Response("no", { status }));
      expect((await serve(new Request(`${ORIGIN}/_plausible/js/script.js`), stub)).status).toBe(502);
    }
  });

  test("an unreachable upstream is a 502, not a hanging request", async () => {
    const stub = upstream(() => {
      throw new Error("connection refused");
    });
    expect((await serve(new Request(`${ORIGIN}/_plausible/js/script.js`), stub)).status).toBe(502);
  });
});

describe("the event", () => {
  test("goes to the fixed upstream and the status comes back as it is", async () => {
    const stub = upstream();
    const res = await serve(
      post(pageview({ u: `${ORIGIN}/waves/new` }), {
        "x-forwarded-for": "203.0.113.7",
        "user-agent": "Mozilla/5.0 test",
      }),
      stub,
    );

    expect(res.status).toBe(202);
    expect(await res.text()).toBe("ok");
    const call = stub.calls[0];
    expect(call?.url).toBe(`${PLAUSIBLE_UPSTREAM}/api/event`);
    expect(call?.method).toBe("POST");
    expect(call?.headers.get("x-forwarded-for")).toBe("203.0.113.7");
    expect(call?.headers.get("user-agent")).toBe("Mozilla/5.0 test");
    expect(call?.headers.get("content-type")).toBe("text/plain");
    expect(JSON.parse(call?.body ?? "")).toEqual({
      n: "pageview",
      u: `${ORIGIN}/waves/new`,
      d: "control.wave-mesh.net",
      w: 1280,
    });
  });

  test("no cookie and no authorization header leave", async () => {
    const stub = upstream();
    await serve(
      post(pageview(), { cookie: "wave_session=secret", authorization: "Bearer x", "x-other": "y" }),
      stub,
    );

    const headers = stub.calls[0]?.headers;
    expect(headers?.get("cookie")).toBeNull();
    expect(headers?.get("authorization")).toBeNull();
    expect(headers?.get("x-other")).toBeNull();
  });

  test("an upstream error status is handed on", async () => {
    const stub = upstream(() => new Response("nope", { status: 400 }));
    expect((await serve(post(pageview()), stub)).status).toBe(400);
  });

  test("an upstream without a body (204) does not break the answer", async () => {
    const stub = upstream(() => new Response(null, { status: 204 }));
    expect((await serve(post(pageview()), stub)).status).toBe(204);
  });

  test("a redirect from the upstream is a 502", async () => {
    const stub = upstream(
      () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }),
    );
    expect((await serve(post(pageview()), stub)).status).toBe(502);
  });

  test("an unreachable upstream is a 502", async () => {
    const stub = upstream(() => {
      throw new Error("connection refused");
    });
    expect((await serve(post(pageview()), stub)).status).toBe(502);
  });

  test("a timeout is a 502", async () => {
    const stub = upstream(() => {
      throw new DOMException("The operation timed out", "TimeoutError");
    });
    expect((await serve(post(pageview()), stub)).status).toBe(502);
  });

  test("a body over the limit is refused and never forwarded", async () => {
    const stub = upstream();
    const big = JSON.stringify(pageview({ p: { filler: "x".repeat(MAX_EVENT_BYTES) } }));

    // Declared too large ...
    expect((await serve(post(big, { "content-length": String(big.length) }), stub)).status).toBe(413);
    // ... and one that only turns out to be while it is read.
    const chunked = new Request(`${ORIGIN}/_plausible/api/event`, {
      method: "POST",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(big));
          controller.close();
        },
      }),
      duplex: "half",
    });
    expect((await serve(chunked, stub)).status).toBe(413);
    expect(stub.calls).toHaveLength(0);
  });

  test("something that is not an event is refused and never forwarded", async () => {
    const stub = upstream();
    for (const body of [
      "not json",
      "[]",
      "null",
      "42",
      JSON.stringify({ n: "pageview" }),
      JSON.stringify({ u: ORIGIN }),
    ]) {
      expect((await serve(post(body), stub)).status).toBe(400);
    }
    expect(stub.calls).toHaveLength(0);
  });
});

describe("what is not served", () => {
  test("any other path under /_plausible/ is a 404", async () => {
    const stub = upstream();
    for (const path of [
      "/_plausible/",
      "/_plausible/js/script.outbound-links.js",
      "/_plausible/js/script.js/",
      "/_plausible/api/stats",
      "/_plausible/api/event/",
      "/_plausible/api/event/extra",
      "/_plausible/../api/me",
      "/_plausible/%2e%2e/etc",
      "/_plausible/https://evil.example/",
      "/_plausibleX/js/script.js",
      "/js/script.js",
    ]) {
      expect((await serve(new Request(`${ORIGIN}${path}`), stub)).status).toBe(404);
      expect(
        (await serve(new Request(`${ORIGIN}${path}`, { method: "POST", body: "{}" }), stub)).status,
      ).toBe(404);
    }
    expect(stub.calls).toHaveLength(0);
  });

  test("the known paths with the wrong method are a 404", async () => {
    const stub = upstream();
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      expect(
        (await serve(new Request(`${ORIGIN}/_plausible/js/script.js`, { method, body: "x" }), stub)).status,
      ).toBe(404);
    }
    for (const method of ["GET", "HEAD", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const init = method === "GET" || method === "HEAD" ? {} : { body: "x" };
      expect(
        (await serve(new Request(`${ORIGIN}/_plausible/api/event`, { method, ...init }), stub)).status,
      ).toBe(404);
    }
    expect(stub.calls).toHaveLength(0);
  });

  test("a query string does not open another upstream path", async () => {
    const stub = upstream();
    await serve(new Request(`${ORIGIN}/_plausible/js/script.js?next=//evil.example/x`), stub);
    expect(stub.calls[0]?.url).toBe(`${PLAUSIBLE_UPSTREAM}/js/script.js`);
  });

  test("nothing is served while tracking is off", async () => {
    const stub = upstream();
    expect((await serve(new Request(`${ORIGIN}/_plausible/js/script.js`), stub, null)).status).toBe(404);
    expect((await serve(post(pageview()), stub, null)).status).toBe(404);
    expect(stub.calls).toHaveLength(0);
  });
});

describe("privacy", () => {
  const ID = "6f0f2d7e-5b0e-4a53-9b3f-2c1a8d9e7f10";
  const TOKEN = "k3J9xQ_Zr-Tt0aPpWw5vLmNn8yBbCcDdEeFfGgHhIiJ";

  const sent = async (event: Record<string, unknown>) => {
    const stub = upstream();
    await serve(post(event), stub);
    return JSON.parse(stub.calls[0]?.body ?? "{}") as Record<string, unknown>;
  };

  test("ids and tokens in the path become placeholders", () => {
    const cases: Record<string, string> = {
      "/": "/",
      "/login": "/login",
      "/login/2fa": "/login/2fa",
      "/account": "/account",
      "/waves/new": "/waves/new",
      [`/waves/${ID}/access`]: "/waves/:id/access",
      [`/waves/${ID}/invited`]: "/waves/:id/invited",
      [`/waves/${ID}`]: "/waves/:id",
      [`/join/${TOKEN}`]: "/join/:token",
      "/join/gone": "/join/gone",
      "/devices/choose": "/devices/choose",
      "/devices/connected": "/devices/connected",
      "/devices/expired": "/devices/expired",
    };
    for (const [path, expected] of Object.entries(cases)) expect(normalizePath(path)).toBe(expected);
  });

  test("what the whitelist does not know is replaced, wherever it stands", () => {
    expect(normalizePath("/devices/laptop-von-robin")).toBe("/devices/:id");
    expect(normalizePath(`/devices/${ID}/secret`)).toBe("/devices/:id/:id");
    expect(normalizePath("/robin.lenz@example.com")).toBe("/:id");
    expect(normalizePath(`/waves/${ID}/members/${ID}/remove`)).toBe("/waves/:id/:id/:id/:id");
    expect(normalizePath("/waves/new/extra")).toBe("/waves/new/:id");
    expect(normalizePath(`/${ID}/waves/new`)).toBe("/:id/:id/:id");
    expect(normalizePath("/join/waves")).toBe("/join/:token");
  });

  test("names of Object.prototype are not pages", () => {
    expect(normalizePath("/constructor")).toBe("/:id");
    expect(normalizePath("/__proto__/toString")).toBe("/:id/:id");
    expect(normalizePath("/waves/hasOwnProperty")).toBe("/waves/:id");
  });

  test("a path never gets long", () => {
    expect(normalizePath(`/${Array(40).fill("a").join("/")}`).split("/").length).toBeLessThanOrEqual(7);
  });

  test("query string, fragment and credentials leave the address", async () => {
    const body = await sent(
      pageview({
        u: `https://user:pw@control.wave-mesh.net/devices/connected?host=Robins-Laptop&code=abc#token=xyz`,
      }),
    );
    expect(body.u).toBe("https://control.wave-mesh.net/devices/connected");
    expect(JSON.stringify(body)).not.toMatch(/Robins|code=|token=|user:pw|abc|xyz/);
  });

  test("an invitation link is reduced to /join/:token", async () => {
    const body = await sent(pageview({ u: `${ORIGIN}/join/${TOKEN}?email=a@b.example` }));
    expect(body.u).toBe(`${ORIGIN}/join/:token`);
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  test("the referrer is reduced too -- our own pages to a placeholder, others to origin and path", async () => {
    expect((await sent(pageview({ r: `${ORIGIN}/waves/${ID}/access?x=1#y` }))).r).toBe(
      `${ORIGIN}/waves/:id/access`,
    );
    expect((await sent(pageview({ r: "https://search.example/results/page?q=robin+lenz#top" }))).r).toBe(
      "https://search.example/results/page",
    );
    expect("r" in (await sent(pageview({ r: "javascript:alert(1)" })))).toBe(false);
    expect("r" in (await sent(pageview({ r: null })))).toBe(false);
  });

  test("custom properties and every unknown field are dropped", async () => {
    const body = await sent(
      pageview({
        p: { email: "robin@example.com", device: "Robins Laptop", userId: ID },
        m: { email: "robin@example.com" },
        revenue: { currency: "EUR", amount: 1 },
        $: 12,
        h: 1,
        extra: "robin@example.com",
        i: true,
      }),
    );
    expect(body).toEqual({ n: "pageview", u: `${ORIGIN}/`, d: CONFIG.domain, w: 1280 });
  });

  test("the site is pinned: a client cannot count for another domain", async () => {
    const body = await sent(pageview({ d: "someone-else.example" }));
    expect(body.d).toBe(CONFIG.domain);
  });

  test("sanitizeEvent keeps nothing it was not asked to", () => {
    expect(sanitizeEvent({ n: "pageview", u: `${ORIGIN}/`, w: "wide" }, "a.example")).toEqual({
      n: "pageview",
      u: `${ORIGIN}/`,
      d: "a.example",
    });
    expect(sanitizeEvent({ n: "x".repeat(65), u: `${ORIGIN}/` }, "a.example")).toBeNull();
    expect(sanitizeEvent({ n: "pageview", u: "/relative" }, "a.example")).toBeNull();
    expect(sanitizeEvent({ n: "pageview", u: "ftp://x.example/" }, "a.example")).toBeNull();
  });
});
