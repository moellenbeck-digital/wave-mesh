import { type Context, Hono } from "hono";
import { html, raw } from "hono/html";
import { LoginThrottle, verifyLogin } from "../auth/password.ts";
import { createSession, setSessionCookie } from "../auth/session.ts";
import type { Database } from "../db/client.ts";
import type { Config } from "../env.ts";
import { type Locale, localeOf } from "../i18n.ts";
import { peerAddress } from "../net/peer.ts";
import { pageMessages } from "./messages.ts";
import { safeNext } from "./next.ts";

export interface PasswordRouteDeps {
  db: Database;
  config: Config;
  throttle?: LoginThrottle;
}

const page = (locale: Locale, body: ReturnType<typeof html>) => html`<!doctype html>
  <html lang="${locale}">
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    body { font: 16px system-ui, sans-serif; margin: 4rem auto; max-width: 22rem; padding: 0 1rem; }
    label { display: block; margin: 1rem 0 0.25rem; }
    input { width: 100%; padding: 0.5rem; font-size: 1rem; box-sizing: border-box; }
    button { margin-top: 1.25rem; padding: 0.6rem 1rem; font-size: 1rem; width: 100%; }
    .error { color: #b00; margin-top: 1rem; }
  </style>
  ${body}`;

const loginForm = (locale: Locale, next: string | undefined, error?: string) => {
  const m = pageMessages(locale);
  return page(
    locale,
    html`<h1>${m.signIn}</h1>
    <form method="post" action="/auth/password/login">
      ${next ? raw(`<input type="hidden" name="next" value="${Bun.escapeHTML(next)}" />`) : ""}
      <label for="email">${m.email}</label>
      <input id="email" name="email" type="email" autocomplete="username" required autofocus />
      <label for="password">${m.password}</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required />
      <button type="submit">${m.signIn}</button>
      ${error ? html`<p class="error">${error}</p>` : ""}
    </form>`,
  );
};

export function passwordRoutes({ db, config, throttle }: PasswordRouteDeps) {
  const app = new Hono();
  const limiter = throttle ?? new LoginThrottle();

  /**
   * With a frontend, the sign-in page lives there and this server only takes
   * the POST. The reason stays in the query string rather than the body, so a
   * reload of the page does not re-submit the password.
   */
  const toLoginPage = (c: Context, next: string | undefined, error?: "invalid" | "throttled") => {
    const query = new URLSearchParams();
    if (next && next !== "/") query.set("next", next);
    if (error) query.set("error", error);
    const suffix = query.size > 0 ? `?${query}` : "";
    return c.redirect(`/login${suffix}`);
  };

  app.get("/auth/password/login", (c) => {
    const next = safeNext(c.req.query("next"));
    return config.webUrl ? toLoginPage(c, next) : c.html(loginForm(localeOf(c), next));
  });

  app.post("/auth/password/login", async (c) => {
    const form = await c.req.formData();
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");
    const next = safeNext(String(form.get("next") ?? "")) ?? "/";
    const source = peerAddress(c) ?? "unknown";

    if (limiter.blocked(email, source)) {
      if (config.webUrl) return toLoginPage(c, next, "throttled");
      return c.html(loginForm(localeOf(c), next, pageMessages(localeOf(c)).tooManyAttempts), 429);
    }

    const result = await verifyLogin(db, email, password);
    if (!result) {
      limiter.fail(email, source);
      // One message for both causes: which addresses exist is not public.
      if (config.webUrl) return toLoginPage(c, next, "invalid");
      return c.html(loginForm(localeOf(c), next, pageMessages(localeOf(c)).wrongCredentials), 401);
    }
    limiter.succeed(email, source);

    const { token, expiresAt } = await createSession(db, result.userId, {
      userAgent: c.req.header("user-agent") ?? null,
      ip: source,
    });
    setSessionCookie(c, config, token, expiresAt);
    return c.redirect(next);
  });

  return app;
}
