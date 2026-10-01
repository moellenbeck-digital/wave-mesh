/**
 * Where a browser is sent back to after a detour through the login, the wave
 * form or the device approval.
 *
 * Only relative paths, so a crafted link cannot bounce the user off-site --
 * `//evil.example` is a protocol-relative URL and would leave the server
 * without ever looking like it. One copy, because three routes carry a `next`
 * through and a check that drifts in one of them is a redirect to anywhere.
 */
export const safeNext = (value: string | undefined): string | undefined =>
  value?.startsWith("/") && !value.startsWith("//") ? value : undefined;
