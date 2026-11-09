/**
 * Ticket #78: Geführte, sichere Verknüpfung getrennter Konten nach OIDC-Anmeldung.
 *
 * Aufbau: Der Eigentümer (APP_USER) legt eine Wave `W` an und lädt das Konto A (Adresse mit Lauf-Kennung,
 * bestätigt, mit Passwort) als Mitglied ein. Danach meldet sich eine frische Mock-OIDC-Identität (`sub` mit
 * Lauf-Kennung, gleiche Adresse wie A, `email_verified=false`) an: Das ist das getrennte Konto B. Die Fälle
 * bauen aufeinander auf (`serial`) und teilen B; jeder beendet eine offene Verknüpfungsanfrage mit „Cancel“.
 *
 * Nicht geprüft (kein Fall, bewusst): die erfolgreiche Zusammenführung (Schritt 3, „Join the accounts“) – sie ist
 * nicht umkehrbar und gehört nicht zu den Kriterien 1–3; ebenso die Gerätefreigabe (`/devices/choose`), die ein
 * Client-Gerät mit Anfrage bräuchte. Die Hinweiskarte steht auf `/` und `/account` und wird dort geprüft.
 *
 * Testdaten: W wird am Ende vom Eigentümer entfernt. Die Konten A und B lassen sich in der Oberfläche nicht
 * löschen und bleiben bestehen (Adresse `t78-<lauf>@example.test`, siehe README). Die Mock-Identität wird
 * ausschließlich über „Claims frei setzen“ mit eigenem `sub` angelegt, nie über die festen Testnutzer.
 *
 * Beschriftungen gelten für `en-US` (Config); Selektoren sonst über `name`, `action`, Rolle.
 */
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import {
  accept,
  createWave,
  deleteWave,
  env,
  invite,
  login,
  newSession,
  passwordFor,
} from "./helpers.ts";

const run = Math.random().toString(36).slice(2, 8);
const waveName = `t78-wave-${run}`;
const mail = `t78-${run}@example.test`;
const sub = `mock-user-t78-${run}`;

let owner: { ctx: BrowserContext; page: Page };
let b: { ctx: BrowserContext; page: Page };

const notice = (page: Page) => page.locator('section[aria-labelledby="link-notice-title"]');
const currentStep = (page: Page) => page.locator('ol li[aria-current="step"]');
const startForm = (page: Page) => page.locator('form[action="/account/link/start"]');
const passwordInput = (page: Page) => page.locator("#link-password");
const confirmForm = (page: Page) => page.locator('form[action="/account/link/confirm"]');

async function session(browser: Parameters<typeof newSession>[0]) {
  const ctx = await newSession(browser);
  return { ctx, page: await ctx.newPage() };
}

/** Die Authorize-Seite des Mock: „Claims frei setzen“ mit eigenem `sub` und der Adresse von A. */
async function pickClaims(page: Page, verified: boolean): Promise<void> {
  await page.waitForURL((url) => url.pathname === "/authorize");
  await page.locator('input[name="sub"]').fill(sub);
  await page.locator('input[name="email"]').fill(mail);
  await page.locator('input[name="name"]').fill(`t78 ${run}`);
  const box = page.locator('input[name="email_verified"]');
  if (verified) await box.check();
  else await box.uncheck();
  await page.locator("#user-frei").click();
  await page.waitForURL((url) => url.origin === new URL(env("APP_URL")).origin);
}

/** Anmeldung per OIDC am Mock mit unbestätigter Adresse: legt B an bzw. meldet B wieder an. */
async function signInUnverified(page: Page): Promise<void> {
  await page.goto("/auth/oidc/start");
  await pickClaims(page, false);
}

/** Schritt 1 anstoßen: „Continue with …“, am Mock erneut anmelden mit dem angegebenen Bestätigungsstand. */
async function startStepOne(page: Page, verified: boolean): Promise<void> {
  await page.goto("/account/link");
  await startForm(page).locator('button[type="submit"]').click();
  await pickClaims(page, verified);
  await page.waitForURL((url) => url.pathname === "/account/link");
}

async function cancelLink(page: Page): Promise<void> {
  await page.goto("/account/link");
  const cancel = page.locator('form[action="/account/link/cancel"] button[type="submit"]');
  if ((await cancel.count()) > 0) {
    await cancel.click();
    await page.waitForURL((url) => url.pathname === "/account");
  }
}

test.describe("Konten verknüpfen nach OIDC-Anmeldung", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    owner = await session(browser);
    await login(owner.page, env("APP_USER"), env("APP_PASSWORD"));
    const card = await createWave(owner.page, waveName, `${waveName}.wave.internal`);
    const link = await invite(owner.page, card, mail, "member");

    // Konto A: bestätigt (Einladung), mit Passwort, Mitglied von W.
    const a = await session(browser);
    try {
      await accept(a.page, link, mail);
      await expect(a.page.getByRole("heading", { level: 2, name: waveName, exact: true })).toBeVisible();
    } finally {
      await a.ctx.close();
    }

    // Konto B: Mock-Identität mit unbestätigter, gleicher Adresse.
    b = await session(browser);
    await signInUnverified(b.page);
  });

  test.afterAll(async () => {
    try {
      if (b) await cancelLink(b.page).catch(() => undefined);
      if (owner) await deleteWave(owner.page, waveName);
    } finally {
      await Promise.all([owner?.ctx.close(), b?.ctx.close()]);
    }
  });

  test(
    "K1 Getrenntes Konto B: Hinweiskarte nennt das aktive Konto und warum die Wave fehlt, Wave von A nicht sichtbar",
    { tag: "@t78" },
    async () => {
      const { page } = b;
      await page.goto("/");

      const card = notice(page);
      await expect(card).toBeVisible();
      await expect(page.locator("#link-notice-title")).toHaveText("You are signed in to a separate account");
      await expect(card).toContainText(`Active account: ${mail}`);
      await expect(card).toContainText("did not confirm your email address");
      await expect(card).toContainText("a wave you expect can be missing");
      await expect(card.locator('a[href="/account/link"]')).toBeVisible();

      // Die Karte steht über dem Angebot, eine neue Wave anzulegen.
      const create = page.locator('a[href="/waves/new"]').first();
      await expect(create).toBeVisible();
      const noticeBox = await card.boundingBox();
      const createBox = await create.boundingBox();
      expect(noticeBox?.y).toBeLessThan(createBox?.y ?? 0);

      // Der Wave von A ist in B nicht zu sehen.
      await expect(page.getByRole("heading", { level: 2, name: waveName, exact: true })).toHaveCount(0);
      await expect(page.getByText(waveName)).toHaveCount(0);

      // Auch die Konto-Seite trägt die Karte.
      await page.goto("/account");
      await expect(notice(page)).toBeVisible();
      await expect(notice(page)).toContainText(`Active account: ${mail}`);
    },
  );

  test(
    "K2 Adresse beim Anbieter bestätigt: ohne Nachweis über Konto A (falsches Passwort) kein Schritt 3, nichts ändert sich",
    { tag: "@t78" },
    async () => {
      const { page } = b;

      // Schritt 1: Anbieter bestätigt jetzt die Adresse (gleicher `sub`, email_verified=true).
      await page.goto("/account/link");
      await expect(currentStep(page)).toContainText("1.");
      await startStepOne(page, true);

      // Schritt 2: Nachweis über das andere Konto verlangt.
      await expect(currentStep(page)).toContainText("2.");
      await expect(page.getByRole("heading", { level: 2 })).toContainText(mail);
      await expect(passwordInput(page)).toBeVisible();

      // Falsches Passwort: Fehler, weiter Schritt 2, keine Zusammenfassung, kein Schritt 3.
      await passwordInput(page).fill(`${passwordFor(mail)}-falsch`);
      await page.locator('form[action="/account/link/control/password"] button[type="submit"]').click();
      await page.waitForURL((url) => url.pathname === "/account/link" && url.searchParams.has("error"));
      expect(new URL(page.url()).searchParams.get("error")).toBe("wrong-password");
      await expect(page.locator('p[role="alert"]')).toHaveText("That password did not work.");
      await expect(currentStep(page)).toContainText("2.");
      await expect(passwordInput(page)).toBeVisible();
      await expect(confirmForm(page)).toHaveCount(0);

      // Direktes Absenden von Schritt 3 ohne Nachweis führt nirgends hin.
      const direct = await page.request.post("/account/link/confirm", { maxRedirects: 0 });
      expect(direct.headers().location ?? "").not.toContain("/account/link/done");
      await page.goto("/account/link");
      await expect(currentStep(page)).toContainText("2.");
      await expect(confirmForm(page)).toHaveCount(0);

      // Nichts hat sich geändert: B bleibt B, die Wave von A bleibt unsichtbar.
      await page.goto("/");
      await expect(notice(page)).toBeVisible();
      await expect(page.getByText(waveName)).toHaveCount(0);

      await cancelLink(page);
    },
  );

  test(
    "K3 Gleiche, aber unbestätigte Adresse führt nie zur Verknüpfung: Schritt 1 bleibt stehen",
    { tag: "@t78" },
    async ({ browser }) => {
      // Erneutes Anmelden (frische Sitzung, gleicher `sub`, weiter unbestätigt): dasselbe getrennte Konto B.
      const again = await session(browser);
      try {
        const { page } = again;
        await signInUnverified(page);
        await page.goto("/");
        await expect(notice(page)).toBeVisible();
        await expect(page.getByText(waveName)).toHaveCount(0);

        // Schritt 1 direkt starten, der Anbieter bestätigt die Adresse weiterhin nicht.
        await startStepOne(page, false);
        expect(new URL(page.url()).searchParams.get("error")).toBe("unverified");
        await expect(page.locator('p[role="alert"]')).toHaveText(
          "The sign-in service does not confirm this address. Nothing was changed.",
        );
        await expect(currentStep(page)).toContainText("1.");
        await expect(passwordInput(page)).toHaveCount(0);
        await expect(confirmForm(page)).toHaveCount(0);

        // Schritte 2 und 3 lassen sich nicht überspringen, auch nicht mit dem richtigen Passwort von A.
        const password = await page.request.post("/account/link/control/password", {
          form: { password: passwordFor(mail) },
          maxRedirects: 0,
        });
        expect(password.headers().location ?? "").not.toContain("/account/link/done");
        const confirm = await page.request.post("/account/link/confirm", { maxRedirects: 0 });
        expect(confirm.headers().location ?? "").not.toContain("/account/link/done");

        await page.goto("/account/link");
        await expect(currentStep(page)).toContainText("1.");
        await expect(passwordInput(page)).toHaveCount(0);
        await expect(confirmForm(page)).toHaveCount(0);

        // B bleibt B: Hinweiskarte da, Wave von A nicht sichtbar.
        await page.goto("/");
        await expect(notice(page)).toBeVisible();
        await expect(page.getByText(waveName)).toHaveCount(0);

        await cancelLink(page);
      } finally {
        await again.ctx.close();
      }
    },
  );
});
