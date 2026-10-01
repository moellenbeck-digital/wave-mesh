import type { ServiceScheme } from "@wave/proto";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { nodes, waveServices, waves } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { allocateIpv4, ipv6ForIpv4 } from "../net/addressing.ts";

/**
 * Services in a wave (D11).
 *
 * A service is a name and an address, reached through one node. The node is an
 * ordinary member of the wave with keys and a tunnel; the service has neither,
 * which is exactly why it is not one: twenty ingresses would otherwise be
 * twenty tunnels inside one pod.
 *
 * The declaration is a whole set, not single calls. The operator in the cluster
 * watches objects that come and go, and "these are the services now" is the
 * only shape that cannot drift -- a missed delete would otherwise leave a name
 * in the wave forever.
 */

export interface ServiceRow {
  id: string;
  name: string;
  ipv4: string;
  ipv6: string;
  viaNodeId: string;
  /** How the cluster serves it; https unless its Ingress says otherwise. */
  scheme: ServiceScheme;
}

export type SyncResult =
  | { services: ServiceRow[]; changed: boolean }
  /** A name somebody has to fix, rather than something that broke. */
  | { conflict: string };

/** One label, the way a hostname is one. What sits under the wave's suffix. */
const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * The label of a service name as it may be given: bare, or fully qualified
 * under the wave's own suffix.
 *
 * The operator reads an Ingress `host`, which is the whole name -- and it has
 * to be under this wave's suffix, because the host header is what picks the
 * ingress rule on the other side. A name from somewhere else would be a
 * certificate and a route for a zone this wave does not own.
 */
export function serviceLabel(given: string, dnsSuffix: string): string | null {
  const name = given.trim().toLowerCase().replace(/\.$/, "");
  const label = name.endsWith(`.${dnsSuffix}`) ? name.slice(0, -(dnsSuffix.length + 1)) : name;
  return LABEL.test(label) ? label : null;
}

/**
 * Where a service is opened.
 *
 * Built here and nowhere else, and sent out finished: the scheme comes from
 * the cluster, the zone from the wave, and both are known only on this side.
 * Every view that offers a link -- the browser, the tray window, `wave status`
 * and the shell -- would otherwise assemble its own, and four spellings of one
 * address is how they come to disagree. It is also the only way a device can
 * have a link at all: a netmap carries no scheme.
 */
export const serviceUrl = (label: string, dnsSuffix: string, scheme: ServiceScheme): string =>
  `${scheme}://${label}.${dnsSuffix}`;

/**
 * Makes the wave's services exactly this set, and says whether anything moved.
 *
 * Everything happens under a row lock on the wave: names and addresses are
 * shared with the nodes, and no unique index can span two tables. The lock is
 * on the row that carries `netmap_version`, which is the serialisation point
 * this server already has.
 */
export async function syncServices(
  db: Database,
  input: { waveId: string; viaNodeId: string; names: string[]; secure?: string[] },
): Promise<SyncResult> {
  return db.transaction(async (tx) => {
    const waveRows = await tx.select().from(waves).where(eq(waves.id, input.waveId)).limit(1).for("update");
    const wave = waveRows[0];
    if (!wave) return { conflict: "the wave is gone" };

    const labels: string[] = [];
    for (const given of input.names) {
      const label = serviceLabel(given, wave.dnsSuffix);
      if (!label) return { conflict: `${given} is not a name under ${wave.dnsSuffix}` };
      if (!labels.includes(label)) labels.push(label);
    }

    // The same reduction as the names above, because that is what they are
    // compared against. A name here that is not in the set means nothing: the
    // scheme is an attribute of a service, never what makes one exist. And an
    // operator that says nothing leaves every service at the column default,
    // which is what keeps an older one working.
    const secure = new Set(
      (input.secure ?? [])
        .map((given) => serviceLabel(given, wave.dnsSuffix))
        .filter((label): label is string => label !== null),
    );
    const schemeFor = (label: string): ServiceScheme =>
      input.secure === undefined ? "https" : secure.has(label) ? "https" : "http";

    const siblings = await tx.select().from(nodes).where(eq(nodes.waveId, input.waveId));
    const existing = await tx.select().from(waveServices).where(eq(waveServices.waveId, input.waveId));

    // A device and a service may not share a name: inside a wave a name means
    // one thing, and a resolver that answered twice would be the proof it does
    // not.
    for (const label of labels) {
      if (siblings.some((node) => node.hostname === label)) {
        return { conflict: `${label}.${wave.dnsSuffix} is a device in this wave` };
      }
      const other = existing.find((service) => service.name === label);
      if (other && other.viaNodeId !== input.viaNodeId) {
        return { conflict: `${label}.${wave.dnsSuffix} is served by another node` };
      }
    }

    const mine = existing.filter((service) => service.viaNodeId === input.viaNodeId);
    const gone = mine.filter((service) => !labels.includes(service.name));
    for (const service of gone) {
      await tx.delete(waveServices).where(eq(waveServices.id, service.id));
    }

    // Every address in the wave, whoever holds it -- that is what keeps the two
    // kinds of name in one numbering.
    const taken = new Set<string>([
      ...siblings.map((node) => node.ipv4),
      ...existing.filter((service) => !gone.includes(service)).map((service) => service.ipv4),
    ]);

    const kept: ServiceRow[] = [];
    // Counted rather than compared by identity: what makes a netmap is a name
    // coming or going, and a row that only changed its scheme is neither.
    let added = 0;
    for (const label of labels) {
      const already = mine.find((service) => service.name === label);
      if (already) {
        const scheme = schemeFor(label);
        // A certificate added to an Ingress changes how the name is shown and
        // nothing else. It is deliberately not `changed`: the netmap carries
        // no scheme, so bumping its version would push an identical document
        // to every device in the wave for a column only the browser reads.
        if (scheme !== already.scheme) {
          await tx.update(waveServices).set({ scheme }).where(eq(waveServices.id, already.id));
        }
        kept.push({ ...already, scheme });
        continue;
      }
      const ipv4 = allocateIpv4(wave.ipv4Prefix, taken);
      taken.add(ipv4);
      const service = {
        id: newId("svc"),
        waveId: input.waveId,
        name: label,
        viaNodeId: input.viaNodeId,
        ipv4,
        ipv6: ipv6ForIpv4(wave.ipv6Prefix, wave.ipv4Prefix, ipv4),
        scheme: schemeFor(label),
      };
      await tx.insert(waveServices).values(service);
      kept.push(service);
      added++;
    }

    const changed = gone.length > 0 || added > 0;
    if (changed) {
      await tx
        .update(waves)
        .set({ netmapVersion: sql`${waves.netmapVersion} + 1` })
        .where(eq(waves.id, input.waveId));
    }
    return { services: kept, changed };
  });
}

export async function listServices(db: Database, waveId: string): Promise<ServiceRow[]> {
  return db
    .select({
      id: waveServices.id,
      name: waveServices.name,
      ipv4: waveServices.ipv4,
      ipv6: waveServices.ipv6,
      viaNodeId: waveServices.viaNodeId,
      scheme: waveServices.scheme,
    })
    .from(waveServices)
    .where(eq(waveServices.waveId, waveId))
    .orderBy(asc(waveServices.name));
}

/** Takes one service away from the shell, when the cluster no longer can. */
export async function removeService(db: Database, waveId: string, name: string): Promise<boolean> {
  const gone = await db
    .delete(waveServices)
    .where(and(eq(waveServices.waveId, waveId), eq(waveServices.name, name)))
    .returning({ id: waveServices.id });
  if (gone.length === 0) return false;

  await db
    .update(waves)
    .set({ netmapVersion: sql`${waves.netmapVersion} + 1` })
    .where(eq(waves.id, waveId));
  return true;
}
