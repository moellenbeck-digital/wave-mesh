/**
 * Ticket #70: Control /waves — ungültiger Name oder ungültige Domain zeigt das Formular mit Fehler
 * am Feld (Status 400) statt einer nackten Fehlerseite.
 *
 * Aufbau: Der Eigentümer (APP_USER) legt auf `/waves/new` Waves an. Die Fälle sind unabhängig
 * voneinander; jeder öffnet das Formular neu. Nur K7 legt einen Wave an (eindeutiger Name mit
 * Lauf-Kennung), `afterAll` entfernt ihn wieder. Die übrigen Namen werden vorsorglich ebenfalls
 * entfernt, falls ein ungültiger Wert doch angenommen würde.
 *
 * Mit Frontend ist `/waves/new` die Next.js-Seite, deren Formular an `/waves` (Control) postet. Dort
 * prüft der Browser den Namen vorab (`pattern`, `maxLength`) und würde `123`, `1x` oder `<` gar nicht
 * absenden. Die Fälle prüfen aber die Antwort des Servers, deshalb schaltet `submit` die
 * Browser-Validierung des Formulars ab (`noValidate`); gesendet wird weiter durch die Oberfläche.
 *
 * Nicht prüfbar: der Seitenrahmen (Kopf, Navigation) der Fehlerseite — Control hat keinen, laut
 * Auftrag ausdrücklich kein Befund.
 *
 * Die Fehlertexte stehen in Control (`Accept-Language`); K8 prüft sie mit einem Kontext je Sprache.
 */
import { type Browser, type BrowserContext, expect, type Page, type Response, test } from "@playwright/test";
import { deleteWave, env, login } from "./helpers.ts";

const run = Math.random().toString(36).slice(2, 8);
const okName = `t70-${run}`;
const okSuffix = `${okName}.example.com`;

let owner: { ctx: BrowserContext; page: Page };
const used = new Set<string>();

/** Öffnet `/waves/new`, füllt beide Felder, sendet ohne Browser-Prüfung ab und liefert die Antwort. */
async function submit(page: Page, name: string, suffix: string): Promise<Response> {
  used.add(name);
  await page.goto("/waves/new");
  await page.locator("#name").fill(name);
  await page.locator("#suffix").fill(suffix);
  await page.locator('form[action="/waves"]').evaluate((f) => {
    (f as HTMLFormElement).noValidate = true;
  });
  const [response] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === "/waves" && r.request().method() === "POST"),
    page.locator('form[action="/waves"] button[type="submit"]').click(),
  ]);
  return response;
}

async function evidence(page: Page, label: string) {
  await test.info().attach(label, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  await test.info().attach(`${label}-text`, { body: await page.locator("body").innerText(), contentType: "text/plain" });
}

async function session(browser: Browser, locale: string) {
  const ctx = await browser.newContext({ baseURL: env("APP_URL"), locale });
  const page = await ctx.newPage();
  await login(page, env("APP_USER"), env("APP_PASSWORD"));
  return { ctx, page };
}

test.describe("Wave anlegen: Formularfehler", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000);
    owner = await session(browser, "en-US");
  });

  test.afterAll(async () => {
    try {
      if (owner) for (const name of used) await deleteWave(owner.page, name);
    } finally {
      await owner?.ctx.close();
    }
  });

  test("K1 Ungültige Domain: Status 400, Fehler unter dem Feld mit Format und Beispiel, keine nackte Textseite", {
    tag: "@t70",
  }, async () => {
    const { page } = owner;
    const response = await submit(page, `t70-k1-${run}`, "martins-synologie");
    expect(response.status()).toBe(400);
    // Das Formular ist wieder da, kein nackter Text.
    await expect(page.locator('form[action="/waves"]')).toBeVisible();
    await expect(page.locator('label[for="suffix"]')).toHaveText("Domain");
    const error = page.locator("#suffix-error");
    await expect(error).toBeVisible();
    await expect(error).toHaveText(/martins-synologie.*is not a valid domain/);
    await expect(error).toContainText("at least two labels");
    await expect(error).toContainText("a–z, 0–9 and hyphens");
    await expect(error).toContainText("no scheme");
    await expect(error).toContainText("no trailing dot");
    await expect(error).toContainText("my-company.example.com");
    // Der Fehler gehört zum Feld und folgt ihm auf der Seite.
    await expect(page.locator("#suffix ~ #suffix-error")).toHaveCount(1);
    await expect(page.locator("#suffix")).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator("#name-error")).toHaveCount(0);
    await evidence(page, "k1-domain-ungueltig");
  });

  test("K2 Nach ungültiger Domain bleiben Domain und Name unverändert im Formular", { tag: "@t70" }, async () => {
    const { page } = owner;
    const name = `t70-k2-${run}`;
    const response = await submit(page, name, "martins-synologie");
    expect(response.status()).toBe(400);
    await expect(page.locator("#suffix")).toHaveValue("martins-synologie");
    await expect(page.locator("#name")).toHaveValue(name);
  });

  test("K3 Ungültiger Name mit gültiger Domain: Fehler am Namensfeld mit Format und Beispiel, Domain bleibt", {
    tag: "@t70",
  }, async () => {
    const { page } = owner;
    const response = await submit(page, "123", "robin.example.com");
    expect(response.status()).toBe(400);
    const error = page.locator("#name-error");
    await expect(error).toBeVisible();
    await expect(error).toContainText("123");
    await expect(error).toContainText("starts with a letter");
    await expect(error).toContainText("a–z, 0–9 and hyphens");
    await expect(error).toContainText("at most 24 characters");
    await expect(error).toContainText("my-company");
    await expect(page.locator("#name ~ #name-error")).toHaveCount(1);
    await expect(page.locator("#suffix")).toHaveValue("robin.example.com");
    await expect(page.locator("#suffix-error")).toHaveCount(0);
    await evidence(page, "k3-name-ungueltig");
  });

  test("K4 Beide Felder ungültig: beide Fehler gleichzeitig sichtbar", { tag: "@t70" }, async () => {
    const { page } = owner;
    const response = await submit(page, "1x", "https://wave");
    expect(response.status()).toBe(400);
    await expect(page.locator("#name-error")).toBeVisible();
    await expect(page.locator("#name-error")).toContainText("1x");
    await expect(page.locator("#suffix-error")).toBeVisible();
    await expect(page.locator("#suffix-error")).toContainText("https://wave");
    await expect(page.locator("#name")).toHaveValue("1x");
    await expect(page.locator("#suffix")).toHaveValue("https://wave");
    await evidence(page, "k4-beide-ungueltig");
  });

  test("K5 Das Domain-Feld zeigt ohne vorherigen Fehler einen Formathinweis", { tag: "@t70" }, async () => {
    const { page } = owner;
    await page.goto("/waves/new");
    const form = page.locator('form[action="/waves"]');
    await expect(form).toBeVisible();
    await expect(page.locator("#suffix-error")).toHaveCount(0);
    await expect(form).toContainText("at least two labels");
    await expect(form).toContainText("my-company.example.com");
    await evidence(page, "k5-formathinweis");
  });

  test("K6 Zeichen < \" & im Namen kommen escaped zurück, kein Markup wird ausgeführt", { tag: "@t70" }, async () => {
    const { page } = owner;
    const typed = 'x"><b id=t70inj>&amp;';
    const response = await submit(page, typed, "martins-synologie");
    expect(response.status()).toBe(400);
    const body = await response.text();
    expect(body).not.toContain("<b id=t70inj>");
    expect(body).toContain("&lt;b id=t70inj&gt;");
    await expect(page.locator("#t70inj")).toHaveCount(0);
    await expect(page.locator("#name")).toHaveValue(typed);
    await expect(page.locator("#name-error")).toContainText(typed);
    await evidence(page, "k6-escaping");
  });

  test("K7 Gültige Eingabe legt den Wave an und leitet weiter", { tag: "@t70" }, async () => {
    const { page } = owner;
    used.add(okName);
    await page.goto("/waves/new");
    await page.locator("#name").fill(okName);
    await page.locator("#suffix").fill(okSuffix);
    await page.locator('form[action="/waves"] button[type="submit"]').click();
    await page.waitForURL((url) => url.pathname === "/");
    expect(new URL(page.url()).searchParams.get("wave")).toBeTruthy();
    await expect(page.getByRole("heading", { level: 2, name: okName, exact: true })).toBeVisible();
    await evidence(page, "k7-wave-angelegt");
  });

  test("K8 Fehlertexte folgen der Browsersprache: de auf Deutsch, en auf Englisch", { tag: "@t70" }, async ({ browser }) => {
    test.setTimeout(120_000);
    const de = await session(browser, "de-DE");
    try {
      const response = await submit(de.page, `t70-k8-${run}`, "martins-synologie");
      expect(response.status()).toBe(400);
      await expect(de.page.locator("#suffix-error")).toContainText("ist keine gültige Domain");
      await expect(de.page.locator("#suffix-error")).toContainText("mindestens zwei Labels");
      await expect(de.page.locator("#suffix-error")).toContainText("meine-firma.example.com");
      await expect(de.page.locator("#suffix-error")).not.toContainText("is not a valid domain");
      await evidence(de.page, "k8-de");
    } finally {
      await de.ctx.close();
    }
    const { page } = owner;
    const response = await submit(page, `t70-k8-${run}`, "martins-synologie");
    expect(response.status()).toBe(400);
    await expect(page.locator("#suffix-error")).toContainText("is not a valid domain");
    await expect(page.locator("#suffix-error")).not.toContainText("ist keine gültige Domain");
  });
});
