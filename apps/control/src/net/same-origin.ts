import type { Context } from "hono";

/**
 * Whether a form post came from this server's own pages. Browsers send
 * `Sec-Fetch-Site` and, on a POST, `Origin`; a request with neither is not a
 * browser carrying someone's cookies, and is let through.
 */
export function sameOrigin(c: Context, baseUrl: string): boolean {
  const site = c.req.header("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = c.req.header("origin");
  if (origin && origin !== "null" && origin !== new URL(baseUrl).origin) return false;
  if (origin === "null") return false;
  return true;
}
