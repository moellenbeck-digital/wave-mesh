import { z } from "zod";

const IPV4 = /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const IPV6 = /^(([0-9a-fA-F]{1,4}:){1,7}|:)((:[0-9a-fA-F]{1,4}){1,7}|:)$/;

export const Ipv4 = z.string().regex(IPV4, "not an IPv4 address");
export const Ipv6 = z.string().regex(IPV6, "not an IPv6 address");
export const IpAddress = z.union([Ipv4, Ipv6]);
export const Port = z.number().int().min(1).max(65535);

export const Ipv4Cidr = z.string().regex(new RegExp(`^${IPV4.source.slice(1, -1)}/([0-9]|[12]\\d|3[0-2])$`));
export const Ipv6Cidr = z
  .string()
  .regex(new RegExp(`^${IPV6.source.slice(1, -1)}/(\\d|[1-9]\\d|1[01]\\d|12[0-8])$`));
export const Cidr = z.union([Ipv4Cidr, Ipv6Cidr]);

/** A UDP endpoint as it appears on the wire, e.g. "203.0.113.7:41641". */
export const Endpoint = z.object({ ip: IpAddress, port: Port });
export type Endpoint = z.infer<typeof Endpoint>;

export const formatEndpoint = (e: Endpoint): string =>
  e.ip.includes(":") ? `[${e.ip}]:${e.port}` : `${e.ip}:${e.port}`;

/** Inverse of {@link formatEndpoint}; returns null instead of throwing on junk. */
export function parseEndpoint(s: string): Endpoint | null {
  const m = s.startsWith("[") ? /^\[(.+)\]:(\d+)$/.exec(s) : /^([^:]+):(\d+)$/.exec(s);
  if (!m?.[1] || !m[2]) return null;
  const parsed = Endpoint.safeParse({ ip: m[1], port: Number(m[2]) });
  return parsed.success ? parsed.data : null;
}

/** ISO-8601 timestamp. Everything on the wire is UTC and string-encoded. */
export const Timestamp = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "not an ISO-8601 timestamp");
