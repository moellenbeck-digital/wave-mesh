import { notFound, redirect } from "next/navigation";
import { DnsProviderForm } from "@/components/dns-provider-form";
import { dnsMessages } from "@/i18n/dns";
import { rich } from "@/i18n/rich";
import { fetchDns, fetchMe } from "@/lib/control";
import { formatDate } from "@/lib/format";
import { getLocale } from "@/lib/i18n";

/**
 * How one wave answers dns-01 (D7): the provider whose API writes the
 * challenge record, or the manual mode. For whoever may manage the wave --
 * everyone else gets the same 404 as a wave that does not exist, because the
 * control server answers so and this page does not second-guess it.
 */
export default async function DnsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await fetchMe();
  if (!me) redirect("/login");
  const wave = me.waves.find((entry) => entry.id === id);
  const settings = await fetchDns(id);
  if (!wave || !settings) notFound();
  const locale = await getLocale();
  const t = dnsMessages(locale);
  const suffix = <code className="font-mono">{settings.dnsSuffix}</code>;

  return (
    <div>
      <a href="/" className="text-caption text-slate">
        {t.back}
      </a>
      <h1 className="animate-fade-in mt-4 font-display text-display-sm text-navy">{t.title(wave.name)}</h1>
      <p className="animate-fade-in mt-3 text-body-sm text-slate">
        {rich(t.intro, { cert: <code className="font-mono">wave cert</code>, suffix })}
      </p>

      <section className="wc-card animate-slide-up relative mt-8 rounded-lg p-6 md:p-8">
        <div className="absolute top-0 right-0 left-0 h-1 rounded-t-lg bg-accent" />
        {settings.placeholder ? (
          // Nothing to choose: no CA validates a name under `.internal`, and the
          // control server refuses any provider for it.
          <p className="text-body-sm text-navy">{rich(t.placeholder, { suffix })}</p>
        ) : (
          <>
            <p className="mb-6 text-body-sm text-navy" suppressHydrationWarning>
              {settings.provider
                ? t.current(t.providerName(settings.provider), formatDate(settings.updatedAt, locale))
                : t.none}
            </p>
            {settings.sealing ? null : <p className="mb-6 text-caption text-slate">{t.noSealing}</p>}
            <DnsProviderForm waveId={id} settings={settings} />
          </>
        )}
      </section>
    </div>
  );
}
