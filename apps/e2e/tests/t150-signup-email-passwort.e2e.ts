/**
 * Ticket #150: `/signup` bietet immer auch E-Mail und Passwort an (Registrierung mit Bestätigungsmail).
 *
 * Voraussetzung für P6/P7: `MAILPIT_URL` (HTTP-API von Mailpit, z. B. `http://localhost:8025`), an das der Server
 * seine Mail schickt (`WAVE_SMTP_URL=smtp://<mailpit>:1025`). Fehlt sie, überspringen beide mit Grund.
 *
 * Zustand und Voraussetzung: Wie in t147 entscheidet das Testsystem, nicht dieser Test. Er liest ohne
 * Anmeldung `GET /api/auth/providers` (`signup`, `passwordSignup`) und führt nur die Fälle des
 * vorgefundenen Zustands aus; die anderen überspringen mit Grund. `passwordSignup` ist wahr, wenn
 * `WAVE_SIGNUP_ENABLED=true` gilt und `WAVE_SMTP_URL`/`WAVE_MAIL_FROM` gesetzt sind. Der Test legt kein
 * Konto an: Eine Registrierung ohne Bestätigung ist kein Konto, und die Adresse (`t150-<Lauf>@example.test`)
 * ist je Lauf neu. Die Fälle gelten für beide Fassungen (Frontend und schlichte Seiten von Control),
 * Selektoren über `data-*`, `name` und `href`.
 *
 * - P1 „Formular“ (Schalter an, Mail an): `/signup` zeigt das Formular mit E-Mail und Passwort
 *   (`data-signup="form"`, `data-field`, `data-action="signup-submit"`), zusätzlich zu den Knöpfen der
 *   konfigurierten Anbieter; ohne Anbieter steht nur das Formular da, ohne den Hinweis „no-provider“.
 * - P2 „Ohne Mail kein Formular“ (Schalter an, Mail aus): kein Formular, kein Passwortfeld, der Endpunkt
 *   `/auth/signup` antwortet 404; die Anbieter-Knöpfe bleiben.
 * - P3 „Passwort zu kurz“: elf Zeichen werden abgelehnt (`data-error="password-too-short"`), die Seite
 *   bleibt `/signup`. Das Browserattribut `minlength` wird dafür entfernt, damit der Server prüft.
 * - P4 „Registrierung abgeschickt“: ein gültiges Paar führt auf die Seite „Mail ist unterwegs“
 *   (`data-signup="sent"`); danach geht die Anmeldung mit genau diesem Paar nicht (kein Konto ohne
 *   Bestätigung) und es gibt keine Sitzung (`/api/me` 401).
 * - P6 „Kernpfad“: Registrierung mit frischer Adresse → Bestätigungsmail aus Mailpit → Link öffnen →
 *   Knopf „Confirm and create account“ → `[data-signup="login"]` führt auf die Anmeldung mit
 *   `next=/waves/new` → Anmeldung mit dem gewählten Passwort → Ziel `/waves/new` (Formular für den ersten Wave).
 * - P7 „Bekannte Adresse“: Dieselbe, nun bestehende Adresse registriert sich noch einmal: dieselbe Seite „Mail
 *   unterwegs“, aber die Mail „You already have a wave-mesh account“ ohne `/signup/confirm` im Text.
 * - P5 „Link ungültig“: `/signup/confirm?token=…` mit einem erfundenen Token endet auf der Seite
 *   „Link gilt nicht mehr“ (`data-signup="gone"`), im Frontend nach dem Klick auf den Bestätigungsknopf.
 * - S2 „Schalter aus“: `/signup`, `/register`, `/signup/confirm` liefern 404, `POST /auth/signup` und
 *   `POST /auth/signup/confirm` ebenso, die Login-Seite hat keinen Link, `signup: false` und
 *   `passwordSignup: false` in `/api/auth/providers`.
 *
 * Aufräumen: Die Mails beider Adressen löscht der Test in Mailpit wieder. Das angelegte Konto (P6) bleibt:
 * Konten lassen sich weder in der Oberfläche noch über eine API löschen; die Adresse
 * (`t150-flow-<Lauf>@example.test`) ist je Lauf neu und stört nichts.
 *
 * Nicht über die Oberfläche prüfbar, mit Grund (Beleg: `apps/control/test/signup-password.test.ts`):
 * - Einmaligkeit und Ablauf des Links, Verhalten bei bekannter Adresse (OIDC, Passwort, unbestätigte
 *   Registrierung: gleiche Antwort, Mail „Du hast bereits ein Konto“, keine Zusammenführung), Rate-Limit:
 *   Jede Probe würde Mails an fremde Postfächer schicken oder das geteilte System sperren.
 *
 * Beschriftungen gelten für `en-US` (Config).
 */
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { newSession } from "./helpers.ts";

interface Options {
  providers: string[];
  signup?: boolean;
  passwordSignup?: boolean;
}

let ctx: BrowserContext;
let page: Page;
let options: Options;

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const ADDRESS = `t150-${RUN}@example.test`;
/** Die Adresse des Kernpfads (P6/P7): hier entsteht ein Konto, deshalb eigene Adresse je Lauf. */
const FLOW_ADDRESS = `t150-flow-${RUN}@example.test`;
const FLOW_PASSWORD = `t150-flow-${RUN}-passwort`;
const MAILPIT_URL = process.env.MAILPIT_URL?.replace(/\/+$/, "");
const NO_MAILPIT =
  "MAILPIT_URL ist nicht gesetzt: ohne das Postfach des Systems ist der Mailweg nicht prüfbar.";

interface MailpitMessage {
  ID: string;
  Subject: string;
}

/** Die Mails an eine Adresse aus Mailpit, neueste zuerst. */
async function mailsTo(p: Page, address: string): Promise<MailpitMessage[]> {
  const res = await p.request.get(`${MAILPIT_URL}/api/v1/search`, { params: { query: `to:"${address}"` } });
  expect(res.status(), "Mailpit /api/v1/search").toBe(200);
  return ((await res.json()) as { messages?: MailpitMessage[] }).messages ?? [];
}

/** Wartet auf die Mail mit diesem Betreff und liefert ihren Text. */
async function mailText(p: Page, address: string, subject: string): Promise<string> {
  let id = "";
  await expect
    .poll(
      async () => {
        id = (await mailsTo(p, address)).find((m) => m.Subject === subject)?.ID ?? "";
        return id;
      },
      {
        message: `Mail „${subject}“ an ${address} in Mailpit`,
        timeout: 30_000,
        intervals: [500, 1_000, 2_000],
      },
    )
    .not.toBe("");
  const res = await p.request.get(`${MAILPIT_URL}/api/v1/message/${id}`);
  expect(res.status(), "Mailpit /api/v1/message").toBe(200);
  return ((await res.json()) as { Text: string }).Text;
}

/** Löscht die Mails der Adressen wieder; Aufräumen scheitert nie den Fall. */
async function deleteMails(p: Page, addresses: string[]): Promise<void> {
  if (!MAILPIT_URL) return;
  try {
    const ids = (await Promise.all(addresses.map((a) => mailsTo(p, a)))).flat().map((m) => m.ID);
    if (ids.length > 0) await p.request.delete(`${MAILPIT_URL}/api/v1/messages`, { data: { IDs: ids } });
  } catch {
    // Mailpit weg oder anders konfiguriert: nichts aufzuräumen.
  }
}

/** Der Link aus dem Mailtext als Pfad mit Query: der Test öffnet ihn gegen `APP_URL`, nicht gegen `WAVE_BASE_URL`. */
function confirmPath(text: string): string {
  const found = text.match(/https?:\/\/\S+\/signup\/confirm\?token=[\w-]+/);
  expect(found, "Bestätigungslink im Mailtext").toBeTruthy();
  const url = new URL(found?.[0] ?? "");
  return `${url.pathname}${url.search}`;
}

let flowConfirmed = false;
const PASSWORD = `t150-${RUN}-passwort`;

/** Die Login-Seite: `/login` im Frontend, sonst die schlichte Seite von Control auf `/`. */
async function openLogin(p: Page): Promise<void> {
  const res = await p.goto("/login");
  if (res?.status() === 404) await p.goto("/");
}

/** Füllt das Formular von `/signup` aus; `minlength` fällt weg, damit der Server die Regel prüft. */
async function fillSignup(p: Page, email: string, password: string): Promise<void> {
  await p.locator('[data-field="email"]').fill(email);
  const field = p.locator('[data-field="password"]');
  await field.evaluate((el) => el.removeAttribute("minlength"));
  await field.fill(password);
}

test.describe("Registrierung mit E-Mail und Passwort", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    ctx = await newSession(browser);
    page = await ctx.newPage();
    const res = await page.request.get("/api/auth/providers");
    expect(res.status()).toBe(200);
    options = (await res.json()) as Options;
  });

  test.afterAll(async () => {
    await deleteMails(page, [ADDRESS, FLOW_ADDRESS]);
    await ctx?.close();
  });

  test("P1 Formular: E-Mail und Passwort zusätzlich zu den Anbieter-Knöpfen", { tag: "@t150" }, async () => {
    test.skip(
      options.passwordSignup !== true,
      "Das Testsystem bietet die Registrierung mit E-Mail nicht an (passwordSignup≠true): Fälle P2/S2 gelten.",
    );

    expect((await page.goto("/signup"))?.status()).toBe(200);
    await expect(page.locator('[data-signup="form"]')).toBeVisible();
    await expect(page.locator('[data-field="email"]')).toHaveAttribute("type", "email");
    await expect(page.locator('[data-field="password"]')).toHaveAttribute("type", "password");
    await expect(page.locator('[data-action="signup-submit"]')).toBeVisible();

    const offered = options.providers.filter((id) => id !== "dev");
    for (const id of offered) {
      await expect(page.locator(`a[data-provider="${id}"]`)).toHaveAttribute(
        "href",
        `/auth/${id}/start?next=%2Fwaves%2Fnew`,
      );
    }
    if (offered.length === 0) {
      await expect(page.locator("[data-provider]")).toHaveCount(0);
      await expect(page.locator('[data-signup="no-provider"]')).toHaveCount(0);
    }
  });

  test("P2 Ohne Mail kein Formular", { tag: "@t150" }, async () => {
    test.skip(
      options.signup !== true || options.passwordSignup === true,
      "Nur für ein System mit Registrierung an und Mail aus (signup=true, passwordSignup≠true).",
    );

    expect((await page.goto("/signup"))?.status()).toBe(200);
    await expect(page.locator('[data-signup="form"]')).toHaveCount(0);
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    const res = await page.request.post("/auth/signup", {
      form: { email: ADDRESS, password: PASSWORD },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(404);
    for (const id of options.providers.filter((p) => p !== "dev")) {
      await expect(page.locator(`a[data-provider="${id}"]`)).toBeVisible();
    }
  });

  test("P3 Passwort zu kurz wird abgelehnt", { tag: "@t150" }, async () => {
    test.skip(options.passwordSignup !== true, "passwordSignup≠true: kein Formular, Fall P2 gilt.");

    await page.goto("/signup");
    await fillSignup(page, ADDRESS, "elf-zeichen");
    await page.locator('[data-action="signup-submit"]').click();

    await expect(page.locator('[data-signup="error"][data-error="password-too-short"]')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/signup");
    await expect(page.locator('[data-signup="sent"]')).toHaveCount(0);
  });

  test("P4 Registrierung abgeschickt: Hinweis „Mail unterwegs“, aber kein Zugang ohne Bestätigung", {
    tag: "@t150",
  }, async () => {
    test.skip(options.passwordSignup !== true, "passwordSignup≠true: kein Formular, Fall P2 gilt.");

    await page.goto("/signup");
    await fillSignup(page, ADDRESS, PASSWORD);
    await page.locator('[data-action="signup-submit"]').click();

    // Scheitert hier mit `mail-failed`, fehlt dem System der Mailzugang oder er ist falsch.
    await expect(
      page.locator('[data-signup="error"]'),
      "Die Bestätigungsmail ließ sich nicht senden: WAVE_SMTP_URL/WAVE_MAIL_FROM des Testsystems prüfen",
    ).toHaveCount(0);
    await expect(page.locator('[data-signup="sent"]')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/signup/sent");

    // Ohne Bestätigung gibt es kein Konto, also weder Anmeldung noch Sitzung.
    await openLogin(page);
    await page.locator("#email").fill(ADDRESS);
    await page.locator("#password").fill(PASSWORD);
    await page.locator('form[action="/auth/password/login"] button[type="submit"]').click();
    await expect(page.locator("#email")).toBeVisible();
    expect((await page.request.get("/api/me")).status()).toBe(401);
  });

  test("P6 Kernpfad: Registrierung → Mail → Link → Knopf → Anmeldung → /waves/new", {
    tag: "@t150",
  }, async () => {
    test.skip(!MAILPIT_URL, NO_MAILPIT);
    test.skip(options.passwordSignup !== true, "passwordSignup≠true: kein Formular, Fall P2 gilt.");

    await page.goto("/signup");
    await fillSignup(page, FLOW_ADDRESS, FLOW_PASSWORD);
    await page.locator('[data-action="signup-submit"]').click();
    await expect(page.locator('[data-signup="sent"]')).toBeVisible();

    const text = await mailText(page, FLOW_ADDRESS, "Confirm your wave-mesh account");
    await page.goto(confirmPath(text));
    await page.locator('[data-action="signup-confirm"]').click();

    // Bestätigt: der Link führt auf die Anmeldung und nimmt `/waves/new` als Ziel mit.
    const login = page.locator('a[data-signup="login"]');
    await expect(login).toBeVisible();
    await login.click();
    await page.waitForURL((url) => url.searchParams.get("next") === "/waves/new");
    await page.locator("#email").fill(FLOW_ADDRESS);
    await page.locator("#password").fill(FLOW_PASSWORD);
    await page.locator('form[action="/auth/password/login"] button[type="submit"]').click();

    await page.waitForURL((url) => url.pathname === "/waves/new");
    await expect(page.locator('form[action="/waves"]')).toBeVisible();
    flowConfirmed = true;

    // Der Link ist verbraucht: ein zweites Öffnen und Absenden ändert nichts.
    await page.goto(confirmPath(text));
    const again = page.locator('[data-action="signup-confirm"]');
    if ((await again.count()) > 0) await again.click();
    await expect(page.locator('[data-signup="gone"]')).toBeVisible();
  });

  test("P7 Bekannte Adresse: gleiche Seite, Mail „bereits ein Konto“ ohne Bestätigungslink", {
    tag: "@t150",
  }, async () => {
    test.skip(!MAILPIT_URL, NO_MAILPIT);
    test.skip(!flowConfirmed, "Der Kernpfad (P6) hat kein Konto für die Adresse angelegt.");

    // Ohne Sitzung: P6 hat sich angemeldet, `/signup` schickt Angemeldete weg.
    await ctx.clearCookies();
    await page.goto("/signup");
    await fillSignup(page, FLOW_ADDRESS, `${FLOW_PASSWORD}-anders`);
    await page.locator('[data-action="signup-submit"]').click();

    // Dieselbe Seite wie bei einer neuen Adresse: von außen ist nicht zu sehen, dass es sie gibt.
    await expect(page.locator('[data-signup="sent"]')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/signup/sent");

    const text = await mailText(page, FLOW_ADDRESS, "You already have a wave-mesh account");
    expect(text).not.toContain("/signup/confirm");
    expect(text).toContain("already has an account");
    expect(text).toMatch(/https?:\/\/\S+/);
  });

  test("P5 Ungültiger Link endet auf „Link gilt nicht mehr“", { tag: "@t150" }, async () => {
    test.skip(options.signup !== true, "signup≠true: die Seite gibt es nicht, Fall S2 gilt.");

    await page.goto(`/signup/confirm?token=t150-${RUN}-erfunden`);
    // Das Frontend zeigt zuerst den Knopf, der Link wird erst beim Absenden geprüft; Control prüft gleich.
    const button = page.locator('[data-action="signup-confirm"]');
    if ((await button.count()) > 0) await button.click();
    await expect(page.locator('[data-signup="gone"]')).toBeVisible();
    await expect(page.locator('[data-signup="login"]')).toHaveCount(0);
  });

  test("S2 Schalter aus: 404 für Seite und Endpunkte, kein Link, signup=false", {
    tag: "@t150",
  }, async () => {
    test.skip(
      options.signup === true,
      "Das Testsystem hat die Registrierung an (signup=true in /api/auth/providers): Fälle P1–P5 gelten.",
    );

    expect(options.passwordSignup === true).toBe(false);
    expect((await page.goto("/signup"))?.status()).toBe(404);
    expect((await page.goto("/register"))?.status()).toBe(404);
    expect((await page.goto("/signup/confirm?token=x"))?.status()).toBe(404);
    for (const path of ["/auth/signup", "/auth/signup/confirm"]) {
      const res = await page.request.post(path, {
        form: { email: ADDRESS, password: PASSWORD, token: "x" },
        maxRedirects: 0,
      });
      expect(res.status(), `POST ${path}`).toBe(404);
    }

    await openLogin(page);
    await expect(page.locator('a[href="/signup"]')).toHaveCount(0);
    await expect(page.locator('a[href="/register"]')).toHaveCount(0);
  });
});
