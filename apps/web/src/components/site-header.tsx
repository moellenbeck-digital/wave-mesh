import type { Locale } from "@wave/i18n";
import { LanguageSwitch } from "@/components/language-switch";
import { appMessages } from "@/i18n/app";
import type { Me } from "@/lib/control";

/**
 * Fixed, blurred, one hairline of navy underneath -- the same header the other
 * WAVe sites wear. `main` carries the matching top padding.
 */
export function SiteHeader({ me, locale }: { me: Me | null; locale: Locale }) {
  const t = appMessages(locale);
  return (
    <header
      className="fixed top-0 right-0 left-0 z-50 border-b backdrop-blur-md"
      style={{ backgroundColor: "rgba(255, 253, 248, 0.85)", borderColor: "rgba(15, 39, 68, 0.1)" }}
    >
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
        <a href="/" className="flex items-baseline">
          <span className="font-display text-xl tracking-tight text-navy">wave</span>
          <span className="font-display text-xl tracking-tight text-accent">mesh</span>
          <span className="ml-2 hidden text-sm text-slate sm:inline">Control</span>
        </a>

        <div className="flex items-center gap-4">
          {/* Outside the signed-in branch: the person who most needs another
              language is the one looking at the login page. */}
          <LanguageSwitch locale={locale} label={t.language} />
          {me ? (
            <>
              {/* The address is the way to the account page: where the second
                  factor is set up, and whatever else belongs to a person
                  rather than a wave. */}
              <a href="/account" className="hidden text-caption text-slate hover:text-navy sm:inline">
                {me.user.email ?? me.user.name ?? me.user.id}
              </a>
              <form method="post" action="/auth/logout">
                <button type="submit" className="wc-btn wc-btn-secondary">
                  {t.signOut}
                </button>
              </form>
            </>
          ) : null}
        </div>
      </div>
    </header>
  );
}
