import { notFound, redirect } from "next/navigation";
import { SignupPanel } from "@/components/signup-panel";
import { fetchAuthOptions, fetchMe } from "@/lib/control";
import { getLocale } from "@/lib/i18n";

/**
 * Registration through the configured OIDC providers (ticket #147). Whether the
 * page exists is the control server's decision (`WAVE_SIGNUP_ENABLED`, reported
 * as `signup` by `/api/auth/providers`): off, or an older server that does not
 * say, is a 404 like any other address nobody serves.
 */
export default async function SignupPage() {
  const options = await fetchAuthOptions();
  if (!options.signup) notFound();

  // Someone who is signed in has an account already.
  if (await fetchMe()) redirect("/");

  return <SignupPanel options={options} locale={await getLocale()} />;
}
