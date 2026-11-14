import { headers } from "next/headers";
import { PeopleQuota } from "@/components/people-quota";
import { appMessages } from "@/i18n/app";
import { rich } from "@/i18n/rich";
import { fetchMembers, type Membership } from "@/lib/control";
import { getLocale } from "@/lib/i18n";

/**
 * Where creating an invitation lands. The link is shown here and nowhere else:
 * the database only keeps its hash, so it cannot be looked up again -- a lost
 * one is replaced by inviting the same address once more.
 *
 * Below the link: how many places the account has left now that this
 * invitation reserves one (a hosted server only).
 */
export default async function InvitedPage({
  params: routeParams,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const { id } = await routeParams;
  const value = (key: string) => (typeof params[key] === "string" ? params[key] : undefined);
  const token = value("token");
  const email = value("email");
  const wave = value("wave");
  const locale = await getLocale();
  const t = appMessages(locale);
  // The people line is a courtesy: a page that cannot read it still shows the link.
  const account: Membership["account"] = await fetchMembers(id)
    .then((membership) => membership.account)
    .catch(() => undefined);
  const role = t.asRole(value("role") === "admin" ? "admin" : "member");

  // The browser talks to the control server, which proxies this page; these
  // headers are the only way to know the address it used.
  const head = await headers();
  const host = head.get("x-forwarded-host") ?? head.get("host") ?? "";
  const proto = head.get("x-forwarded-proto") ?? "https";
  const link = token && host ? `${proto}://${host}/invite/${token}` : undefined;

  return (
    <div className="mx-auto max-w-lg">
      <h1 className="animate-fade-in font-display text-display-sm text-navy">
        {email ? t.invitedTitle(email) : t.invitedCreated}
      </h1>

      <section
        className="wc-card animate-slide-up relative mt-8 rounded-lg p-8"
        style={{ animationDelay: "0.1s" }}
      >
        <div className="absolute top-0 right-0 left-0 h-1 rounded-t-lg bg-accent" />

        <p className="text-body-sm text-slate">
          {wave
            ? rich(t.invitedAs, { role, wave: <strong className="font-medium text-navy">{wave}</strong> })
            : null}
          {t.invitedShare}
        </p>

        {link ? (
          <pre
            className="mt-6 overflow-x-auto rounded-lg p-4 text-caption text-navy"
            style={{ backgroundColor: "#0f27440a" }}
          >
            {link}
          </pre>
        ) : (
          <p className="wc-alert-error mt-6" role="alert">
            {t.invitedNoLink}
          </p>
        )}

        <p className="mt-6 text-caption text-slate">{t.invitedPending}</p>

        <PeopleQuota account={account} locale={locale} />

        <a href="/" className="wc-btn wc-btn-primary mt-8">
          {t.toOverview}
        </a>
      </section>
    </div>
  );
}
