import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import { isValidElement } from "react";
import type { Me } from "@/lib/control";

/**
 * The notice of a split-off account on the pages where it is about to make a
 * wave or add a device. The pages are async server components, so they are
 * called and their element tree read -- no browser, no control server. What is
 * checked is the wiring: which page carries the card, for which account, and
 * that the page around it is the same one.
 */

let me: Me | null;
let locale: "en" | "de";

mock.module("@/lib/control", () => ({
  fetchMe: async () => me,
  fetchDeviceRequest: async () => ({
    request: { id: "req-1", hostname: "laptop", os: "linux" },
    waves: [{ id: "w1", name: "home", dnsSuffix: "home.wave.internal" }],
  }),
}));
mock.module("@/lib/i18n", () => ({ getLocale: async () => locale }));

const { LinkNotice } = await import("@/components/link-notice");
const { default: NewWavePage } = await import("@/app/waves/new/page");
const { default: ChooseWavePage } = await import("@/app/devices/choose/page");

const account = (linkable: boolean): Me["account"] => ({
  linkable,
  identities: [{ provider: "oidc:https://idp.example", label: "Pocket ID" }],
});

const meOf = (over: Partial<Me> = {}): Me => ({
  user: { id: "u1", email: "robin@example.com", emailVerified: false, name: "Robin" },
  account: account(true),
  waves: [],
  invites: [],
  suggestion: { name: "robin", dnsSuffix: "robin.wave.internal" },
  canCreateWave: true,
  ...over,
});

/** Every element of a tree, depth first. Function components are not called. */
function elements(node: ReactNode, found: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) for (const child of node) elements(child, found);
  else if (isValidElement(node)) {
    found.push(node);
    elements((node.props as { children?: ReactNode }).children, found);
  }
  return found;
}

/** Whether the page carries the card and it says something: the component hides itself for other accounts. */
async function hasNotice(tree: ReactNode): Promise<boolean> {
  const cards = elements(tree).filter((e) => e.type === LinkNotice);
  const shown = await Promise.all(cards.map((e) => LinkNotice(e.props as Parameters<typeof LinkNotice>[0])));
  return shown.some((card) => card !== null);
}
const propsOf = <T,>(element: ReactElement | undefined): T => (element?.props ?? {}) as T;
const searchParams = (params: Record<string, string> = {}) => Promise.resolve(params);

beforeEach(() => {
  me = meOf();
  locale = "en";
});

describe("the notice itself", () => {
  const text = (tree: ReactNode): string[] =>
    elements(tree).flatMap((e) => {
      const { children } = e.props as { children?: ReactNode };
      return (Array.isArray(children) ? children : [children]).filter((c) => typeof c === "string");
    }) as string[];

  test("names the active account and the way to /account/link, in English and German", async () => {
    const en = await LinkNotice({ me: meOf() });
    expect(text(en)).toContain("Active account: robin@example.com");
    const link = elements(en).find((e) => e.type === "a");
    expect(propsOf<{ href: string }>(link).href).toBe("/account/link");

    locale = "de";
    const de = await LinkNotice({ me: meOf() });
    expect(text(de)).toContain("Aktives Konto: robin@example.com");
    expect(text(de)).not.toContain("Active account: robin@example.com");
  });

  test("is nothing for an ordinary account and for an older control server", async () => {
    expect(await LinkNotice({ me: meOf({ account: account(false) }) })).toBeNull();
    expect(await LinkNotice({ me: meOf({ account: undefined }) })).toBeNull();
  });
});

describe("/waves/new", () => {
  test("a split-off account sees the notice above the form", async () => {
    const tree = await NewWavePage({ searchParams: searchParams() });
    const all = elements(tree);
    const notice = all.findIndex((e) => e.type === LinkNotice);
    const form = all.findIndex((e) => e.type === "form");
    expect(notice).toBeGreaterThanOrEqual(0);
    expect(form).toBeGreaterThan(notice);
  });

  test("also where waves come only with a subscription", async () => {
    me = meOf({ canCreateWave: false });
    const tree = await NewWavePage({ searchParams: searchParams() });
    expect(await hasNotice(tree)).toBe(true);
    expect(elements(tree).some((e) => e.type === "form")).toBe(false);
  });

  test("and keeps the device link the form carries", async () => {
    const tree = await NewWavePage({
      searchParams: searchParams({ next: "/machine/authorize?request=req-1" }),
    });
    expect(await hasNotice(tree)).toBe(true);
    const hidden = elements(tree).find((e) => (e.props as { name?: string }).name === "next");
    expect(propsOf<{ value: string }>(hidden).value).toBe("/machine/authorize?request=req-1");
  });

  test("an ordinary account gets the page without it", async () => {
    me = meOf({ account: account(false) });
    expect(await hasNotice(await NewWavePage({ searchParams: searchParams() }))).toBe(false);
    me = meOf({ account: account(false), canCreateWave: false });
    expect(await hasNotice(await NewWavePage({ searchParams: searchParams() }))).toBe(false);
  });
});

describe("/devices/choose", () => {
  const choose = () => ChooseWavePage({ searchParams: searchParams({ request: "req-1" }) });

  test("a split-off account sees the notice before the choice, and the form is still there", async () => {
    const all = elements(await choose());
    const notice = all.findIndex((e) => e.type === LinkNotice);
    const form = all.findIndex((e) => e.type === "form");
    expect(notice).toBeGreaterThanOrEqual(0);
    expect(form).toBeGreaterThan(notice);
    expect(propsOf<{ action: string }>(all[form]).action).toBe("/machine/authorize");
  });

  test("an ordinary account gets the page without it", async () => {
    me = meOf({ account: account(false) });
    const tree = await choose();
    expect(await hasNotice(tree)).toBe(false);
    expect(elements(tree).some((e) => e.type === "form")).toBe(true);
  });
});
