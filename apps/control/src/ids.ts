/** Prefixed, collision-free identifiers. The prefix makes logs readable. */
export const newId = (prefix: string): string => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
