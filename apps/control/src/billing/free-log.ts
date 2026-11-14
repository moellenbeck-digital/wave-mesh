/**
 * One log line per decision about a free hosted account (ticket #117), so abuse
 * can be traced afterwards: `free-account.created`, `free-account.wave-created`
 * and `free-account.denied` with the reason.
 *
 * Reasons of `denied`: `placeholder`, `unverified-email`, `email-domain`,
 * `wave-limit`, `rate-limit`, `people-limit`, `device-limit`, `merge-limit`.
 *
 * On stdout, like the billing sweep: a denial has no wave to hang an audit entry
 * on. Where a wave exists (`created`), the audit log of the wave carries the
 * same event as well (`routes/waves.ts`). Values are written as `key=value`
 * with whitespace folded, so one line is always one decision.
 */
export type FreeDecision = "created" | "wave-created" | "denied";

export function logFreeDecision(
  kind: FreeDecision,
  fields: Record<string, string | number | null | undefined>,
): void {
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${String(value).replace(/\s+/g, "_")}`);
  console.log(`free-account.${kind} ${parts.join(" ")}`.trimEnd());
}
