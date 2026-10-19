/**
 * Retrying the first contact with the control server.
 *
 * Everything after the first connect already reconnects on its own (the
 * control socket, the relay). What did not was enrolment itself: one refused
 * connection while registering or polling for approval threw all the way up,
 * and a daemon that starts before the network does ended up "failed" for good.
 *
 * The same rule lives in the Go core (mobile/core/waveengine/retry.go); a
 * change to which errors count as "the server is not there yet" is a change
 * to both.
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

/** A name that does not resolve: a typo, or a resolver that is not up yet. */
const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_NODATA", "EAI_NONAME"]);

const CONNECTION_TEXT =
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|connection refused|connection reset|socket connection was closed|Unable to connect/i;
const DNS_TEXT = /ENOTFOUND|EAI_AGAIN|no such host/i;
const CERTIFICATE_TEXT = /certificate|x509/i;
const CERTIFICATE_CODE = /CERT|TLS|SSL|SELF_SIGNED|VERIFY|ALTNAME/i;

export type Verdict = { retry: true; reason: string } | { retry: false };

/**
 * Whether an error from reaching the control server is worth another try.
 *
 * Retried: connection refused or reset, timeout, network or host unreachable,
 * HTTP 502/503/504. Reported at once: every other HTTP answer (a wrong
 * address, a refusal) and everything that is not a connection problem at all
 * (an expired request, a netmap that does not verify) -- retrying those would
 * hide the real reason behind a wait that never ends.
 *
 * `knownAddress` is whether this device has enrolled at that address before.
 * A DNS failure then is the network not being up yet, and is retried; for an
 * address a person has just typed it is most likely a typo, and is reported.
 * A certificate error is reported either way: waiting does not fix it.
 */
export function classify(error: unknown, knownAddress: boolean): Verdict {
  if (error instanceof HttpError) {
    return GATEWAY_STATUSES.has(error.status) ? { retry: true, reason: error.message } : { retry: false };
  }
  if (!(error instanceof Error)) return { retry: false };
  if (isAbort(error)) return { retry: false };
  if (error.name === "TimeoutError") return { retry: true, reason: "no answer in time" };

  const code = String((error as { code?: unknown }).code ?? "");
  // First, because Bun reports an untrusted certificate with a code that
  // looks like nothing else and a message that only says "certificate".
  if (CERTIFICATE_CODE.test(code) || CERTIFICATE_TEXT.test(error.message)) return { retry: false };
  if (DNS_CODES.has(code) || DNS_TEXT.test(error.message)) {
    return knownAddress ? { retry: true, reason: error.message } : { retry: false };
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
  onWait?: (wait: { reason: string; delayMs: number }) => void;
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
      options.onWait?.({ reason: verdict.reason, delayMs: delay });
      waited = true;
      await sleep(delay, options.signal);
      delay = Math.min(delay * 2, max);
    }
  }
}
