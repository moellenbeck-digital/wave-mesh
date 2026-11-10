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
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-2 px-4 sm:px-6">
        <a href="/" className="flex shrink-0 items-baseline">
          <span className="font-display text-xl tracking-tight text-navy">wave</span>
          <span className="font-display text-xl tracking-tight text-accent">mesh</span>
          <span className="ml-2 hidden text-sm text-slate sm:inline">Control</span>
        </a>

        {/* min-w-0: dieser Block darf unter seine Inhaltsbreite schrumpfen. Auf
            schmalem Schirm gibt zuerst die Adresse nach (min-w-0 + truncate),
            nie Sprachumschalter, „?“ oder Abmelden (shrink-0). */}
        <div className="flex min-w-0 items-center gap-2 sm:gap-4">
          {/* Outside the signed-in branch: the person who most needs another
              language is the one looking at the login page. */}
          <div className="shrink-0">
            <LanguageSwitch locale={locale} label={t.language} />
          </div>
          {me ? (
            <>
              {/* The address is the way to the account page: where the second
                  factor is set up, and whatever else belongs to a person
                  rather than a wave. */}
              <a
                href="/account"
                className="min-w-0 max-w-[8rem] truncate text-caption text-slate hover:text-navy sm:max-w-none"
              >
                {me.user.email ?? me.user.name ?? me.user.id}
              </a>
              {/* Der Knopf beendet nur die Browser-Sitzung; wer mehr will
                  (Gerät abmelden, Wave verlassen), findet es auf der
                  Kontoseite. Auf schmalem Schirm nur ein „?“, damit die Zeile
                  nicht überläuft. */}
              <a
                href="/account#abmelden"
                aria-label={t.signOutHelp}
                title={t.signOutHelp}
                className="shrink-0 text-caption text-slate hover:text-navy"
              >
                <span className="hidden md:inline">{t.signOutHelp}</span>
                <span aria-hidden className="md:hidden">
                  ?
                </span>
              </a>
              <form method="post" action="/auth/logout" className="shrink-0">
                <button type="submit" className="wc-btn wc-btn-secondary max-sm:px-3">
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
