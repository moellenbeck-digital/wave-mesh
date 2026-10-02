import type { Locale } from "@wave/i18n";
import { AclPolicy } from "@wave/proto";
import type { AclNode, AclService } from "./evaluate.ts";
import { aclMessages } from "./messages.ts";

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

/**
 * Judges a policy document against the wave it is for. `locale` only changes
 * the words of the errors and warnings, never which there are: English by
 * default, which is what the shell and every existing caller read.
 */
export function checkPolicy(
  raw: unknown,
  subjects: { nodes: AclNode[]; services: AclService[] },
  locale: Locale = "en",
): PolicyCheck {
  const m = aclMessages(locale);
  const parsed = AclPolicy.safeParse(raw);
  if (!parsed.success) {
    return {
      policy: null,
      errors: parsed.error.issues.map((issue) => `${issue.path.join(".") || m.document}: ${issue.message}`),
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
      if (selector.startsWith("svc:")) errors.push(m.serviceAsSource(where, selector));
    }
    for (const selector of [...rule.src, ...rule.dst]) {
      if (selector.startsWith("group:") && !(selector in groups)) {
        errors.push(m.undefinedGroup(where, selector));
      }
      if (selector.startsWith("user:") && !emails.has(selector.slice(5).toLowerCase())) {
        warnings.add(m.userWithoutDevice(selector));
      }
      if (selector.startsWith("tag:") && !tags.has(selector)) warnings.add(m.unwornTag(selector));
      if (selector.startsWith("svc:") && !services.has(selector.slice(4))) {
        warnings.add(m.unknownService(selector.slice(4)));
      }
    }
  });

  return { policy: errors.length === 0 ? policy : null, errors, warnings: [...warnings] };
}
