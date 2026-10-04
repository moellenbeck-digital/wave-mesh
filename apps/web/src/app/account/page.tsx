import { redirect } from "next/navigation";
import { TwoFactorPanel } from "@/components/two-factor";
import { accountMessages } from "@/i18n/account";
import { fetchMe, fetchTwoFactor } from "@/lib/control";
import { getLocale } from "@/lib/i18n";

/** The account's own settings: for now, the second factor of the password login. */
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
    </div>
  );
}
