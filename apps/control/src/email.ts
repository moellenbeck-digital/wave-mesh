/**
 * The one way an address is compared: trimmed and lowercased.
 *
 * Its own module (and not part of `waves/invites.ts`) because the seat count in
 * `billing/plan.ts` needs it too, and `invites.ts` imports the billing code.
 */
export const normaliseEmail = (email: string): string => email.trim().toLowerCase();
