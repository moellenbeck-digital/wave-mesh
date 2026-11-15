import { notFound, redirect } from "next/navigation";
import { SignupPanel } from "@/components/signup-panel";
import { fetchAuthOptions, fetchMe } from "@/lib/control";
import { getLocale } from "@/lib/i18n";

/**
 * Registration (tickets #147, #150): the configured OIDC providers, and the form
 * for email and password where the server can send the confirmation mail.
 * Whether the page exists is the control server's decision
 * (`WAVE_SIGNUP_ENABLED`, reported as `signup` by `/api/auth/providers`): off,
 * or an older server that does not say, is a 404 like any other address nobody
 * serves. `?error=<code>` is how `/auth/signup` sends a refusal back.
 */
export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const options = await fetchAuthOptions();
  if (!options.signup) notFound();

  // Someone who is signed in has an account already.
  if (await fetchMe()) redirect("/");

  const params = await searchParams;
  return (
    <SignupPanel
      options={options}
      locale={await getLocale()}
      error={typeof params.error === "string" ? params.error : undefined}
    />
  );
}
