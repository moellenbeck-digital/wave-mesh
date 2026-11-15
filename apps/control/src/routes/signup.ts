import { type Context, Hono } from "hono";
import { html } from "hono/html";
import { LoginThrottle } from "../auth/password.ts";
import type { OAuthProvider } from "../auth/providers.ts";
import { SIGNUP_NEXT, signupProviders } from "../auth/signup.ts";
import { alreadyRegisteredMail, confirmationMail } from "../auth/signup-mail.ts";
import {
  confirm,
  confirmUrl,
  isEmailAddress,
  isLive,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  register,
  SIGNUP_TTL_MS,
} from "../auth/signup-password.ts";
import { freeLimitsOf } from "../billing/plan.ts";
import type { Database } from "../db/client.ts";
import { normaliseEmail } from "../email.ts";
import type { Config } from "../env.ts";
import { localeOf } from "../i18n.ts";
import type { Mailer } from "../mail.ts";
import { peerAddress } from "../net/peer.ts";
import { pageMessages } from "./messages.ts";

/**
 * Throttles of the registration (ticket #150), the way the password login has
 * its own: counted in this process, and every request counts -- also one that
 * is refused, and none resets the count. What they key on is the request, never
 * whether the address has an account, so a refusal says nothing about it.
 */
export interface SignupThrottles {
  /** Per address and source: a person who mistypes, and nobody who retries a hundred times. */
  perAddressAndSource: LoginThrottle;
  /** Per address from anywhere: the mail somebody else's mailbox receives is bounded. */
  perAddress: LoginThrottle;
  /** Per source across addresses: one machine does not register a list. */
  perSource: LoginThrottle;
}

export const defaultSignupThrottles = (): SignupThrottles => ({
  perAddressAndSource: new LoginThrottle(5, 15 * 60 * 1000),
  perAddress: new LoginThrottle(5, 60 * 60 * 1000),
  perSource: new LoginThrottle(20, 60 * 60 * 1000),
});

export interface SignupRouteDeps {
  db: Database;
  config: Config;
  providers: Map<string, OAuthProvider>;
  /** Without one the password registration does not exist (no way to confirm an address). */
  mailer?: Mailer | undefined;
  throttles?: SignupThrottles | undefined;
}

/** What went wrong with a registration, as the code the frontend maps to its own wording. */
export type SignupError =
  | "invalid-email"
  | "password-too-short"
  | "password-too-long"
  | "throttled"
  | "mail-failed";

const STATUS: Record<SignupError, 400 | 429 | 503> = {
  "invalid-email": 400,
  "password-too-short": 400,
  "password-too-long": 400,
  throttled: 429,
  "mail-failed": 503,
};

const isSignupError = (value: string | undefined): value is SignupError =>
  value !== undefined && value in STATUS;

const SENT_PATH = "/signup/sent";
const CONFIRM_PATH = "/signup/confirm";

/**
 * Registration with email and password, and the pages around it.
 *
 * With `WAVE_WEB_URL` the pages belong to the frontend and this server only
 * takes the POSTs and answers with a redirect (a code in the query, never its
 * own wording, like the password login); without, it renders plain ones.
 * Switched off, the two POST endpoints answer 404 and nothing else exists.
 */
export function signupRoutes({ db, config, providers, mailer, throttles }: SignupRouteDeps) {
  const app = new Hono();

  if (!config.signupEnabled) {
    // Explicit, because with a frontend an unmatched path is proxied there.
    app.post("/auth/signup", (c) => c.json({ error: "not found" }, 404));
    app.post("/auth/signup/confirm", (c) => c.json({ error: "not found" }, 404));
    return app;
  }

  const limits = throttles ?? defaultSignupThrottles();
  const plain = !config.webUrl;

  /** Whether the password registration is on offer: the switch is on and mail can go out. */
  const passwordSignup = mailer !== undefined;

  const withoutCaching = (c: Context) => {
    c.header("Cache-Control", "no-store");
    // The confirmation link carries its token in the query string.
    c.header("Referrer-Policy", "no-referrer");
  };

  const signupPage = (c: Context, error?: SignupError) => {
    const m = pageMessages(localeOf(c));
    const offered = signupProviders(providers);
    const buttons = offered.map(
      (p) =>
        html`<li><a href="/auth/${p.id}/start?next=${encodeURIComponent(SIGNUP_NEXT)}" data-provider="${p.id}">${m.signupWith(p.label)}</a></li>`,
    );
    const message = error ? errorText(m, error) : undefined;
    const form = html`${message ? html`<p role="alert" data-signup="error" data-error="${error}">${message}</p>` : ""}
      <form method="post" action="/auth/signup" data-signup="form">
        <p><label>${m.email} <input type="email" name="email" autocomplete="email" required data-field="email" /></label></p>
        <p><label>${m.password} <input type="password" name="password" minlength="${MIN_PASSWORD_LENGTH}" autocomplete="new-password" required data-field="password" /></label></p>
        <p data-signup="password-hint">${m.signupPasswordHint(MIN_PASSWORD_LENGTH)}</p>
        <button type="submit" data-action="signup-submit">${m.signupSubmit}</button>
      </form>`;
    return html`<h1>${m.signupTitle}</h1>
      <p data-signup="plan">${m.signupFreePlan(freeLimitsOf(config))}</p>
      <p data-signup="how">${m.signupHow}</p>
      <p data-signup="verified">${m.signupVerified}</p>
      ${passwordSignup ? form : ""}
      ${offered.length > 0 ? html`<ul>${buttons}</ul>` : ""}
      ${!passwordSignup && offered.length === 0 ? html`<p data-signup="no-provider">${m.signupNothing}</p>` : ""}
      <p>${m.signupHaveAccount} <a href="/">${m.signIn}</a></p>`;
  };

  const errorText = (m: ReturnType<typeof pageMessages>, error: SignupError): string => {
    switch (error) {
      case "invalid-email":
        return m.signupInvalidEmail;
      case "password-too-short":
        return `${m.passwordTooShort}. ${m.useAtLeast(MIN_PASSWORD_LENGTH)}`;
      case "password-too-long":
        return m.signupPasswordTooLong(MAX_PASSWORD_LENGTH);
      case "throttled":
        return m.tooManyAttempts;
      case "mail-failed":
        return m.signupMailFailed;
    }
  };

  const fail = (c: Context, error: SignupError) => {
    if (!plain) return c.redirect(`/signup?error=${error}`, 303);
    return c.html(signupPage(c, error), STATUS[error]);
  };

  if (plain) {
    app.get("/signup", (c) => {
      const error = c.req.query("error");
      return c.html(signupPage(c, isSignupError(error) ? error : undefined));
    });

    app.get(SENT_PATH, (c) => {
      const m = pageMessages(localeOf(c));
      return c.html(
        html`<h1 data-signup="sent">${m.signupSentTitle}</h1><p>${m.signupSentBody}</p><p><a href="/">${m.signIn}</a></p>`,
      );
    });

    app.get(CONFIRM_PATH, async (c) => {
      withoutCaching(c);
      const m = pageMessages(localeOf(c));
      const loginLink = `/auth/password/login?next=${encodeURIComponent(SIGNUP_NEXT)}`;
      const state = c.req.query("state");
      if (state === "done") {
        return c.html(
          html`<h1 data-signup="confirmed">${m.signupConfirmedTitle}</h1><p>${m.signupConfirmedBody}</p><p><a href="${loginLink}" data-signup="login">${m.signIn}</a></p>`,
        );
      }
      const token = c.req.query("token") ?? "";
      if (state === "gone" || !passwordSignup || !(await isLive(db, token))) {
        return c.html(
          html`<h1 data-signup="gone">${m.signupGoneTitle}</h1><p>${m.signupGoneBody}</p><p><a href="/">${m.signIn}</a> · <a href="/signup">${m.createAccount}</a></p>`,
          410,
        );
      }
      // A button, not the account made by the GET: a mail scanner that opens
      // every link would otherwise spend the token before its owner arrives.
      return c.html(html`<h1>${m.signupConfirmTitle}</h1>
        <p>${m.signupConfirmBody}</p>
        <form method="post" action="/auth/signup/confirm" data-signup="confirm">
          <input type="hidden" name="token" value="${token}" />
          <button type="submit" data-action="signup-confirm">${m.signupConfirmButton}</button>
        </form>`);
    });
  }

  app.post("/auth/signup", async (c) => {
    // No mail server, no way to confirm an address, so no registration.
    if (!mailer) return c.json({ error: "not found" }, 404);
    const locale = localeOf(c);

    const form = await c.req.formData().catch(() => null);
    if (!form) return fail(c, "invalid-email");
    const email = normaliseEmail(String(form.get("email") ?? ""));
    const password = String(form.get("password") ?? "");
    const source = peerAddress(c) ?? "unknown";

    // Before anything is looked at: a refusal depends on the requests made,
    // not on what the address is.
    if (
      limits.perAddressAndSource.blocked(email, source) ||
      limits.perAddress.blocked(email, "any") ||
      limits.perSource.blocked("signup", source)
    ) {
      return fail(c, "throttled");
    }
    limits.perAddressAndSource.hit(email, source);
    limits.perAddress.hit(email, "any");
    limits.perSource.hit("signup", source);

    if (!isEmailAddress(email)) return fail(c, "invalid-email");
    if (password.length < MIN_PASSWORD_LENGTH) return fail(c, "password-too-short");
    if (password.length > MAX_PASSWORD_LENGTH) return fail(c, "password-too-long");

    const registration = await register(db, { email, password });
    // One mail either way, the same status and the same page: the only
    // difference is in the mailbox of the address.
    const mail =
      registration.kind === "pending"
        ? confirmationMail(locale, email, confirmUrl(config.baseUrl, registration.token), SIGNUP_TTL_MS)
        : alreadyRegisteredMail(locale, email, `${config.baseUrl}${config.webUrl ? "/login" : "/"}`);
    try {
      await mailer.send(mail);
    } catch (error) {
      console.error(`signup: mail could not be sent: ${error instanceof Error ? error.message : error}`);
      return fail(c, "mail-failed");
    }
    return c.redirect(SENT_PATH, 303);
  });

  app.post("/auth/signup/confirm", async (c) => {
    if (!mailer) return c.json({ error: "not found" }, 404);
    const form = await c.req.formData().catch(() => null);
    const token = String(form?.get("token") ?? "");
    const result = await confirm(db, token);
    return c.redirect(`${CONFIRM_PATH}?state=${result.kind === "confirmed" ? "done" : "gone"}`, 303);
  });

  return app;
}

/** What `/api/auth/providers` says about the registration. */
export const passwordSignupOffered = (config: Config, mailer: Mailer | undefined): boolean =>
  config.signupEnabled && mailer !== undefined;
