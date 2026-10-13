import { createHash, timingSafeEqual } from "node:crypto";
import { type Context, Hono } from "hono";
import { html } from "hono/html";
import { z } from "zod";
import { createSession, setSessionCookie } from "../auth/session.ts";
import { loadSetup, ownerAccess, redeemSetup } from "../billing/setup-links.ts";
import { applySubscription, billedWave, NoCapacityError } from "../billing/subscriptions.ts";
import type { Database } from "../db/client.ts";
import type { Config } from "../env.ts";
import { localeOf } from "../i18n.ts";
import type { NetmapHub } from "./control-ws.ts";
import { type PageMessages, pageMessages } from "./messages.ts";

/** Same floor as everywhere else a password is set. */
const MIN_PASSWORD_LENGTH = 12;

export interface BillingRouteDeps {
  db: Database;
  config: Config;
  hub?: NetmapHub;
}

const SubscriptionBody = z.object({
  email: z.string().optional(),
  name: z.string().max(200).optional(),
  seats: z.number().int().min(1).max(100_000),
  state: z.enum(["active", "suspended", "ended"]),
  /** When the site read this state (ms); older than the last one applied means stale. */
  asOf: z.number().int().nonnegative().optional(),
});

const OwnerLinkBody = z.object({ key: z.string().min(1).max(255).optional() });

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

/**
 * Compared as hashes: equal length on both sides whatever was sent, so the
 * comparison takes the same time for a wrong token of any length.
 */
const sameSecret = (given: string, expected: string): boolean =>
  timingSafeEqual(digest(given), digest(expected));

/**
 * What wave-mesh.org calls when Stripe tells it something, and the page the
 * owner of a freshly paid wave sets a password on.
 *
 * The API speaks in subscription ids and desired states (see
 * billing/subscriptions.ts). It is one bearer token, held by the site alone --
 * not a user's session, because nobody is signed in when a payment clears.
 */
export function billingRoutes({ db, config, hub }: BillingRouteDeps) {
  const app = new Hono();
  const billing = config.billing;

  const say = (c: Context): PageMessages => pageMessages(localeOf(c));
  const page = (c: Context, title: string, body: string, status: 410 | 400 | 403) =>
    c.html(html`<h1>${title}</h1><p>${body}</p>`, status);

  app.use("/api/billing/*", async (c, next) => {
    // Without a token the routes do not exist: the same plain 404 as any path
    // nothing serves, not a JSON answer that says a billing API lives here.
    if (!billing) return c.notFound();
    const header = c.req.header("authorization") ?? "";
    const given = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (!given || !sameSecret(given, billing.token)) return c.json({ error: "unauthorized" }, 401);
    return next();
  });

  app.put("/api/billing/subscriptions/:subscriptionId", async (c) => {
    const subscriptionId = c.req.param("subscriptionId");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "not JSON" }, 400);
    }
    const parsed = SubscriptionBody.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid request", detail: parsed.error.issues }, 400);

    let result: Awaited<ReturnType<typeof applySubscription>>;
    try {
      result = await applySubscription(db, subscriptionId, parsed.data, {
        retentionDays: billing?.retentionDays,
        container: config.ipv4Container,
      });
    } catch (error) {
      // An address that is none is the caller's mistake; anything else is ours
      // and goes to the log as well, so a retry from Stripe is not the only
      // trace of it.
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("not an email address")) return c.json({ error: message }, 400);
      if (error instanceof NoCapacityError) {
        // Loud: a customer has paid and this server cannot give them a wave.
        // A retry will not change that; a second server or a larger
        // WAVE_IPV4_CONTAINER will.
        console.error(`billing: NO CAPACITY: every address block is taken, ${subscriptionId} got no wave`);
        return c.json({ error: "no-capacity" }, 507);
      }
      console.error(`billing: ${subscriptionId}: ${message}`);
      return c.json({ error: "could not apply the subscription" }, 500);
    }
    if (result.kind === "unknown") return c.json({ error: "unknown-subscription" }, 404);
    if (result.kind === "ended") return c.json({ error: "ended" }, 409);

    // The mesh stopped or started: every device needs the netmap that says so.
    const { meshChanged, ...answer } = result.view;
    if (meshChanged) await hub?.broadcast(answer.waveId);
    return c.json(answer);
  });

  app.post("/api/billing/subscriptions/:subscriptionId/owner-link", async (c) => {
    // The key is optional and so is the body: an empty POST is a fresh link.
    let body: unknown = {};
    const raw = await c.req.text();
    if (raw.trim()) {
      try {
        body = JSON.parse(raw);
      } catch {
        return c.json({ error: "not JSON" }, 400);
      }
    }
    const parsed = OwnerLinkBody.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid request", detail: parsed.error.issues }, 400);

    const wave = await billedWave(db, c.req.param("subscriptionId"));
    if (!wave || !billing) return c.json({ error: "unknown-subscription" }, 404);
    const access = await ownerAccess(db, wave.ownerUserId, {
      baseUrl: config.baseUrl,
      secret: billing.token,
      key: parsed.data.key,
    });
    if (!access) return c.json({ error: "the owner has no address" }, 409);
    // Where the customer signs in, from the one place that knows: the site's
    // own address for this server is an API base, not a page for people.
    return c.json({ ...access, signInUrl: config.baseUrl });
  });

  // Anything else under the prefix is not a page of the frontend: with
  // WAVE_WEB_URL set it would otherwise go to the proxy, Authorization header
  // and all.
  app.all("/api/billing/*", (c) => c.notFound());

  // --- the owner's first password -------------------------------------------

  app.get("/account/setup/:token", async (c) => {
    const m = say(c);
    const setup = await loadSetup(db, c.req.param("token"));
    if (!setup) return page(c, m.setupGone, m.setupGoneBody, 410);
    return c.html(html`<!doctype html>
      <html lang="${localeOf(c)}">
        <h1>${m.setPasswordTitle}</h1>
        <p>${m.setPasswordFor(setup.email)}</p>
        <form method="post">
          <input type="email" name="email" value="${setup.email}" autocomplete="username" readonly hidden />
          <label>${m.password} <input type="password" name="password" minlength="${MIN_PASSWORD_LENGTH}"
            autocomplete="new-password" required /></label>
          <button type="submit">${m.savePassword}</button>
        </form>
      </html>`);
  });

  app.post("/account/setup/:token", async (c) => {
    const m = say(c);
    // This form signs whoever submits it in. Without the check, a page
    // elsewhere could post an attacker's own link from a victim's browser and
    // leave the victim signed in to the attacker's account (login CSRF).
    if (!sameOrigin(c, config.baseUrl)) return page(c, m.setupForeignOrigin, m.setupForeignOriginBody, 403);
    const form = await c.req.formData();
    const password = String(form.get("password") ?? "");
    if (password.length < MIN_PASSWORD_LENGTH) {
      return page(c, m.passwordTooShort, m.useAtLeast(MIN_PASSWORD_LENGTH), 400);
    }

    const redeemed = await redeemSetup(db, c.req.param("token"), password);
    if (redeemed.kind === "gone") return page(c, m.setupGone, m.setupGoneBody, 410);
    if (redeemed.kind === "has-access") return page(c, m.setupHasAccess, m.setupHasAccessBody, 410);

    // Signed in straight away, like claiming an invitation: the person just
    // proved the mailbox and chose the password, asking for both again would
    // prove nothing more.
    const { token, expiresAt } = await createSession(db, redeemed.userId, {
      userAgent: c.req.header("user-agent") ?? null,
      ip: c.req.header("x-forwarded-for") ?? null,
    });
    setSessionCookie(c, config, token, expiresAt);
    return c.redirect("/", 303);
  });

  return app;
}

/**
 * Whether a form post came from this server's own pages. Browsers send
 * `Sec-Fetch-Site` and, on a POST, `Origin`; a request with neither is not a
 * browser carrying someone's cookies, and is let through.
 */
function sameOrigin(c: Context, baseUrl: string): boolean {
  const site = c.req.header("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = c.req.header("origin");
  if (origin && origin !== "null" && origin !== new URL(baseUrl).origin) return false;
  if (origin === "null") return false;
  return true;
}
