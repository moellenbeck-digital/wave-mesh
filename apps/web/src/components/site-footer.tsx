import type { Locale } from "@wave/i18n";
import { appMessages } from "@/i18n/app";

export function SiteFooter({ locale }: { locale: Locale }) {
  const t = appMessages(locale);
  return (
    <footer className="px-6 py-8" style={{ borderTop: "1px solid rgba(15, 39, 68, 0.1)" }}>
      <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 text-sm text-slate sm:flex-row">
        <span>{t.footerTagline}</span>
        <span className="text-caption">{t.footerSigned}</span>
      </div>
    </footer>
  );
}
