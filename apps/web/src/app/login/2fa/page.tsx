import { redirect } from "next/navigation";
import { accountMessages } from "@/i18n/account";
import { fetchMe } from "@/lib/control";
import { getLocale } from "@/lib/i18n";

/**
 * The second step of a password login. The password was right; the control
 * server holds a short-lived challenge in a cookie this page never sees, and
 * the form posts the code straight back to it.
 */
export default async function LoginCodePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const t = accountMessages(await getLocale());
  const errors: Record<string, string> = { invalid: t.loginCodeInvalid, throttled: t.loginCodeThrottled };
  const error = typeof params.error === "string" ? errors[params.error] : undefined;

  // Already signed in is not a reason to ask for a code.
  if (await fetchMe()) redirect("/");

  return (
    <div className="mx-auto max-w-md">
      <div className="mb-10 text-center">
        <h1 className="animate-fade-in font-display text-display-sm text-navy">{t.loginCodeTitle}</h1>
        <p className="animate-fade-in mt-2 text-body-sm text-slate" style={{ animationDelay: "0.1s" }}>
          {t.loginCodeIntro}
        </p>
      </div>

      <section
        className="wc-card animate-slide-up relative rounded-lg p-8"
        style={{ animationDelay: "0.2s" }}
      >
        <div className="absolute top-0 right-0 left-0 h-1 rounded-t-lg bg-accent" />

        {error ? (
          <p className="wc-alert-error mb-6" role="alert">
            {error}
          </p>
        ) : null}

        <form method="post" action="/auth/password/2fa" className="flex flex-col gap-4">
          <div>
            <label className="wc-label" htmlFor="code">
              {t.codeOrRecovery}
            </label>
            {/* one-time-code lets a phone offer the code from its own
                authenticator; the field takes recovery codes too, so it is
                text and not a number. */}
            <input
              className="wc-input font-mono tracking-widest"
              id="code"
              name="code"
              autoComplete="one-time-code"
              inputMode="text"
              autoCapitalize="none"
              spellCheck={false}
              required
              // biome-ignore lint/a11y/noAutofocus: the page exists for this one field
              autoFocus
            />
          </div>
          <button type="submit" className="wc-btn wc-btn-primary mt-2 w-full">
            {t.loginCodeSubmit}
          </button>
        </form>

        <p className="mt-6 text-center text-caption">
          <a href="/login" className="text-slate hover:text-navy">
            {t.loginCodeBack}
          </a>
        </p>
      </section>
    </div>
  );
}
