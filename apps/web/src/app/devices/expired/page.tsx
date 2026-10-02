import { appMessages } from "@/i18n/app";
import { getLocale } from "@/lib/i18n";

export default async function DeviceExpiredPage() {
  const t = appMessages(await getLocale());
  return (
    <div className="mx-auto max-w-lg text-center">
      <h1 className="animate-fade-in font-display text-display-sm text-navy">{t.expiredTitle}</h1>

      <section
        className="wc-card animate-slide-up relative mt-8 rounded-lg p-8"
        style={{ animationDelay: "0.1s" }}
      >
        <div
          className="absolute top-0 right-0 left-0 h-1 rounded-t-lg"
          style={{ backgroundColor: "#dc2626" }}
        />

        <p className="text-body text-slate">{t.expiredText}</p>

        <p className="mt-4 text-body-sm text-slate">{t.expiredRetry}</p>

        <pre
          className="mt-4 inline-block rounded-lg px-4 py-2.5 text-caption text-navy"
          style={{ backgroundColor: "#0f27440a" }}
        >
          wave login &lt;control-server-url&gt;
        </pre>
      </section>
    </div>
  );
}
