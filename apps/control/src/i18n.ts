import { type Locale, requestLocale } from "@wave/i18n";
import type { Context } from "hono";

export type { Locale };

/**
 * The language of the person behind a browser request.
 *
 * The rule itself lives in `@wave/i18n`, because the web app answers under the
 * same origin and reads the same cookie: deciding it here a second time would
 * show one person a German page and an English error from the form on it.
 * Only browser-facing texts go through this. The node API, the control socket
 * and the server's own log stay English -- a client compares those, and an
 * operator greps them.
 */
export function localeOf(c: Context): Locale {
  return requestLocale({
    cookie: c.req.header("cookie"),
    acceptLanguage: c.req.header("accept-language"),
  });
}
