/**
 * Retrying the first contact with the control server.
 *
 * Everything after the first connect already reconnects on its own (the
 * control socket, the relay). What did not was enrolment itself: one refused
 * connection while registering or polling for approval threw all the way up,
 * and a daemon that starts before the network does ended up "failed" for good.
 *
 * The same rule lives in the Go core (mobile/core/wavecontrol/retry.go); a
 * change to which errors count as "the server is not there yet" -- or, with
 * the clock-skew 401, "not yet" for a reason on this device -- is a change to
 * both.
 */

/** Same bounds as the control socket's reconnect (control-socket.ts). */
export const MIN_BACKOFF_MS = 500;
export const MAX_BACKOFF_MS = 30_000;

/**
 * One attempt may take this long. Without it a server that accepts and then
 * says nothing would hold enrolment open forever, and "timeout" is one of the
 * things that are meant to be retried, not waited out.
 */
export const ATTEMPT_TIMEOUT_MS = 15_000;

/** A reply that is not a success; `status` is what the retry rule looks at. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const isAbort = (error: unknown): boolean => error instanceof Error && error.name === "AbortError";

/**
 * The server's own sentence out of a failed request's message, which carries
 * its JSON body (`POST /v1/... failed: 401 {"error":"clock-skew"}`).
 */
export function serverReason(error: HttpError): string {
  const start = error.message.indexOf("{");
  if (start >= 0) {
    try {
      const body = JSON.parse(error.message.slice(start)) as { error?: unknown };
      if (typeof body.error === "string") return body.error;
    } catch {
      // Cut off at 200 characters: say what there is.
    }
  }
  return error.message;
}

/**
 * The reason the server gives a signed request whose timestamp is outside its
 * window (MAX_CLOCK_SKEW_SECONDS). Right after boot that is a clock NTP has not
 * set yet, and it fixes itself within seconds: the one 401 that is waited out.
 */
export const CLOCK_SKEW_REASON = "clock-skew";

/** The server is there but not serving: a proxy in front of a restarting control server. */
const GATEWAY_STATUSES = new Set([502, 503, 504]);

/** Connection refused or reset, no route, no answer in time. */
const CONNECTION_CODES = new Set([
  "ConnectionRefused",
  "ConnectionClosed",
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTDOWN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * A name the resolver says does not exist: a typo, or -- for an address that
 * worked before -- a network that is not up yet. The only DNS answer that
 * depends on `knownAddress`.
 */
const NAME_NOT_FOUND_CODES = new Set(["ENOTFOUND", "EAI_NODATA", "EAI_NONAME"]);

/**
 * The resolver itself did not answer: c-ares spells a timeout ETIMEOUT (not
 * ETIMEDOUT), and the rest are a resolver that refuses, fails or gives up.
 * That is the network and not the address, so it is waited out whether or not
 * this device has enrolled there before.
 */
const RESOLVER_CODES = new Set([
  "ETIMEOUT",
  "EAI_AGAIN",
  "ESERVFAIL",
  "EREFUSED",
  "ECONNREFUSED",
  "EBADRESP",
  "ECANCELLED",
]);

const CONNECTION_TEXT =
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|connection refused|connection reset|socket connection was closed|Unable to connect/i;
const NAME_NOT_FOUND_TEXT = /ENOTFOUND|EAI_NODATA|EAI_NONAME|no such host/i;
const RESOLVER_TEXT = /getaddrinfo (ETIMEOUT|EAI_AGAIN|ESERVFAIL|EREFUSED|ECONNREFUSED|EBADRESP|ECANCELLED)/i;
const CERTIFICATE_TEXT = /certificate|x509/i;
const CERTIFICATE_CODE = /CERT|TLS|SSL|SELF_SIGNED|VERIFY|ALTNAME/i;

/**
 * `cause` is set when the wait has a reason a person can act on or just be told
 * about, apart from "the server is not there": today only the clock.
 */
export type Verdict = { retry: true; reason: string; cause?: "clock-skew" } | { retry: false };

/**
 * Whether an error from reaching the control server is worth another try.
 *
 * Retried: connection refused or reset, timeout, network or host unreachable,
 * a resolver that times out or fails (`getaddrinfo ETIMEOUT`, EAI_AGAIN,
 * ESERVFAIL, ...), HTTP 502/503/504, and HTTP 401 whose reason is `clock-skew`
 * (the clock is not set yet after boot; the backoff is the same). Reported at
 * once: every other HTTP answer (a wrong address, a refusal, any other 401 such
 * as `bad-signature`) and everything that is not a connection problem at all
 * (an expired request, a netmap that does not verify) -- retrying those would
 * hide the real reason behind a wait that never ends.
 *
 * `knownAddress` is whether this device has enrolled at that address before.
 * A name that does not exist (ENOTFOUND, EAI_NONAME, EAI_NODATA) then is the
 * network not being up yet, and is retried; for an address a person has just
 * typed it is most likely a typo, and is reported. A resolver that does not
 * answer says nothing about the address and is retried either way. A
 * certificate error is reported either way: waiting does not fix it.
 */
export function classify(error: unknown, knownAddress: boolean): Verdict {
  if (error instanceof HttpError) {
    if (GATEWAY_STATUSES.has(error.status)) return { retry: true, reason: error.message };
    if (error.status === 401 && serverReason(error) === CLOCK_SKEW_REASON) {
      return { retry: true, reason: error.message, cause: "clock-skew" };
    }
    return { retry: false };
  }
  if (!(error instanceof Error)) return { retry: false };
  if (isAbort(error)) return { retry: false };
  if (error.name === "TimeoutError") return { retry: true, reason: "no answer in time" };

  const code = String((error as { code?: unknown }).code ?? "");
  // First, because Bun reports an untrusted certificate with a code that
  // looks like nothing else and a message that only says "certificate".
  if (CERTIFICATE_CODE.test(code) || CERTIFICATE_TEXT.test(error.message)) return { retry: false };
  if (NAME_NOT_FOUND_CODES.has(code) || NAME_NOT_FOUND_TEXT.test(error.message)) {
    return knownAddress ? { retry: true, reason: error.message } : { retry: false };
  }
  if (RESOLVER_CODES.has(code) || RESOLVER_TEXT.test(error.message)) {
    return { retry: true, reason: error.message };
  }
  if (CONNECTION_CODES.has(code) || CONNECTION_TEXT.test(error.message)) {
    return { retry: true, reason: error.message };
  }
  return { retry: false };
}

/** Sleeps, but wakes at once -- and throws -- when the signal fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const abortReason = (signal: AbortSignal): Error =>
  signal.reason instanceof Error && signal.reason.name === "AbortError"
    ? signal.reason
    : new DOMException("aborted", "AbortError");

export interface RetryOptions {
  /** Ends the wait -- and any attempt in flight -- with an AbortError. */
  signal?: AbortSignal;
  /** See {@link classify}. */
  knownAddress: boolean;
  /** Backoff bounds, overridable for tests like the control socket's. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Called after each failed attempt, before the wait. */
  onWait?: (wait: { reason: string; delayMs: number; cause?: "clock-skew" }) => void;
  /** Called when an attempt that followed a failure succeeds. */
  onRecovered?: () => void;
  /**
   * A time limit that retrying does not move: past `at`, the next failure
   * throws `error` instead of waiting. The approval wait has one.
   */
  deadline?: { at: number; error: Error };
}

/**
 * Runs `attempt` until it succeeds or fails with something that is not a
 * connection problem. The backoff doubles from the minimum to the maximum and
 * starts over with every call.
 */
export async function retrying<T>(
  attempt: (signal: AbortSignal | undefined) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const max = options.maxBackoffMs ?? MAX_BACKOFF_MS;
  let delay = options.minBackoffMs ?? MIN_BACKOFF_MS;
  let waited = false;
  for (;;) {
    if (options.signal?.aborted) throw abortReason(options.signal);
    try {
      const result = await attempt(options.signal);
      if (waited) options.onRecovered?.();
      return result;
    } catch (error) {
      // Our own abort wins over whatever the aborted request made of it.
      if (options.signal?.aborted) throw abortReason(options.signal);
      const verdict = classify(error, options.knownAddress);
      if (!verdict.retry) throw error;
      if (options.deadline && Date.now() >= options.deadline.at) throw options.deadline.error;
      options.onWait?.({ reason: verdict.reason, delayMs: delay, cause: verdict.cause });
      waited = true;
      await sleep(delay, options.signal);
      delay = Math.min(delay * 2, max);
    }
  }
}
