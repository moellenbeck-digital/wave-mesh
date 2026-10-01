export default function NotFound() {
  return (
    <div className="mx-auto max-w-lg text-center">
      <h1 className="animate-fade-in font-display text-display-sm text-navy">Seite nicht gefunden</h1>
      <p className="mt-3 text-body text-slate">Diese Adresse gehört zu keiner Seite dieser Verwaltung.</p>
      <a href="/" className="wc-btn wc-btn-secondary mt-8">
        Zur Übersicht
      </a>
    </div>
  );
}
