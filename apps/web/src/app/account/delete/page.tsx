import { redirect } from "next/navigation";
import { DeleteAccountPanel } from "@/components/delete-account";
import { deleteAccountMessages } from "@/i18n/delete-account";
import { fetchDeletePreview, fetchMe } from "@/lib/control";
import { getLocale } from "@/lib/i18n";

/**
 * Deleting one's own account (ticket #31; Google Play, GDPR Art. 17). A fixed
 * address, because the help page links to it.
 *
 * Without a session it goes through the login and comes back here. Opening it
 * changes nothing: the control server describes what a deletion would do, and
 * only the form's POST deletes.
 */
export default async function DeleteAccountPage() {
  const me = await fetchMe();
  if (!me) redirect("/login?next=/account/delete");
  const preview = await fetchDeletePreview();
  if (!preview) redirect("/login?next=/account/delete");
  const t = deleteAccountMessages(await getLocale());

  return (
    <div className="mx-auto max-w-3xl">
      <a href="/account" className="text-caption text-slate">
        {t.back}
      </a>
      <h1 className="animate-fade-in mt-4 mb-6 font-display text-display-sm text-navy">{t.title}</h1>
      <DeleteAccountPanel preview={preview} who={me.user.email ?? me.user.name ?? ""} />
    </div>
  );
}
