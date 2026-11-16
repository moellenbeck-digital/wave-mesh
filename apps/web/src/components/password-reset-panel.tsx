import type { Locale } from "@wave/i18n";
import { appMessages } from "@/i18n/app";

/** The length the server's password rule asks for (`MIN_PASSWORD_LENGTH` in control). */
const MIN_PASSWORD_LENGTH = 12;

/**
 * The pages of "forgot password" (ticket #159): the form for the address, the
 * neutral "the mail is on its way", the form for the new password and the page
 * for a link that does not work. Each is a card with a title, a text and one
 * way on; the selectors are `data-*`, `name` and `href`, the way the sign-up
 * pages have them.
 *
 * The forms post to control (`/auth/password/forgot`, `/auth/password/reset`),
 * which answers with a redirect: onwards, or back here with `?error=<code>`.
 * Nothing here knows whether an address has an account.
 */

const Card = ({ title, children, kind }: { title: string; children: React.ReactNode; kind: string }) => (
  <div className="mx-auto max-w-md" data-reset={kind}>
    <div className="mb-10 text-center">
      <h1 className="animate-fade-in font-display text-display-sm text-navy">{title}</h1>
    </div>
    <section className="wc-card animate-slide-up relative rounded-lg p-8">
      <div className="absolute top-0 right-0 left-0 h-1 rounded-t-lg bg-accent" />
      {children}
    </section>
  </div>
);

/** The form for the address. `error` is the code control redirected back with. */
export function ForgotPanel({ locale, error }: { locale: Locale; error?: string | undefined }) {
  const t = appMessages(locale);
  const message = error ? t.forgotError(error) : "";
  return (
    <Card title={t.forgotTitle} kind="request">
      <p className="text-body-sm text-slate" data-reset="lead">
        {t.forgotLead}
      </p>
      <form
        method="post"
        action="/auth/password/forgot"
        className="mt-7 flex flex-col gap-4"
        data-reset="request-form"
      >
        {message ? (
          <p className="wc-alert-error" role="alert" data-reset="error" data-error={error}>
            {message}
          </p>
        ) : null}
        <div>
          <label className="wc-label" htmlFor="forgot-email">
            {t.email}
          </label>
          <input
            className="wc-input"
            id="forgot-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            data-field="email"
          />
        </div>
        <button type="submit" className="wc-btn wc-btn-primary w-full" data-action="reset-request">
          {t.forgotSubmit}
        </button>
      </form>
      <p className="mt-7 text-center text-body-sm text-slate">
        <a href="/login" className="text-accent">
          {t.signIn}
        </a>
      </p>
    </Card>
  );
}

/** What follows the form, the same for every address; the form for the new password; the dead link. */
export function ResetNotice({
  kind,
  locale,
  token,
  error,
}: {
  kind: "sent" | "form" | "gone";
  locale: Locale;
  token?: string | undefined;
  error?: string | undefined;
}) {
  const t = appMessages(locale);

  if (kind === "sent") {
    return (
      <div className="mx-auto max-w-lg text-center" data-reset="sent">
        <h1 className="animate-fade-in font-display text-display-sm text-navy">{t.forgotSentTitle}</h1>
        <section className="wc-card animate-slide-up relative mt-8 rounded-lg p-8">
          <div className="absolute top-0 right-0 left-0 h-1 rounded-t-lg bg-accent" />
          <p className="text-body text-slate">{t.forgotSentBody}</p>
          <a href="/login" className="wc-btn wc-btn-secondary mt-8">
            {t.signIn}
          </a>
        </section>
      </div>
    );
  }

  if (kind === "gone" || !token) {
    return (
      <div className="mx-auto max-w-lg text-center" data-reset="gone">
        <h1 className="animate-fade-in font-display text-display-sm text-navy">{t.resetGoneTitle}</h1>
        <section className="wc-card animate-slide-up relative mt-8 rounded-lg p-8">
          <div className="absolute top-0 right-0 left-0 h-1 rounded-t-lg bg-accent" />
          <p className="text-body text-slate">{t.resetGoneBody}</p>
          <p className="mt-8 text-body-sm text-slate">
            <a href="/password/forgot" className="text-accent" data-reset="again">
              {t.resetAskAgain}
            </a>
            {" · "}
            <a href="/login" className="text-accent">
              {t.signIn}
            </a>
          </p>
        </section>
      </div>
    );
  }

  const message = error ? t.forgotError(error) : "";
  return (
    <Card title={t.resetTitle} kind="reset">
      <p className="text-body-sm text-slate">{t.resetBody}</p>
      <form
        method="post"
        action="/auth/password/reset"
        className="mt-7 flex flex-col gap-4"
        data-reset="form"
      >
        {message ? (
          <p className="wc-alert-error" role="alert" data-reset="error" data-error={error}>
            {message}
          </p>
        ) : null}
        <input type="hidden" name="token" value={token} />
        <div>
          <label className="wc-label" htmlFor="reset-password">
            {t.password}
          </label>
          <input
            className="wc-input"
            id="reset-password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            required
            data-field="password"
          />
          <p data-reset="password-hint" className="mt-2 text-body-sm text-slate">
            {t.resetPasswordHint(MIN_PASSWORD_LENGTH)}
          </p>
        </div>
        <button type="submit" className="wc-btn wc-btn-primary w-full" data-action="reset-submit">
          {t.resetButton}
        </button>
      </form>
    </Card>
  );
}

/** "Forgot password" on the login page: there only where the server can send mail. */
export function ForgotLink({ passwordReset, locale }: { passwordReset: boolean; locale: Locale }) {
  if (!passwordReset) return null;
  return (
    <p className="mt-5 text-center text-body-sm text-slate">
      <a href="/password/forgot" className="text-accent" data-field="forgot-link">
        {appMessages(locale).forgotLink}
      </a>
    </p>
  );
}
