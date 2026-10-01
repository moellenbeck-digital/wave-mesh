import { createMemoryNonceStore } from "@wave/crypto";
import { generateCodeVerifier, generateState } from "arctic";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { html } from "hono/html";
import { proxy } from "hono/proxy";
import { resolveUser } from "./auth/identity.ts";
import type { OAuthProvider } from "./auth/providers.ts";
import {
  clearSessionCookie,
  createSession,
  destroySession,
  lookupSession,
  readSessionCookie,
  type SessionUser,
  setSessionCookie,
} from "./auth/session.ts";
import { CertificateService } from "./certs/issue.ts";
import type { Database } from "./db/client.ts";
import { waveMembers, waves } from "./db/schema.ts";
import type { Config } from "./env.ts";
import { isWithin } from "./net/addressing.ts";
import { peerAddress } from "./net/peer.ts";
import type { SigningKey } from "./netmap/build.ts";
import { certRoutes } from "./routes/cert.ts";
import { controlWebsocket, NetmapHub } from "./routes/control-ws.ts";
import { DeviceFeed, deviceFeedRoutes } from "./routes/device-feed.ts";
import { machineRoutes } from "./routes/machine.ts";
import { safeNext } from "./routes/next.ts";
import { passwordRoutes } from "./routes/password.ts";
import { serviceRoutes } from "./routes/services.ts";
import { waveRoutes } from "./routes/waves.ts";
import { websocket } from "./routes/ws.ts";
import { listDevices } from "./waves/devices.ts";
import { invitesFor } from "./waves/invites.ts";
import { wavesOf } from "./waves/members.ts";
import { suggestWave, waveSetup } from "./waves/provision.ts";

const STATE_COOKIE = "wave_oauth_state";
const NEXT_COOKIE = "wave_oauth_next";
const VERIFIER_COOKIE = "wave_oauth_verifier";
const FLOW_TTL_SECONDS = 600;

export interface AppDeps {
  db: Database;
  config: Config;
  providers: Map<string, OAuthProvider>;
  signingKey: SigningKey;
  /** How the frontend is reached. Only the tests ever replace it. */
  webFetch?: typeof fetch;
  /**
   * Certificates, if this server issues them. Built here by default; the tests
   * pass one whose CA and DNS provider are fakes they can look inside.
   */
  certs?: CertificateService;
}

type Vars = { user: SessionUser | null };

/** Length-safe constant-time comparison for the OAuth state parameter. */
function sameToken(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function createApp({ db, config, providers, signingKey, webFetch, certs }: AppDeps) {
  const app = new Hono<{ Variables: Vars }>();

  /**
   * The development login trusts whatever address is typed into it, so on a
   * publicly bound server it is a way into the network. Restricting it to
   * named ranges keeps it usable from a trusted network while the node API,
   * which authenticates with machine keys, stays reachable from anywhere.
   *
   * The peer address comes from the socket, never from a header: a forwarded-
   * for header is attacker-controlled unless a trusted proxy sets it.
   */
  app.use("/auth/dev/*", async (c, next) => {
    if (config.devAuthFrom.length === 0) return next();
    // No socket address means no way to check, so the restriction holds.
    if (!isWithin(peerAddress(c) ?? "", config.devAuthFrom)) {
      // Same answer as an unknown provider: no hint that it exists.
      return c.json({ error: "unknown provider" }, 404);
    }
    return next();
  });

  app.use("*", async (c, next) => {
    const token = readSessionCookie(c);
    c.set("user", token ? await lookupSession(db, token) : null);
    await next();
  });

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.route("/", passwordRoutes({ db, config }));

  const hub = new NetmapHub(db, signingKey, config.relays);
  // The same events, told to the other audience: nodes get a signed netmap,
  // browsers get the device list they are rendering.
  const feed = new DeviceFeed(db, hub);
  hub.onChange((waveId) => feed.changed(waveId));
  app.route("/", controlWebsocket({ db, hub }));
  app.route("/", deviceFeedRoutes({ db, feed }));
  // One nonce store for every node-facing route: a signature is bound to its
  // path, so sharing it costs nothing and keeps the replay window in one place.
  const nonces = createMemoryNonceStore();
  app.route("/", machineRoutes({ db, config, signingKey, hub, nonces }));
  app.route("/", certRoutes({ db, certs: certs ?? new CertificateService({ db, config }), nonces }));
  app.route("/", serviceRoutes({ db, hub, nonces }));
  app.route("/", waveRoutes({ db, config, hub }));

  // Without a frontend this server is its own, deliberately plain, UI. With
  // one, "/" belongs to the frontend and falls through to the proxy below.
  if (!config.webUrl) {
    app.get("/", async (c) => {
      const user = c.get("user");
      if (!user) {
        const next = safeNext(c.req.query("next"));
        const suffix = next ? `?next=${encodeURIComponent(next)}` : "";
        const links = [
          html`<li><a href="/auth/password/login${suffix}">Sign in with email and password</a></li>`,
          ...[...providers.keys()].map(
            (id) => html`<li><a href="/auth/${id}/start${suffix}">Login with ${id}</a></li>`,
          ),
        ];
        return c.html(html`<h1>wave-mesh</h1><ul>${links}</ul>`);
      }
      const membership = await db
        .select({ name: waves.name, dnsSuffix: waves.dnsSuffix })
        .from(waveMembers)
        .innerJoin(waves, eq(waves.id, waveMembers.waveId))
        .where(eq(waveMembers.userId, user.id));
      const rows = membership.map((w) => html`<li>${w.name} — <code>${w.dnsSuffix}</code></li>`);
      // Nothing to show is the state of a fresh account: it has no network
      // until its owner makes one, and this is the only way there.
      const body =
        membership.length > 0
          ? html`<ul>${rows}</ul>`
          : html`<p>No wave yet. <a href="/waves/new">Create one</a>.</p>`;
      return c.html(html`<h1>wave-mesh</h1>
        <p>Signed in as ${user.email ?? user.name ?? user.id}</p>
        ${body}
        <form method="post" action="/auth/logout"><button type="submit">Log out</button></form>`);
    });
  }

  app.get("/api/me", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    return c.json({
      user: { id: user.id, email: user.email, emailVerified: user.emailVerified, name: user.name },
      waves: await wavesOf(db, user.id),
      // Why an account can sit here without a wave of its own: it was invited
      // into someone else's and has not opened the link yet. Without this the
      // empty dashboard would claim a wave appears on first login.
      invites: (await invitesFor(db, user.email)).map((invite) => ({
        wave: invite.waveName,
        role: invite.role,
        invitedBy: invite.invitedBy,
        expiresAt: invite.expiresAt,
      })),
      // What the create form starts with, so the frontend never has to invent
      // a name or guess what the placeholder domain is called.
      suggestion: suggestWave(user.email ?? user.name),
    });
  });

  /** What the login page has to offer besides the password form. */
  app.get("/api/auth/providers", (c) => c.json({ providers: [...providers.keys()] }));

  app.get("/api/waves/:id/nodes", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);

    const waveId = c.req.param("id");
    const member = await db
      .select({ waveId: waveMembers.waveId })
      .from(waveMembers)
      .where(and(eq(waveMembers.waveId, waveId), eq(waveMembers.userId, user.id)))
      .limit(1);
    // Same answer as a wave that does not exist: who is a member is not public.
    if (member.length === 0) return c.json({ error: "unknown wave" }, 404);

    // The same list the feed pushes on every change, built in one place so a
    // page and its updates cannot disagree.
    return c.json({ nodes: await listDevices(db, waveId, hub.onlineNodeIds(waveId)) });
  });

  app.get("/auth/:provider/start", (c) => {
    const provider = providers.get(c.req.param("provider"));
    if (!provider) return c.json({ error: "unknown provider" }, 404);

    const state = generateState();
    const verifier = generateCodeVerifier();
    const cookieOptions = {
      httpOnly: true,
      secure: config.secureCookies,
      sameSite: "Lax",
      path: "/auth",
      maxAge: FLOW_TTL_SECONDS,
    } as const;
    setCookie(c, STATE_COOKIE, state, cookieOptions);
    const next = safeNext(c.req.query("next"));
    if (next) setCookie(c, NEXT_COOKIE, next, { ...cookieOptions, path: "/" });
    if (provider.usesPkce) setCookie(c, VERIFIER_COOKIE, verifier, cookieOptions);

    return c.redirect(provider.createAuthorizationURL(state, verifier).toString());
  });

  // Stand-in for a provider's consent screen; only mounted when dev auth is on.
  app.get("/auth/dev/login", (c) => {
    if (!providers.has("dev")) return c.json({ error: "unknown provider" }, 404);
    const state = c.req.query("state") ?? "";
    return c.html(html`<h1>Dev login</h1>
      <form method="get" action="/auth/dev/callback">
        <input type="hidden" name="state" value="${state}" />
        <input type="email" name="code" placeholder="you@example.com" required />
        <button type="submit">Sign in</button>
      </form>`);
  });

  app.get("/auth/:provider/callback", async (c) => {
    const providerId = c.req.param("provider");
    const provider = providers.get(providerId);
    if (!provider) return c.json({ error: "unknown provider" }, 404);

    const code = c.req.query("code");
    const state = c.req.query("state");
    const expectedState = getCookie(c, STATE_COOKIE);
    const verifier = getCookie(c, VERIFIER_COOKIE) ?? "";
    deleteCookie(c, STATE_COOKIE, { path: "/auth" });
    deleteCookie(c, VERIFIER_COOKIE, { path: "/auth" });

    if (!code) return c.json({ error: "missing code" }, 400);
    if (!sameToken(state, expectedState)) return c.json({ error: "state mismatch" }, 400);
    if (provider.usesPkce && !verifier) return c.json({ error: "missing PKCE verifier" }, 400);

    let claims: Awaited<ReturnType<OAuthProvider["fetchClaims"]>>;
    try {
      claims = await provider.fetchClaims(code, verifier);
    } catch (err) {
      const message = err instanceof Error ? err.message : "authorization failed";
      return c.json({ error: "authorization failed", detail: message }, 400);
    }

    const { userId } = await resolveUser(db, claims);
    const setup = await waveSetup(db, userId, claims.email);

    const { token, expiresAt } = await createSession(db, userId, {
      userAgent: c.req.header("user-agent") ?? null,
      ip: c.req.header("x-forwarded-for") ?? null,
    });
    setSessionCookie(c, config, token, expiresAt);

    const next = safeNext(getCookie(c, NEXT_COOKIE));
    deleteCookie(c, NEXT_COOKIE, { path: "/" });

    // Signing in no longer conjures a network. The suffix every device name
    // hangs under is the owner's to choose, and a wave nobody asked for is
    // exactly what the invitation rule exists to prevent -- so a first login
    // lands on the form, carrying whatever it was on its way to. Without the
    // detour that destination could not work anyway: approving a device needs
    // a wave to put it in.
    if (setup.state !== "ready") {
      const query = next ? `?next=${encodeURIComponent(next)}` : "";
      return c.redirect(`/waves/new${query}`);
    }
    return c.redirect(next ?? "/");
  });

  app.post("/auth/logout", async (c) => {
    const token = readSessionCookie(c);
    if (token) await destroySession(db, token);
    clearSessionCookie(c);
    return c.redirect("/");
  });

  /**
   * Everything this server does not own itself is the frontend's. It stays a
   * plain request proxy: a WebSocket cannot be upgraded through `fetch`, which
   * is why every socket route -- `/v1/control` -- lives here and not there.
   */
  if (config.webUrl) {
    const frontend = new URL(config.webUrl);
    app.all("*", async (c) => {
      const target = new URL(c.req.url);
      target.protocol = frontend.protocol;
      target.host = frontend.host;
      try {
        return await proxy(target, {
          raw: c.req.raw,
          customFetch: webFetch,
          // Redirects belong to the browser. Following them here would leave
          // it on the old address showing the new page.
          redirect: "manual",
          headers: {
            ...c.req.header(),
            // The frontend sees our loopback socket, not the browser's; these
            // are the only way it can build a correct absolute link.
            "x-forwarded-host": c.req.header("host"),
            "x-forwarded-proto": new URL(config.baseUrl).protocol.replace(":", ""),
          },
        });
      } catch (err) {
        // Say which half is down. The node API above is unaffected either way.
        console.error(`frontend at ${config.webUrl} is unreachable:`, err);
        return c.text("frontend unavailable", 502);
      }
    });
  }

  return Object.assign(app, { websocket, hub, feed });
}
