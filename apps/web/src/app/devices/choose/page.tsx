import { redirect } from "next/navigation";
import { appMessages } from "@/i18n/app";
import { fetchDeviceRequest } from "@/lib/control";
import { osName } from "@/lib/format";
import { getLocale } from "@/lib/i18n";

/**
 * Wohin `/machine/authorize` führt — immer, nicht nur bei mehreren Waves.
 *
 * Geraten wird hier nichts: der Wave entscheidet Adressen, DNS-Suffix und wer
 * das Gerät sieht. Vor allem aber ist das Absenden die Freigabe, und nicht
 * schon das Öffnen des Links: ein GET trägt bei `SameSite=Lax` das
 * Sitzungscookie auch von einer fremden Seite aus, ein Formular-POST nicht.
 * Deshalb hat auch der Fall mit genau einem Wave eine Seite — er ist der
 * häufigste, und er wäre der, den niemand ansieht.
 */
export default async function ChooseWavePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const id = typeof params.request === "string" ? params.request : undefined;
  const pending = id ? await fetchDeviceRequest(id) : null;
  if (!pending) redirect("/devices/expired");

  const { request, waves } = pending;
  const locale = await getLocale();
  const t = appMessages(locale);
  const only = waves.length === 1 ? waves[0] : undefined;

  return (
    <div className="mx-auto max-w-md">
      <div className="mb-10 text-center">
        <h1 className="animate-fade-in font-display text-display-sm text-navy">
          {only ? t.chooseOne(request.hostname) : t.chooseMany(request.hostname)}
        </h1>
        <p className="animate-fade-in mt-2 text-body-sm text-slate" style={{ animationDelay: "0.1s" }}>
          {osName(request.os, locale)} · {only ? t.chooseOneText : t.chooseManyText}
        </p>
      </div>

      <section
        className="wc-card animate-slide-up relative rounded-lg p-8"
        style={{ animationDelay: "0.2s" }}
      >
        <div className="absolute top-0 right-0 left-0 h-1 rounded-t-lg bg-accent" />

        <form method="post" action="/machine/authorize" className="flex flex-col gap-3">
          <input type="hidden" name="request" value={request.id} />

          {only ? (
            <>
              <input type="hidden" name="wave" value={only.id} />
              <div className="flex items-center gap-3 rounded-lg border border-line p-4">
                <span className="min-w-0">
                  <span className="block truncate font-medium text-navy text-body-sm">{only.name}</span>
                  <span className="block truncate font-mono text-caption text-slate">{only.dnsSuffix}</span>
                </span>
              </div>
            </>
          ) : (
            waves.map((wave, index) => (
              <label
                key={wave.id}
                className="flex cursor-pointer items-center gap-3 rounded-lg border border-line p-4"
              >
                <input type="radio" name="wave" value={wave.id} defaultChecked={index === 0} required />
                <span className="min-w-0">
                  <span className="block truncate font-medium text-navy text-body-sm">{wave.name}</span>
                  <span className="block truncate font-mono text-caption text-slate">{wave.dnsSuffix}</span>
                </span>
              </label>
            ))
          )}

          <button type="submit" className="wc-btn wc-btn-primary mt-3 w-full">
            {t.addDevice}
          </button>
        </form>
      </section>
    </div>
  );
}
