import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { identityName, linkMessages } from "@/i18n/link";
import { fetchLink, type LinkState, type LinkSummary } from "@/lib/control";
import { formatDate } from "@/lib/format";
import { getLocale } from "@/lib/i18n";

/**
 * The guided link of an account a provider login split off (B) into the
 * verified account that holds its address (A).
 *
 * One page for all three steps: the control server says where the request
 * stands, and this shows only that step. Every button is a form POST to the
 * control server, which checks the whole chain again each time -- the page
 * never decides anything. Opening it, in any state, changes nothing.
 */
export default async function LinkPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const link = await fetchLink();
  if (!link) redirect("/login?next=/account/link");
  const locale = await getLocale();
  const t = linkMessages(locale);
  const code = typeof params.error === "string" ? params.error : undefined;
  const error = code ? (t.errors[code] ?? t.errors.unknown) : undefined;
  const who = link.account.email ?? link.account.name ?? "";
  const step = link.state === "none" || link.state === "address" ? 1 : link.state === "control" ? 2 : 3;

  return (
    <div className="mx-auto max-w-3xl">
      <a href="/account" className="text-caption text-slate">
        {t.linkBack}
      </a>
      <h1 className="animate-fade-in mt-4 font-display text-display-sm text-navy">{t.linkTitle}</h1>
      <p className="animate-fade-in mt-3 text-body-sm text-slate">{t.activeText(who)}</p>

      <ol className="mt-6 flex flex-wrap gap-x-6 gap-y-1 text-caption">
        {t.steps.map((name, index) => (
          <li
            key={name}
            aria-current={index + 1 === step ? "step" : undefined}
            className={index + 1 === step ? "font-medium text-navy" : "text-slate"}
          >
            {index + 1}. {name}
          </li>
        ))}
      </ol>

      {error ? (
        <p className="wc-alert-error mt-6" role="alert">
          {error}
        </p>
      ) : null}

      <section className="wc-card animate-slide-up relative mt-6 rounded-lg p-8">
        <div className="absolute top-0 right-0 left-0 h-1 rounded-t-lg bg-accent" />
        <p className="text-caption text-slate">{t.stepOf(step)}</p>
        {link.state === "control" ? (
          <ControlStep link={link} t={t} />
        ) : link.state === "confirm" ? (
          <ConfirmStep link={link} t={t} />
        ) : (
          <StartStep link={link} t={t} />
        )}
        {link.state === "control" || link.state === "confirm" ? (
          <p className="mt-6 text-caption text-slate">{t.expires(formatDate(link.expiresAt, locale))}</p>
        ) : null}
        {link.state !== "none" ? (
          <form method="post" action="/account/link/cancel" className="mt-4">
            <button type="submit" className="wc-btn wc-btn-secondary">
              {t.cancel}
            </button>
          </form>
        ) : null}
      </section>
    </div>
  );
}

type T = ReturnType<typeof linkMessages>;

function StartStep({ link, t }: { link: LinkState; t: T }) {
  const providers = link.state === "none" ? link.providers : [];
  const needed = link.state === "none" ? link.linkable : true;
  return (
    <>
      <h2 className="wc-section-title mt-1">{t.startTitle}</h2>
      {link.state === "address" ? <p className="mt-3 text-body-sm text-slate">{t.addressWaiting}</p> : null}
      {!needed ? (
        <p className="mt-3 text-body-sm text-slate">{t.notNeeded}</p>
      ) : (
        <>
          {providers.length === 0 && link.state === "none" ? (
            <p className="mt-3 text-body-sm text-slate">{t.noProvider}</p>
          ) : null}
          {providers.map((provider) => (
            <form key={provider.id} method="post" action="/account/link/start" className="mt-4">
              <p className="mb-3 text-body-sm text-slate">{t.startText(provider.label)}</p>
              <input type="hidden" name="provider" value={provider.id} />
              <button type="submit" className="wc-btn wc-btn-primary">
                {t.startButton(provider.label)}
              </button>
            </form>
          ))}
        </>
      )}
    </>
  );
}

function ControlStep({ link, t }: { link: Extract<LinkState, { state: "control" }>; t: T }) {
  const { control } = link;
  const nothing = !control.password && control.providers.length === 0;
  return (
    <>
      <h2 className="wc-section-title mt-1">{t.controlTitle(link.address)}</h2>
      <p className="mt-3 text-body-sm text-slate">{t.controlText}</p>

      {nothing ? (
        <p className="wc-alert-error mt-4" role="alert">
          {t.noWay}
        </p>
      ) : null}

      {control.needsCode ? (
        <form method="post" action="/account/link/control/code" className="mt-4 flex flex-col gap-4">
          <p className="text-body-sm text-slate">{t.codeIntro}</p>
          <div>
            <label className="wc-label" htmlFor="link-code">
              {t.codeLabel}
            </label>
            <input
              className="wc-input font-mono tracking-widest"
              id="link-code"
              name="code"
              autoComplete="one-time-code"
              inputMode="text"
              autoCapitalize="none"
              spellCheck={false}
              required
            />
          </div>
          <button type="submit" className="wc-btn wc-btn-primary">
            {t.codeButton}
          </button>
        </form>
      ) : (
        <>
          {control.password ? (
            <form method="post" action="/account/link/control/password" className="mt-4 flex flex-col gap-4">
              <div>
                <label className="wc-label" htmlFor="link-password">
                  {t.passwordLabel}
                </label>
                <input
                  className="wc-input"
                  id="link-password"
                  name="password"
                  type="password"
                  autoComplete="off"
                  required
                />
              </div>
              <button type="submit" className="wc-btn wc-btn-primary">
                {t.passwordButton}
              </button>
            </form>
          ) : null}
          {control.providers.map((provider) => (
            <form key={provider.id} method="post" action="/account/link/control/provider" className="mt-4">
              <input type="hidden" name="provider" value={provider.id} />
              <button type="submit" className="wc-btn wc-btn-secondary">
                {t.providerButton(provider.label)}
              </button>
            </form>
          ))}
        </>
      )}
    </>
  );
}

function ConfirmStep({ link, t }: { link: Extract<LinkState, { state: "confirm" }>; t: T }) {
  const s: LinkSummary = link.summary;
  const into = s.into.email ?? s.into.name ?? link.address;
  const from = s.from.email ?? s.from.name ?? "";

  const section = (title: string, items: ReactNode[], none?: string) => (
    <div>
      <h3 className="font-medium text-body-sm text-navy">{title}</h3>
      {items.length > 0 ? (
        <ul className="mt-1 list-disc pl-5 text-body-sm text-slate">
          {items.map((item, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed summary that is never reordered
            <li key={index}>{item}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-body-sm text-slate">{none}</p>
      )}
    </div>
  );

  return (
    <>
      <h2 className="wc-section-title mt-1">{t.confirmTitle(into)}</h2>
      <p className="mt-3 text-body-sm text-slate">{t.confirmText}</p>

      <div className="mt-5 flex flex-col gap-5">
        {section(t.sumIdentitiesTitle, [t.sumIdentities(s.identities.map(identityName).join(", "), into)])}
        {section(
          t.sumOwnedTitle,
          s.ownedWaves.map((w) => t.sumOwned(w.name, into, w.billing, w.targetWasMember)),
          t.sumOwnedNone,
        )}
        {section(
          t.sumMemberTitle,
          s.memberships.map((m) => t.sumMember(m.name, m.role, into, m.targetRole)),
          t.sumMemberNone,
        )}
        {section(
          t.sumDevicesTitle,
          s.devices.length > 0
            ? [
                t.sumDevices(s.devices.length, into),
                ...s.devices.map((d) => `${d.hostname} · ${d.waveName} · ${d.ipv4}`),
              ]
            : [],
          t.sumDevicesNone,
        )}
        {section(t.sumSessionsTitle, [
          t.sumSessions(s.sessions, from, into),
          ...(s.from.hasPassword ? [t.sumPassword(from)] : []),
        ])}
      </div>

      <form method="post" action="/account/link/confirm" className="mt-6">
        <button type="submit" className="wc-btn wc-btn-primary">
          {t.confirmButton}
        </button>
      </form>
    </>
  );
}
