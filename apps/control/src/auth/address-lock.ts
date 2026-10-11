import { sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";

/**
 * Serialises everything that decides which account an address belongs to.
 *
 * `users.email` has no unique index -- provider accounts may share one -- so
 * the address itself is the lock. Two paths take it: a payment making the
 * owner's placeholder (billing/subscriptions.ts) and a provider login
 * deciding whether to link, absorb a placeholder or make a new account
 * (auth/identity.ts). Without it, a first Google login and a checkout for the
 * same address at the same moment would each see "nobody here yet" and leave
 * two accounts, the paid wave on the one its owner can never reach.
 * Transaction-scoped: released with the commit, never held across requests.
 */
export async function lockAddress(tx: Database, email: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`billing-owner:${email}`}))`);
}
