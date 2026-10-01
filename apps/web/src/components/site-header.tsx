import type { Me } from "@/lib/control";

/**
 * Fixed, blurred, one hairline of navy underneath -- the same header the other
 * WAVe sites wear. `main` carries the matching top padding.
 */
export function SiteHeader({ me }: { me: Me | null }) {
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

        {me ? (
          <div className="flex items-center gap-4">
            <span className="hidden text-caption text-slate sm:inline">
              {me.user.email ?? me.user.name ?? me.user.id}
            </span>
            <form method="post" action="/auth/logout">
              <button type="submit" className="wc-btn wc-btn-secondary">
                Abmelden
              </button>
            </form>
          </div>
        ) : null}
      </div>
    </header>
  );
}
