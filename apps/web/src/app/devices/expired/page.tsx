export default function DeviceExpiredPage() {
  return (
    <div className="mx-auto max-w-lg text-center">
      <h1 className="animate-fade-in font-display text-display-sm text-navy">Anfrage abgelaufen</h1>

      <section
        className="wc-card animate-slide-up relative mt-8 rounded-lg p-8"
        style={{ animationDelay: "0.1s" }}
      >
        <div
          className="absolute top-0 right-0 left-0 h-1 rounded-t-lg"
          style={{ backgroundColor: "#dc2626" }}
        />

        <p className="text-body text-slate">
          Der Link war nur kurz gültig, damit ein abgefangener Link kein fremdes Gerät ins Netz lässt.
        </p>

        <p className="mt-4 text-body-sm text-slate">Starte die Anmeldung auf dem Gerät noch einmal:</p>

        <pre
          className="mt-4 inline-block rounded-lg px-4 py-2.5 text-caption text-navy"
          style={{ backgroundColor: "#0f27440a" }}
        >
          wave up
        </pre>
      </section>
    </div>
  );
}
