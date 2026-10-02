import { appMessages } from "@/i18n/app";
import { getLocale } from "@/lib/i18n";

export default async function NotFound() {
  const t = appMessages(await getLocale());
  return (
    <div className="mx-auto max-w-lg text-center">
      <h1 className="animate-fade-in font-display text-display-sm text-navy">{t.notFoundTitle}</h1>
      <p className="mt-3 text-body text-slate">{t.notFoundText}</p>
      <a href="/" className="wc-btn wc-btn-secondary mt-8">
        {t.toOverview}
      </a>
    </div>
  );
}
