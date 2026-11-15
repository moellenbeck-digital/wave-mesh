import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SignupNotice } from "@/components/signup-panel";
import { fetchAuthOptions } from "@/lib/control";
import { getLocale } from "@/lib/i18n";

/** The token is in the address; it must not travel on in a Referer header. */
export const metadata: Metadata = { referrer: "no-referrer" };

/**
 * The page the link in the confirmation mail opens (ticket #150). It only shows
 * the button: `POST /auth/signup/confirm` makes the account and redirects back
 * here with `?state=done` or `?state=gone`. Without a token and without a state
 * there is nothing to confirm, which looks the same as a link that is used up.
 */
export default async function SignupConfirmPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const options = await fetchAuthOptions();
  if (!options.signup) notFound();

  const params = await searchParams;
  const locale = await getLocale();
  if (params.state === "done") return <SignupNotice kind="done" locale={locale} />;
  const token = typeof params.token === "string" ? params.token : undefined;
  if (params.state === "gone" || !token || !options.passwordSignup) {
    return <SignupNotice kind="gone" locale={locale} />;
  }
  return <SignupNotice kind="confirm" locale={locale} token={token} />;
}
