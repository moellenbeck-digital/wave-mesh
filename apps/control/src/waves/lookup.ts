import { eq, or } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { users, waves } from "../db/schema.ts";
import { normaliseEmail } from "./invites.ts";

export interface FoundWave {
  id: string;
  name: string;
  dnsSuffix: string;
  ownerEmail: string | null;
}

/**
 * Finds a wave by its name or by its owner's address -- the two things an
 * operator has at hand, since the id appears nowhere on the command line.
 *
 * Several matches are reported, never picked: a server can hold 64 waves, and
 * running a command against the wrong one is how a stranger ends up in a
 * network or a member loses their devices.
 */
export async function resolveWave(
  db: Database,
  selector: string,
): Promise<FoundWave | { ambiguous: FoundWave[] } | null> {
  const needle = selector.trim();
  if (!needle) return null;

  const rows = await db
    .select({
      id: waves.id,
      name: waves.name,
      dnsSuffix: waves.dnsSuffix,
      ownerEmail: users.email,
    })
    .from(waves)
    .innerJoin(users, eq(users.id, waves.ownerUserId))
    .where(or(eq(waves.name, needle), eq(waves.id, needle), eq(users.email, normaliseEmail(needle))));

  if (rows.length === 0) return null;
  if (rows.length > 1) return { ambiguous: rows };
  return rows[0] as FoundWave;
}

export const isAmbiguous = (
  result: Awaited<ReturnType<typeof resolveWave>>,
): result is { ambiguous: FoundWave[] } => result !== null && "ambiguous" in result;
