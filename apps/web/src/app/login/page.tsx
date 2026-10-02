import { redirect } from "next/navigation";
import { type AppMessages, appMessages, providerName } from "@/i18n/app";
import { fetchMe, fetchProviders } from "@/lib/control";
import { getLocale } from "@/lib/i18n";

/** The codes the control server redirects back with, never its own wording. */
const ERRORS: Record<string, (t: AppMessages) => string> = {
  invalid: (t) => t.loginInvalid,
  throttled: (t) => t.loginThrottled,
};

/** Only relative paths, so a crafted link cannot bounce the user off-site. */
function safeNext(value: string | undefined): string | undefined {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return undefined;
  return value;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = safeNext(typeof params.next === "string" ? params.next : undefined);
  const t = appMessages(await getLocale());
  const error = typeof params.error === "string" ? ERRORS[params.error]?.(t) : undefined;

  const me = await fetchMe();
  if (me) redirect(next ?? "/");

  const providers = await fetchProviders();
  const suffix = next ? `?next=${encodeURIComponent(next)}` : "";

  return (
    <div className="mx-auto max-w-md">
      <div className="mb-10 text-center">
        <h1 className="animate-fade-in font-display text-display-sm text-navy">{t.signIn}</h1>
        <p className="animate-fade-in mt-2 text-body-sm text-slate" style={{ animationDelay: "0.1s" }}>
          {t.loginLead}
        </p>
      </div>

      <section
        className="wc-card animate-slide-up relative rounded-lg p-8"
        style={{ animationDelay: "0.2s" }}
      >
        <div className="absolute top-0 right-0 left-0 h-1 rounded-t-lg bg-accent" />

        {error ? (
          <p className="wc-alert-error mb-6" role="alert">
            {error}
          </p>
        ) : null}

        <form method="post" action="/auth/password/login" className="flex flex-col gap-4">
          {next ? <input type="hidden" name="next" value={next} /> : null}

          <div>
            <label className="wc-label" htmlFor="email">
              {t.email}
            </label>
            <input
              className="wc-input"
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              required
            />
          </div>

          <div>
            <label className="wc-label" htmlFor="password">
              {t.password}
            </label>
            <input
              className="wc-input"
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </div>

          <button type="submit" className="wc-btn wc-btn-primary mt-2 w-full">
            {t.signIn}
          </button>
        </form>

        {providers.length > 0 ? (
          <>
            <div className="my-7 flex items-center gap-4">
              <span className="h-px flex-1 bg-line" />
              <span className="text-label text-slate uppercase">{t.or}</span>
              <span className="h-px flex-1 bg-line" />
            </div>

            <div className="flex flex-col gap-3">
              {providers.map((id) => (
                <a key={id} className="wc-btn wc-btn-secondary w-full" href={`/auth/${id}/start${suffix}`}>
                  {t.continueWith(providerName(id, t))}
                </a>
              ))}
            </div>
          </>
        ) : null}
      </section>
    </div>
  );
}
