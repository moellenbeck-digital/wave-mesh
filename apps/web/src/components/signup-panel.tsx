import type { Locale } from "@wave/i18n";
import { appMessages, providerName } from "@/i18n/app";
import { type AuthOptions, SIGNUP_NEXT, signupProviders } from "@/lib/auth-options";

/**
 * The body of `/signup` (ticket #147): the free plan, what the first login does,
 * the note about the confirmed address, and one button per configured provider.
 *
 * The numbers are the control server's (`freePlan` of `/api/auth/providers`);
 * nothing is counted here. The buttons go into the existing login flow with
 * `next=/waves/new`: the first login creates the account, this page creates
 * nothing itself. Password accounts are not offered, they only ever come from a
 * setup or invitation link.
 */
export function SignupPanel({ options, locale }: { options: AuthOptions; locale: Locale }) {
  const t = appMessages(locale);
  const offered = signupProviders(options.providers);
  const next = encodeURIComponent(SIGNUP_NEXT);

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

        {offered.length > 0 ? (
          <div className="mt-7 flex flex-col gap-3">
            {offered.map((provider) => (
              <a
                key={provider.id}
                className="wc-btn wc-btn-primary w-full"
                data-provider={provider.id}
                href={`/auth/${provider.id}/start?next=${next}`}
              >
                {t.signupWith(providerName(provider, t))}
              </a>
            ))}
          </div>
        ) : (
          <p data-signup="no-provider" className="mt-7 text-body-sm text-slate" role="alert">
            {t.signupNoProvider}
          </p>
        )}

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
