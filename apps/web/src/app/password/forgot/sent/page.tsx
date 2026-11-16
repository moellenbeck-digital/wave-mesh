import { notFound } from "next/navigation";
import { ResetNotice } from "@/components/password-reset-panel";
import { fetchAuthOptions } from "@/lib/control";
import { getLocale } from "@/lib/i18n";

/** "The mail is on its way" (ticket #159): the same page for every address. */
export default async function ForgotSentPage() {
  const options = await fetchAuthOptions();
  if (!options.passwordReset) notFound();
  return <ResetNotice kind="sent" locale={await getLocale()} />;
}
