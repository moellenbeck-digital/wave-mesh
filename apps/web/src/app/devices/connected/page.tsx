import { appMessages } from "@/i18n/app";
import { rich } from "@/i18n/rich";
import { getLocale } from "@/lib/i18n";

/**
 * Where `/machine/authorize` lands once the device is in. The approval itself
 * already happened on the control server -- this page only reports it.
 */
export default async function DeviceConnectedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const value = (key: string) => (typeof params[key] === "string" ? params[key] : undefined);
  const host = value("host");
  const wave = value("wave");
  const ip = value("ip");
  const t = appMessages(await getLocale());

  return (
    <div className="mx-auto max-w-lg text-center">
      <h1 className="animate-fade-in font-display text-display-sm text-navy">
        {host ? t.connectedHost(host) : t.connectedDevice}
      </h1>

      <section
        className="wc-card animate-slide-up relative mt-8 rounded-lg p-8"
        style={{ animationDelay: "0.1s" }}
      >
        <div className="absolute top-0 right-0 left-0 h-1 rounded-t-lg bg-accent" />

        <p className="text-body text-slate">
          {wave
            ? rich(t.connectedWave, {
                wave: <strong className="font-medium text-navy">{wave}</strong>,
                ip: ip
                  ? rich(t.connectedIp, { ip: <code className="font-mono text-navy">{ip}</code> })
                  : null,
              })
            : t.connectedNoWave}
        </p>

        <p className="mt-4 text-body-sm text-slate">{t.connectedClose}</p>

        <a href="/" className="wc-btn wc-btn-primary mt-8">
          {t.toOverview}
        </a>
      </section>
    </div>
  );
}
