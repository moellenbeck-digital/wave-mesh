import { describe, expect, test } from "bun:test";
import {
  classify,
  HttpError,
  isAbort,
  MAX_BACKOFF_MS,
  MIN_BACKOFF_MS,
  retrying,
  sleep,
} from "../src/retry.ts";

/** What Bun's fetch throws, as seen from a real refused and reset connection. */
const bunError = (code: string, message: string) => Object.assign(new TypeError(message), { code });
const refused = () =>
  bunError("ConnectionRefused", "Unable to connect. Is the computer able to access the url?");
const reset = () =>
  bunError(
    "ECONNRESET",
    "The socket connection was closed unexpectedly. For more information, pass `verbose: true`",
  );
const missing = () => bunError("ENOTFOUND", "getaddrinfo ENOTFOUND control.example");
const untrusted = () =>
  bunError("UNKNOWN_CERTIFICATE_VERIFICATION_ERROR", "unknown certificate verification error");
const timeout = () => new DOMException("The operation timed out.", "TimeoutError");

const wait = (error: unknown, knownAddress = false) => classify(error, knownAddress).retry;

describe("which failures are waited out", () => {
  test("a refused or reset connection, a timeout and an unreachable host are retried", () => {
    expect(wait(refused())).toBe(true);
    expect(wait(reset())).toBe(true);
    expect(wait(timeout())).toBe(true);
    expect(wait(bunError("EHOSTUNREACH", "connect EHOSTUNREACH 10.0.0.1:443"))).toBe(true);
    expect(wait(bunError("ENETUNREACH", "connect ENETUNREACH"))).toBe(true);
  });

  test("502, 503 and 504 are retried: the server is there but not serving", () => {
    for (const status of [502, 503, 504])
      expect(wait(new HttpError(status, `POST /x failed: ${status}`))).toBe(true);
  });

  test("any other answer is reported at once: a wrong address or a refusal", () => {
    for (const status of [400, 401, 403, 404, 405, 500]) {
      expect(wait(new HttpError(status, `POST /x failed: ${status}`), true)).toBe(false);
    }
  });

  test("an expired request and a netmap that does not verify are not connection problems", () => {
    expect(wait(new Error("enrolment request expired — run `wave up` again"), true)).toBe(false);
    expect(
      wait(new Error("control server presented a different netmap signing key than the one pinned"), true),
    ).toBe(false);
    expect(wait(new Error("netmap signature does not verify"), true)).toBe(false);
  });

  test("a missing name is retried only where the address is known to be good", () => {
    // A person just typed it: most likely a typo, and the hosts explain that.
    expect(wait(missing(), false)).toBe(false);
    // Daemon start, `wave up`: the address worked before, so this is the network.
    expect(wait(missing(), true)).toBe(true);
  });

  test("a certificate error is never retried, known address or not", () => {
    expect(wait(untrusted(), false)).toBe(false);
    expect(wait(untrusted(), true)).toBe(false);
    expect(wait(new Error("x509: certificate signed by unknown authority"), true)).toBe(false);
  });

  test("a cancelled request is not a failure to wait out", () => {
    expect(wait(new DOMException("The operation was aborted.", "AbortError"), true)).toBe(false);
  });
});

describe("retrying", () => {
  const fast = { minBackoffMs: 5, maxBackoffMs: 20, knownAddress: false };

  test("keeps going until the attempt gets through, and says when it is back", async () => {
    let tries = 0;
    const waits: number[] = [];
    let recovered = 0;
    const result = await retrying(
      async () => {
        if (++tries < 4) throw refused();
        return "in";
      },
      { ...fast, onWait: (w) => waits.push(w.delayMs), onRecovered: () => recovered++ },
    );
    expect(result).toBe("in");
    expect(tries).toBe(4);
    expect(waits.length).toBe(3);
    expect(recovered).toBe(1);
  });

  test("doubles from the minimum and stops doubling at the maximum", async () => {
    let tries = 0;
    const waits: number[] = [];
    await retrying(
      async () => {
        if (++tries <= 5) throw refused();
      },
      { ...fast, onWait: (w) => waits.push(w.delayMs) },
    );
    expect(waits).toEqual([5, 10, 20, 20, 20]);
  });

  test("the bounds are the control socket's: 500 ms to 30 s", () => {
    expect(MIN_BACKOFF_MS).toBe(500);
    expect(MAX_BACKOFF_MS).toBe(30_000);
  });

  test("a failure that is not a connection problem ends it at the first try", async () => {
    let tries = 0;
    await expect(
      retrying(
        async () => {
          tries++;
          throw new HttpError(401, "POST /v1/machine/register failed: 401");
        },
        { ...fast, knownAddress: true },
      ),
    ).rejects.toThrow("401");
    expect(tries).toBe(1);
  });

  test("the signal ends the wait at once, with an AbortError and no timer left", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = retrying(
      async () => {
        throw refused();
      },
      // A wait of a minute: only the abort can end this in time.
      { knownAddress: false, minBackoffMs: 60_000, maxBackoffMs: 60_000, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 30);
    const error = await pending.catch((e) => e);
    expect(isAbort(error)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("the deadline is not moved by retrying: past it, the next failure throws its error", async () => {
    const expired = new Error("timed out waiting for approval");
    let tries = 0;
    const started = Date.now();
    await expect(
      retrying(
        async () => {
          tries++;
          throw refused();
        },
        { ...fast, deadline: { at: started + 100, error: expired } },
      ),
    ).rejects.toBe(expired);
    expect(tries).toBeGreaterThan(1);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("sleep", () => {
  test("is over at once when the signal has already fired", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleep(60_000, controller.signal)).rejects.toThrow();
  });
});
