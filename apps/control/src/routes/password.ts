import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { html, raw } from "hono/html";
import { LoginThrottle, verifyLogin } from "../auth/password.ts";
import { createSession, setSessionCookie } from "../auth/session.ts";
import {
  createChallenge,
  endChallenge,
  failChallenge,
  hasTwoFactor,
  readChallenge,
  verifySecondFactor,
} from "../auth/two-factor.ts";
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
  /** Wrong second-factor codes, per account: see the comment on its use. */
  codeThrottle?: LoginThrottle;
}

/** Carries a login between the password and the code. Not a session: it opens nothing else. */
export const CHALLENGE_COOKIE = "wave_2fa";

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

const codeForm = (locale: Locale, error?: string) => {
  const m = pageMessages(locale);
  return page(
    locale,
    html`<h1>${m.twoFactorTitle}</h1>
    <form method="post" action="/auth/password/2fa">
      <label for="code">${m.twoFactorCode}</label>
      <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required autofocus />
      <button type="submit">${m.twoFactorConfirm}</button>
      ${error ? html`<p class="error">${error}</p>` : ""}
    </form>`,
  );
};

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

export function passwordRoutes({ db, config, throttle, codeThrottle }: PasswordRouteDeps) {
  const app = new Hono();
  const limiter = throttle ?? new LoginThrottle();
  // Per account, not per challenge: whoever has the password can open as many
  // challenges as they like, five guesses each, and only this stops them from
  // working through a million codes that way.
  const codeLimiter = codeThrottle ?? new LoginThrottle(10);

  /**
   * With a frontend, the sign-in page lives there and this server only takes
   * the POST. The reason stays in the query string rather than the body, so a
   * reload of the page does not re-submit the password.
   */
  const toLoginPage = (c: Context, next: string | undefined, error?: "invalid" | "throttled" | "expired") => {
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

    // The password was right; with a second factor that is half a login. What
    // the browser gets is a challenge, good for the one form that asks for
    // the code and for five minutes -- never a session.
    if (await hasTwoFactor(db, result.userId)) {
      const challenge = await createChallenge(db, result.userId, next);
      setCookie(c, CHALLENGE_COOKIE, challenge.token, {
        httpOnly: true,
        secure: config.secureCookies,
        sameSite: "Lax",
        path: "/auth/password",
        expires: challenge.expiresAt,
      });
      return config.webUrl ? c.redirect("/login/2fa") : c.html(codeForm(localeOf(c)));
    }

    return startSession(c, result.userId, source, next);
  });

  const startSession = async (c: Context, userId: string, source: string, next: string) => {
    const { token, expiresAt } = await createSession(db, userId, {
      userAgent: c.req.header("user-agent") ?? null,
      ip: source,
    });
    setSessionCookie(c, config, token, expiresAt);
    return c.redirect(next);
  };

  app.get("/auth/password/2fa", (c) =>
    config.webUrl ? c.redirect("/login/2fa") : c.html(codeForm(localeOf(c))),
  );

  app.post("/auth/password/2fa", async (c) => {
    const m = pageMessages(localeOf(c));
    const form = await c.req.formData();
    const code = String(form.get("code") ?? "");
    const source = peerAddress(c) ?? "unknown";
    const token = getCookie(c, CHALLENGE_COOKIE);
    const challenge = token ? await readChallenge(db, token) : null;

    // Gone, used up or never there: back to the password, which is the only
    // way to a new challenge.
    if (!token || !challenge) {
      deleteCookie(c, CHALLENGE_COOKIE, { path: "/auth/password" });
      if (config.webUrl) return toLoginPage(c, undefined, "expired");
      return c.html(loginForm(localeOf(c), undefined, m.challengeExpired), 401);
    }
    const next = safeNext(challenge.next ?? "") ?? "/";

    if (codeLimiter.blocked(challenge.userId, "2fa")) {
      if (config.webUrl) return c.redirect("/login/2fa?error=throttled");
      return c.html(codeForm(localeOf(c), m.tooManyAttempts), 429);
    }

    if (!(await verifySecondFactor(db, challenge.userId, code))) {
      codeLimiter.fail(challenge.userId, "2fa");
      await failChallenge(db, token);
      if (config.webUrl) return c.redirect("/login/2fa?error=invalid");
      return c.html(codeForm(localeOf(c), m.wrongCode), 401);
    }
    codeLimiter.succeed(challenge.userId, "2fa");
    await endChallenge(db, token);
    deleteCookie(c, CHALLENGE_COOKIE, { path: "/auth/password" });
    return startSession(c, challenge.userId, source, next);
  });

  return app;
}
