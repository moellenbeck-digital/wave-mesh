import { redirect } from "next/navigation";
import { TwoFactorPanel } from "@/components/two-factor";
import { accountMessages } from "@/i18n/account";
import { rich } from "@/i18n/rich";
import { fetchMe, fetchTwoFactor } from "@/lib/control";
import { getLocale } from "@/lib/i18n";

/** The account's own settings: the second factor of the password login, and the ways out. */
export default async function AccountPage() {
  const me = await fetchMe();
  if (!me) redirect("/login?next=/account");
  const status = await fetchTwoFactor();
  if (!status) redirect("/login?next=/account");
  const t = accountMessages(await getLocale());

  return (
    <div className="mx-auto max-w-3xl">
      <a href="/" className="text-caption text-slate">
        {t.backToOverview}
      </a>
      <h1 className="animate-fade-in mt-4 font-display text-display-sm text-navy">{t.accountTitle}</h1>
      <p className="animate-fade-in mt-3 text-body-sm text-slate">{me.user.email ?? me.user.name}</p>

      <section className="wc-card animate-slide-up relative mt-8 rounded-lg p-8">
        <div className="absolute top-0 right-0 left-0 h-1 rounded-t-lg bg-accent" />
        <h2 className="wc-section-title">{t.securityTitle}</h2>
        <TwoFactorPanel status={status} />
      </section>

      {/* Anker für den Link aus dem Header: Der Knopf dort beendet nur die
          Browser-Sitzung, und wer mehr will, soll hier die drei Wege sehen. */}
      <section id="abmelden" className="wc-card animate-slide-up relative mt-8 scroll-mt-24 rounded-lg p-8">
        <div className="absolute top-0 right-0 left-0 h-1 rounded-t-lg bg-accent" />
        <h2 className="wc-section-title">{t.signOutTitle}</h2>
        <p className="text-body-sm text-slate">{t.signOutIntro}</p>
        <dl className="mt-4 flex flex-col gap-4">
          <div>
            <dt className="font-medium text-body-sm text-navy">{t.signOutWebLabel}</dt>
            <dd className="text-body-sm text-slate">{t.signOutWeb}</dd>
          </div>
          <div>
            <dt className="font-medium text-body-sm text-navy">{t.signOutCliLabel}</dt>
            <dd className="text-body-sm text-slate">{t.signOutCli}</dd>
          </div>
          <div>
            <dt className="font-medium text-body-sm text-navy">{t.signOutLeaveLabel}</dt>
            <dd className="text-body-sm text-slate">{t.signOutLeave}</dd>
          </div>
        </dl>
        <p className="mt-4 text-body-sm text-slate">
          {rich(t.signOutWhere, {
            overview: (
              <a href="/" className="text-accent">
                {t.signOutOverview}
              </a>
            ),
          })}
        </p>
      </section>
    </div>
  );
}
