import { type Locale, requestLocale } from "@wave/i18n";
import { headers } from "next/headers";
import { cache } from "react";

/**
 * The language of this request, decided by the one rule in `@wave/i18n`: the
 * switcher's cookie, then the browser's `Accept-Language`, then English. The
 * control server reads the same cookie with the same rule for its own pages,
 * so a person never sees one language here and another one hop further.
 *
 * Server only, like `@/lib/control`: it reads the request's headers. Client
 * components get the locale from `LocaleProvider`, seeded with this value in
 * the root layout -- which is also what keeps the server's and the browser's
 * rendering of a date the same, instead of the browser asking `navigator`.
 *
 * Cached per request because the layout, the page and its metadata all ask.
 */
export const getLocale = cache(async (): Promise<Locale> => {
  const head = await headers();
  return requestLocale({ cookie: head.get("cookie"), acceptLanguage: head.get("accept-language") });
});
