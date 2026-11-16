import { type Context, Hono } from "hono";
import { html } from "hono/html";
import { LoginThrottle } from "../auth/password.ts";
import { isLive, RESET_TTL_MS, redeemReset, requestReset, resetUrl } from "../auth/password-reset.ts";
import { noPasswordMail, passwordResetMail } from "../auth/password-reset-mail.ts";
import { isEmailAddress, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "../auth/signup-password.ts";
import type { Database } from "../db/client.ts";
import { normaliseEmail } from "../email.ts";
import type { Config } from "../env.ts";
import { localeOf } from "../i18n.ts";
import type { Mail, Mailer } from "../mail.ts";
import { peerAddress } from "../net/peer.ts";
import { sameOrigin } from "../net/same-origin.ts";
import { pageMessages } from "./messages.ts";
import type { SignupThrottles } from "./signup.ts";

/**
 * "Forgot password" (ticket #159): ask for a link by mail, choose a new
 * password with it. Only where the server can send mail: without a mailer the
 * link does not exist and neither do the endpoints (404).
 *
 * The one thing the request endpoint must not do is say anything about the
 * account. It answers the same for every well-formed address (the same page, the
 * same status, the same text), takes about the same time, and sends its mail
 * after the answer. Throttles count every request, as the registration's do.
 */

/** The throttles of the request endpoint; the same shape as the registration's, but counted on their own. */
export type ResetThrottles = SignupThrottles;

export const defaultResetThrottles = (): ResetThrottles => ({
  perAddressAndSource: new LoginThrottle(5, 15 * 60 * 1000),
  perAddress: new LoginThrottle(5, 60 * 60 * 1000),
  perSource: new LoginThrottle(20, 60 * 60 * 1000),
});

export interface PasswordResetRouteDeps {
  db: Database;
  config: Config;
  /** Without one nothing here exists. */
  mailer?: Mailer | undefined;
  throttles?: ResetThrottles | undefined;
  /** The least a request takes, so the answer's timing does not tell a known address from an unknown one. */
  minDurationMs?: number | undefined;
}

/** What went wrong with a request, as the code the frontend maps to its own wording. */
export type ForgotError = "invalid-email" | "throttled";
/** What went wrong with the new password. */
export type ResetError = "password-too-short" | "password-too-long";

const FORGOT_STATUS: Record<ForgotError, 400 | 429> = { "invalid-email": 400, throttled: 429 };
const RESET_STATUS: Record<ResetError, 400> = { "password-too-short": 400, "password-too-long": 400 };

const FORGOT_PATH = "/password/forgot";
const SENT_PATH = "/password/forgot/sent";
const RESET_PATH = "/password/reset";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function passwordResetRoutes({
  db,
  config,
  mailer,
  throttles,
  minDurationMs = 400,
}: PasswordResetRouteDeps) {
  const app = new Hono();

  if (!mailer) {
    // Explicit, because with a frontend an unmatched path is proxied there.
    app.get("/api/auth/password-reset/check", (c) => c.json({ error: "not found" }, 404));
    app.post("/auth/password/forgot", (c) => c.json({ error: "not found" }, 404));
    app.post("/auth/password/reset", (c) => c.json({ error: "not found" }, 404));
    if (!config.webUrl) {
      app.get(FORGOT_PATH, (c) => c.notFound());
      app.get(SENT_PATH, (c) => c.notFound());
      app.get(RESET_PATH, (c) => c.notFound());
    }
    return app;
  }

  const limits = throttles ?? defaultResetThrottles();
  const plain = !config.webUrl;
  const loginPath = plain ? "/auth/password/login" : "/login";

  const withoutCaching = (c: Context) => {
    c.header("Cache-Control", "no-store");
    // The link carries its token in the query string.
    c.header("Referrer-Policy", "no-referrer");
  };

  const wrap = (c: Context, body: ReturnType<typeof html>, status: 200 | 400 | 403 | 410 | 429 = 200) =>
    c.html(
      html`<!doctype html><html lang="${localeOf(c)}"><meta name="viewport" content="width=device-width,initial-scale=1" />${body}</html>`,
      status,
    );

  const forgotErrorText = (m: ReturnType<typeof pageMessages>, error: ForgotError): string =>
    error === "invalid-email" ? m.signupInvalidEmail : m.tooManyAttempts;

  const resetErrorText = (m: ReturnType<typeof pageMessages>, error: ResetError): string =>
    error === "password-too-short"
      ? `${m.passwordTooShort}. ${m.useAtLeast(MIN_PASSWORD_LENGTH)}`
      : m.signupPasswordTooLong(MAX_PASSWORD_LENGTH);

  const forgotPage = (c: Context, error?: ForgotError) => {
    const m = pageMessages(localeOf(c));
    return html`<h1>${m.forgotTitle}</h1>
      <p data-reset="lead">${m.forgotLead}</p>
      ${error ? html`<p role="alert" data-reset="error" data-error="${error}">${forgotErrorText(m, error)}</p>` : ""}
      <form method="post" action="/auth/password/forgot" data-reset="request-form">
        <p><label>${m.email} <input type="email" name="email" autocomplete="email" required data-field="email" /></label></p>
        <button type="submit" data-action="reset-request">${m.forgotSubmit}</button>
      </form>
      <p><a href="${loginPath}">${m.signIn}</a></p>`;
  };

  const resetFormPage = (c: Context, token: string, error?: ResetError) => {
    const m = pageMessages(localeOf(c));
    return html`<h1>${m.resetTitle}</h1>
      <p>${m.resetBody}</p>
      ${error ? html`<p role="alert" data-reset="error" data-error="${error}">${resetErrorText(m, error)}</p>` : ""}
      <form method="post" action="/auth/password/reset" data-reset="form">
        <input type="hidden" name="token" value="${token}" />
        <p><label>${m.password} <input type="password" name="password" minlength="${MIN_PASSWORD_LENGTH}" autocomplete="new-password" required data-field="password" /></label></p>
        <p data-reset="password-hint">${m.useAtLeast(MIN_PASSWORD_LENGTH)}</p>
        <button type="submit" data-action="reset-submit">${m.resetButton}</button>
      </form>`;
  };

  const gonePage = (c: Context) => {
    const m = pageMessages(localeOf(c));
    return html`<h1 data-reset="gone">${m.resetGoneTitle}</h1>
      <p>${m.resetGoneBody}</p>
      <p><a href="${FORGOT_PATH}" data-reset="again">${m.resetAskAgain}</a> · <a href="${loginPath}">${m.signIn}</a></p>`;
  };

  const forgotFail = (c: Context, error: ForgotError) => {
    // Never the account: only the request (an address that is not one, or too many).
    if (!plain) return c.redirect(`${FORGOT_PATH}?error=${error}`, 303);
    return wrap(c, forgotPage(c, error), FORGOT_STATUS[error]);
  };

  if (plain) {
    app.get(FORGOT_PATH, (c) => {
      const error = c.req.query("error");
      return wrap(c, forgotPage(c, error === "invalid-email" || error === "throttled" ? error : undefined));
    });

    app.get(SENT_PATH, (c) => {
      const m = pageMessages(localeOf(c));
      return wrap(
        c,
        html`<h1 data-reset="sent">${m.forgotSentTitle}</h1><p>${m.forgotSentBody}</p><p><a href="${loginPath}">${m.signIn}</a></p>`,
      );
    });

    app.get(RESET_PATH, async (c) => {
      withoutCaching(c);
      const token = c.req.query("token") ?? "";
      const state = c.req.query("state");
      const error = c.req.query("error");
      if (state === "gone" || !(await isLive(db, token))) return wrap(c, gonePage(c), 410);
      return wrap(
        c,
        resetFormPage(
          c,
          token,
          error === "password-too-short" || error === "password-too-long" ? error : undefined,
        ),
      );
    });
  }

  /** Whether a link is good, for the pages of the frontend; the token is 256 bits, so there is nothing to guess. */
  app.get("/api/auth/password-reset/check", async (c) => {
    withoutCaching(c);
    return c.json({ valid: await isLive(db, c.req.query("token") ?? "") });
  });

  app.post("/auth/password/forgot", async (c) => {
    const started = performance.now();
    const locale = localeOf(c);

    const form = await c.req.formData().catch(() => null);
    if (!form) return forgotFail(c, "invalid-email");
    const email = normaliseEmail(String(form.get("email") ?? ""));
    const source = peerAddress(c) ?? "unknown";

    // Before anything is looked at: a refusal depends on the requests made,
    // not on what the address is.
    if (
      limits.perAddressAndSource.blocked(email, source) ||
      limits.perAddress.blocked(email, "any") ||
      limits.perSource.blocked("reset", source)
    ) {
      return forgotFail(c, "throttled");
    }
    limits.perAddressAndSource.hit(email, source);
    limits.perAddress.hit(email, "any");
    limits.perSource.hit("reset", source);

    if (!isEmailAddress(email)) return forgotFail(c, "invalid-email");

    const request = await requestReset(db, { email });
    let mail: Mail | undefined;
    if (request.kind === "pending") {
      mail = passwordResetMail(locale, email, resetUrl(config.baseUrl, request.token), RESET_TTL_MS);
    } else if (request.kind === "no-password") {
      mail = noPasswordMail(locale, email, `${config.baseUrl}${config.webUrl ? "/login" : "/"}`);
    }
    // After the answer, not before: sending takes as long as the relay takes,
    // and an address without a mail would answer faster. A failure is logged
    // and nothing else -- telling the person would tell them the account exists.
    if (mail) {
      mailer.send(mail).catch((error: unknown) => {
        console.error(
          `password reset: mail could not be sent: ${error instanceof Error ? error.message : error}`,
        );
      });
    }

    const rest = minDurationMs - (performance.now() - started);
    if (rest > 0) await sleep(rest);
    return c.redirect(SENT_PATH, 303);
  });

  app.post("/auth/password/reset", async (c) => {
    withoutCaching(c);
    const m = pageMessages(localeOf(c));
    // A form that changes a password; a page elsewhere must not post one from a browser.
    if (!sameOrigin(c, config.baseUrl)) {
      return wrap(c, html`<h1>${m.setupForeignOrigin}</h1><p>${m.setupForeignOriginBody}</p>`, 403);
    }
    const form = await c.req.formData().catch(() => null);
    const token = String(form?.get("token") ?? "");
    const password = String(form?.get("password") ?? "");

    const gone = () => (plain ? wrap(c, gonePage(c), 410) : c.redirect(`${RESET_PATH}?state=gone`, 303));
    const refuse = (error: ResetError) => {
      if (!plain) return c.redirect(`${RESET_PATH}?token=${encodeURIComponent(token)}&error=${error}`, 303);
      return wrap(c, resetFormPage(c, token, error), RESET_STATUS[error]);
    };

    // A dead link is "gone" before the password is looked at, so a refusal of the
    // password never tells a live link from a dead one.
    if (!(await isLive(db, token))) return gone();
    if (password.length < MIN_PASSWORD_LENGTH) return refuse("password-too-short");
    if (password.length > MAX_PASSWORD_LENGTH) return refuse("password-too-long");

    const result = await redeemReset(db, token, password);
    if (result.kind === "gone") return gone();
    // No session is started: the sessions are all ended and the second factor
    // stays what it was, so the next step is the sign-in.
    return c.redirect(`${loginPath}?notice=password-changed`, 303);
  });

  return app;
}

/** What `/api/auth/providers` says about the reset: it is there when mail can go out. */
export const passwordResetOffered = (mailer: Mailer | undefined): boolean => mailer !== undefined;
