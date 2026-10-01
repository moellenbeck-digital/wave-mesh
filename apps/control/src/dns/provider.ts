/**
 * Writing into the wave's own zone.
 *
 * Only the control server ever holds these credentials. A node must never get
 * them: a token that can write `_acme-challenge` can write the whole zone, and
 * handing that to every device would trade one compromised machine for the
 * domain (D6/D7).
 *
 * The interface is deliberately two calls wide. dns-01 needs nothing else, and
 * anything wider would be an invitation to manage records that are not ours.
 */
export interface DnsProvider {
  readonly kind: string;
  /** Adds a TXT record. Several may exist for one name -- a wave with two
   *  pending orders for the same name is normal, and removing the other one's
   *  record would fail its challenge. */
  setTxt(name: string, value: string): Promise<void>;
  /** Removes exactly the record with this value, leaving any others alone. */
  removeTxt(name: string, value: string): Promise<void>;
}

/**
 * Providers that write the record themselves, each with a credential of its
 * own. Three of them take a token; INWX takes an account, because it has
 * nothing smaller to offer -- see `inwx.ts`.
 */
export const AUTOMATIC_KINDS = ["cloudflare", "hetzner", "ionos", "inwx"] as const;
export type AutomaticKind = (typeof AUTOMATIC_KINDS)[number];

/**
 * ...and `manual`, which is not a provider at all but the way out of needing
 * one: the server names the record and waits until it appears in the zone,
 * whoever put it there and with whatever tool. Without it every hoster would
 * have to be implemented here before anybody with that hoster could have a
 * certificate -- and there are hundreds of them.
 *
 * The price is that a renewal needs a person again, which is why it is the
 * fallback and not the default.
 */
export const PROVIDER_KINDS = [...AUTOMATIC_KINDS, "manual"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const isProviderKind = (value: string): value is ProviderKind =>
  (PROVIDER_KINDS as readonly string[]).includes(value);

export const isAutomaticKind = (value: string): value is AutomaticKind =>
  (AUTOMATIC_KINDS as readonly string[]).includes(value);

export class DnsProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DnsProviderError";
  }
}

/**
 * The zones a record name could live in, longest first.
 *
 * `_acme-challenge.laptop.wave.example.com` may sit in a zone called
 * `wave.example.com` or in `example.com`, and only the provider knows which of
 * them exists. Trying the longest first means a delegated subzone wins over its
 * parent, which is the answer the operator intended by delegating it.
 */
export function zoneCandidates(recordName: string): string[] {
  const labels = recordName.replace(/\.$/, "").split(".");
  const candidates: string[] = [];
  // A single label is never a zone we can write to, so stop before it.
  for (let index = 1; index <= labels.length - 2; index++) candidates.push(labels.slice(index).join("."));
  return candidates;
}

/** The part of a record name below its zone, which some APIs want on its own. */
export function relativeName(recordName: string, zone: string): string {
  const name = recordName.replace(/\.$/, "");
  if (name === zone) return "@";
  return name.endsWith(`.${zone}`) ? name.slice(0, -(zone.length + 1)) : name;
}

/** TTL of a challenge record: it exists for a minute or two and never longer. */
export const CHALLENGE_TTL_SECONDS = 60;
