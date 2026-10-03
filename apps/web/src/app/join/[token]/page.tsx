import { redirect } from "next/navigation";
import { type AppMessages, appMessages, providerName } from "@/i18n/app";
import { rich } from "@/i18n/rich";
import { fetchInvite, fetchMe, fetchProviders } from "@/lib/control";
import { formatDate } from "@/lib/format";
import { getLocale } from "@/lib/i18n";

/** The codes the control server redirects back with, never its own wording. */
const ERRORS: Record<string, (t: AppMessages) => string> = {
  "wrong-address": (t) => t.joinWrongAddress,
  "unverified-address": (t) => t.joinUnverified,
  gone: (t) => t.joinGone,
};

/**
 * Was der Eingeladene sieht, bevor er angemeldet ist.
 *
 * Angenommen wird die Einladung nicht hier, sondern auf `/invite/<token>` im
 * Control-Server — diese Seite bietet nur die Wege dorthin an. Deshalb führt
 * jeder Knopf über `next` wieder auf genau diesen Pfad zurück.
 */
export default async function JoinPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await params;
  const query = await searchParams;
  const locale = await getLocale();
  const t = appMessages(locale);
  const error = typeof query.error === "string" ? ERRORS[query.error]?.(t) : undefined;

  const invite = await fetchInvite(token);
  if (!invite) redirect("/join/gone");

  const [me, providers] = await Promise.all([fetchMe(), fetchProviders()]);
  const accept = `/invite/${encodeURIComponent(token)}`;
  const suffix = `?next=${encodeURIComponent(accept)}`;

  return (
    <div className="mx-auto max-w-md">
      <div className="mb-10 text-center">
        <h1 className="animate-fade-in font-display text-display-sm text-navy">{t.joinTitle(invite.wave)}</h1>
        <p className="animate-fade-in mt-2 text-body-sm text-slate" style={{ animationDelay: "0.1s" }}>
          {rich(t.joinLead, {
            email: <strong className="font-medium text-navy">{invite.email}</strong>,
            role: t.asRole(invite.role),
            by: invite.invitedBy ? t.joinBy(invite.invitedBy) : null,
            until: formatDate(invite.expiresAt, locale),
          })}
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

        {me ? (
          <>
            <p className="text-body-sm text-slate">
              {rich(t.signedInAs, {
                who: <strong className="font-medium text-navy">{me.user.email ?? me.user.id}</strong>,
              })}
            </p>
            {me.user.email === invite.email ? (
              <a href={accept} className="wc-btn wc-btn-primary mt-6 w-full">
                {t.join}
              </a>
            ) : (
              <>
                <p className="mt-2 text-body-sm text-slate">{t.signOutToAccept(invite.email)}</p>
                <form method="post" action="/auth/logout" className="mt-6">
                  <button type="submit" className="wc-btn wc-btn-secondary w-full">
                    {t.signOut}
                  </button>
                </form>
              </>
            )}
          </>
        ) : invite.hasAccount ? (
          <>
            <p className="text-body-sm text-slate">{t.hasAccount}</p>
            <a href={`/login${suffix}`} className="wc-btn wc-btn-primary mt-6 w-full">
              {t.signIn}
            </a>
            {providers.length > 0 ? (
              <div className="mt-3 flex flex-col gap-3">
                {providers.map((provider) => (
                  <a
                    key={provider.id}
                    className="wc-btn wc-btn-secondary w-full"
                    href={`/auth/${provider.id}/start${suffix}`}
                  >
                    {t.continueWith(providerName(provider, t))}
                  </a>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <>
            {/* Ohne Konto ist der Token die Berechtigung, eines anzulegen --
                eine Registrierungsseite gibt es absichtlich nicht. */}
            <form method="post" action={`${accept}/claim`} className="flex flex-col gap-4">
              <div>
                <label className="wc-label" htmlFor="password">
                  {t.passwordFor(invite.email)}
                </label>
                <input
                  className="wc-input"
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  required
                />
                <p className="mt-2 text-caption text-slate">{t.minChars}</p>
              </div>

              <button type="submit" className="wc-btn wc-btn-primary w-full">
                {t.createAndJoin}
              </button>
            </form>

            {providers.length > 0 ? (
              <>
                <div className="my-7 flex items-center gap-4">
                  <span className="h-px flex-1 bg-line" />
                  <span className="text-label text-slate uppercase">{t.or}</span>
                  <span className="h-px flex-1 bg-line" />
                </div>

                <div className="flex flex-col gap-3">
                  {providers.map((provider) => (
                    <a
                      key={provider.id}
                      className="wc-btn wc-btn-secondary w-full"
                      href={`/auth/${provider.id}/start${suffix}`}
                    >
                      {t.continueWith(providerName(provider, t))}
                    </a>
                  ))}
                </div>
              </>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
