import type { Locale } from "@wave/i18n";
import { appMessages, providerName } from "@/i18n/app";
import { type AuthOptions, SIGNUP_NEXT, signupProviders } from "@/lib/auth-options";

/** The length the server's password rule asks for (`MIN_PASSWORD_LENGTH` in control). */
const MIN_PASSWORD_LENGTH = 12;

/**
 * The body of `/signup` (tickets #147, #150): the free plan, what the first
 * login does, the note about the confirmed address, the form for email and
 * password where the server can send the confirmation mail, and one button per
 * configured provider.
 *
 * The numbers are the control server's (`freePlan` of `/api/auth/providers`);
 * nothing is counted here. The form posts to `/auth/signup`, which answers with
 * a redirect: to `/signup/sent`, or back here with `?error=<code>`. The buttons
 * go into the existing login flow with `next=/waves/new`: the first login
 * creates the account, this page creates nothing itself.
 */
export function SignupPanel({
  options,
  locale,
  error,
}: {
  options: AuthOptions;
  locale: Locale;
  /** The code control redirected back with; one it does not know shows nothing. */
  error?: string | undefined;
}) {
  const t = appMessages(locale);
  const offered = signupProviders(options.providers);
  const next = encodeURIComponent(SIGNUP_NEXT);
  const message = error ? t.signupError(error) : "";

  return (
    <div className="mx-auto max-w-md" data-signup="page">
      <div className="mb-10 text-center">
        <h1 className="animate-fade-in font-display text-display-sm text-navy">{t.signupTitle}</h1>
        <p className="animate-fade-in mt-2 text-body-sm text-slate">{t.signupLead}</p>
      </div>

      <section className="wc-card animate-slide-up relative rounded-lg p-8">
        <div className="absolute top-0 right-0 left-0 h-1 rounded-t-lg bg-accent" />

        {options.freePlan ? (
          <p data-signup="plan" className="font-medium text-navy text-body-sm">
            {t.signupFreePlan(options.freePlan.waves, options.freePlan.people, options.freePlan.devices)}
          </p>
        ) : null}
        <p data-signup="how" className="mt-3 text-body-sm text-slate">
          {t.signupHow}
        </p>
        <p data-signup="verified" className="mt-3 text-body-sm text-slate" role="note">
          {t.signupVerified}
        </p>

        {options.passwordSignup ? (
          <form method="post" action="/auth/signup" className="mt-7 flex flex-col gap-4" data-signup="form">
            {message ? (
              <p className="wc-alert-error" role="alert" data-signup="error" data-error={error}>
                {message}
              </p>
            ) : null}

            <div>
              <label className="wc-label" htmlFor="signup-email">
                {t.email}
              </label>
              <input
                className="wc-input"
                id="signup-email"
                name="email"
                type="email"
                autoComplete="email"
                required
                data-field="email"
              />
            </div>

            <div>
              <label className="wc-label" htmlFor="signup-password">
                {t.password}
              </label>
              <input
                className="wc-input"
                id="signup-password"
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={MIN_PASSWORD_LENGTH}
                required
                data-field="password"
              />
              <p data-signup="password-hint" className="mt-2 text-body-sm text-slate">
                {t.signupPasswordHint(MIN_PASSWORD_LENGTH)}
              </p>
            </div>

            <button type="submit" className="wc-btn wc-btn-primary w-full" data-action="signup-submit">
              {t.signupSubmit}
            </button>
          </form>
        ) : null}

        {offered.length > 0 ? (
          <div className="mt-7 flex flex-col gap-3">
            {offered.map((provider) => (
              <a
                key={provider.id}
                className={`wc-btn w-full ${options.passwordSignup ? "wc-btn-secondary" : "wc-btn-primary"}`}
                data-provider={provider.id}
                href={`/auth/${provider.id}/start?next=${next}`}
              >
                {t.signupWith(providerName(provider, t))}
              </a>
            ))}
          </div>
        ) : null}

        {!options.passwordSignup && offered.length === 0 ? (
          <p data-signup="no-provider" className="mt-7 text-body-sm text-slate" role="alert">
            {t.signupNothing}
          </p>
        ) : null}

        <p className="mt-7 text-center text-body-sm text-slate">
          {t.signupHaveAccount}{" "}
          <a href="/login" className="text-accent">
            {t.signIn}
          </a>
        </p>
      </section>
    </div>
  );
}

/**
 * The pages after the form (ticket #150): "the mail is on its way", and the
 * three states of the link in it -- the button that spends it, the account
 * that exists now, and a link that is used up, expired or not the person's any
 * more. Each is a card with a title, a text and one way on.
 */
export function SignupNotice({
  kind,
  locale,
  token,
}: {
  kind: "sent" | "confirm" | "done" | "gone";
  locale: Locale;
  token?: string | undefined;
}) {
  const t = appMessages(locale);
  const content = {
    sent: { title: t.signupSentTitle, body: t.signupSentBody },
    confirm: { title: t.signupConfirmTitle, body: t.signupConfirmBody },
    done: { title: t.signupConfirmedTitle, body: t.signupConfirmedBody },
    gone: { title: t.signupGoneTitle, body: t.signupGoneBody },
  }[kind];

  return (
    <div className="mx-auto max-w-lg text-center" data-signup={kind}>
      <h1 className="animate-fade-in font-display text-display-sm text-navy">{content.title}</h1>

      <section
        className="wc-card animate-slide-up relative mt-8 rounded-lg p-8"
        style={{ animationDelay: "0.1s" }}
      >
        <div className="absolute top-0 right-0 left-0 h-1 rounded-t-lg bg-accent" />
        <p className="text-body text-slate">{content.body}</p>

        {kind === "confirm" && token ? (
          // A button, not a link that does it: a mail scanner that opens every
          // link would spend the token before its owner arrives.
          <form method="post" action="/auth/signup/confirm" className="mt-8">
            <input type="hidden" name="token" value={token} />
            <button type="submit" className="wc-btn wc-btn-primary" data-action="signup-confirm">
              {t.signupConfirmButton}
            </button>
          </form>
        ) : null}

        {kind === "done" ? (
          <a
            href={`/login?next=${encodeURIComponent(SIGNUP_NEXT)}`}
            className="wc-btn wc-btn-primary mt-8"
            data-signup="login"
          >
            {t.signIn}
          </a>
        ) : null}

        {kind === "gone" ? (
          <p className="mt-8 text-body-sm text-slate">
            <a href="/login" className="text-accent">
              {t.signIn}
            </a>
            {" · "}
            <a href="/signup" className="text-accent">
              {t.createAccount}
            </a>
          </p>
        ) : null}

        {kind === "sent" ? (
          <a href="/login" className="wc-btn wc-btn-secondary mt-8">
            {t.signIn}
          </a>
        ) : null}
      </section>
    </div>
  );
}

/**
 * "Create account" on the login page: there only where sign-up is switched on,
 * and nothing at all where it is not -- the page stays as it was.
 */
export function SignupLink({ signup, locale }: { signup: boolean; locale: Locale }) {
  if (!signup) return null;
  return (
    <p className="mt-7 text-center text-body-sm text-slate">
      <a href="/signup" className="text-accent" data-field="signup-link">
        {appMessages(locale).createAccount}
      </a>
    </p>
  );
}
