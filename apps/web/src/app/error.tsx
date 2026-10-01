"use client";

/**
 * Nearly every failure here is the control server not answering -- the pages
 * are thin wrappers around its API. Say that instead of a bare stack trace.
 */
export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto max-w-lg text-center">
      <h1 className="font-display text-display-sm text-navy">Der Control-Server antwortet nicht</h1>
      <p className="mt-3 text-body text-slate">
        Die Oberfläche konnte ihre Daten nicht laden. Der Tunnel selbst ist davon unberührt: Geräte, die
        bereits verbunden sind, bleiben es.
      </p>
      <button type="button" className="wc-btn wc-btn-primary mt-8" onClick={reset}>
        Erneut versuchen
      </button>
    </div>
  );
}
