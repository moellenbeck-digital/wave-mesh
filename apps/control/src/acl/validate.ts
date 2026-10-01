import { AclPolicy } from "@wave/proto";
import type { AclNode, AclService } from "./evaluate.ts";

export interface PolicyCheck {
  policy: AclPolicy | null;
  /** Reasons to refuse the document. */
  errors: string[];
  /**
   * Things that are allowed but probably not meant: a tag no device wears, a
   * member with no device yet. Said, not refused -- a policy is often written
   * before the device it is for is enrolled.
   */
  warnings: string[];
}

export function checkPolicy(
  raw: unknown,
  subjects: { nodes: AclNode[]; services: AclService[] },
): PolicyCheck {
  const parsed = AclPolicy.safeParse(raw);
  if (!parsed.success) {
    return {
      policy: null,
      errors: parsed.error.issues.map((issue) => `${issue.path.join(".") || "document"}: ${issue.message}`),
      warnings: [],
    };
  }

  const policy = parsed.data;
  const errors: string[] = [];
  const warnings = new Set<string>();
  const groups = policy.groups ?? {};
  const emails = new Set(
    subjects.nodes.filter((node) => node.tags.length === 0).map((n) => n.email?.toLowerCase()),
  );
  const tags = new Set(subjects.nodes.flatMap((node) => node.tags));
  const services = new Set(subjects.services.map((service) => service.name));

  policy.acls.forEach((rule, index) => {
    const where = `acls.${index}`;
    for (const selector of rule.src) {
      // A service has no keys and sends nothing of its own; what comes out of
      // a cluster comes from its connector, and that is `tag:`.
      if (selector.startsWith("svc:"))
        errors.push(`${where}.src: ${selector} is a service, which is never a source`);
    }
    for (const selector of [...rule.src, ...rule.dst]) {
      if (selector.startsWith("group:") && !(selector in groups)) {
        errors.push(`${where}: ${selector} is not defined under groups`);
      }
      if (selector.startsWith("user:") && !emails.has(selector.slice(5).toLowerCase())) {
        warnings.add(`${selector} has no untagged device in this wave (yet)`);
      }
      if (selector.startsWith("tag:") && !tags.has(selector))
        warnings.add(`no device wears ${selector} (yet)`);
      if (selector.startsWith("svc:") && !services.has(selector.slice(4))) {
        warnings.add(`no service called ${selector.slice(4)} (yet)`);
      }
    }
  });

  return { policy: errors.length === 0 ? policy : null, errors, warnings: [...warnings] };
}
