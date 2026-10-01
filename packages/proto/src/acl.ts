import { z } from "zod";

/**
 * Who may reach whom in a wave (M7).
 *
 * Without a policy every device reaches every other one -- the full mesh of D9,
 * and still the default. With one, nothing is allowed that no rule allows.
 *
 * A rule names sources, destinations and ports:
 *
 *   { "src": ["user:robin@example.com"], "dst": ["tag:nas"], "ports": ["445"] }
 *
 * Selectors:
 *   *                    every device in the wave (and, as a destination, every service)
 *   user:<email>         the devices of that member
 *   group:<name>         the devices of the members listed under `groups`
 *   role:owner|admin|member   the devices of the members with that role
 *   tag:<name>           the devices an operator tagged so
 *   svc:<name>           a service (D11); a destination only
 *
 * A tagged device is its tags and nothing else: it does not count as its
 * owner's. A connector enrolled with the owner's pre-auth key is a machine in a
 * cluster, not one of the owner's laptops, and a rule for the owner's devices
 * that silently included it would hand the cluster everything the owner may
 * reach. `*` still covers it.
 */

export const TAG_PATTERN = /^tag:[a-z0-9][a-z0-9-]{0,62}$/;
const GROUP_PATTERN = /^group:[a-z0-9][a-z0-9-]{0,62}$/;

export const AclSelector = z
  .string()
  .refine(
    (value) =>
      value === "*" ||
      /^user:\S+@\S+$/.test(value) ||
      GROUP_PATTERN.test(value) ||
      /^role:(owner|admin|member)$/.test(value) ||
      TAG_PATTERN.test(value) ||
      /^svc:[a-z0-9][a-z0-9-]{0,62}$/.test(value),
    {
      message: "expected *, user:<email>, group:<name>, role:<owner|admin|member>, tag:<name> or svc:<name>",
    },
  );

/**
 * `*`, a port, a range, each optionally limited to one protocol: `22`,
 * `5000-5001`, `tcp:445`, `udp:53`, `tcp:*`. Without a protocol it means both.
 */
export const AclPort = z.string().refine((value) => parsePortSpec(value) !== null, {
  message: "expected *, <port>, <from>-<to>, optionally prefixed with tcp: or udp:",
});

export const AclRule = z.object({
  src: z.array(AclSelector).min(1),
  dst: z.array(AclSelector).min(1),
  /** Left out, the rule allows every port. */
  ports: z.array(AclPort).min(1).optional(),
});

export const AclPolicy = z.object({
  groups: z.record(z.string().regex(GROUP_PATTERN), z.array(z.email())).optional(),
  acls: z.array(AclRule),
});

export type AclRule = z.infer<typeof AclRule>;
export type AclPolicy = z.infer<typeof AclPolicy>;

export interface PortRange {
  proto: "tcp" | "udp" | "any";
  from: number;
  to: number;
}

export function parsePortSpec(spec: string): PortRange | null {
  const match = /^(?:(tcp|udp):)?(\*|\d{1,5}(?:-\d{1,5})?)$/.exec(spec);
  if (!match) return null;
  const proto = (match[1] ?? "any") as PortRange["proto"];
  const body = match[2] ?? "";
  if (body === "*") return { proto, from: 1, to: 65535 };
  const [first, second] = body.split("-");
  const from = Number(first);
  const to = second === undefined ? from : Number(second);
  if (from < 1 || to > 65535 || from > to) return null;
  return { proto, from, to };
}
