import { describe, expect, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import { isValidElement } from "react";
import { SignupLink, SignupNotice, SignupPanel } from "@/components/signup-panel";
import { parseAuthOptions, signupProviders } from "@/lib/auth-options";

/**
 * The sign-up page and the link to it (tickets #147, #150). Whether the page exists is
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

  test("the form needs the page: passwordSignup counts only with signup on, and only a real true", () => {
    expect(parseAuthOptions({ providers: [], signup: true }).passwordSignup).toBe(false);
    expect(parseAuthOptions({ providers: [], signup: true, passwordSignup: true }).passwordSignup).toBe(true);
    expect(parseAuthOptions({ providers: [], signup: false, passwordSignup: true }).passwordSignup).toBe(
      false,
    );
    for (const value of ["true", 1, null, {}]) {
      expect(parseAuthOptions({ providers: [], signup: true, passwordSignup: value }).passwordSignup).toBe(
        false,
      );
    }
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
    expect(body).toContain("first sign-in creates the account");
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

  test("without a mail server there is no form, as before", () => {
    const tree = SignupPanel({ options, locale: "en" });
    expect(elements(tree).some((e) => e.type === "form" || e.type === "input")).toBe(false);
  });

  test("without a mail server and without a provider it says nobody can sign up yet", () => {
    const none = { ...options, providers: [] };
    expect(text(SignupPanel({ options: none, locale: "en" }))).toContain("Nobody can sign up here yet");
  });

  describe("with the form", () => {
    const withForm = { ...options, passwordSignup: true };

    const props = (tree: ReactNode, type: string) =>
      elements(tree)
        .filter((e) => e.type === type)
        .map((e) => e.props as Record<string, unknown>);

    test("email and password, posted to /auth/signup, with stable selectors", () => {
      const tree = SignupPanel({ options: withForm, locale: "en" });
      const [form] = props(tree, "form");
      expect(form).toMatchObject({ method: "post", action: "/auth/signup", "data-signup": "form" });
      const inputs = props(tree, "input");
      expect(inputs.map((i) => i.name)).toEqual(["email", "password"]);
      expect(inputs[0]).toMatchObject({ type: "email", required: true, "data-field": "email" });
      expect(inputs[1]).toMatchObject({
        type: "password",
        required: true,
        minLength: 12,
        autoComplete: "new-password",
        "data-field": "password",
      });
      const [button] = props(tree, "button");
      expect(button).toMatchObject({ type: "submit", "data-action": "signup-submit" });
    });

    test("next to the provider buttons, which stay", () => {
      const tree = SignupPanel({ options: withForm, locale: "en" });
      expect(hrefs(tree).filter((h) => h.startsWith("/auth/"))).toEqual([
        "/auth/google/start?next=%2Fwaves%2Fnew",
        "/auth/oidc/start?next=%2Fwaves%2Fnew",
      ]);
      expect(text(tree)).toContain("At least 12 characters");
    });

    test("without a provider only the form is there, and no hint that nothing is", () => {
      const tree = SignupPanel({ options: { ...withForm, providers: [] }, locale: "en" });
      expect(props(tree, "form")).toHaveLength(1);
      expect(text(tree)).not.toContain("Nobody can sign up");
      expect(props(tree, "p").some((p) => p["data-signup"] === "no-provider")).toBe(false);
    });

    test("the old notes (no password field, the hint for no provider) are gone", () => {
      const body = text(SignupPanel({ options: withForm, locale: "en" }));
      expect(body).not.toContain("No sign-in provider is configured");
      expect(body).not.toContain("Sign up with one of the providers below");
    });

    test("German: the same form", () => {
      const body = text(SignupPanel({ options: withForm, locale: "de" }));
      expect(body).toContain("Mindestens 12 Zeichen");
      expect(body).toContain("Konto erstellen");
    });

    test("a code that control redirected back with shows its sentence; an unknown one nothing", () => {
      const shown = SignupPanel({ options: withForm, locale: "en", error: "password-too-short" });
      expect(text(shown)).toContain("That password is too short.");
      expect(props(shown, "p").some((p) => p["data-error"] === "password-too-short")).toBe(true);
      expect(text(SignupPanel({ options: withForm, locale: "de", error: "throttled" }))).toContain(
        "Zu viele Versuche",
      );
      const unknown = SignupPanel({ options: withForm, locale: "en", error: "<script>" });
      expect(props(unknown, "p").some((p) => p["data-signup"] === "error")).toBe(false);
    });
  });
});

describe("the pages after the form", () => {
  const forms = (tree: ReactNode) =>
    elements(tree)
      .filter((e) => e.type === "form" || e.type === "input")
      .map((e) => e.props as Record<string, unknown>);

  test("sent: the mail is on its way, the same words for every address", () => {
    expect(text(SignupNotice({ kind: "sent", locale: "en" }))).toContain("The mail is on its way");
    expect(text(SignupNotice({ kind: "sent", locale: "de" }))).toContain("Die Mail ist unterwegs");
  });

  test("confirm: a button that posts the token, not a link that spends it", () => {
    const tree = SignupNotice({ kind: "confirm", locale: "en", token: "abc_DEF-123" });
    const [form, token] = forms(tree);
    expect(form).toMatchObject({ method: "post", action: "/auth/signup/confirm" });
    expect(token).toMatchObject({ type: "hidden", name: "token", value: "abc_DEF-123" });
    expect(
      elements(tree)
        .filter((e) => e.type === "button")
        .map((e) => (e.props as Record<string, unknown>)["data-action"]),
    ).toEqual(["signup-confirm"]);
    expect(hrefs(tree)).toEqual([]);
  });

  test("confirm without a token has no button", () => {
    expect(forms(SignupNotice({ kind: "confirm", locale: "en" }))).toEqual([]);
  });

  test("done: signed up, on to the login with next=/waves/new", () => {
    const tree = SignupNotice({ kind: "done", locale: "en" });
    expect(text(tree)).toContain("Address confirmed");
    expect(hrefs(tree)).toEqual(["/login?next=%2Fwaves%2Fnew"]);
  });

  test("gone: used, expired or not the person's any more", () => {
    const tree = SignupNotice({ kind: "gone", locale: "en" });
    expect(text(tree)).toContain("This link no longer works");
    expect(hrefs(tree)).toEqual(["/login", "/signup"]);
    expect(text(SignupNotice({ kind: "gone", locale: "de" }))).toContain("Dieser Link gilt nicht mehr");
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
