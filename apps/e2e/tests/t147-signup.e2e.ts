/**
 * Ticket #147: Registrierungsseite `/signup`, per Konfiguration abschaltbar (`WAVE_SIGNUP_ENABLED`).
 *
 * Zustand und Voraussetzung: Welcher Zustand gilt, entscheidet das Testsystem, nicht dieser Test. Der
 * Test liest ihn ohne Anmeldung aus `GET /api/auth/providers` (Feld `signup`) und führt nur den Fall
 * des vorgefundenen Zustands aus; der andere überspringt mit Grund, statt etwas Falsches zu behaupten.
 * Beide Zustände zu prüfen heißt, zwei Läufe gegen je ein System: eines mit `WAVE_SIGNUP_ENABLED=true`
 * (gehostet, Testsystem) und eines ohne den Schalter (Standard, Selfhosting). Der Test legt nichts an,
 * meldet niemanden an und braucht keine Konten: er sieht nur, was ein Besucher ohne Sitzung sieht.
 * Läuft das System ohne `WAVE_WEB_URL`, antwortet Control mit seinen schlichten Seiten (Login auf `/`);
 * die Fälle gelten für beide Fassungen, Selektoren über `href` und `data-*`.
 *
 * - S1 „Schalter an“: `/signup` antwortet mit 200 und zeigt den Gratis-Tarif mit den Zahlen aus
 *   `/api/auth/providers` (`freePlan`), den Hinweis auf die bestätigte Adresse (`email_verified`) und je
 *   konfiguriertem Anbieter (ohne `dev`) einen Knopf nach `/auth/<anbieter>/start?next=/waves/new`;
 *   ohne Anbieter steht stattdessen der Hinweis dafür da. Kein Passwortfeld. Die Login-Seite zeigt den
 *   Link „Create account“, und er führt auf `/signup`.
 * - S2 „Schalter aus“: `/signup` und `/register` liefern 404, die Login-Seite hat keinen Link auf
 *   `/signup`, und `/api/auth/providers` meldet `signup: false`.
 *
 * Nicht über die Oberfläche prüfbar, mit Grund (Beleg: `apps/control/test/signup.test.ts`):
 * - Der Anbieter-Login selbst (erster Login legt das Konto an, danach `/waves/new`): Er läuft über einen
 *   fremden Identitätsanbieter. Belege: `oidc.test.ts` („a first sign-in makes a verified account“).
 * - Die Env-Auswertung (leer, unbekannt, `1`, `true`): das Testsystem hat genau eine Konfiguration.
 *
 * Beschriftungen gelten für `en-US` (Config).
 */
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { newSession } from "./helpers.ts";

interface Options {
  providers: string[];
  signup?: boolean;
  freePlan?: { waves: number; people: number; devices: number };
}

let ctx: BrowserContext;
let page: Page;
let options: Options;

/** Die Login-Seite: `/login` im Frontend, sonst die schlichte Seite von Control auf `/`. */
async function openLogin(p: Page): Promise<void> {
  const res = await p.goto("/login");
  if (res?.status() === 404) await p.goto("/");
}

test.describe("Registrierungsseite /signup", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    ctx = await newSession(browser);
    page = await ctx.newPage();
    const res = await page.request.get("/api/auth/providers");
    expect(res.status()).toBe(200);
    options = (await res.json()) as Options;
  });

  test.afterAll(async () => {
    await ctx?.close();
  });

  test("S1 Schalter an: Gratis-Tarif, email_verified, Anbieter-Knöpfe, Link auf der Login-Seite", {
    tag: "@t147",
  }, async () => {
    test.skip(
      options.signup !== true,
      "Das Testsystem hat die Registrierung aus (signup=false in /api/auth/providers): Fall S2 gilt.",
    );

    const res = await page.goto("/signup");
    expect(res?.status()).toBe(200);

    const plan = page.locator('[data-signup="plan"]');
    await expect(plan).toBeVisible();
    const limits = options.freePlan;
    expect(limits, "freePlan fehlt in /api/auth/providers bei eingeschalteter Registrierung").toBeTruthy();
    if (limits) {
      await expect(plan).toContainText(`${limits.waves} waves`);
      await expect(plan).toContainText(`${limits.people} people`);
      await expect(plan).toContainText(`${limits.devices} devices`);
    }
    await expect(page.locator('[data-signup="verified"]')).toContainText("email_verified");

    // Ein Knopf je konfiguriertem Anbieter, `dev` ist keine Registrierung.
    const offered = options.providers.filter((id) => id !== "dev");
    if (offered.length === 0) {
      await expect(page.locator('[data-signup="no-provider"]')).toBeVisible();
    }
    for (const id of offered) {
      const button = page.locator(`a[data-provider="${id}"]`);
      await expect(button).toBeVisible();
      await expect(button).toHaveAttribute("href", `/auth/${id}/start?next=%2Fwaves%2Fnew`);
    }

    // Keine Passwort-Registrierung.
    await expect(page.locator('input[type="password"]')).toHaveCount(0);

    // Die Login-Seite führt hierher.
    await openLogin(page);
    const link = page.locator('a[href="/signup"]');
    await expect(link).toBeVisible();
    await expect(link).toHaveText("Create account");
    await link.click();
    await page.waitForURL((url) => url.pathname === "/signup");
    await expect(page.locator('[data-signup="verified"]')).toBeVisible();
  });

  test("S2 Schalter aus: 404, kein Link auf der Login-Seite, signup=false", { tag: "@t147" }, async () => {
    test.skip(
      options.signup === true,
      "Das Testsystem hat die Registrierung an (signup=true in /api/auth/providers): Fall S1 gilt.",
    );

    expect(options.signup === false || options.signup === undefined).toBe(true);
    expect((await page.goto("/signup"))?.status()).toBe(404);
    expect((await page.goto("/register"))?.status()).toBe(404);

    await openLogin(page);
    await expect(page.locator('a[href="/signup"]')).toHaveCount(0);
    await expect(page.locator('a[href="/register"]')).toHaveCount(0);
  });
});
