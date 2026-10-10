import { createHash, timingSafeEqual } from "node:crypto";
import { type Context, Hono } from "hono";
import { html } from "hono/html";
import { z } from "zod";
import { createSession, setSessionCookie } from "../auth/session.ts";
import { loadSetup, ownerAccess, redeemSetup } from "../billing/setup-links.ts";
import { applySubscription, billedWave } from "../billing/subscriptions.ts";
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
});

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
  const page = (c: Context, title: string, body: string, status: 410 | 400) =>
    c.html(html`<h1>${title}</h1><p>${body}</p>`, status);

  app.use("/api/billing/*", async (c, next) => {
    // Without a token the routes do not exist: same answer as any unknown path.
    if (!billing) return c.json({ error: "not found" }, 404);
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

    let view: Awaited<ReturnType<typeof applySubscription>>;
    try {
      view = await applySubscription(db, subscriptionId, parsed.data, {
        retentionDays: billing?.retentionDays,
        container: config.ipv4Container,
      });
    } catch (error) {
      // An address that is none is the caller's mistake; anything else is ours
      // and goes to the log as well, so a retry from Stripe is not the only
      // trace of it.
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("not an email address")) return c.json({ error: message }, 400);
      console.error(`billing: ${subscriptionId}: ${message}`);
      return c.json({ error: "could not apply the subscription" }, 500);
    }
    if (!view) return c.json({ error: "unknown-subscription" }, 404);

    // The mesh stopped or started: every device needs the netmap that says so.
    if (view.meshChanged) await hub?.broadcast(view.waveId);
    const { meshChanged: _, ...answer } = view;
    return c.json(answer);
  });

  app.post("/api/billing/subscriptions/:subscriptionId/owner-link", async (c) => {
    const wave = await billedWave(db, c.req.param("subscriptionId"));
    if (!wave) return c.json({ error: "unknown-subscription" }, 404);
    const access = await ownerAccess(db, wave.ownerUserId, config.baseUrl);
    if (!access) return c.json({ error: "the owner has no address" }, 409);
    return c.json(access);
  });

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
    const form = await c.req.formData();
    const password = String(form.get("password") ?? "");
    if (password.length < MIN_PASSWORD_LENGTH) {
      return page(c, m.passwordTooShort, m.useAtLeast(MIN_PASSWORD_LENGTH), 400);
    }

    const redeemed = await redeemSetup(db, c.req.param("token"), password);
    if (!redeemed) return page(c, m.setupGone, m.setupGoneBody, 410);

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
