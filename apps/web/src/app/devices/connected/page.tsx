/**
 * Where `/machine/authorize` lands once the device is in. The approval itself
 * already happened on the control server -- this page only reports it.
 */
export default async function DeviceConnectedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const value = (key: string) => (typeof params[key] === "string" ? params[key] : undefined);
  const host = value("host");
  const wave = value("wave");
  const ip = value("ip");

  return (
    <div className="mx-auto max-w-lg text-center">
      <h1 className="animate-fade-in font-display text-display-sm text-navy">
        {host ? `${host} ist verbunden` : "Gerät ist verbunden"}
      </h1>

      <section
        className="wc-card animate-slide-up relative mt-8 rounded-lg p-8"
        style={{ animationDelay: "0.1s" }}
      >
        <div className="absolute top-0 right-0 left-0 h-1 rounded-t-lg bg-accent" />

        <p className="text-body text-slate">
          {wave ? (
            <>
              Es gehört jetzt zu <strong className="font-medium text-navy">{wave}</strong>
              {ip ? (
                <>
                  {" "}
                  und hört auf <code className="font-mono text-navy">{ip}</code>
                </>
              ) : null}
              .
            </>
          ) : (
            "Das Gerät wurde deinem Wave hinzugefügt."
          )}
        </p>

        <p className="mt-4 text-body-sm text-slate">
          Dieses Fenster kann zu — die Kommandozeile hat übernommen.
        </p>

        <a href="/" className="wc-btn wc-btn-primary mt-8">
          Zur Übersicht
        </a>
      </section>
    </div>
  );
}
