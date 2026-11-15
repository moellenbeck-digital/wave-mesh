import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DeleteAccountPanel } from "@/components/delete-account";
import { LocaleProvider } from "@/components/locale-provider";
import { deleteAccountMessages, failureText, nameList } from "@/i18n/delete-account";
import {
  type DeletePreview,
  hasBilling,
  isBlocked,
  mayDelete,
  readFailure,
  readPreview,
} from "@/lib/delete-account";

/**
 * The page "delete account" (ticket #31): how the control server's preview is
 * read, when the form may be sent, and what the page shows in each state, in
 * both languages. The server's own rules are tested in
 * `apps/control/test/account-delete.test.ts`; here the page must only never
 * offer what the server would refuse, and never hide what it does.
 */

const preview = (over: Partial<DeletePreview> = {}): DeletePreview => ({
  confirmation: "email",
  word: null,
  twoFactor: false,
  blockers: [],
  deleted: [],
  handedOver: [],
  left: [],
  devices: 0,
  billed: [],
  accountSubscription: false,
  ...over,
});

const render = (p: DeletePreview, locale: "en" | "de" = "en") =>
  renderToStaticMarkup(
    <LocaleProvider locale={locale}>
      <DeleteAccountPanel preview={p} who="robin@example.com" />
    </LocaleProvider>,
  );

/** The `<button type="submit">` and the inputs, as markup, to read their `disabled`. */
const submitButton = (html: string) => html.match(/<button[^>]*type="submit"[^>]*>/)?.[0] ?? "";
const input = (html: string, id: string) => html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0] ?? "";

describe("reading the preview", () => {
  test("a missing list is empty and a missing confirmation is the address", () => {
    const read = readPreview({});
    expect(read).toEqual(preview());
    expect(readPreview(null)).toEqual(preview());
  });

  test("the word is only there for an account without an address", () => {
    expect(readPreview({ confirmation: "word", word: "DELETE" })).toMatchObject({
      confirmation: "word",
      word: "DELETE",
    });
    expect(readPreview({ confirmation: "email", word: "DELETE" }).word).toBeNull();
    expect(readPreview({ confirmation: "word" }).word).toBe("DELETE");
  });

  test("only a real true switches the second factor or the account subscription on", () => {
    expect(readPreview({ twoFactor: "true", accountSubscription: 1 })).toMatchObject({
      twoFactor: false,
      accountSubscription: false,
    });
    expect(readPreview({ twoFactor: true, accountSubscription: true })).toMatchObject({
      twoFactor: true,
      accountSubscription: true,
    });
  });
});

describe("when the form may be sent", () => {
  test("it needs the confirmation, and a code when there is a second factor", () => {
    expect(mayDelete(preview(), "", "")).toBe(false);
    expect(mayDelete(preview(), "  ", "")).toBe(false);
    expect(mayDelete(preview(), "robin@example.com", "")).toBe(true);
    expect(mayDelete(preview({ twoFactor: true }), "robin@example.com", "")).toBe(false);
    expect(mayDelete(preview({ twoFactor: true }), "robin@example.com", " 123456 ")).toBe(true);
  });

  test("a blocking wave locks it whatever is typed", () => {
    const blocked = preview({ blockers: [{ id: "w1", name: "robin" }], twoFactor: true });
    expect(isBlocked(blocked)).toBe(true);
    expect(mayDelete(blocked, "robin@example.com", "123456")).toBe(false);
  });

  test("a subscription is billing, from a wave or from the account", () => {
    expect(hasBilling(preview())).toBe(false);
    expect(hasBilling(preview({ billed: [{ id: "w", name: "n", outcome: "delete" }] }))).toBe(true);
    expect(hasBilling(preview({ accountSubscription: true }))).toBe(true);
  });
});

describe("the answers of POST /api/me/delete", () => {
  test("each code is its own failure", () => {
    for (const error of [
      "confirmation-mismatch",
      "invalid-code",
      "code-required",
      "throttled",
      "unauthenticated",
    ]) {
      expect(readFailure({ error })).toEqual({ kind: error as "throttled" });
    }
    expect(readFailure({ error: "boom" })).toEqual({ kind: "unknown" });
    expect(readFailure(undefined)).toEqual({ kind: "unknown" });
  });

  test("last-admin carries the names of the waves", () => {
    expect(
      readFailure({
        error: "last-admin",
        waves: [{ id: "1", name: "robin" }, { id: "2", name: "home" }, {}],
      }),
    ).toEqual({
      kind: "last-admin",
      waves: ["robin", "home"],
    });
    expect(readFailure({ error: "last-admin" })).toEqual({ kind: "last-admin", waves: [] });
  });

  test("every failure has its own sentence, in both languages", () => {
    const kinds = [
      { kind: "confirmation-mismatch" },
      { kind: "invalid-code" },
      { kind: "code-required" },
      { kind: "throttled" },
      { kind: "last-admin", waves: ["robin"] },
      { kind: "unauthenticated" },
      { kind: "unknown" },
    ] as const;
    for (const locale of ["en", "de"] as const) {
      const texts = kinds.map((k) => failureText(k, "email", locale));
      expect(new Set(texts).size).toBe(kinds.length);
      expect(texts.every((text) => text.length > 0)).toBe(true);
    }
    expect(failureText({ kind: "last-admin", waves: ["robin"] }, "email", "en")).toContain("“robin”");
  });

  test("a wrong word and a wrong address are told apart", () => {
    const mismatch = { kind: "confirmation-mismatch" } as const;
    expect(failureText(mismatch, "word", "en")).not.toBe(failureText(mismatch, "email", "en"));
    expect(failureText(mismatch, "word", "de")).not.toBe(failureText(mismatch, "email", "de"));
  });

  test("names are listed as a phrase", () => {
    expect(nameList(["a", "b", "c"], "en")).toBe("“a”, “b”, and “c”");
    expect(nameList(["a", "b"], "de")).toBe("“a” und “b”");
  });
});

describe("the page", () => {
  test("a plain account: the address field, no code, a form that is open", () => {
    const html = render(preview({ deleted: [{ id: "w", name: "solo" }], devices: 2 }));
    expect(input(html, "delete-confirm")).toContain('type="email"');
    expect(input(html, "delete-confirm")).not.toContain("disabled");
    expect(html).not.toContain('id="delete-code"');
    expect(html).toContain("Type your email address to confirm");
    expect(html).toContain("solo");
    expect(html).toContain("2 devices of yours are removed.");
    expect(html).not.toContain('data-testid="delete-blocked"');
    expect(html).not.toContain('data-testid="delete-billed"');
    // Nothing typed yet: the button waits.
    expect(submitButton(html)).toContain("disabled");
  });

  test("waves that go, get a new owner or are left are listed apart", () => {
    const html = render(
      preview({
        deleted: [{ id: "1", name: "alone" }],
        handedOver: [{ id: "2", name: "shared" }],
        left: [{ id: "3", name: "guest-of" }],
      }),
    );
    for (const id of ["delete-deleted", "delete-handover", "delete-left"]) {
      expect(html).toContain(`data-testid="${id}"`);
    }
    expect(html).toContain("alone");
    expect(html).toContain("shared");
    expect(html).toContain("guest-of");
  });

  test("an account without an address is asked for the word", () => {
    const html = render(preview({ confirmation: "word", word: "DELETE" }));
    expect(html).toContain("Type DELETE to confirm");
    expect(input(html, "delete-confirm")).toContain('type="text"');
    expect(html).not.toContain("Type your email address");
  });

  test("a second factor adds the code field", () => {
    const html = render(preview({ twoFactor: true }));
    expect(input(html, "delete-code")).toMatch(/autocomplete="one-time-code"/i);
    expect(html).toContain("Code from your app, or a recovery code");
  });

  test("billing is named with the waves and the customer portal, and the account is deleted anyway", () => {
    const html = render(
      preview({
        billed: [{ id: "w", name: "paid-wave", outcome: "handover" }],
        accountSubscription: true,
      }),
    );
    expect(html).toContain('data-testid="delete-billed"');
    expect(html).toContain("Your subscription is not cancelled");
    expect(html).toContain("customer portal");
    expect(html).toContain("deleted either way");
    expect(html).toContain("paid-wave (stays, new owner)");
    expect(html).toContain("subscription of its own");
    // Billing never locks the form.
    expect(input(html, "delete-confirm")).not.toContain("disabled");
  });

  test("a blocking wave is named, locks every field and the button, and hides the consequences", () => {
    const html = render(
      preview({
        twoFactor: true,
        blockers: [{ id: "w", name: "team" }],
        deleted: [{ id: "x", name: "solo" }],
        billed: [{ id: "y", name: "paid", outcome: "delete" }],
      }),
    );
    expect(html).toContain('data-testid="delete-blocked"');
    expect(html).toContain("You cannot delete your account yet");
    expect(html).toContain("team");
    expect(input(html, "delete-confirm")).toContain("disabled");
    expect(input(html, "delete-code")).toContain("disabled");
    expect(submitButton(html)).toContain("disabled");
    // Nothing happens while it blocks, so nothing is listed as if it did.
    expect(html).not.toContain('data-testid="delete-deleted"');
    expect(html).not.toContain('data-testid="delete-billed"');
  });

  test("German, with the same parts", () => {
    const html = render(
      preview({
        confirmation: "word",
        word: "DELETE",
        twoFactor: true,
        billed: [{ id: "w", name: "bezahlt", outcome: "delete" }],
      }),
      "de",
    );
    expect(html).toContain("Gib zur Bestätigung DELETE ein");
    expect(html).toContain("Code aus deiner App oder ein Wiederherstellungscode");
    expect(html).toContain("Dein Abo wird nicht gekündigt");
    expect(html).toContain("Kundenportal");
    expect(html).toContain("bezahlt (wird gelöscht)");
    expect(html).toContain("Mein Konto endgültig löschen");
  });
});

describe("the catalogs", () => {
  test("German and English have the same keys and no empty text", () => {
    const en = deleteAccountMessages("en");
    const de = deleteAccountMessages("de");
    const keys = (o: object, prefix = ""): string[] =>
      Object.entries(o).flatMap(([k, v]) =>
        v && typeof v === "object" ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
      );
    expect(keys(de).sort()).toEqual(keys(en).sort());
    for (const catalog of [en, de]) {
      expect(catalog.title.length).toBeGreaterThan(0);
      expect(catalog.devices(1)).not.toBe(catalog.devices(2));
      expect(catalog.failures.lastAdmin("x")).toContain("x");
    }
  });
});
