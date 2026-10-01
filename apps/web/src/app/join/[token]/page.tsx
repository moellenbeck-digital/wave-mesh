import { redirect } from "next/navigation";
import { fetchInvite, fetchMe, fetchProviders } from "@/lib/control";
import { formatDate } from "@/lib/format";

const PROVIDER_NAMES: Record<string, string> = {
  google: "Google",
  dev: "Entwickler-Login",
};

const ERRORS: Record<string, string> = {
  "wrong-address": "Diese Einladung gehört zu einer anderen Adresse als der, mit der du angemeldet bist.",
  "unverified-address":
    "Der Anmeldedienst bestätigt deine Adresse nicht. Eine unbestätigte Adresse kann keine Einladung annehmen.",
  gone: "Diese Einladung wurde schon benutzt, zurückgezogen oder ist abgelaufen.",
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
  const error = typeof query.error === "string" ? ERRORS[query.error] : undefined;

  const invite = await fetchInvite(token);
  if (!invite) redirect("/join/gone");

  const [me, providers] = await Promise.all([fetchMe(), fetchProviders()]);
  const accept = `/invite/${encodeURIComponent(token)}`;
  const suffix = `?next=${encodeURIComponent(accept)}`;
  const role = invite.role === "admin" ? "Administrator" : "Mitglied";

  return (
    <div className="mx-auto max-w-md">
      <div className="mb-10 text-center">
        <h1 className="animate-fade-in font-display text-display-sm text-navy">Einladung in {invite.wave}</h1>
        <p className="animate-fade-in mt-2 text-body-sm text-slate" style={{ animationDelay: "0.1s" }}>
          Für <strong className="font-medium text-navy">{invite.email}</strong>, als {role}
          {invite.invitedBy ? <>, von {invite.invitedBy}</> : null}. Gültig bis {formatDate(invite.expiresAt)}
          .
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
              Du bist als <strong className="font-medium text-navy">{me.user.email ?? me.user.id}</strong>{" "}
              angemeldet.
            </p>
            {me.user.email === invite.email ? (
              <a href={accept} className="wc-btn wc-btn-primary mt-6 w-full">
                Beitreten
              </a>
            ) : (
              <>
                <p className="mt-2 text-body-sm text-slate">
                  Melde dich ab und mit {invite.email} wieder an, um die Einladung anzunehmen.
                </p>
                <form method="post" action="/auth/logout" className="mt-6">
                  <button type="submit" className="wc-btn wc-btn-secondary w-full">
                    Abmelden
                  </button>
                </form>
              </>
            )}
          </>
        ) : invite.hasAccount ? (
          <>
            <p className="text-body-sm text-slate">
              Für diese Adresse gibt es schon ein Konto. Melde dich damit an — die Einladung wird dabei
              angenommen.
            </p>
            <a href={`/login${suffix}`} className="wc-btn wc-btn-primary mt-6 w-full">
              Anmelden
            </a>
            {providers.length > 0 ? (
              <div className="mt-3 flex flex-col gap-3">
                {providers.map((id) => (
                  <a key={id} className="wc-btn wc-btn-secondary w-full" href={`/auth/${id}/start${suffix}`}>
                    Weiter mit {PROVIDER_NAMES[id] ?? id}
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
                  Passwort für {invite.email}
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
                <p className="mt-2 text-caption text-slate">Mindestens 12 Zeichen.</p>
              </div>

              <button type="submit" className="wc-btn wc-btn-primary w-full">
                Konto anlegen und beitreten
              </button>
            </form>

            {providers.length > 0 ? (
              <>
                <div className="my-7 flex items-center gap-4">
                  <span className="h-px flex-1 bg-line" />
                  <span className="text-label text-slate uppercase">oder</span>
                  <span className="h-px flex-1 bg-line" />
                </div>

                <div className="flex flex-col gap-3">
                  {providers.map((id) => (
                    <a
                      key={id}
                      className="wc-btn wc-btn-secondary w-full"
                      href={`/auth/${id}/start${suffix}`}
                    >
                      Weiter mit {PROVIDER_NAMES[id] ?? id}
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
