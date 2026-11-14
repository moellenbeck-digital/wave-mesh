import type { Database } from "../db/client.ts";
import { waves } from "../db/schema.ts";
import { type CapacityReport, capacityOf } from "./addressing.ts";

/** What is left of the address container, and whether the reserve for billed waves still holds. */
export interface ServerCapacity extends CapacityReport {
  reserve: {
    /** Whole /16s that must stay free (WAVE_CAPACITY_RESERVE). */
    blocks: number;
    /** Whole /16s free now. */
    free: number;
    /** True when `free` is below `blocks`: a free sign-up is refused. */
    below: boolean;
  };
  /** Waves whose block lies outside the container (numbered before it was set); not counted above. */
  outside: number;
}

/**
 * The capacity report: container, blocks held and free per prefix length,
 * the share taken, and the reserve. Read-only; shown by `wave-admin capacity`.
 * (There is no admin web page on this server to show it on.)
 */
export async function serverCapacity(
  db: Database,
  config: { ipv4Container: string; capacityReserve: number; freeIpv4PrefixLength: number },
): Promise<ServerCapacity> {
  const held = (await db.select({ prefix: waves.ipv4Prefix }).from(waves)).map((row) => row.prefix);
  const report = capacityOf(config.ipv4Container, held, [16, config.freeIpv4PrefixLength]);
  const free16 = report.free.find((entry) => entry.prefixLength === 16)?.blocks ?? 0;
  const inside = report.used.reduce((sum, entry) => sum + entry.blocks, 0);
  return {
    ...report,
    reserve: {
      blocks: config.capacityReserve,
      free: free16,
      // Nothing to reserve in a container that cannot hold a /16 at all.
      below:
        config.capacityReserve > 0 && report.totalAddresses >= 2 ** 16 && free16 < config.capacityReserve,
    },
    outside: held.length - inside,
  };
}
