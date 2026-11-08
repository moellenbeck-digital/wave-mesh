"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { WAVE_COOKIE, WAVE_PARAM } from "@/lib/wave-select";

/**
 * The dropdown above the wave card, shown when an account has several waves.
 *
 * The choice lives in the URL and in a cookie. The URL (`/?wave=<id>`) is what
 * survives a reload or a shared link; the cookie is what `/` falls back to
 * the next time it is opened bare. Choosing replaces the URL instead of
 * loading a page: the server components re-render with the new wave while
 * everything else stays, and other query parameters -- `joined` -- are kept.
 *
 * The cookie is also written for the wave that is showing, not only on a
 * choice: a link such as the one the control server redirects to after
 * creating a wave carries the id and no cookie.
 */
export function WaveSelect({
  waves,
  currentId,
  label,
}: {
  waves: { id: string; name: string }[];
  currentId: string;
  label: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();

  useEffect(() => {
    remember(currentId);
  }, [currentId]);

  function choose(id: string) {
    remember(id);
    const query = new URLSearchParams(search.toString());
    query.set(WAVE_PARAM, id);
    router.replace(`${pathname}?${query.toString()}`);
  }

  return (
    <div className="mb-6">
      <label htmlFor="wave-select" className="wc-label">
        {label}
      </label>
      <select
        id="wave-select"
        className="wc-input"
        value={currentId}
        onChange={(event) => choose(event.target.value)}
      >
        {waves.map((wave) => (
          <option key={wave.id} value={wave.id}>
            {wave.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/** One plain cookie, a year, like `wave_lang`. */
function remember(id: string) {
  // biome-ignore lint/suspicious/noDocumentCookie: one plain cookie; the Cookie Store API is still missing from browsers we serve
  document.cookie = `${WAVE_COOKIE}=${encodeURIComponent(id)}; path=/; max-age=31536000; samesite=lax`;
}
