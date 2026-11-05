/**
 * Plausible behind our own domain.
 *
 * Plausible runs inside the ops cluster and has no public endpoint, so the
 * browser never talks to it: the script and the events go to `/_plausible/…`
 * on this origin and this module forwards them. Nothing in here imports Next --
 * a `Request` goes in, a `Response` comes out, and `fetch` is injectable -- so
 * `bun test` at the repository root can run it.
 *
 * Two rules shape it:
 *
 * - It is not an open proxy. The upstream is a constant, only two (method,
 *   path) pairs are served, and the event's site (`d`) is pinned to the
 *   configured domain, so nobody can feed other sites' statistics through us.
 * - Nothing personal leaves. The signed-in app has ids and invitation tokens in
 *   its paths and device names in its query strings; the event body is
 *   rewritten *here*, on the server, before it is forwarded, so a patched or
 *   outdated script cannot undo it. Cookies are never forwarded.
 */

/** The only host this module ever talks to. Not derived from a request or the environment. */
export const PLAUSIBLE_UPSTREAM = "https://plausible.ops.moellenbeck-digital.io";

/** Where on our own origin the browser finds it. */
export const PLAUSIBLE_PREFIX = "/_plausible";

/** A real event is a few hundred bytes; this is generous and still harmless. */
export const MAX_EVENT_BYTES = 8 * 1024;
const MAX_SCRIPT_BYTES = 512 * 1024;
const MAX_REPLY_BYTES = 4 * 1024;
const UPSTREAM_TIMEOUT_MS = 5_000;
const SCRIPT_CACHE_CONTROL = "public, max-age=3600";

export interface PlausibleConfig {
  /** `data-domain`: the site as registered in Plausible. */
  domain: string;
  /** `src` of the script tag. */
  src: string;
  /** Base of the event endpoint, without `/api/event`. Absent: the script's own default. */
  apiHost?: string;
}

/**
 * Read at request time from the environment that is handed in, never from a
 * `process.env.NEXT_PUBLIC_…` the bundler would freeze at build: one image has
 * to serve every environment. Without a domain and a script there is no
 * tracking, which is what keeps development and tests silent.
 */
export function plausibleConfig(env: Record<string, string | undefined>): PlausibleConfig | null {
  const domain = env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN?.trim();
  const src = env.NEXT_PUBLIC_PLAUSIBLE_SRC?.trim();
  if (!domain || !src) return null;
  const apiHost = env.NEXT_PUBLIC_PLAUSIBLE_API_HOST?.trim().replace(/\/+$/, "");
  return { domain, src, ...(apiHost ? { apiHost } : {}) };
}

/** The attributes of the script tag, in the order they are documented. */
export function scriptAttributes(config: PlausibleConfig) {
  return {
    defer: true,
    "data-domain": config.domain,
    ...(config.apiHost ? { "data-api": `${config.apiHost}/api/event` } : {}),
    src: config.src,
  };
}

// ---------------------------------------------------------------------------
// What may stay in a path
// ---------------------------------------------------------------------------

interface Route {
  /** Segments that are page names and stay as they are. */
  static?: Record<string, Route>;
  /** What any other segment at this position is called -- it is an id or a token. */
  param?: { name: string; next?: Route };
}

/**
 * The pages of `apps/web/src/app`, and nothing else. A segment that is not on
 * this list is never sent on, whatever it looks like: an id we did not think
 * of is replaced just the same.
 */
const ROUTES: Route = {
  static: {
    account: {},
    devices: { static: { choose: {}, connected: {}, expired: {} } },
    join: { static: { gone: {} }, param: { name: ":token" } },
    login: { static: { "2fa": {} } },
    waves: {
      static: { new: {} },
      param: { name: ":id", next: { static: { access: {}, invited: {} } } },
    },
  },
};

const MAX_SEGMENTS = 6;

/**
 * `/waves/3f2a…/invited` → `/waves/:id/invited`, `/join/<token>` →
 * `/join/:token`. Where the path leaves the known pages, every further segment
 * becomes `:id`, so a 404 for a guessed address does not carry the guess.
 */
export function normalizePath(pathname: string): string {
  const segments = pathname.split("/").filter((segment) => segment !== "");
  let route: Route | undefined = ROUTES;
  const kept = segments.slice(0, MAX_SEGMENTS).map((segment) => {
    const page: Route | undefined =
      route?.static && Object.hasOwn(route.static, segment) ? route.static[segment] : undefined;
    if (page) {
      route = page;
      return segment;
    }
    const param = route?.param;
    route = param?.next;
    return param?.name ?? ":id";
  });
  return `/${kept.join("/")}`;
}

/**
 * Scheme, host and normalised path of an address -- no credentials, query or
 * fragment. Null for anything that is not an http(s) URL.
 */
function stripAddress(raw: unknown, normalize: boolean, ownHost?: string): string | null {
  if (typeof raw !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  // Our own pages carry ids; somebody else's we only reduce.
  const own = normalize || url.host === ownHost;
  return `${url.protocol}//${url.host}${own ? normalizePath(url.pathname) : url.pathname}`;
}

/**
 * What of an event survives: the name, the address, the referrer, the screen
 * width and the site. Everything else is dropped -- above all `p`, the custom
 * properties, which are free-form and where a name or an address would end up.
 * Null if it is not an event at all.
 */
export function sanitizeEvent(raw: unknown, domain: string): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const event = raw as Record<string, unknown>;

  const address = stripAddress(event.u, true);
  if (address === null) return null;
  const name = event.n;
  if (typeof name !== "string" || name.length === 0 || name.length > 64) return null;

  const clean: Record<string, unknown> = { n: name, u: address, d: domain };
  const referrer = stripAddress(event.r, false, new URL(address).host);
  if (referrer !== null) clean.r = referrer;
  if (typeof event.w === "number" && Number.isFinite(event.w)) clean.w = event.w;
  return clean;
}

// ---------------------------------------------------------------------------
// The proxy
// ---------------------------------------------------------------------------

export interface PlausibleDeps {
  /** Null while tracking is not configured: nothing is served and nothing leaves. */
  config: PlausibleConfig | null;
  fetch?: typeof fetch;
}

const notFound = () => new Response("not found", { status: 404 });
const bad = (status: number, text: string) => new Response(text, { status });

/** Reads at most `max` bytes; null when there is more. */
async function readCapped(
  stream: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** Bodyless statuses: constructing a Response with a body for these throws. */
const NO_BODY = new Set([101, 204, 205, 304]);

/**
 * Serves `/_plausible/…`. Pass the whole request: its path decides, and
 * anything but the two known pairs is a 404 -- other paths, other methods and
 * everything when tracking is switched off.
 */
export async function handlePlausible(request: Request, deps: PlausibleDeps): Promise<Response> {
  const { config } = deps;
  if (!config) return notFound();

  const path = new URL(request.url).pathname;
  if (!path.startsWith(`${PLAUSIBLE_PREFIX}/`)) return notFound();
  const route = path.slice(PLAUSIBLE_PREFIX.length);

  if (request.method === "GET" && route === "/js/script.js") return script(deps);
  if (request.method === "POST" && route === "/api/event") return event(request, config.domain, deps);
  return notFound();
}

const fetchOf = (deps: PlausibleDeps) => deps.fetch ?? fetch;

async function script(deps: PlausibleDeps): Promise<Response> {
  try {
    const res = await fetchOf(deps)(`${PLAUSIBLE_UPSTREAM}/js/script.js`, {
      method: "GET",
      headers: { accept: "application/javascript, text/javascript, */*;q=0.1" },
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (res.status !== 200) return bad(502, "plausible unavailable");
    const body = await readCapped(res.body, MAX_SCRIPT_BYTES);
    if (body === null) return bad(502, "plausible unavailable");
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": SCRIPT_CACHE_CONTROL,
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return bad(502, "plausible unavailable");
  }
}

async function event(request: Request, domain: string, deps: PlausibleDeps): Promise<Response> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_EVENT_BYTES) return bad(413, "payload too large");
  const raw = await readCapped(request.body, MAX_EVENT_BYTES);
  if (raw === null) return bad(413, "payload too large");

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return bad(400, "invalid event");
  }
  const clean = sanitizeEvent(parsed, domain);
  if (clean === null) return bad(400, "invalid event");

  // Only what Plausible needs to count a visitor. No cookie, no authorization.
  const headers = new Headers({
    "content-type": request.headers.get("content-type") ?? "text/plain",
  });
  const agent = request.headers.get("user-agent");
  if (agent) headers.set("user-agent", agent);
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) headers.set("x-forwarded-for", forwardedFor);

  try {
    const res = await fetchOf(deps)(`${PLAUSIBLE_UPSTREAM}/api/event`, {
      method: "POST",
      headers,
      body: JSON.stringify(clean),
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    // A redirect from Plausible would send the browser somewhere we did not choose.
    if (res.status >= 300 && res.status < 400) return bad(502, "plausible unavailable");
    const reply = await readCapped(res.body, MAX_REPLY_BYTES);
    if (reply === null) return bad(502, "plausible unavailable");
    return new Response(NO_BODY.has(res.status) ? null : reply, {
      status: res.status,
      headers: {
        "content-type": res.headers.get("content-type") ?? "text/plain",
        "cache-control": "no-store",
      },
    });
  } catch {
    return bad(502, "plausible unavailable");
  }
}
