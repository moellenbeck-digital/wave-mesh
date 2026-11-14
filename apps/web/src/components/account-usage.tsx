import { accountMessages } from "@/i18n/account";
import type { AccountPlanView, Counts } from "@/lib/control";
import { getLocale } from "@/lib/i18n";

/**
 * Plan, usage against the limits and -- when the account holds more than its
 * plan allows -- the concrete overhang: the numbers, and per wave which people
 * (by address) and which devices (by name).
 *
 * Only a report. Nothing is removed because a limit is exceeded: existing
 * waves, people and devices stay, only new ones are turned away. Renders
 * nothing for an older control server or a self-hosted one, which send no plan.
 */
export async function AccountUsage({ plan }: { plan: AccountPlanView | undefined }) {
  if (!plan) return null;
  const t = accountMessages(await getLocale());
  const rows: Array<{ key: keyof Counts; label: string }> = [
    { key: "waves", label: t.usageWaves },
    { key: "people", label: t.usagePeople },
    { key: "devices", label: t.usageDevices },
  ];
  const { overhang } = plan;
  const over = overhang.waves > 0 || overhang.people > 0 || overhang.devices > 0;

  return (
    <section
      id="plan"
      data-plan={plan.plan}
      aria-labelledby="plan-title"
      className="wc-card animate-slide-up relative mt-8 scroll-mt-24 rounded-lg p-8"
    >
      <div className="absolute top-0 right-0 left-0 h-1 rounded-t-lg bg-accent" />
      <h2 id="plan-title" className="wc-section-title">
        {t.planTitle}
      </h2>
      <p className="text-body-sm text-slate">
        {t.planLabel}:{" "}
        <strong data-field="plan" className="font-medium text-navy">
          {plan.plan === "free" ? t.planFree : t.planPaid}
        </strong>
      </p>
      <p className="mt-1 text-body-sm text-slate">{plan.plan === "free" ? t.planFreeNote : t.planPaidNote}</p>

      <dl className="mt-4 grid gap-3 sm:grid-cols-3">
        {rows.map(({ key, label }) => {
          const limit = plan.limits[key];
          return (
            <div key={key} data-usage={key} className="rounded-md border border-navy/10 p-4">
              <dt className="text-caption text-slate">{label}</dt>
              <dd className="mt-1 font-display text-xl text-navy">
                <span data-field="used">{plan.usage[key]}</span>
                <span className="text-body-sm text-slate">
                  {" "}
                  {limit === null ? t.noLimit : t.ofLimit(limit)}
                </span>
              </dd>
            </div>
          );
        })}
      </dl>

      {over ? (
        <div data-overhang="true" className="mt-6">
          <h3 className="font-medium text-body text-navy">{t.overhangTitle}</h3>
          <p className="mt-1 text-body-sm text-slate">{t.overhangIntro}</p>
          <ul className="mt-3 list-disc pl-5 text-body-sm text-navy">
            {overhang.waves > 0 ? <li data-over="waves">{t.overWaves(overhang.waves)}</li> : null}
            {overhang.people > 0 ? <li data-over="people">{t.overPeople(overhang.people)}</li> : null}
            {overhang.devices > 0 ? <li data-over="devices">{t.overDevices(overhang.devices)}</li> : null}
          </ul>

          <h4 className="mt-5 font-medium text-body-sm text-navy">{t.perWaveTitle}</h4>
          <ul className="mt-2 flex flex-col gap-3">
            {overhang.perWave.map((wave) => (
              <li
                key={wave.waveId}
                data-over-wave={wave.waveName}
                className="rounded-md border border-navy/10 p-4"
              >
                <p className="font-medium text-body-sm text-navy">{wave.waveName}</p>
                <p className="mt-2 text-caption text-slate">{t.peopleHeading}</p>
                <ul data-list="people" className="text-body-sm text-navy">
                  {wave.people.length === 0 ? <li className="text-slate">{t.none}</li> : null}
                  {wave.people.map((person) => (
                    <li key={`${person.kind}:${person.email}`}>
                      {person.email ?? "—"}
                      {person.kind === "invitation" ? <span className="text-slate"> {t.invited}</span> : null}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-caption text-slate">{t.devicesHeading}</p>
                <ul data-list="devices" className="text-body-sm text-navy">
                  {wave.devices.length === 0 ? <li className="text-slate">{t.none}</li> : null}
                  {wave.devices.map((device) => (
                    <li key={device.name}>{device.name}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
