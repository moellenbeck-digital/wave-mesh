import {
  CHALLENGE_TTL_SECONDS,
  type DnsProvider,
  DnsProviderError,
  relativeName,
  zoneCandidates,
} from "./provider.ts";

const API = "https://dns.hetzner.com/api/v1";

interface Zone {
  id: string;
  name: string;
}

interface Record {
  id: string;
  name: string;
  value: string;
  type: string;
}

/**
 * Hetzner DNS, the second provider -- and the reason the interface exists at
 * all. Two implementations are what keeps `DnsProvider` an interface rather
 * than a description of one API: this one names records relative to their zone
 * and authenticates with a header of its own.
 */
export function hetznerProvider(token: string, http: typeof fetch = fetch): DnsProvider {
  let zoneCache: { record: string; zone: Zone } | undefined;

  const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await http(`${API}${path}`, {
      ...init,
      headers: { "auth-api-token": token, "content-type": "application/json", ...init?.headers },
    });
    if (!res.ok) {
      throw new DnsProviderError(`hetzner: ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    // A delete answers with an empty body, which JSON.parse would choke on.
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  };

  const zoneOf = async (recordName: string): Promise<Zone> => {
    if (zoneCache?.record === recordName) return zoneCache.zone;
    const { zones } = await call<{ zones: Zone[] }>("/zones");
    for (const candidate of zoneCandidates(recordName)) {
      const zone = zones.find((entry) => entry.name === candidate);
      if (zone) {
        zoneCache = { record: recordName, zone };
        return zone;
      }
    }
    throw new DnsProviderError(`hetzner: no zone of this account answers for ${recordName}`);
  };

  return {
    kind: "hetzner",

    async setTxt(name, value) {
      const zone = await zoneOf(name);
      await call("/records", {
        method: "POST",
        body: JSON.stringify({
          zone_id: zone.id,
          type: "TXT",
          name: relativeName(name, zone.name),
          value,
          ttl: CHALLENGE_TTL_SECONDS,
        }),
      });
    },

    async removeTxt(name, value) {
      const zone = await zoneOf(name);
      const { records } = await call<{ records: Record[] }>(`/records?zone_id=${zone.id}`);
      const wanted = relativeName(name, zone.name);
      for (const record of records) {
        if (record.type !== "TXT" || record.name !== wanted) continue;
        if (record.value !== value && record.value !== `"${value}"`) continue;
        await call(`/records/${record.id}`, { method: "DELETE" });
      }
    },
  };
}
