import { appMessages } from "@/i18n/app";
import { getLocale } from "@/lib/i18n";

/** Benutzt, zurückgezogen oder abgelaufen — von außen dasselbe Bild. */
export default async function InviteGonePage() {
  const t = appMessages(await getLocale());
  return (
    <div className="mx-auto max-w-lg text-center">
      <h1 className="animate-fade-in font-display text-display-sm text-navy">{t.goneTitle}</h1>

      <section
        className="wc-card animate-slide-up relative mt-8 rounded-lg p-8"
        style={{ animationDelay: "0.1s" }}
      >
        <div className="absolute top-0 right-0 left-0 h-1 rounded-t-lg bg-accent" />

        <p className="text-body text-slate">{t.goneText}</p>

        <p className="mt-4 text-body-sm text-slate">{t.goneAsk}</p>

        <a href="/" className="wc-btn wc-btn-primary mt-8">
          {t.toOverview}
        </a>
      </section>
    </div>
  );
}
