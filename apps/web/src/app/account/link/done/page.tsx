import { redirect } from "next/navigation";
import { linkMessages } from "@/i18n/link";
import { fetchMe } from "@/lib/control";
import { getLocale } from "@/lib/i18n";

/** Where the confirmation lands: signed in as the account that held the address. */
export default async function LinkDonePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const me = await fetchMe();
  if (!me) redirect("/login");
  const t = linkMessages(await getLocale());
  const count = (value: string | string[] | undefined) => {
    const n = typeof value === "string" ? Number.parseInt(value, 10) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  };

  return (
    <div className="mx-auto max-w-md">
      <section className="wc-card animate-slide-up relative rounded-lg p-8 text-center">
        <div className="absolute top-0 right-0 left-0 h-1 rounded-t-lg bg-accent" />
        <h1 className="font-display text-headline text-navy">{t.doneTitle}</h1>
        <p className="mt-3 text-body-sm text-slate">{me.user.email ?? me.user.name}</p>
        <p className="mt-3 text-body-sm text-slate" role="status">
          {t.doneText(count(params.waves), count(params.devices))}
        </p>
        <a href="/" className="wc-btn wc-btn-primary mt-6">
          {t.doneOverview}
        </a>
      </section>
    </div>
  );
}
