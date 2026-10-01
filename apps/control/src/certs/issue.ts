import { leafOf, readCsr } from "@wave/crypto";
import { and, eq } from "drizzle-orm";
import { AcmeClient, type Order } from "../acme/client.ts";
import { generateAccountKey } from "../acme/jose.ts";
import type { Database } from "../db/client.ts";
import { acmeAccounts, type CertChallenge, certificateOrders, nodes, waves } from "../db/schema.ts";
import { type DnsMode, loadDnsMode } from "../dns/credentials.ts";
import { lookupTxtAtAuthority, type TxtLookup } from "../dns/lookup.ts";
import { type DnsProvider, PROVIDER_KINDS } from "../dns/provider.ts";
import type { Config } from "../env.ts";
import { newId } from "../ids.ts";
import { DEFAULT_DNS_BASE } from "../waves/provision.ts";

/**
 * Certificates for node names (D7).
 *
 * The shape of this is the whole point: the node makes the key and the
 * request, this server checks that the names in it belong to that node, and
 * only then does it speak to the CA and to the zone. A node never sees a DNS
 * credential and the server never sees a private key -- neither side can do
 * the other's damage.
 *
 * An order runs in two halves, because what sits between them may be a person:
 * the first asks the CA and works out which records have to exist, the second
 * tells the CA to look and collects the certificate. With a provider the two
 * run back to back. In the manual mode the order parks in `waiting`, survives
 * a restart -- everything it needs is in its row -- and goes on the moment the
 * record turns up in the zone.
 */

/** Refusals a node can read and act on, as opposed to something that broke. */
export type OrderRefusal = { error: string; status: 400 | 403 | 409 };

export interface OrderRequest {
  nodeId: string;
  csrDer: Buffer;
  names: string[];
}

export interface OrderAccepted {
  orderId: string;
  /** The issuance, already running. The route drops it; the tests await it. */
  done: Promise<void>;
}

export interface CertificateServiceOptions {
  db: Database;
  config: Config;
  /** Replaced in tests by a fake CA and a fake provider API. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Replaced in tests by a zone that is a Map. */
  lookupTxt?: TxtLookup;
  /**
   * How long to give the records before telling the CA to look. A provider's
   * own nameservers need a moment, and a challenge checked too early counts as
   * a failed validation rather than a pending one.
   */
  propagationMs?: number;
  /** How rarely a waiting order may look at DNS. Zero in tests. */
  checkIntervalMs?: number;
  log?: (message: string) => void;
}

/** How often a waiting order looks at the zone again, however often it is asked. */
const DNS_CHECK_INTERVAL_MS = 15_000;

export class CertificateService {
  private readonly db: Database;
  private readonly config: Config;
  private readonly log: (message: string) => void;
  /** When each waiting order last looked at DNS, so polling cannot flood it. */
  private readonly checked = new Map<string, number>();

  constructor(private readonly options: CertificateServiceOptions) {
    this.db = options.db;
    this.config = options.config;
    this.log = options.log ?? console.log;
  }

  /**
   * Checks the request and starts the order.
   *
   * Everything that can be decided without the CA is decided here, so a node
   * that asks for something it may not have is told at once instead of after a
   * minute of validation.
   */
  async request(input: OrderRequest): Promise<OrderAccepted | OrderRefusal> {
    const rows = await this.db
      .select({ node: nodes, wave: waves })
      .from(nodes)
      .innerJoin(waves, eq(waves.id, nodes.waveId))
      .where(eq(nodes.id, input.nodeId))
      .limit(1);
    const found = rows[0];
    if (!found) return { error: "unknown node", status: 403 };

    const refusal = checkNames({
      names: input.names,
      hostname: found.node.hostname,
      dnsSuffix: found.wave.dnsSuffix,
      wildcardAllowed: found.node.wildcardAllowed,
    });
    if (refusal) return refusal;

    let csr: ReturnType<typeof readCsr>;
    try {
      csr = readCsr(input.csrDer);
    } catch (error) {
      return { error: `unreadable certificate request: ${message(error)}`, status: 400 };
    }
    // The names are checked above; the request has to ask for those and no
    // others, or the certificate would carry a name nobody authorised.
    if (!sameNames(csr.names, input.names)) {
      return { error: `the request asks for ${csr.names.join(", ") || "no names"}`, status: 400 };
    }

    const open = await this.db
      .select()
      .from(certificateOrders)
      .where(and(eq(certificateOrders.nodeId, input.nodeId), eq(certificateOrders.status, "waiting")))
      .limit(1);
    const waiting = open[0];
    // An order waiting for a hand-made record is handed back rather than
    // replaced: asking again is exactly how somebody says "I have created it
    // now", and a second order would only mean a second record to create. Only
    // a request for different names starts over.
    if (waiting && sameNames(waiting.names, input.names)) {
      return { orderId: waiting.id, done: this.resume(waiting.id) };
    }
    if (waiting) {
      await this.db
        .update(certificateOrders)
        .set({ status: "failed", error: "replaced by an order for other names", completedAt: new Date() })
        .where(eq(certificateOrders.id, waiting.id));
    }

    const pending = await this.db
      .select({ id: certificateOrders.id })
      .from(certificateOrders)
      .where(and(eq(certificateOrders.nodeId, input.nodeId), eq(certificateOrders.status, "pending")))
      .limit(1);
    // One at a time per device. A CA counts every order against the domain's
    // rate limit, and a node that retries in a loop would spend a week's worth
    // in a minute.
    if (pending[0]) return { error: "an order for this device is still running", status: 409 };

    const orderId = newId("cert");
    await this.db.insert(certificateOrders).values({
      id: orderId,
      waveId: found.wave.id,
      nodeId: found.node.id,
      names: input.names,
      csr: input.csrDer.toString("base64"),
    });

    return { orderId, done: this.run(orderId) };
  }

  /** What the node polls for. Scoped to its own node id, never by id alone. */
  async find(orderId: string, nodeId: string) {
    const rows = await this.db
      .select()
      .from(certificateOrders)
      .where(and(eq(certificateOrders.id, orderId), eq(certificateOrders.nodeId, nodeId)))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Looks at the zone again for a waiting order, and carries on if the record
   * is there now.
   *
   * Driven by whoever asks after the order rather than by a timer: the node
   * polls anyway, and a pull survives a restart without a loop to restart. The
   * interval is what keeps a three-second poll from becoming three DNS
   * queries a second.
   */
  async poke(orderId: string): Promise<void> {
    const last = this.checked.get(orderId) ?? 0;
    if (Date.now() - last < (this.options.checkIntervalMs ?? DNS_CHECK_INTERVAL_MS)) return;
    this.checked.set(orderId, Date.now());
    await this.resume(orderId);
  }

  /**
   * The first half: ask the CA, work out the records, and either write them or
   * park the order.
   *
   * Never throws. Whatever goes wrong is written to the order, because the
   * node is not on the other end of this call -- it comes back later and asks
   * how it went.
   */
  async run(orderId: string): Promise<void> {
    const order = await this.load(orderId);
    if (!order) return;

    try {
      const mode = await this.mode(order.waveId);
      const client = await this.client();
      const acmeOrder = await client.newOrder(order.names);

      const challenges: CertChallenge[] = [];
      for (const url of acmeOrder.authorizations) {
        const authorization = await client.authorization(url);
        // A CA remembers a successful validation for a while; re-answering one
        // that is already valid would be work for nothing.
        if (authorization.status === "valid") continue;

        const { challenge, recordName, recordValue } = client.dns01(authorization);
        challenges.push({
          name: recordName,
          value: recordValue,
          challengeUrl: challenge.url,
          authorizationUrl: url,
        });
      }

      await this.db
        .update(certificateOrders)
        .set({ challenges, acmeOrderUrl: acmeOrder.url })
        .where(eq(certificateOrders.id, orderId));

      if (mode.kind === "manual" && challenges.length > 0) {
        // Nothing to write and nobody here to wait for: the order parks, and
        // whoever asks after it next sets it going again.
        await this.db
          .update(certificateOrders)
          .set({ status: "waiting" })
          .where(eq(certificateOrders.id, orderId));
        this.log(`${order.names.join(", ")} waits for ${challenges.map((c) => c.name).join(", ")}`);
        return;
      }

      if (mode.kind === "automatic") {
        // Every record first, then one wait: with two names that halves it.
        for (const challenge of challenges) await mode.provider.setTxt(challenge.name, challenge.value);
        if (challenges.length > 0) await this.wait(this.options.propagationMs ?? 10_000);
      }

      await this.finish(orderId, client, acmeOrder, challenges, mode);
    } catch (error) {
      await this.fail(orderId, error, order.names);
    }
  }

  /**
   * Picks a parked order up -- and does nothing at all until every record is
   * really in the zone. Telling the CA to look at a record that is not there
   * yet spends one of the few attempts an authorization has.
   */
  async resume(orderId: string): Promise<void> {
    const order = await this.load(orderId);
    if (order?.status !== "waiting" || !order.acmeOrderUrl) return;

    const lookup = this.options.lookupTxt ?? lookupTxtAtAuthority;
    for (const challenge of order.challenges) {
      const values = await lookup(challenge.name).catch(() => [] as string[]);
      if (!values.includes(challenge.value)) return;
    }

    // Claimed before the work starts: two pokes arriving together would
    // otherwise both answer the same challenges.
    const claimed = await this.db
      .update(certificateOrders)
      .set({ status: "pending" })
      .where(and(eq(certificateOrders.id, orderId), eq(certificateOrders.status, "waiting")))
      .returning({ id: certificateOrders.id });
    if (claimed.length === 0) return;

    try {
      const client = await this.client();
      const acmeOrder = await client.order(order.acmeOrderUrl);
      await this.finish(orderId, client, acmeOrder, order.challenges, { kind: "manual" });
    } catch (error) {
      await this.fail(orderId, error, order.names);
    }
  }

  /** The second half: tell the CA to look, finalise, store the chain. */
  private async finish(
    orderId: string,
    client: AcmeClient,
    acmeOrder: Order,
    challenges: CertChallenge[],
    mode: DnsMode,
  ): Promise<void> {
    const order = await this.load(orderId);
    if (!order) return;

    try {
      for (const challenge of challenges) {
        await client.completeChallenge(challenge.challengeUrl);
        const authorization = await client.waitForAuthorization(challenge.authorizationUrl);
        if (authorization.status !== "valid") {
          throw new Error(`the CA could not validate ${authorization.identifier.value}`);
        }
      }

      await client.finalize(acmeOrder, Buffer.from(order.csr, "base64"));
      const finished = await client.waitForOrder(acmeOrder.url);
      if (finished.status !== "valid" || !finished.certificate) {
        throw new Error(`the CA ended the order as ${finished.status}`);
      }

      const chainPem = await client.downloadCertificate(finished.certificate);
      const leaf = leafOf(chainPem);

      await this.db
        .update(certificateOrders)
        .set({
          status: "valid",
          chainPem,
          expiresAt: leaf.notAfter,
          renewAt: await this.renewAt(client, leaf),
          completedAt: new Date(),
        })
        .where(eq(certificateOrders.id, orderId));
      this.log(`certificate for ${order.names.join(", ")} issued until ${leaf.notAfter.toISOString()}`);
    } catch (error) {
      await this.fail(orderId, error, order.names);
    } finally {
      // Always, and never fatal: a leftover TXT record is untidy, a failed
      // cleanup that hid a successful issuance would be worse. In the manual
      // mode there is nothing to clean up -- the record belongs to whoever
      // made it, and `wave certs` says when it may go.
      if (mode.kind === "automatic") await this.cleanUp(mode.provider, challenges);
    }
  }

  private async cleanUp(provider: DnsProvider, challenges: CertChallenge[]): Promise<void> {
    for (const challenge of challenges) {
      await provider
        .removeTxt(challenge.name, challenge.value)
        .catch((error) => this.log(`could not remove ${challenge.name}: ${message(error)}`));
    }
  }

  private async load(orderId: string) {
    const rows = await this.db
      .select()
      .from(certificateOrders)
      .where(eq(certificateOrders.id, orderId))
      .limit(1);
    return rows[0] ?? null;
  }

  private async fail(orderId: string, error: unknown, names: string[]): Promise<void> {
    await this.db
      .update(certificateOrders)
      .set({ status: "failed", error: message(error), completedAt: new Date() })
      .where(eq(certificateOrders.id, orderId));
    this.log(`certificate for ${names.join(", ")} failed: ${message(error)}`);
  }

  private async mode(waveId: string): Promise<DnsMode> {
    const mode = await loadDnsMode(this.db, waveId, this.config.dnsSecret, this.options.fetch);
    if (!mode) {
      throw new Error(
        "this wave has not said how it answers dns-01 " +
          `(bun apps/control/src/admin.ts set-dns-provider <wave> <${PROVIDER_KINDS.join("|")}>)`,
      );
    }
    return mode;
  }

  /**
   * When the node should come back for a new certificate.
   *
   * ARI first: the CA knows about revocations we cannot see, and a mass
   * revocation is exactly the case where everybody renewing at two thirds of
   * the lifetime is too late. A random point inside the suggested window,
   * because the whole point of the window is that not everyone arrives at its
   * start.
   */
  private async renewAt(client: AcmeClient, leaf: ReturnType<typeof leafOf>): Promise<Date> {
    const window = await client.renewalWindow(leaf).catch(() => null);
    if (window) {
      const span = window.end.getTime() - window.start.getTime();
      const picked = new Date(window.start.getTime() + Math.random() * Math.max(span, 0));
      return picked > new Date() ? picked : new Date();
    }
    const lifetime = leaf.notAfter.getTime() - leaf.notBefore.getTime();
    return new Date(leaf.notBefore.getTime() + (lifetime * 2) / 3);
  }

  private wait(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return (this.options.sleep ?? ((delay) => new Promise((resolve) => setTimeout(resolve, delay))))(ms);
  }

  /**
   * The account, created once and kept.
   *
   * Stored rather than made per order because a CA counts accounts too, and
   * because the ARI and rate-limit history of a server belongs to one account.
   */
  private async client(): Promise<AcmeClient> {
    const directoryUrl = this.config.acmeDirectory;
    const existing = await this.db
      .select()
      .from(acmeAccounts)
      .where(eq(acmeAccounts.directoryUrl, directoryUrl))
      .limit(1);

    let account = existing[0];
    if (!account) {
      await this.db
        .insert(acmeAccounts)
        .values({ directoryUrl, privateKeyPem: generateAccountKey() })
        .onConflictDoNothing();
      // Re-read rather than trust the insert: two orders starting at once must
      // end up with the same account key, and the unique key decides which.
      account = (
        await this.db.select().from(acmeAccounts).where(eq(acmeAccounts.directoryUrl, directoryUrl)).limit(1)
      )[0];
      if (!account) throw new Error("could not create an ACME account key");
    }

    const client = new AcmeClient({
      directoryUrl,
      accountKeyPem: account.privateKeyPem,
      accountUrl: account.accountUrl ?? undefined,
      contact: this.config.acmeContact,
      fetch: this.options.fetch,
      sleep: this.options.sleep,
    });

    if (!account.accountUrl) {
      const accountUrl = await client.ensureAccount();
      await this.db
        .update(acmeAccounts)
        .set({ accountUrl })
        .where(eq(acmeAccounts.directoryUrl, directoryUrl));
    }
    return client;
  }
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const sameNames = (a: string[], b: string[]): boolean =>
  a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");

/**
 * Whether these names are this node's to ask for.
 *
 * The rule from D7, and it is short on purpose: a node may have a certificate
 * for its own name in its own wave, and for nothing else. A compromised device
 * therefore cannot obtain a certificate for a colleague's machine, which is the
 * one thing a name-based authorisation has to prevent.
 *
 * The wildcard is the one exception, and it is not an exception to the rule but
 * to who decides: `*.<suffix>` stands for every name in the wave, so it cannot
 * be *this device's* name by any test. It takes an operator saying so about
 * this device (`admin.ts allow-wildcard`), and then it also carries the zone's
 * own name -- a machine that fronts the wildcard fronts the apex too, and
 * refusing it would only force a second certificate with the same reach.
 */
export function checkNames(input: {
  names: string[];
  hostname: string;
  dnsSuffix: string;
  wildcardAllowed?: boolean;
}): OrderRefusal | null {
  if (input.names.length === 0) return { error: "no names requested", status: 400 };

  // Never a public certificate for the placeholder suffix: `.internal` cannot
  // be delegated, so no CA can validate it and no order would get past dns-01.
  if (input.dnsSuffix === DEFAULT_DNS_BASE || input.dnsSuffix.endsWith(`.${DEFAULT_DNS_BASE}`)) {
    return {
      error: `${input.dnsSuffix} is a placeholder domain; point the wave at a domain you own first`,
      status: 400,
    };
  }

  const suffix = input.dnsSuffix.toLowerCase();
  const own = `${input.hostname}.${suffix}`.toLowerCase();
  const wildcard = `*.${suffix}`;

  const seen = new Set<string>();
  for (const raw of input.names) {
    const name = raw.toLowerCase();
    // The same name twice is a certificate request the CA would refuse later;
    // saying so here costs nothing and points at the actual mistake.
    if (seen.has(name)) return { error: `${raw} is listed twice`, status: 400 };
    seen.add(name);

    if (name === own) continue;
    if (name === wildcard || name === suffix) {
      if (input.wildcardAllowed) continue;
      return {
        error:
          `${raw} covers the whole wave, so it is not this device's to ask for. ` +
          "An operator grants it with `admin.ts allow-wildcard`.",
        status: 403,
      };
    }
    // A wildcard deeper in the tree is nobody's: it would cover names that are
    // not in this wave at all, and it is not what `allow-wildcard` grants.
    if (name.startsWith("*.")) return { error: `${raw} is not this wave's wildcard`, status: 403 };
    return { error: `${raw} does not belong to this device (it is ${own})`, status: 403 };
  }
  return null;
}
