export function SiteFooter() {
  return (
    <footer className="px-6 py-8" style={{ borderTop: "1px solid rgba(15, 39, 68, 0.1)" }}>
      <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 text-sm text-slate sm:flex-row">
        <span>wave-mesh — selbst gehostetes Mesh-VPN auf WireGuard-Basis.</span>
        <span className="text-caption">Netzkarten werden signiert ausgeliefert.</span>
      </div>
    </footer>
  );
}
