import { and, eq, gt, isNull, ne, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { waveBilling, waveInvites, waveMembers } from "../db/schema.ts";

/**
 * A billed wave that has no seat left for another person.
 *
 * Its own class, like InvalidInputError: the web route says it in the reader's
 * language and wave-admin in the operator's, from the same two numbers.
 */
export class SeatLimitError extends Error {
  constructor(
    readonly waveId: string,
    readonly seats: number,
  ) {
    super(`wave ${waveId} has no seat left (${seats} booked)`);
    this.name = "SeatLimitError";
  }
}

/**
 * Refuses an invitation that would take a billed wave past what was booked.
 *
 * Open invitations count as taken: each one is a person who can walk in
 * without asking anyone again, so counting only members would let a full wave
 * hand out any number of links and fill up later. An invitation for the same
 * address is not counted, because creating a new one replaces it.
 *
 * Checked here, at the invitation, and not at the door: an invitation that
 * has been sent is a promise, and refusing it when the person clicks would be
 * the worse place to find out. A wave without a billing row -- every
 * self-hosted one -- has no limit and costs one lookup.
 */
export async function ensureSeatFor(db: Database, waveId: string, email: string): Promise<void> {
  const billed = await db
    .select({ seats: waveBilling.seats })
    .from(waveBilling)
    .where(eq(waveBilling.waveId, waveId))
    .limit(1);
  const seats = billed[0]?.seats;
  if (seats === undefined) return;

  const [members] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(waveMembers)
    .where(eq(waveMembers.waveId, waveId));
  const [invites] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(waveInvites)
    .where(
      and(
        eq(waveInvites.waveId, waveId),
        ne(waveInvites.email, email),
        isNull(waveInvites.acceptedAt),
        isNull(waveInvites.revokedAt),
        gt(waveInvites.expiresAt, new Date()),
      ),
    );
  if ((members?.count ?? 0) + (invites?.count ?? 0) >= seats) throw new SeatLimitError(waveId, seats);
}
