import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { DeviceFeed } from "@/components/device-feed";
import { LinkNotice } from "@/components/link-notice";
import { WaveCard } from "@/components/wave-card";
import { WaveSelect } from "@/components/wave-select";
import { appMessages } from "@/i18n/app";
import { rich } from "@/i18n/rich";
import { fetchMe, fetchMembers, fetchNodes } from "@/lib/control";
import { formatDate } from "@/lib/format";
import { getLocale } from "@/lib/i18n";
import { pickWave, WAVE_COOKIE, WAVE_PARAM } from "@/lib/wave-select";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const joined = typeof params.joined === "string" ? params.joined : undefined;
  const wanted = typeof params[WAVE_PARAM] === "string" ? params[WAVE_PARAM] : undefined;

  const me = await fetchMe();
  if (!me) redirect("/login");
  const locale = await getLocale();
  const t = appMessages(locale);
  const invite = me.invites[0];
  const canCreate = me.canCreateWave !== false;

  // One card at a time: the link, then the cookie, then the first wave. Only
  // the shown wave is asked for its devices and members.
  const current = pickWave(me.waves, wanted, (await cookies()).get(WAVE_COOKIE)?.value);
  const shown = current
    ? { wave: current, nodes: await fetchNodes(current.id), membership: await fetchMembers(current.id) }
    : undefined;

  return (
    <>
      {/* Keine sichtbare Einleitung: die Wave-Karten sind die Seite und stehen
          ganz oben. Die Überschrift bleibt für Screenreader, damit die Seite
          eine hat. */}
      <h1 className="sr-only">{t.dashboardTitle}</h1>

      {/* Ein getrenntes Konto sagt, welches Konto aktiv ist und warum ein
          erwarteter Wave fehlen kann -- sonst nur Rätselraten vor der leeren Seite. */}
      <LinkNotice me={me} />

      {joined ? (
        <p className="wc-alert-success mb-6" role="status">
          {rich(t.joined, { wave: <strong className="font-medium">{joined}</strong> })}
        </p>
      ) : null}

      {!shown ? (
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
        /* Die Karte bleibt serverseitig -- gelebt wird nur die Geräteliste
           darin, und die hängt an einem Socket für die ganze Seite. Er
           liefert die Listen aller Waves; die der nicht gezeigten
           ignoriert die Karte, weil sie nur ihre eigene liest. */
        <DeviceFeed>
          {me.waves.length > 1 ? (
            <WaveSelect waves={me.waves} currentId={shown.wave.id} label={t.chooseWave} />
          ) : null}
          <WaveCard
            key={shown.wave.id}
            wave={shown.wave}
            nodes={shown.nodes}
            membership={shown.membership}
            meId={me.user.id}
            delay={0}
            locale={locale}
          />
        </DeviceFeed>
      )}
    </>
  );
}
