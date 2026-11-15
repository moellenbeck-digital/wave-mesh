import { notFound } from "next/navigation";
import { SignupNotice } from "@/components/signup-panel";
import { fetchAuthOptions } from "@/lib/control";
import { getLocale } from "@/lib/i18n";

/** "The mail is on its way" (ticket #150): the same page for every address. */
export default async function SignupSentPage() {
  const options = await fetchAuthOptions();
  if (!options.signup) notFound();
  return <SignupNotice kind="sent" locale={await getLocale()} />;
}
