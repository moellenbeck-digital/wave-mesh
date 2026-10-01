import { CHALLENGE_TTL_SECONDS, type DnsProvider, DnsProviderError, zoneCandidates } from "./provider.ts";

const API = "https://api.cloudflare.com/client/v4";

interface CloudflareResponse<T> {
  success: boolean;
  errors: { code: number; message: string }[];
  result: T;
}

interface Record {
  id: string;
  name: string;
  content: string;
}

/**
 * Cloudflare, the first provider because it is the one most waves will already
 * have their domain at and the one whose tokens are scopeable to a single zone
 * (Zone / DNS / Edit). That scoping is the whole reason a provider token is
 * acceptable at all.
 */
export function cloudflareProvider(token: string, http: typeof fetch = fetch): DnsProvider {
  let zoneCache: { record: string; id: string } | undefined;

  const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await http(`${API}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...init?.headers,
      },
    });
    const body = (await res.json().catch(() => null)) as CloudflareResponse<T> | null;
    if (!res.ok || !body?.success) {
      const detail = body?.errors?.map((error) => error.message).join("; ") ?? `HTTP ${res.status}`;
      throw new DnsProviderError(`cloudflare: ${detail}`);
    }
    return body.result;
  };

  /**
   * Which zone the record belongs to, asked rather than assumed.
   *
   * A zone-scoped token may not list zones at all, but it may always ask for
   * one by name -- so the candidates are tried one at a time instead of
   * fetching the account's zone list.
   */
  const zoneOf = async (recordName: string): Promise<string> => {
    if (zoneCache?.record === recordName) return zoneCache.id;
    for (const candidate of zoneCandidates(recordName)) {
      const zones = await call<{ id: string }[]>(`/zones?name=${encodeURIComponent(candidate)}`);
      const zone = zones[0];
      if (zone) {
        zoneCache = { record: recordName, id: zone.id };
        return zone.id;
      }
    }
    throw new DnsProviderError(`cloudflare: no zone of this account answers for ${recordName}`);
  };

  return {
    kind: "cloudflare",

    async setTxt(name, value) {
      const zone = await zoneOf(name);
      await call(`/zones/${zone}/dns_records`, {
        method: "POST",
        body: JSON.stringify({ type: "TXT", name, content: value, ttl: CHALLENGE_TTL_SECONDS }),
      });
    },

    async removeTxt(name, value) {
      const zone = await zoneOf(name);
      const records = await call<Record[]>(
        `/zones/${zone}/dns_records?type=TXT&name=${encodeURIComponent(name)}`,
      );
      for (const record of records) {
        // Cloudflare stores the value unquoted; compare both, because a record
        // put there by hand may well carry the quotes.
        if (record.content !== value && record.content !== `"${value}"`) continue;
        await call(`/zones/${zone}/dns_records/${record.id}`, { method: "DELETE" });
      }
    },
  };
}
