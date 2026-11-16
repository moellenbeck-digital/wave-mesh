import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ResetNotice } from "@/components/password-reset-panel";
import { fetchAuthOptions, fetchResetLinkLive } from "@/lib/control";
import { getLocale } from "@/lib/i18n";

/**
 * The token is in the address; it must not travel on in a Referer header to
 * another site. `same-origin` and not `no-referrer`: with `no-referrer` the
 * browser sends `Origin: null` on the form post, and control refuses that.
 */
export const metadata: Metadata = { referrer: "same-origin" };

/**
 * The page the link in the reset mail opens (ticket #159). It asks control
 * whether the link is still good -- without spending it -- and shows the form
 * for the new password, or "this link no longer works" for one that is used,
 * expired, replaced or never was. `POST /auth/password/reset` does the change
 * and redirects to the sign-in, or back here with `?error=<code>` or
 * `?state=gone`.
 */
export default async function ResetPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const options = await fetchAuthOptions();
  if (!options.passwordReset) notFound();

  const params = await searchParams;
  const locale = await getLocale();
  const token = typeof params.token === "string" ? params.token : undefined;
  if (params.state === "gone" || !token || !(await fetchResetLinkLive(token))) {
    return <ResetNotice kind="gone" locale={locale} />;
  }
  return (
    <ResetNotice
      kind="form"
      locale={locale}
      token={token}
      error={typeof params.error === "string" ? params.error : undefined}
    />
  );
}
