/** The cookie that remembers which wave the start page shows, next to `wave_lang`. */
export const WAVE_COOKIE = "wave_current";

/** The query parameter that names the wave to show: `/?wave=<id>`. */
export const WAVE_PARAM = "wave";

/**
 * Which wave the start page shows.
 *
 * The link wins, so a reload or a shared URL lands on the same card; then the
 * cookie, which is what makes `/` itself remember the last choice; then the
 * first wave. Either value may name a wave that is gone -- deleted, left --
 * and then counts as not given. Undefined only when there is no wave at all.
 */
export function pickWave<T extends { id: string }>(
  waves: readonly T[],
  param: string | undefined,
  cookie: string | undefined,
): T | undefined {
  for (const id of [param, cookie]) {
    const found = id ? waves.find((wave) => wave.id === id) : undefined;
    if (found) return found;
  }
  return waves[0];
}
