import { redirect } from "next/navigation";
import { fetchMe } from "@/lib/control";

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

  return (
    <div className="mx-auto max-w-lg">
      <div className="mb-10">
        <h1 className="animate-fade-in font-display text-display-sm text-navy">Wave anlegen</h1>
        <p className="animate-fade-in mt-3 text-body-sm text-slate" style={{ animationDelay: "0.1s" }}>
          Ein Wave ist dein Netz: jedes Gerät darin bekommt eine feste Adresse und einen Namen unter deiner
          Domain.
        </p>
      </div>

      {/* Eine wartende Einladung ist fast immer der Weg, den jemand eigentlich
          gehen wollte -- deshalb steht sie vor dem Formular, verstellt es aber
          nicht: wer daneben ein eigenes Netz will, soll es anlegen können. */}
      {waiting ? (
        <p className="wc-alert-success mb-6" role="status">
          Es wartet eine Einladung in <strong className="font-medium">{waiting.wave}</strong>
          {waiting.invitedBy ? <> von {waiting.invitedBy}</> : null}. Öffne den Link, den du bekommen hast —
          ein eigener Wave ist dafür nicht nötig.
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
              Name
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
            <p className="mt-2 text-caption text-slate">Kleinbuchstaben, Ziffern und Bindestriche.</p>
          </div>

          <div>
            <label className="wc-label" htmlFor="suffix">
              Domain
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
              Geräte heißen dann <code className="font-mono">&lt;name&gt;.{me.suggestion.dnsSuffix}</code>.
              Behalte den Vorschlag, wenn du keine eigene Domain hast — ändern kannst du ihn später, das
              benennt allerdings jedes Gerät im Wave um.
            </p>
          </div>

          <button type="submit" className="wc-btn wc-btn-primary mt-2 w-full">
            Wave anlegen
          </button>
        </form>
      </section>
    </div>
  );
}
