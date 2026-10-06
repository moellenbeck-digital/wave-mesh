import { notFound, redirect } from "next/navigation";
import { PolicyEditor } from "@/components/acl-editor";
import { AclGraph } from "@/components/acl-graph";
import { aclMessages } from "@/i18n/acl";
import { rich } from "@/i18n/rich";
import { fetchAcl, fetchAudit, fetchMe } from "@/lib/control";
import { formatDate } from "@/lib/format";
import { getLocale } from "@/lib/i18n";

/**
 * Who may reach whom in one wave (M7): the tags, the policy, what it comes to,
 * and who changed it. For whoever may manage the wave -- everyone else gets
 * the same 404 as a wave that does not exist, because the control server
 * answers so and this page does not second-guess it.
 */
export default async function AccessPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await fetchMe();
  if (!me) redirect("/login");
  const wave = me.waves.find((entry) => entry.id === id);
  const acl = await fetchAcl(id);
  if (!wave || !acl) notFound();
  const audit = await fetchAudit(id);
  const locale = await getLocale();
  const t = aclMessages(locale);
  const code = (text: string) => <code className="font-mono">{text}</code>;
  const unenforced = acl.policy ? acl.devices.filter((device) => !device.enforced) : [];

  return (
    // Breiter als die Spalte des Layouts, bis an die Kanten der Kopfzeile
    // (max-w-7xl, px-6): Graph und Leiste nebeneinander brauchen mehr als
    // max-w-5xl, und eine Leiste unter dem Graphen liegt außer Sicht, sobald
    // man eine Karte antippt. Die ganze Seite, nicht nur die Karte, damit
    // Kopf, Graph und Verlauf an denselben Kanten stehen.
    <div className="relative left-1/2 w-[min(77rem,calc(100vw-3rem))] -translate-x-1/2">
      <a href="/" className="text-caption text-slate">
        {t.back}
      </a>
      <h1 className="animate-fade-in mt-4 font-display text-display-sm text-navy">{t.title(wave.name)}</h1>
      <p className="animate-fade-in mt-3 text-body-sm text-slate">
        {acl.policy ? t.policyActive(acl.version, formatDate(acl.updatedAt, locale)) : t.noPolicy}
      </p>

      <section className="wc-card animate-slide-up relative mt-8 rounded-lg p-6 md:p-8">
        <div className="absolute top-0 right-0 left-0 h-1 rounded-t-lg bg-accent" />
        <h2 className="wc-section-title">{t.reachTitle}</h2>
        {/* Policy und Tags zusammen: eine Regel für tag:nas trifft erst, wenn
            ein Gerät den Tag trägt, und ein getaggtes Gerät zählt nicht mehr
            als Gerät seines Besitzers. Beides getrennt zu bearbeiten hieße,
            die Hälfte der Wirkung nicht zu sehen. */}
        <AclGraph waveId={id} view={acl} />

        {/* Der Ausweg für alles, was der Graph nicht zeichnet, und für den,
            der ein Dokument lieber tippt. Nach jedem Speichern neu, damit es
            nie einen älteren Stand zurückschreibt. */}
        <details className="mt-8">
          <summary className="cursor-pointer text-body-sm text-navy">{t.editJson}</summary>
          <p className="mt-4 mb-4 text-caption text-slate">
            {rich(t.jsonHelp, {
              // The selectors are the policy's own syntax, the same in every language.
              selectors: rich("{a}, {b}, {c}, {d}, {e}", {
                a: code("*"),
                b: code("user:<email>"),
                c: code("group:<name>"),
                d: code("role:owner|admin|member"),
                e: code("tag:<name>"),
              }),
              svc: rich("{a}, {b}", { a: code("svc:<name>"), b: code("svc:*") }),
              p1: code("22"),
              p2: code("5000-5001"),
              p3: code("tcp:445"),
            })}
          </p>
          <PolicyEditor key={acl.version} waveId={id} policy={acl.policy} />
        </details>

        {/* Wer welche Peers sieht, hält die Netzkarte auf jedem Gerät. Die
            Ports hält jedes Gerät selbst -- und eines, das es nicht kann oder
            nie gesagt hat, steht hier, statt still mitzulaufen. */}
        {unenforced.length > 0 ? (
          <div className="mt-6 text-caption text-slate">
            <p className="font-medium text-navy">{t.unenforced}</p>
            <ul className="mt-2 space-y-1">
              {unenforced.map((device) => (
                <li key={device.id}>
                  <span className="font-mono">{device.hostname}</span> — {device.ports}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section className="wc-card animate-slide-up relative mt-8 rounded-lg p-8">
        <div className="absolute top-0 right-0 left-0 h-1 rounded-t-lg bg-accent" />
        <h2 className="wc-section-title">{t.historyTitle}</h2>
        {audit.length === 0 ? (
          <p className="text-body-sm text-slate">{t.historyEmpty}</p>
        ) : (
          <ul className="divide-y divide-line">
            {audit.map((entry) => (
              <li
                key={`${entry.at}-${entry.action}-${entry.target ?? ""}`}
                className="grid grid-cols-1 gap-x-6 gap-y-1 py-3 md:grid-cols-[10rem_minmax(0,1fr)_minmax(0,1.2fr)]"
              >
                <span className="text-caption text-slate" suppressHydrationWarning>
                  {formatDate(entry.at, locale)}
                </span>
                <span className="truncate text-caption text-slate">{entry.actor}</span>
                <span className="truncate text-caption text-navy">
                  <span className="font-mono">{entry.action}</span>
                  {entry.target ? ` ${entry.target}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
