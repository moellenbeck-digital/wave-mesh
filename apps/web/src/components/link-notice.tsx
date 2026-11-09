import { identityName, linkMessages } from "@/i18n/link";
import type { Me } from "@/lib/control";
import { getLocale } from "@/lib/i18n";

/**
 * Says to an account that was split off -- its address is not confirmed by
 * the provider -- which account is active, and why a wave it expects can be
 * missing. Nothing here says whether another account holds the address: that
 * is for the guided link's first step, after the provider has vouched for it.
 * Renders nothing for everyone else, and for an older control server that
 * sends no `account`.
 */
export async function LinkNotice({ me }: { me: Me }) {
  if (!me.account?.linkable) return null;
  const t = linkMessages(await getLocale());
  const who = me.user.email ?? me.user.name ?? me.user.id;
  const via = me.account.identities.map(identityName).join(", ");

  return (
    <section
      aria-labelledby="link-notice-title"
      className="wc-card animate-slide-up relative mb-6 rounded-lg p-6"
    >
      <div className="absolute top-0 right-0 left-0 h-1 rounded-t-lg bg-accent" />
      <h2 id="link-notice-title" className="wc-section-title">
        {t.noticeTitle}
      </h2>
      <p className="mt-2 font-medium text-body-sm text-navy">{t.noticeActive(who)}</p>
      {via ? <p className="text-body-sm text-slate">{t.noticeVia(via)}</p> : null}
      <p className="mt-3 text-body-sm text-slate">{t.noticeWhy}</p>
      <p className="mt-2 text-body-sm text-slate">{t.noticeHow}</p>
      <a href="/account/link" className="wc-btn wc-btn-secondary mt-4">
        {t.noticeAction}
      </a>
    </section>
  );
}
