import { createHmac } from "node:crypto";
import { type DnsProvider, DnsProviderError, zoneCandidates } from "./provider.ts";

const API = "https://api.domrobot.com/jsonrpc/";
/** The OTE, INWX's test system. Separate accounts, separate domains, no charges. */
const SANDBOX_API = "https://api.ote.domrobot.com/jsonrpc/";

/** Five minutes is the floor INWX enforces; see the note in ionos.ts for why it is free. */
export const INWX_TTL_SECONDS = 300;

/**
 * What INWX needs to let us in.
 *
 * An account, not a token -- and that is the thing to understand before using
 * this provider: INWX has no credential that can be scoped to one zone, so
 * what is sealed here can do everything the person could, transfers and
 * deletions included. Cloudflare's zone-scoped token is a different class of
 * secret. A sub-account limited to the one domain is the closest INWX comes,
 * and it is worth making one.
 */
export interface InwxAccount {
  user: string;
  password: string;
  /** The TOTP shared secret, when the account has two-factor auth switched on. */
  totpSecret?: string;
  /** Talk to the OTE rather than the real registry. */
  sandbox?: boolean;
}

/**
 * The sealed string for INWX is JSON, because a username and a password do not
 * fit in the one opaque token the other three providers store.
 */
export function parseInwxAccount(secret: string): InwxAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    throw new DnsProviderError(`inwx: the stored credential is not JSON ({"user":…,"password":…})`);
  }
  const value = parsed as Partial<InwxAccount>;
  if (typeof value?.user !== "string" || value.user.length === 0) {
    throw new DnsProviderError("inwx: the stored credential has no user");
  }
  if (typeof value.password !== "string" || value.password.length === 0) {
    throw new DnsProviderError("inwx: the stored credential has no password");
  }
  return {
    user: value.user,
    password: value.password,
    totpSecret: typeof value.totpSecret === "string" && value.totpSecret ? value.totpSecret : undefined,
    sandbox: value.sandbox === true,
  };
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(value: string): Buffer {
  const bytes: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const char of value.replace(/[\s=-]/g, "").toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new DnsProviderError("inwx: the TOTP secret is not base32");
    accumulator = (accumulator << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

export const TOTP_STEP_MS = 30_000;

/** RFC 6238, the shape every authenticator app produces: SHA-1, 30 seconds, six digits. */
export function totp(secret: string, atMs: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / TOTP_STEP_MS)));
  const digest = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const code = (digest.readUInt32BE(offset) & 0x7fff_ffff) % 1_000_000;
  return String(code).padStart(6, "0");
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => Bun.sleep(ms),
};

interface RpcResponse<T> {
  code: number;
  msg?: string;
  reason?: string;
  resData?: T;
}

interface NameserverRecord {
  id: string | number;
  name: string;
  type: string;
  content: string;
}

/** Carries the API's own code, which is the only thing worth branching on. */
class InwxError extends DnsProviderError {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "InwxError";
    this.code = code;
  }
}

/** No session, or none any more. Both mean: log in and try that again. */
const NOT_AUTHENTICATED = 2200;
/** The record is already there with this value, which is what was wanted. */
const OBJECT_EXISTS = 2302;

/**
 * INWX, over the JSON-RPC face of its DomRobot API.
 *
 * Two things make this the odd one out among the four. It is a session rather
 * than a header -- log in, carry a cookie, and be ready for it to have expired
 * between two certificates months apart -- and the login may want a second
 * factor, which is why RFC 6238 is implemented above. Neither is optional: an
 * INWX account without two-factor auth is one nobody should be running a
 * domain on.
 */
export function inwxProvider(
  secret: string,
  http: typeof fetch = fetch,
  clock: Clock = systemClock,
): DnsProvider {
  const account = parseInwxAccount(secret);
  const endpoint = account.sandbox ? SANDBOX_API : API;
  let session: string | undefined;
  let lastTotpStep = -1;

  const rpc = async <T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<{ resData?: T; response: Response }> => {
    const response = await http(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(session ? { cookie: session } : {}),
      },
      // `lang` decides which language the API answers errors in, and an error
      // that has to be read by whoever runs this server is better in one.
      body: JSON.stringify({ method, params: { lang: "en", ...params } }),
    });
    // The transport is always 200; what went wrong is in the body.
    const body = (await response.json().catch(() => null)) as RpcResponse<T> | null;
    if (!body || typeof body.code !== "number") {
      throw new DnsProviderError(`inwx: ${method} gave no answer this API could have given`);
    }
    if (body.code >= 2000) {
      const detail = [body.msg, body.reason].filter(Boolean).join(": ");
      throw new InwxError(body.code, `inwx: (${body.code}) ${detail || method}`);
    }
    return { resData: body.resData, response };
  };

  /** Whatever the login set, sent back unread -- the name of the cookie is INWX's business. */
  const cookiesFrom = (response: Response): string | undefined => {
    const lines =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [response.headers.get("set-cookie") ?? ""];
    const pairs = lines
      .map((line) => line.split(";")[0]?.trim())
      .filter((pair): pair is string => Boolean(pair));
    return pairs.length > 0 ? pairs.join("; ") : undefined;
  };

  /**
   * A TAN, and never the same one twice.
   *
   * A TOTP code is valid for its 30-second step and INWX refuses one it has
   * already seen. Only a second login inside one step can hit that -- rare,
   * and exactly the case where the failure would look random.
   */
  const tan = async (secretValue: string): Promise<string> => {
    let step = Math.floor(clock.now() / TOTP_STEP_MS);
    if (step === lastTotpStep) {
      await clock.sleep((step + 1) * TOTP_STEP_MS - clock.now());
      step = Math.floor(clock.now() / TOTP_STEP_MS);
    }
    lastTotpStep = step;
    return totp(secretValue, clock.now());
  };

  const login = async (): Promise<void> => {
    session = undefined;
    const { resData, response } = await rpc<{ tfa?: string }>("account.login", {
      user: account.user,
      pass: account.password,
    });
    session = cookiesFrom(response);
    if (!session) throw new DnsProviderError("inwx: the login returned no session");

    // An account without a second factor answers "0" here, or nothing at all.
    const tfa = resData?.tfa;
    if (!tfa || tfa === "0") return;
    if (!account.totpSecret) {
      throw new DnsProviderError(
        `inwx: this account asks for a second factor (${tfa}) and no TOTP secret was stored`,
      );
    }
    await rpc("account.unlock", { tan: await tan(account.totpSecret) });
  };

  const withSession = async <T>(run: () => Promise<T>): Promise<T> => {
    if (!session) await login();
    try {
      return await run();
    } catch (error) {
      // Sessions expire, and two certificates can be months apart. One retry,
      // so a stale cookie costs a round trip rather than an order.
      if (!(error instanceof InwxError) || error.code !== NOT_AUTHENTICATED) throw error;
      await login();
      return run();
    }
  };

  /**
   * The zone this record belongs in, and what TXT already stands there.
   *
   * One call answers both, which is why the lookup is not a separate step:
   * `nameserver.info` fails for a domain the account does not hold, so asking
   * for the records *is* asking whether the zone is ours.
   */
  const infoFor = async (recordName: string): Promise<{ domain: string; records: NameserverRecord[] }> => {
    let lastError: Error | undefined;
    for (const candidate of zoneCandidates(recordName)) {
      try {
        const { resData } = await rpc<{ record?: NameserverRecord[] }>("nameserver.info", {
          domain: candidate,
          type: "TXT",
          name: recordName,
        });
        return { domain: candidate, records: resData?.record ?? [] };
      } catch (error) {
        // A domain this account does not hold is the ordinary answer while
        // walking the candidates from the longest up, so it is not fatal --
        // but a dead session is, and it has to reach withSession.
        if (error instanceof InwxError && error.code === NOT_AUTHENTICATED) throw error;
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    const detail = lastError ? ` (${lastError.message})` : "";
    throw new DnsProviderError(`inwx: no zone of this account answers for ${recordName}${detail}`);
  };

  return {
    kind: "inwx",

    async setTxt(name, value) {
      await withSession(async () => {
        const { domain } = await infoFor(name);
        try {
          await rpc("nameserver.createRecord", {
            domain,
            name,
            type: "TXT",
            content: value,
            ttl: INWX_TTL_SECONDS,
          });
        } catch (error) {
          // The same name with the same value already standing there is the
          // state this call exists to bring about.
          if (!(error instanceof InwxError) || error.code !== OBJECT_EXISTS) throw error;
        }
      });
    },

    async removeTxt(name, value) {
      await withSession(async () => {
        const { records } = await infoFor(name);
        for (const record of records) {
          if (record.type !== "TXT" || record.name !== name) continue;
          if (record.content !== value && record.content !== `"${value}"`) continue;
          await rpc("nameserver.deleteRecord", { id: record.id });
        }
      });
    },
  };
}
