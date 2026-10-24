import { redirect } from "next/navigation";
import { DeviceFeed } from "@/components/device-feed";
import { WaveCard } from "@/components/wave-card";
import { appMessages } from "@/i18n/app";
import { rich } from "@/i18n/rich";
import { fetchMe, fetchMembers, fetchNodes } from "@/lib/control";
import { formatDate } from "@/lib/format";
import { getLocale } from "@/lib/i18n";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const joined = typeof params.joined === "string" ? params.joined : undefined;

  const me = await fetchMe();
  if (!me) redirect("/login");
  const locale = await getLocale();
  const t = appMessages(locale);
  const invite = me.invites[0];
  const canCreate = me.canCreateWave !== false;

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
      <h1 className="sr-only">{t.dashboardTitle}</h1>

      {joined ? (
        <p className="wc-alert-success mb-6" role="status">
          {rich(t.joined, { wave: <strong className="font-medium">{joined}</strong> })}
        </p>
      ) : null}

      {waves.length === 0 ? (
        <section className="wc-card animate-slide-up rounded-lg p-8 text-center">
          <h2 className="font-display text-headline text-navy">{t.noWaveTitle}</h2>
          {invite ? (
            /* Kein eigener Wave, weil eine Einladung wartet -- der Server legt
               dann keinen an. Den Link kennt nur der Eingeladene selbst. */
            <p className="mx-auto mt-3 max-w-md text-body-sm text-slate">
              {rich(t.inviteWaiting, {
                wave: <strong className="font-medium text-navy">{invite.wave}</strong>,
                by: invite.invitedBy ? t.invitedBy(invite.invitedBy) : null,
                until: formatDate(invite.expiresAt, locale),
              })}
            </p>
          ) : (
            <p className="mx-auto mt-3 max-w-md text-body-sm text-slate">
              {canCreate ? t.noWaveText : t.noWaveBooked}
            </p>
          )}
          {/* Wo Waves verkauft werden, gibt es kein Formular -- ein Knopf
              dorthin führte nur zur Absage. */}
          {canCreate ? (
            <a href="/waves/new" className="wc-btn wc-btn-primary mt-6">
              {t.createWave}
            </a>
          ) : null}
        </section>
      ) : (
        /* Die Karten bleiben serverseitig -- gelebt wird nur die Geräteliste
           darin, und die hängt an einem Socket für die ganze Seite. */
        <DeviceFeed>
          <div className="flex flex-col gap-6">
            {waves.map(({ wave, nodes, membership }, index) => (
              <WaveCard
                key={wave.id}
                wave={wave}
                nodes={nodes}
                membership={membership}
                meId={me.user.id}
                delay={index * 0.1}
                locale={locale}
              />
            ))}
          </div>
        </DeviceFeed>
      )}
    </>
  );
}
