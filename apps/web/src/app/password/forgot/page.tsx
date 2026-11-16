import { notFound, redirect } from "next/navigation";
import { ForgotPanel } from "@/components/password-reset-panel";
import { fetchAuthOptions, fetchMe } from "@/lib/control";
import { getLocale } from "@/lib/i18n";

/**
 * "Forgot password" (ticket #159): the form for the address. Whether the page
 * exists is the control server's decision (`passwordReset` of
 * `/api/auth/providers`, true where it can send mail): off, or an older server
 * that does not say, is a 404 like any other address nobody serves.
 * `?error=<code>` is how `/auth/password/forgot` sends a refusal back.
 */
export default async function ForgotPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const options = await fetchAuthOptions();
  if (!options.passwordReset) notFound();
  if (await fetchMe()) redirect("/");

  const params = await searchParams;
  return (
    <ForgotPanel
      locale={await getLocale()}
      error={typeof params.error === "string" ? params.error : undefined}
    />
  );
}
