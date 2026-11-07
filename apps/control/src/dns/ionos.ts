import {
  type AddressType,
  addressRecordType,
  type DnsProvider,
  DnsProviderError,
  zoneCandidates,
} from "./provider.ts";

const API = "https://api.hosting.ionos.com/dns/v1";

/**
 * Longer than the minute the other two providers get.
 *
 * Both this API and INWX want at least five minutes, and it costs nothing to
 * give it: a challenge record is written and taken away within minutes, and
 * nothing ever reads it through a cache -- the CA and our own check both ask
 * the zone's authoritative servers, which have none.
 */
export const IONOS_TTL_SECONDS = 300;

interface Zone {
  id: string;
  name: string;
}

interface Record {
  id: string;
  name: string;
  type: string;
  content: string;
}

/**
 * IONOS hosting DNS: the API behind an ordinary domain at ionos.de.
 *
 * Not to be confused with IONOS Cloud DNS, which is a different product with a
 * different API and different credentials. A key for one is rejected by the
 * other, and that is the first thing to check when this says 401.
 *
 * The credential is a single string, `<public prefix>.<secret>`, because that
 * is what the API itself wants in one header. That it therefore fits the one
 * sealed column here is luck; INWX next door does not.
 */
export function ionosProvider(apiKey: string, http: typeof fetch = fetch): DnsProvider {
  let zoneCache: { record: string; zone: Zone } | undefined;

  const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await http(`${API}${path}`, {
      ...init,
      headers: {
        "x-api-key": apiKey,
        accept: "application/json",
        "content-type": "application/json",
        ...init?.headers,
      },
    });
    if (!res.ok) {
      throw new DnsProviderError(`ionos: ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    // A delete answers with an empty body, which JSON.parse would choke on.
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  };

  const zoneOf = async (recordName: string): Promise<Zone> => {
    if (zoneCache?.record === recordName) return zoneCache.zone;
    const zones = await call<Zone[]>("/zones");
    for (const candidate of zoneCandidates(recordName)) {
      const zone = zones.find((entry) => entry.name === candidate);
      if (zone) {
        zoneCache = { record: recordName, zone };
        return zone;
      }
    }
    throw new DnsProviderError(`ionos: no zone of this account answers for ${recordName}`);
  };

  /** The records of one type already sitting at this name, which is all we may touch. */
  const recordsAt = async (zone: Zone, name: string, type: "TXT" | AddressType): Promise<Record[]> => {
    const query = `recordName=${encodeURIComponent(name)}&recordType=${type}`;
    const { records } = await call<{ records?: Record[] }>(`/zones/${zone.id}?${query}`);
    return (records ?? []).filter((record) => record.type === type && record.name === name);
  };
  const txtAt = (zone: Zone, name: string) => recordsAt(zone, name, "TXT");

  return {
    kind: "ionos",

    async setTxt(name, value) {
      const zone = await zoneOf(name);
      // POST appends; the zone's PATCH would mean reading the records, adding
      // ours and writing the set back, and two orders for the same name at the
      // same time -- a wildcard and its apex -- would then lose one another's
      // record between the read and the write.
      await call(`/zones/${zone.id}/records`, {
        method: "POST",
        body: JSON.stringify([
          { name, type: "TXT", content: value, ttl: IONOS_TTL_SECONDS, prio: 0, disabled: false },
        ]),
      });
    },

    async removeTxt(name, value) {
      const zone = await zoneOf(name);
      for (const record of await txtAt(zone, name)) {
        // IONOS hands TXT content back quoted, unlike the other three. Both
        // forms are compared so a record put there by hand is found too.
        if (record.content !== value && record.content !== `"${value}"`) continue;
        await call(`/zones/${zone.id}/records/${record.id}`, { method: "DELETE" });
      }
    },

    async setAddress(name, address) {
      const zone = await zoneOf(name);
      const type = addressRecordType(address);
      let present = false;
      for (const record of await recordsAt(zone, name, type)) {
        if (record.content === address && !present) {
          present = true;
          continue;
        }
        await call(`/zones/${zone.id}/records/${record.id}`, { method: "DELETE" });
      }
      if (present) return;
      await call(`/zones/${zone.id}/records`, {
        method: "POST",
        body: JSON.stringify([
          { name, type, content: address, ttl: IONOS_TTL_SECONDS, prio: 0, disabled: false },
        ]),
      });
    },

    async removeAddress(name, type) {
      const zone = await zoneOf(name);
      for (const record of await recordsAt(zone, name, type)) {
        await call(`/zones/${zone.id}/records/${record.id}`, { method: "DELETE" });
      }
    },
  };
}
