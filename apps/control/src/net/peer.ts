import type { Context } from "hono";
import { getConnInfo } from "hono/bun";

/**
 * The address the request came from, taken from the socket.
 *
 * Never from a forwarded-for header: that is attacker-controlled unless a
 * trusted proxy sets it. Returns undefined when there is no socket behind the
 * context, which is the case in tests that call the app directly.
 */
export function peerAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}
