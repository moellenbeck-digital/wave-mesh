import { describe, expect, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import { isValidElement } from "react";
import { PeopleQuota } from "@/components/people-quota";
import type { Membership } from "@/lib/control";

/**
 * The people line beside the invitation form (ticket #119): how many places the
 * account has left, why, and -- when none is left -- what to do next. The numbers
 * are the control server's; this is only how they are said, in both languages,
 * and that a self-hosted server (no `account`) gets nothing at all.
 */

function elements(node: ReactNode, found: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) for (const child of node) elements(child, found);
  else if (isValidElement(node)) {
    found.push(node);
    elements((node.props as { children?: ReactNode }).children, found);
  }
  return found;
}

function text(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (isValidElement(node)) return text((node.props as { children?: ReactNode }).children);
  return "";
}

const account = (
  people: number,
  over: Partial<NonNullable<Membership["account"]>> = {},
): NonNullable<Membership["account"]> => ({
  plan: "free",
  limits: { waves: 3, people: 3, devices: 100 },
  usage: { waves: 1, people, devices: 0 },
  ...over,
});

const link = (tree: ReactNode) =>
  elements(tree).find((e) => e.type === "a" && (e.props as { href?: string }).href === "/account#plan");

describe("the people line", () => {
  test("a free account with room: used of allowed, the three rules, no next step", () => {
    const tree = PeopleQuota({ account: account(2), locale: "en" });
    const body = text(tree);
    expect(body).toContain("People in your account: 2 of 3 used.");
    expect(body).toContain("A free account holds 3 people across all its waves.");
    expect(body).toContain("The count is the same in every wave of the account.");
    expect(body).toContain("An open invitation reserves a place");
    expect(body).toContain("A person who is in several waves counts once.");
    expect(body).not.toContain("Next step");
    expect(link(tree)).toBeUndefined();
    const props = (tree as ReactElement).props as Record<string, string>;
    expect(props["data-people-quota"]).toBe("free");
    expect(props["data-full"]).toBe("false");
  });

  test("a full account names the next steps and links to /account#plan", () => {
    const tree = PeopleQuota({ account: account(3), locale: "en" });
    const body = text(tree);
    expect(body).toContain("3 of 3 used");
    expect(body).toContain("No place is left.");
    expect(body).toContain("withdraw an invitation");
    expect(body).toContain("subscribe at /account#plan");
    expect(link(tree)).toBeDefined();
    expect(((tree as ReactElement).props as Record<string, string>)["data-full"]).toBe("true");
  });

  test("the same in German, with the same numbers and the same link", () => {
    const tree = PeopleQuota({ account: account(3), locale: "de" });
    const body = text(tree);
    expect(body).toContain("Personen in deinem Konto: 3 von 3 belegt.");
    expect(body).toContain("Ein Gratis-Konto fasst 3 Personen über alle seine Waves.");
    expect(body).toContain("Eine offene Einladung reserviert einen Platz");
    expect(body).toContain("zählt einmal");
    expect(body).toContain("Es ist kein Platz mehr frei.");
    expect(body).toContain("Zieh in der Liste oben eine Einladung zurück");
    expect(link(tree)).toBeDefined();
  });

  test("a subscription says what it covers; one without a people limit says nothing", () => {
    const paid = account(2, { plan: "paid", limits: { waves: null, people: 10, devices: null } });
    expect(text(PeopleQuota({ account: paid, locale: "en" }))).toContain(
      "2 of 10 used. Your subscription covers 10 people",
    );
    const open = account(2, { plan: "paid", limits: { waves: null, people: null, devices: null } });
    expect(PeopleQuota({ account: open, locale: "en" })).toBeNull();
  });

  test("a self-hosted server sends no account: no hint, in either language", () => {
    expect(PeopleQuota({ account: undefined, locale: "en" })).toBeNull();
    expect(PeopleQuota({ account: undefined, locale: "de" })).toBeNull();
  });
});
