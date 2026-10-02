import { redirect } from "next/navigation";
import { appMessages } from "@/i18n/app";
import { rich } from "@/i18n/rich";
import { fetchMe } from "@/lib/control";
import { getLocale } from "@/lib/i18n";

/** Only relative paths, so a crafted link cannot bounce the user off-site. */
const safeNext = (value: string | undefined): string | undefined =>
  value?.startsWith("/") && !value.startsWith("//") ? value : undefined;

/**
 * Wo ein Wave entsteht. Die Domain wird hier gefragt und nicht vergeben: unter
 * ihr hängt jeder Gerätename, und ein öffentliches Zertifikat gibt es nur für
 * eine Domain, die einem wirklich gehört. Wer keine hat, behält den Vorschlag
 * unter `wave.internal` — der ist ehrlich darüber, nie ein Zertifikat tragen zu
 * können, statt eine echte Zone vorzutäuschen.
 */
export default async function NewWavePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = safeNext(typeof params.next === "string" ? params.next : undefined);

  const me = await fetchMe();
  if (!me) redirect(`/login?next=${encodeURIComponent("/waves/new")}`);

  const waiting = me.invites[0];
  const t = appMessages(await getLocale());

  return (
    <div className="mx-auto max-w-lg">
      <div className="mb-10">
        <h1 className="animate-fade-in font-display text-display-sm text-navy">{t.createWave}</h1>
        <p className="animate-fade-in mt-3 text-body-sm text-slate" style={{ animationDelay: "0.1s" }}>
          {t.newLead}
        </p>
      </div>

      {/* Eine wartende Einladung ist fast immer der Weg, den jemand eigentlich
          gehen wollte -- deshalb steht sie vor dem Formular, verstellt es aber
          nicht: wer daneben ein eigenes Netz will, soll es anlegen können. */}
      {waiting ? (
        <p className="wc-alert-success mb-6" role="status">
          {rich(t.newInviteWaiting, {
            wave: <strong className="font-medium">{waiting.wave}</strong>,
            by: waiting.invitedBy ? t.invitedBy(waiting.invitedBy) : null,
          })}
        </p>
      ) : null}

      <section
        className="wc-card animate-slide-up relative rounded-lg p-8"
        style={{ animationDelay: "0.2s" }}
      >
        <div className="absolute top-0 right-0 left-0 h-1 rounded-t-lg bg-accent" />

        <form method="post" action="/waves" className="flex flex-col gap-4">
          {next ? <input type="hidden" name="next" value={next} /> : null}

          <div>
            <label className="wc-label" htmlFor="name">
              {t.name}
            </label>
            <input
              className="wc-input"
              id="name"
              name="name"
              defaultValue={me.suggestion.name}
              pattern="[a-zA-Z][a-zA-Z0-9-]*"
              maxLength={24}
              required
            />
            <p className="mt-2 text-caption text-slate">{t.nameHint}</p>
          </div>

          <div>
            <label className="wc-label" htmlFor="suffix">
              {t.domain}
            </label>
            <input
              className="wc-input"
              id="suffix"
              name="suffix"
              defaultValue={me.suggestion.dnsSuffix}
              autoComplete="off"
              spellCheck={false}
              required
            />
            <p className="mt-2 text-caption text-slate">
              {rich(t.domainHint, {
                pattern: <code className="font-mono">&lt;name&gt;.{me.suggestion.dnsSuffix}</code>,
              })}
            </p>
          </div>

          <button type="submit" className="wc-btn wc-btn-primary mt-2 w-full">
            {t.createWave}
          </button>
        </form>
      </section>
    </div>
  );
}
