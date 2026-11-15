import { describe, expect, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import { isValidElement } from "react";
import { SignupLink, SignupPanel } from "@/components/signup-panel";
import { parseAuthOptions, signupProviders } from "@/lib/auth-options";

/**
 * The sign-up page and the link to it (ticket #147). Whether the page exists is
 * the control server's answer (`signup` of `/api/auth/providers`); the page
 * itself calls `notFound()` on `false`, so what is tested here is the reading of
 * that answer -- a missing field is off -- and, for the on state, what the page
 * and the login link say, in both languages.
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

const hrefs = (tree: ReactNode) =>
  elements(tree)
    .filter((e) => e.type === "a")
    .map((e) => (e.props as { href: string }).href);

describe("reading /api/auth/providers", () => {
  test("an older server without the field is off", () => {
    const options = parseAuthOptions({ providers: ["oidc"], labels: { oidc: "Pocket ID" } });
    expect(options.signup).toBe(false);
    expect(options.freePlan).toBeUndefined();
    expect(options.providers).toEqual([{ id: "oidc", label: "Pocket ID" }]);
  });

  test("only a real true is on; strings and numbers are not", () => {
    for (const value of ["true", 1, "1", null, undefined, {}]) {
      expect(parseAuthOptions({ providers: [], signup: value }).signup).toBe(false);
    }
    expect(parseAuthOptions({ providers: [], signup: true }).signup).toBe(true);
  });

  test("off: no plan is read even if one is sent", () => {
    const options = parseAuthOptions({
      providers: [],
      signup: false,
      freePlan: { waves: 3, people: 3, devices: 100 },
    });
    expect(options.freePlan).toBeUndefined();
  });

  test("on: the plan is the server's numbers; an incomplete one is dropped", () => {
    expect(
      parseAuthOptions({ providers: [], signup: true, freePlan: { waves: 5, people: 3, devices: 40 } })
        .freePlan,
    ).toEqual({ waves: 5, people: 3, devices: 40 });
    expect(
      parseAuthOptions({ providers: [], signup: true, freePlan: { waves: 5, people: 3 } }).freePlan,
    ).toBeUndefined();
  });

  test("the development login is not offered for registration", () => {
    const providers = [
      { id: "dev", label: null },
      { id: "oidc", label: "Pocket ID" },
    ];
    expect(signupProviders(providers).map((p) => p.id)).toEqual(["oidc"]);
  });
});

describe("the sign-up page", () => {
  const options = parseAuthOptions({
    providers: ["dev", "google", "oidc"],
    labels: { oidc: "Pocket ID" },
    signup: true,
    freePlan: { waves: 3, people: 3, devices: 100 },
  });

  test("English: the free plan, the first login, the confirmed address", () => {
    const body = text(SignupPanel({ options, locale: "en" }));
    expect(body).toContain("Start for free");
    expect(body).toContain("3 waves, 3 people and 100 devices");
    expect(body).toContain("first login creates the account");
    expect(body).toContain("email_verified");
  });

  test("the numbers are the server's, not wired in", () => {
    const other = { ...options, freePlan: { waves: 7, people: 3, devices: 12 } };
    expect(text(SignupPanel({ options: other, locale: "en" }))).toContain("7 waves, 3 people and 12 devices");
  });

  test("German: the same content", () => {
    const body = text(SignupPanel({ options, locale: "de" }));
    expect(body).toContain("Gratis starten");
    expect(body).toContain("3 Waves, 3 Personen und 100 Geräte");
    expect(body).toContain("Der erste Login legt das Konto an");
    expect(body).toContain("email_verified");
  });

  test("one button per provider into the login flow with next=/waves/new, none for dev", () => {
    const tree = SignupPanel({ options, locale: "en" });
    const links = hrefs(tree).filter((h) => h.startsWith("/auth/"));
    expect(links).toEqual(["/auth/google/start?next=%2Fwaves%2Fnew", "/auth/oidc/start?next=%2Fwaves%2Fnew"]);
    const body = text(tree);
    expect(body).toContain("Sign up with Google");
    expect(body).toContain("Sign up with Pocket ID");
  });

  test("no password form: the page creates no password account", () => {
    const tree = SignupPanel({ options, locale: "en" });
    expect(elements(tree).some((e) => e.type === "form" || e.type === "input")).toBe(false);
  });

  test("without a provider it says so", () => {
    const none = { ...options, providers: [] };
    const body = text(SignupPanel({ options: none, locale: "en" }));
    expect(body).toContain("No sign-in provider is configured");
  });
});

describe("the link on the login page", () => {
  test("on: Create account / Konto erstellen, pointing to /signup", () => {
    const en = SignupLink({ signup: true, locale: "en" });
    expect(text(en)).toBe("Create account");
    expect(hrefs(en)).toEqual(["/signup"]);
    expect(text(SignupLink({ signup: true, locale: "de" }))).toBe("Konto erstellen");
  });

  test("off: nothing at all", () => {
    expect(SignupLink({ signup: false, locale: "en" })).toBeNull();
    expect(SignupLink({ signup: false, locale: "de" })).toBeNull();
  });
});
