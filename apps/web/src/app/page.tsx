import { redirect } from "next/navigation";
import { DeviceFeed } from "@/components/device-feed";
import { WaveCard } from "@/components/wave-card";
import { fetchMe, fetchMembers, fetchNodes } from "@/lib/control";
import { formatDate } from "@/lib/format";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const joined = typeof params.joined === "string" ? params.joined : undefined;

  const me = await fetchMe();
  if (!me) redirect("/login");

  const waves = await Promise.all(
    me.waves.map(async (wave) => ({
      wave,
      nodes: await fetchNodes(wave.id),
      membership: await fetchMembers(wave.id),
    })),
  );

  return (
    <>
      {/* Keine sichtbare Einleitung: die Wave-Karten sind die Seite und stehen
          ganz oben. Die Überschrift bleibt für Screenreader, damit die Seite
          eine hat. */}
      <h1 className="sr-only">Dein Netz</h1>

      {joined ? (
        <p className="wc-alert-success mb-6" role="status">
          Du bist jetzt in <strong className="font-medium">{joined}</strong>.
        </p>
      ) : null}

      {waves.length === 0 ? (
        <section className="wc-card animate-slide-up rounded-lg p-8 text-center">
          <h2 className="font-display text-headline text-navy">Noch kein Wave</h2>
          {me.invites.length > 0 ? (
            /* Kein eigener Wave, weil eine Einladung wartet -- der Server legt
               dann keinen an. Den Link kennt nur der Eingeladene selbst. */
            <p className="mx-auto mt-3 max-w-md text-body-sm text-slate">
              Es wartet eine Einladung in{" "}
              <strong className="font-medium text-navy">{me.invites[0]?.wave}</strong>
              {me.invites[0]?.invitedBy ? <> von {me.invites[0].invitedBy}</> : null}. Öffne den Link, den du
              bekommen hast — er gilt bis {formatDate(me.invites[0]?.expiresAt ?? null)}.
            </p>
          ) : (
            <p className="mx-auto mt-3 max-w-md text-body-sm text-slate">
              Für dieses Konto ist noch kein Netz eingerichtet. Ein Wave entsteht nicht von selbst — die
              Domain, unter der die Gerätenamen hängen, wählst du beim Anlegen.
            </p>
          )}
          <a href="/waves/new" className="wc-btn wc-btn-primary mt-6">
            Wave anlegen
          </a>
        </section>
      ) : (
        /* Die Karten bleiben serverseitig -- gelebt wird nur die Geräteliste
           darin, und die hängt an einem Socket für die ganze Seite. */
        <DeviceFeed>
          <div className="flex flex-col gap-6">
            {waves.map(({ wave, nodes, membership }, index) => (
              <WaveCard key={wave.id} wave={wave} nodes={nodes} membership={membership} delay={index * 0.1} />
            ))}
          </div>
        </DeviceFeed>
      )}
    </>
  );
}
