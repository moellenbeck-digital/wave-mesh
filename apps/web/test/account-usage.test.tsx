import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import { isValidElement } from "react";
import type { AccountPlanView } from "@/lib/control";

/**
 * The plan block of the account page (ticket #117): plan, usage against the
 * limits, and the overhang with its per-wave list. The component is an async
 * server component, so it is called and its element tree read.
 */

let locale: "en" | "de";
mock.module("@/lib/i18n", () => ({ getLocale: async () => locale }));
const { AccountUsage } = await import("@/components/account-usage");

function elements(node: ReactNode, found: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) for (const child of node) elements(child, found);
  else if (isValidElement(node)) {
    found.push(node);
    elements((node.props as { children?: ReactNode }).children, found);
  }
  return found;
}

/** All the text of a tree, flattened. */
function text(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (isValidElement(node)) return text((node.props as { children?: ReactNode }).children);
  return "";
}

const attr = (tree: ReactNode, name: string): ReactElement[] =>
  elements(tree).filter((e) => (e.props as Record<string, unknown>)[name] !== undefined);

const free = (over: Partial<AccountPlanView> = {}): AccountPlanView => ({
  accountId: "ca_1",
  plan: "free",
  limits: { waves: 3, people: 3, devices: 100 },
  usage: { waves: 2, people: 1, devices: 5 },
  overhang: { waves: 0, people: 0, devices: 0, perWave: [] },
  ...over,
});

beforeEach(() => {
  locale = "en";
});

describe("the plan block", () => {
  test("a free account: plan, and each usage against its limit", async () => {
    const tree = await AccountUsage({ plan: free() });
    const section = attr(tree, "data-plan")[0];
    const props = (section?.props ?? {}) as Record<string, unknown>;
    expect(props["data-plan"]).toBe("free");
    const usage = attr(tree, "data-usage").map((e) => text(e));
    expect(usage[0]).toContain("Waves");
    expect(usage[0]).toContain("2");
    expect(usage[0]).toContain("of 3");
    expect(usage[1]).toContain("of 3");
    expect(usage[2]).toContain("of 100");
    expect(text(tree)).toContain("Free");
    expect(attr(tree, "data-overhang")).toHaveLength(0);
  });

  test("a paid account shows no limit on waves and devices, in German too", async () => {
    const paid = free({
      plan: "paid",
      limits: { waves: null, people: 10, devices: null },
      usage: { waves: 7, people: 4, devices: 300 },
    });
    expect(text(await AccountUsage({ plan: paid }))).toContain("no limit");
    locale = "de";
    const de = text(await AccountUsage({ plan: paid }));
    expect(de).toContain("Bezahlt");
    expect(de).toContain("keine Grenze");
    expect(de).toContain("von 10");
    expect(de).not.toContain("no limit");
  });

  test("an overhang names the numbers and, per wave, the people by address and the devices by name", async () => {
    const view = free({
      usage: { waves: 4, people: 5, devices: 101 },
      overhang: {
        waves: 1,
        people: 2,
        devices: 1,
        perWave: [
          {
            waveId: "w1",
            waveName: "alpha",
            people: [
              { email: "anna@acme.example", kind: "member" },
              { email: "wait@acme.example", kind: "invitation" },
            ],
            devices: [{ name: "laptop" }],
          },
          { waveId: "w2", waveName: "beta", people: [], devices: [] },
        ],
      },
    });
    const tree = await AccountUsage({ plan: view });
    expect(attr(tree, "data-overhang")).toHaveLength(1);
    expect(attr(tree, "data-over").map((e) => text(e))).toEqual([
      "1 wave too many",
      "2 people too many",
      "1 device too many",
    ]);
    const alpha = attr(tree, "data-over-wave").find(
      (e) => (e.props as { "data-over-wave": string })["data-over-wave"] === "alpha",
    );
    expect(text(alpha)).toContain("anna@acme.example");
    expect(text(alpha)).toContain("wait@acme.example");
    expect(text(alpha)).toContain("(invited)");
    expect(text(alpha)).toContain("laptop");
    expect(text(tree)).toContain("Nothing is removed");

    locale = "de";
    const de = await AccountUsage({ plan: view });
    expect(attr(de, "data-over").map((e) => text(e))).toEqual([
      "1 Wave zu viel",
      "2 Personen zu viel",
      "1 Gerät zu viel",
    ]);
    expect(text(de)).toContain("Es wird nichts entfernt");
  });

  test("each tile reads 'used of allowed', and the free note names the same numbers as the API", async () => {
    const tree = await AccountUsage({ plan: free({ usage: { waves: 3, people: 2, devices: 41 } }) });
    const usage = attr(tree, "data-usage").map((e) => text(e));
    expect(usage[0]).toBe("Waves3 of 3 used");
    expect(usage[1]).toBe("People2 of 3 used");
    expect(usage[2]).toBe("Devices41 of 100 used");
    const all = text(tree);
    expect(all).toContain("Free means 3 waves, 3 people and 100 devices across all waves of the account");
    expect(all).toContain("An open invitation reserves a place");
    expect(all).toContain("counts once");
    expect(attr(tree, "data-counting")).toHaveLength(1);

    locale = "de";
    const de = await AccountUsage({ plan: free({ usage: { waves: 3, people: 2, devices: 41 } }) });
    const deUsage = attr(de, "data-usage").map((e) => text(e));
    expect(deUsage[1]).toBe("Personen2 von 3 belegt");
    expect(deUsage[2]).toBe("Geräte41 von 100 belegt");
    expect(text(de)).toContain("Gratis heißt 3 Waves, 3 Personen und 100 Geräte über alle Waves des Kontos");
    expect(text(de)).toContain("zählt einmal");
  });

  test("the numbers are the limits the server sent, not constants of the page", async () => {
    const tree = await AccountUsage({
      plan: free({ limits: { waves: 1, people: 2, devices: 5 }, usage: { waves: 1, people: 1, devices: 0 } }),
    });
    expect(text(tree)).toContain("Free means 1 waves, 2 people and 5 devices");
    expect(attr(tree, "data-usage").map((e) => text(e))[2]).toBe("Devices0 of 5 used");
  });

  test("a paid account has no counting note: its seats are what limits people", async () => {
    const paid = free({
      plan: "paid",
      limits: { waves: null, people: 10, devices: null },
      usage: { waves: 7, people: 4, devices: 300 },
    });
    const tree = await AccountUsage({ plan: paid });
    expect(attr(tree, "data-counting")).toHaveLength(0);
    expect(attr(tree, "data-usage").map((e) => text(e))[0]).toBe("Waves7 used, no limit");
  });

  test("nothing for a server that sends no plan", async () => {
    expect(await AccountUsage({ plan: undefined })).toBeNull();
  });
});
