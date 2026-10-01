/** Benutzt, zurückgezogen oder abgelaufen — von außen dasselbe Bild. */
export default function InviteGonePage() {
  return (
    <div className="mx-auto max-w-lg text-center">
      <h1 className="animate-fade-in font-display text-display-sm text-navy">
        Diese Einladung gilt nicht mehr
      </h1>

      <section
        className="wc-card animate-slide-up relative mt-8 rounded-lg p-8"
        style={{ animationDelay: "0.1s" }}
      >
        <div className="absolute top-0 right-0 left-0 h-1 rounded-t-lg bg-accent" />

        <p className="text-body text-slate">
          Sie wurde schon benutzt, zurückgezogen oder ist abgelaufen. Eine Einladung gilt einmal und nur für
          die Adresse, an die sie ging.
        </p>

        <p className="mt-4 text-body-sm text-slate">
          Bitte jemanden aus dem Wave um eine neue — Einladungen erstellen der Eigentümer und die
          Administratoren.
        </p>

        <a href="/" className="wc-btn wc-btn-primary mt-8">
          Zur Übersicht
        </a>
      </section>
    </div>
  );
}
