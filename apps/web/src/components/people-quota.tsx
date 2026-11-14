import type { Locale } from "@wave/i18n";
import { accountMessages } from "@/i18n/account";
import { rich } from "@/i18n/rich";
import type { Membership } from "@/lib/control";

/**
 * How many people the account has room for, beside the places that add one: the
 * invitation form and the page an invitation lands on.
 *
 * The numbers are the control server's own (`account` of the members answer);
 * nothing is counted here. It says that the count is across all waves of the
 * account, that an open invitation reserves a place, and that a person in
 * several waves counts once -- and, when no place is left, what to do next.
 *
 * Renders nothing without `account`: a self-hosted server and an older control
 * server send none, and a self-hosted wave has no limit to speak of. Nor for a
 * plan without a people limit.
 */
export function PeopleQuota({ account, locale }: { account: Membership["account"]; locale: Locale }) {
  const limit = account?.limits.people ?? null;
  if (!account || limit === null) return null;
  const t = accountMessages(locale);
  const used = account.usage.people;
  const full = used >= limit;

  return (
    <div
      data-people-quota={account.plan}
      data-full={full ? "true" : "false"}
      className="mt-6 rounded-md border border-navy/10 p-4 text-body-sm text-slate"
      role="note"
    >
      <p className="font-medium text-navy">
        {account.plan === "free" ? t.quotaFree(used, limit) : t.quotaPaid(used, limit)}
      </p>
      <p className="mt-1">{t.quotaRules}</p>
      {full ? (
        <p data-field="next-step" className="mt-2 text-navy">
          {t.quotaFull}{" "}
          {rich(t.quotaNextStep, {
            upgrade: (
              <a href={t.quotaUpgrade} className="text-accent">
                {t.quotaUpgrade}
              </a>
            ),
          })}
        </p>
      ) : null}
    </div>
  );
}
