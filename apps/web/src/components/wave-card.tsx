import type { Locale } from "@wave/i18n";
import { LiveConnectedCount, LiveDeviceCount, LiveNodeList } from "@/components/device-feed";
import { MemberList } from "@/components/member-list";
import { appMessages } from "@/i18n/app";
import { rich } from "@/i18n/rich";
import { canManage, type Membership, type Node, type Wave } from "@/lib/control";

export function WaveCard({
  wave,
  nodes,
  membership,
  delay,
  locale,
}: {
  wave: Wave;
  nodes: Node[];
  membership: Membership;
  delay: number;
  locale: Locale;
}) {
  const t = appMessages(locale);
  const people = membership.members.length;

  return (
    <section
      className="wc-card animate-slide-up relative rounded-lg p-8"
      style={{ animationDelay: `${delay}s` }}
    >
      {/* The accent rule along the top edge, as on the WAVe cards. */}
      <div className="absolute top-0 right-0 left-0 h-1 rounded-t-lg bg-accent" />

      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <div>
          <h2 className="font-display text-headline text-navy">{wave.name}</h2>
          <p className="mt-1 font-mono text-caption text-slate">{wave.dnsSuffix}</p>
        </div>
        <div className="flex items-center gap-3 text-caption text-slate">
          <span>{t.roleName(wave.role)}</span>
          <span aria-hidden>·</span>
          {/* Die Zahlen hängen am Socket, nicht am Seitenaufruf: ein Gerät,
              das sich verbindet, ändert sie ohne Neuladen. */}
          <LiveConnectedCount wave={wave} initial={nodes} />
          <span aria-hidden>·</span>
          <span>{t.people(people)}</span>
        </div>
      </header>

      {/* Der Name ist ein Etikett für Menschen: er steht in keiner Netzkarte,
          auf keinem Zertifikat und in keiner Gerätekonfiguration. Ihn zu
          ändern kostet deshalb nichts -- anders als den Suffix darunter. Ein
          Slug bleibt er trotzdem, weil `admin.ts` einen Wave daran erkennt. */}
      {canManage(membership.role) ? (
        <details className="mb-6 border-line border-b pb-6">
          <summary className="cursor-pointer text-caption text-slate">{t.rename}</summary>
          <form
            method="post"
            action={`/waves/${wave.id}/name`}
            className="mt-4 flex flex-col gap-3 md:flex-row md:items-end"
          >
            <div className="flex-1">
              <label className="wc-label" htmlFor={`name-${wave.id}`}>
                {t.name}
              </label>
              <input
                className="wc-input"
                id={`name-${wave.id}`}
                name="name"
                defaultValue={wave.name}
                autoComplete="off"
                spellCheck={false}
                maxLength={24}
                required
              />
            </div>
            <button type="submit" className="wc-btn wc-btn-secondary">
              {t.apply}
            </button>
          </form>
          <p className="mt-3 text-caption text-slate">{t.renameHint}</p>
        </details>
      ) : null}

      {/* Der Suffix ist das Einzige am Wave, das nicht billig zu ändern ist:
          er benennt jedes Gerät um und ist die Voraussetzung für ein
          Zertifikat. Deshalb eingeklappt -- gebraucht wird er genau einmal,
          beim Umzug von der Platzhalter-Domain auf eine echte. */}
      {canManage(membership.role) ? (
        <details className="mb-8 border-line border-b pb-6">
          <summary className="cursor-pointer text-caption text-slate">{t.changeDomain}</summary>
          <form
            method="post"
            action={`/waves/${wave.id}/domain`}
            className="mt-4 flex flex-col gap-3 md:flex-row md:items-end"
          >
            <div className="flex-1">
              <label className="wc-label" htmlFor={`domain-${wave.id}`}>
                {t.domain}
              </label>
              <input
                className="wc-input"
                id={`domain-${wave.id}`}
                name="domain"
                defaultValue={wave.dnsSuffix}
                autoComplete="off"
                spellCheck={false}
                required
              />
            </div>
            <button type="submit" className="wc-btn wc-btn-secondary">
              {t.apply}
            </button>
          </form>
          <p className="mt-3 text-caption text-slate">
            {rich(t.domainChangeHint, {
              pattern: <code className="font-mono">&lt;name&gt;.&lt;domain&gt;</code>,
            })}
          </p>
        </details>
      ) : null}

      {/* Eine eigene Seite und kein Klappbereich wie Name und Domain: eine
          Policy ist ein Dokument mit Folgen für jedes Gerät, und was sie
          bewirkt, will man neben ihr sehen. */}
      {canManage(membership.role) ? (
        <p className="mb-6 text-caption">
          <a href={`/waves/${wave.id}/access`} className="text-accent">
            {t.accessLink}
          </a>
        </p>
      ) : null}

      <h3 className="wc-section-title">{t.devicesTitle}</h3>
      {/* Wer Mitglieder verwalten darf, darf auch ein einzelnes Gerät
          entfernen -- das ist der kleinere der beiden Schnitte. */}
      <LiveNodeList wave={wave} initial={nodes} mayRemove={canManage(membership.role)} />

      {/* Alle Geräte eines Waves sehen sich gegenseitig -- wer hier steht, ist
          im Netz. Deshalb steht die Liste neben den Geräten, nicht auf einer
          eigenen Seite. */}
      <h3 className="wc-section-title mt-8">{t.peopleTitle}</h3>
      <MemberList wave={wave} membership={membership} locale={locale} />

      {/* Nur der Eigentümer, nicht jeder, der verwalten darf: ein Admin
          entfernt Leute und Geräte, und das lässt sich durch Wiederaufnehmen
          zurücknehmen. Das hier nicht. Deshalb auch eingeklappt und mit
          getipptem Namen -- ein Knopf, der ein Netz auf einen Klick löscht,
          ist einen Fehlgriff von einem Abend Neuanmelden entfernt. */}
      {wave.role === "owner" ? (
        <details className="mt-8 border-line border-t pt-6">
          <summary className="cursor-pointer text-caption text-slate">{t.deleteWave}</summary>
          <form
            method="post"
            action={`/waves/${wave.id}/delete`}
            className="mt-4 flex flex-col gap-3 md:flex-row md:items-end"
          >
            <div className="flex-1">
              <label className="wc-label" htmlFor={`delete-${wave.id}`}>
                {rich(t.deleteConfirm, { name: <span className="font-mono">{wave.name}</span> })}
              </label>
              <input
                className="wc-input"
                id={`delete-${wave.id}`}
                name="name"
                autoComplete="off"
                spellCheck={false}
                required
              />
            </div>
            <button type="submit" className="wc-btn wc-btn-secondary">
              {t.deleteForGood}
            </button>
          </form>
          <p className="mt-3 text-caption text-slate">
            {rich(t.deleteHint, {
              devices: <LiveDeviceCount wave={wave} initial={nodes} />,
              people: t.people(people),
              suffix: <code className="font-mono">{wave.dnsSuffix}</code>,
            })}
          </p>
        </details>
      ) : null}
    </section>
  );
}
