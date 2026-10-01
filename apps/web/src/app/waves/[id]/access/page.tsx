import { notFound, redirect } from "next/navigation";
import { PolicyEditor } from "@/components/acl-editor";
import { AclGraph } from "@/components/acl-graph";
import { fetchAcl, fetchAudit, fetchMe } from "@/lib/control";
import { formatDate } from "@/lib/format";

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
  const unenforced = acl.policy ? acl.devices.filter((device) => !device.enforced) : [];

  return (
    // Breiter als die Spalte des Layouts, bis an die Kanten der Kopfzeile
    // (max-w-7xl, px-6): Graph und Leiste nebeneinander brauchen mehr als
    // max-w-5xl, und eine Leiste unter dem Graphen liegt außer Sicht, sobald
    // man eine Karte antippt. Die ganze Seite, nicht nur die Karte, damit
    // Kopf, Graph und Verlauf an denselben Kanten stehen.
    <div className="relative left-1/2 w-[min(77rem,calc(100vw-3rem))] -translate-x-1/2">
      <a href="/" className="text-caption text-slate">
        ← Übersicht
      </a>
      <h1 className="animate-fade-in mt-4 font-display text-display-sm text-navy">Zugriff in {wave.name}</h1>
      <p className="animate-fade-in mt-3 text-body-sm text-slate">
        {acl.policy
          ? `Es gilt Policy-Version ${acl.version}, gesetzt ${formatDate(acl.updatedAt)}. Erlaubt ist nur, was eine Regel nennt.`
          : "Es gibt keine Policy: jedes Gerät erreicht jedes andere, auf allen Ports."}
      </p>

      <section className="wc-card animate-slide-up relative mt-8 rounded-lg p-6 md:p-8">
        <div className="absolute top-0 right-0 left-0 h-1 rounded-t-lg bg-accent" />
        <h2 className="wc-section-title">Wer wen erreicht</h2>
        {/* Policy und Tags zusammen: eine Regel für tag:nas trifft erst, wenn
            ein Gerät den Tag trägt, und ein getaggtes Gerät zählt nicht mehr
            als Gerät seines Besitzers. Beides getrennt zu bearbeiten hieße,
            die Hälfte der Wirkung nicht zu sehen. */}
        <AclGraph waveId={id} view={acl} />

        {/* Der Ausweg für alles, was der Graph nicht zeichnet, und für den,
            der ein Dokument lieber tippt. Nach jedem Speichern neu, damit es
            nie einen älteren Stand zurückschreibt. */}
        <details className="mt-8">
          <summary className="cursor-pointer text-body-sm text-navy">Als JSON bearbeiten</summary>
          <p className="mt-4 mb-4 text-caption text-slate">
            Quellen und Ziele: <code className="font-mono">*</code>,{" "}
            <code className="font-mono">user:&lt;email&gt;</code>,{" "}
            <code className="font-mono">group:&lt;name&gt;</code>,{" "}
            <code className="font-mono">role:owner|admin|member</code>,{" "}
            <code className="font-mono">tag:&lt;name&gt;</code>, als Ziel auch{" "}
            <code className="font-mono">svc:&lt;name&gt;</code>. Ports: <code className="font-mono">22</code>,{" "}
            <code className="font-mono">5000-5001</code> oder <code className="font-mono">tcp:445</code>. Tags
            stehen nicht darin, sie hängen am Gerät.
          </p>
          <PolicyEditor key={acl.version} waveId={id} policy={acl.policy} />
        </details>

        {/* Wer welche Peers sieht, hält die Netzkarte auf jedem Gerät. Die
            Ports hält jedes Gerät selbst -- und eines, das es nicht kann oder
            nie gesagt hat, steht hier, statt still mitzulaufen. */}
        {unenforced.length > 0 ? (
          <div className="mt-6 text-caption text-slate">
            <p className="font-medium text-navy">Nur über die Netzkarte begrenzt, nicht in den Ports:</p>
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
        <h2 className="wc-section-title">Verlauf</h2>
        {audit.length === 0 ? (
          <p className="text-body-sm text-slate">Noch nichts aufgezeichnet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {audit.map((entry) => (
              <li
                key={`${entry.at}-${entry.action}-${entry.target ?? ""}`}
                className="grid grid-cols-1 gap-x-6 gap-y-1 py-3 md:grid-cols-[10rem_minmax(0,1fr)_minmax(0,1.2fr)]"
              >
                <span className="text-caption text-slate" suppressHydrationWarning>
                  {formatDate(entry.at)}
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
