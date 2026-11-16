import { describe, expect, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import { isValidElement } from "react";
import { ForgotLink, ForgotPanel, ResetNotice } from "@/components/password-reset-panel";
import { parseAuthOptions } from "@/lib/auth-options";

/**
 * The pages of "forgot password" (ticket #159). Whether they exist is the
 * control server's answer (`passwordReset` of `/api/auth/providers`); the pages
 * call `notFound()` on `false`, so what is tested here is the reading of that
 * answer -- a missing field is off -- and what each page says and posts, in
 * both languages.
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

const props = (e: ReactElement) => e.props as Record<string, unknown>;
const hrefs = (tree: ReactNode) =>
  elements(tree)
    .filter((e) => e.type === "a")
    .map((e) => props(e).href);
const fields = (tree: ReactNode) =>
  elements(tree)
    .filter((e) => e.type === "form" || e.type === "input")
    .map(props);

describe("reading /api/auth/providers", () => {
  test("a missing field is off, and only a real true counts", () => {
    expect(parseAuthOptions({ providers: [] }).passwordReset).toBe(false);
    for (const value of ["true", 1, null, {}]) {
      expect(parseAuthOptions({ providers: [], passwordReset: value }).passwordReset).toBe(false);
    }
    expect(parseAuthOptions({ providers: [], passwordReset: true }).passwordReset).toBe(true);
  });

  test("independent of the sign-up switch", () => {
    expect(parseAuthOptions({ providers: [], signup: false, passwordReset: true }).passwordReset).toBe(true);
  });
});

describe("the link on the login page", () => {
  test("on: points to /password/forgot, in both languages", () => {
    const en = ForgotLink({ passwordReset: true, locale: "en" });
    expect(text(en)).toBe("Forgot password");
    expect(hrefs(en)).toEqual(["/password/forgot"]);
    expect(text(ForgotLink({ passwordReset: true, locale: "de" }))).toBe("Passwort vergessen");
  });

  test("off: nothing at all", () => {
    expect(ForgotLink({ passwordReset: false, locale: "en" })).toBeNull();
    expect(ForgotLink({ passwordReset: false, locale: "de" })).toBeNull();
  });
});

describe("the form for the address", () => {
  test("posts an address to control, with stable selectors", () => {
    const tree = ForgotPanel({ locale: "en" });
    const [form, email] = fields(tree);
    expect(form).toMatchObject({ method: "post", action: "/auth/password/forgot" });
    expect(email).toMatchObject({ name: "email", type: "email", "data-field": "email" });
    expect(
      elements(tree)
        .filter((e) => e.type === "button")
        .map((e) => props(e)["data-action"]),
    ).toEqual(["reset-request"]);
    expect(hrefs(tree)).toEqual(["/login"]);
  });

  test("an error code shows its words; one it does not know shows nothing", () => {
    expect(text(ForgotPanel({ locale: "en", error: "throttled" }))).toContain("Too many attempts");
    expect(text(ForgotPanel({ locale: "de", error: "invalid-email" }))).toContain("E-Mail-Adresse");
    expect(
      elements(ForgotPanel({ locale: "en", error: "bogus" })).some((e) => props(e).role === "alert"),
    ).toBe(false);
  });
});

describe("what follows", () => {
  test("sent: the same words for every address, and the 1 hour", () => {
    expect(text(ResetNotice({ kind: "sent", locale: "en" }))).toContain(
      "If there is an account for this address",
    );
    expect(text(ResetNotice({ kind: "sent", locale: "de" }))).toContain("Falls es ein Konto");
    expect(text(ResetNotice({ kind: "sent", locale: "de" }))).toContain("Die Mail ist unterwegs");
  });

  test("form: the token rides along hidden, the password has the minimum length", () => {
    const tree = ResetNotice({ kind: "form", locale: "en", token: "abc_DEF-123" });
    const [form, token, password] = fields(tree);
    expect(form).toMatchObject({ method: "post", action: "/auth/password/reset" });
    expect(token).toMatchObject({ type: "hidden", name: "token", value: "abc_DEF-123" });
    expect(password).toMatchObject({
      type: "password",
      name: "password",
      minLength: 12,
      autoComplete: "new-password",
    });
    expect(text(tree)).toContain("Choose a new password");
  });

  test("form with a refusal shows it and keeps the token", () => {
    const tree = ResetNotice({ kind: "form", locale: "en", token: "t", error: "password-too-short" });
    expect(text(tree)).toContain("too short");
    expect(fields(tree)[1]).toMatchObject({ name: "token", value: "t" });
  });

  test("form without a token is the dead-link page", () => {
    const tree = ResetNotice({ kind: "form", locale: "en" });
    expect(text(tree)).toContain("This link no longer works");
    expect(fields(tree)).toEqual([]);
  });

  test("gone: links to ask again and to sign in, in both languages", () => {
    const tree = ResetNotice({ kind: "gone", locale: "en" });
    expect(text(tree)).toContain("This link no longer works");
    expect(hrefs(tree)).toEqual(["/password/forgot", "/login"]);
    expect(text(ResetNotice({ kind: "gone", locale: "de" }))).toContain("Dieser Link gilt nicht mehr");
  });
});

describe("the reset page", () => {
  // The page's source is read, not imported: importing it would pull in `@/lib/control`, which other
  // test files replace for the whole process with stand-ins that lack the page's exports.
  test("keeps the token from other sites, but not from its own form post", async () => {
    const source = await Bun.file(new URL("../src/app/password/reset/page.tsx", import.meta.url)).text();
    // `no-referrer` would make the browser post the form with `Origin: null`, and control refuses that.
    expect(source).toMatch(/export const metadata: Metadata = \{ referrer: "same-origin" \};/);
    expect(source).not.toContain('"no-referrer"');
  });
});
