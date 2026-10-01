import { createHash } from "node:crypto";
import { publicJwk, signJws, thumbprint } from "./jose.ts";

/**
 * An ACME client, server-side and shared by every wave.
 *
 * Written here rather than taken off the shelf for the reason D7 anticipated:
 * the flow this project needs is one identifier type, one challenge type and
 * one signature algorithm, and it has to run inside Bun in a container that is
 * built for two architectures. What follows is RFC 8555 in the order a single
 * order walks through it, plus the renewal-info lookup of RFC 9773.
 *
 * The CA sees a CSR and hands back a public chain. **No private key of a node
 * passes through here** -- the account key below is the server's own, and it
 * only ever authenticates us to the CA.
 */

export const LETSENCRYPT_STAGING = "https://acme-staging-v02.api.letsencrypt.org/directory";
export const LETSENCRYPT_PRODUCTION = "https://acme-v02.api.letsencrypt.org/directory";

export class AcmeError extends Error {
  constructor(
    message: string,
    readonly type?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AcmeError";
  }
}

export interface Directory {
  newNonce: string;
  newAccount: string;
  newOrder: string;
  /** RFC 9773. Absent on a CA that does not offer renewal information. */
  renewalInfo?: string;
  meta?: { termsOfService?: string; externalAccountRequired?: boolean };
}

export interface Challenge {
  type: string;
  url: string;
  token: string;
  status: string;
}

export interface Authorization {
  status: string;
  identifier: { type: string; value: string };
  wildcard?: boolean;
  challenges: Challenge[];
}

export interface Order {
  url: string;
  status: string;
  authorizations: string[];
  finalize: string;
  certificate?: string;
}

export interface AcmeOptions {
  directoryUrl: string;
  /** PKCS#8 PEM of the server's ACME account key. */
  accountKeyPem: string;
  /** The account URL once one exists; without it the first use creates one. */
  accountUrl?: string;
  contact?: string[];
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const BAD_NONCE = "urn:ietf:params:acme:error:badNonce";

export class AcmeClient {
  private readonly http: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly nonces: string[] = [];
  private cachedDirectory?: Directory;
  private accountUrl?: string;

  constructor(private readonly options: AcmeOptions) {
    this.http = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.accountUrl = options.accountUrl;
  }

  async directory(): Promise<Directory> {
    if (this.cachedDirectory) return this.cachedDirectory;
    const res = await this.http(this.options.directoryUrl);
    if (!res.ok) throw new AcmeError(`ACME directory ${this.options.directoryUrl} answered ${res.status}`);
    this.cachedDirectory = (await res.json()) as Directory;
    return this.cachedDirectory;
  }

  /**
   * Registers the account, or confirms the one we were given.
   *
   * `onlyReturnExisting` is not used: posting the same key again is how ACME
   * says "give me my account", and it answers with the same URL rather than a
   * second account. That makes this safe to call on every start.
   */
  async ensureAccount(): Promise<string> {
    if (this.accountUrl) return this.accountUrl;
    const directory = await this.directory();
    const response = await this.post(directory.newAccount, {
      termsOfServiceAgreed: true,
      ...(this.options.contact?.length ? { contact: this.options.contact } : {}),
    });
    const location = response.headers.get("location");
    if (!location) throw new AcmeError("the CA created an account without saying where it is");
    this.accountUrl = location;
    return location;
  }

  async newOrder(names: string[]): Promise<Order> {
    const directory = await this.directory();
    const response = await this.post(directory.newOrder, {
      identifiers: names.map((value) => ({ type: "dns", value })),
    });
    const url = response.headers.get("location");
    if (!url) throw new AcmeError("the CA created an order without saying where it is");
    return { url, ...((await response.json()) as Omit<Order, "url">) };
  }

  async authorization(url: string): Promise<Authorization> {
    return (await (await this.post(url)).json()) as Authorization;
  }

  /**
   * What has to appear in DNS for one authorization.
   *
   * The record is the SHA-256 of the key authorization, not the key
   * authorization itself -- that is what makes dns-01 different from http-01,
   * and getting it wrong is a challenge that stays pending until it expires.
   */
  dns01(authorization: Authorization): { challenge: Challenge; recordName: string; recordValue: string } {
    const challenge = authorization.challenges.find((entry) => entry.type === "dns-01");
    if (!challenge) {
      throw new AcmeError(`the CA offers no dns-01 challenge for ${authorization.identifier.value}`);
    }
    const keyAuthorization = `${challenge.token}.${thumbprint(publicJwk(this.options.accountKeyPem))}`;
    return {
      challenge,
      // A wildcard authorization carries the bare domain as its identifier, so
      // the record name is the same either way.
      recordName: `_acme-challenge.${authorization.identifier.value}`,
      recordValue: createHash("sha256").update(keyAuthorization).digest("base64url"),
    };
  }

  /** Tells the CA to look. The empty object is what RFC 8555 asks for here. */
  async completeChallenge(challengeUrl: string): Promise<void> {
    await this.post(challengeUrl, {});
  }

  /**
   * An order that already exists, by its URL. What a resumed run starts from:
   * the order outlives this process, and its own row remembers where it is.
   */
  async order(url: string): Promise<Order> {
    return { url, ...((await (await this.post(url)).json()) as Omit<Order, "url">) };
  }

  async waitForAuthorization(url: string, timeoutMs = 120_000): Promise<Authorization> {
    return this.poll(
      () => this.authorization(url),
      (authorization) => authorization.status !== "pending" && authorization.status !== "processing",
      timeoutMs,
      (authorization) => `authorization for ${authorization.identifier.value} is ${authorization.status}`,
    );
  }

  async finalize(order: Order, csrDer: Buffer): Promise<void> {
    await this.post(order.finalize, { csr: csrDer.toString("base64url") });
  }

  async waitForOrder(url: string, timeoutMs = 120_000): Promise<Order> {
    // "ready" counts as not done here, although it is a settled state
    // elsewhere: this is only ever asked *after* finalising, and an order that
    // is still ready then has not started issuing. Waiting says that; reading
    // it as an outcome would report "the CA ended the order as ready".
    const waiting = new Set(["pending", "processing", "ready"]);
    return this.poll(
      async () => ({ url, ...((await (await this.post(url)).json()) as Omit<Order, "url">) }),
      (candidate) => !waiting.has(candidate.status),
      timeoutMs,
      (candidate) => `order is ${candidate.status}`,
    );
  }

  /** The chain, leaf first, exactly as the CA serves it. */
  async downloadCertificate(url: string): Promise<string> {
    return (await this.post(url)).text();
  }

  /**
   * The window the CA suggests for renewing this certificate (RFC 9773).
   *
   * Null when the CA offers no renewal information or does not know this
   * certificate -- the caller then falls back to two thirds of the lifetime,
   * which is what everyone did before ARI existed. Not worth an error: a
   * missing suggestion is not a failed issuance.
   */
  async renewalWindow(certificate: {
    serial: Buffer;
    authorityKeyIdentifier: Buffer | null;
  }): Promise<{ start: Date; end: Date } | null> {
    const directory = await this.directory();
    if (!directory.renewalInfo || !certificate.authorityKeyIdentifier) return null;

    const certId = `${certificate.authorityKeyIdentifier.toString("base64url")}.${certificate.serial.toString("base64url")}`;
    const res = await this.http(`${directory.renewalInfo.replace(/\/$/, "")}/${certId}`);
    if (!res.ok) return null;

    const body = (await res.json()) as { suggestedWindow?: { start: string; end: string } };
    if (!body.suggestedWindow) return null;
    const start = new Date(body.suggestedWindow.start);
    const end = new Date(body.suggestedWindow.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
    return { start, end };
  }

  // --- transport -----------------------------------------------------------

  private async nonce(): Promise<string> {
    const stored = this.nonces.pop();
    if (stored) return stored;
    const directory = await this.directory();
    const res = await this.http(directory.newNonce, { method: "HEAD" });
    const fresh = res.headers.get("replay-nonce");
    if (!fresh) throw new AcmeError("the CA handed out no nonce");
    return fresh;
  }

  /**
   * One signed request, with the one retry ACME asks for.
   *
   * A nonce is single use and the CA may decide ours is stale at any time; the
   * protocol's answer is to take the fresh one that came with the rejection and
   * send again. Anything else that fails, fails.
   */
  private async post(url: string, payload?: unknown): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const body = signJws({
        privateKeyPem: this.options.accountKeyPem,
        url,
        nonce: await this.nonce(),
        kid: url === (await this.directory()).newAccount ? undefined : await this.ensureAccount(),
        payload,
      });
      const res = await this.http(url, {
        method: "POST",
        headers: { "content-type": "application/jose+json" },
        body,
      });

      const nonce = res.headers.get("replay-nonce");
      if (nonce) this.nonces.push(nonce);
      if (res.ok) return res;

      const problem = await this.problem(res);
      if (problem.type === BAD_NONCE && attempt < 2) continue;
      throw new AcmeError(`${url}: ${problem.detail}`, problem.type, res.status);
    }
  }

  private async problem(res: Response): Promise<{ type?: string; detail: string }> {
    const text = await res.text();
    try {
      const body = JSON.parse(text) as { type?: string; detail?: string };
      return { type: body.type, detail: body.detail ?? text.slice(0, 200) };
    } catch {
      return { detail: `${res.status} ${text.slice(0, 200)}` };
    }
  }

  private async poll<T>(
    read: () => Promise<T>,
    done: (value: T) => boolean,
    timeoutMs: number,
    describe: (value: T) => string,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let delay = 500;
    for (;;) {
      const value = await read();
      if (done(value)) return value;
      if (Date.now() >= deadline) throw new AcmeError(`timed out while ${describe(value)}`);
      await this.sleep(delay);
      // Backing off matters here: a validation can take a minute, and asking
      // twice a second for that long is what CAs rate-limit clients for.
      delay = Math.min(delay * 2, 8_000);
    }
  }
}
