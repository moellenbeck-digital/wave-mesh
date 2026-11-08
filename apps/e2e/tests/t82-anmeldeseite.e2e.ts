/**
 * Ticket #82: Probe des Stufen-Ablaufs, Oberflächentest der Anmeldeseite `/login`.
 *
 * Die Seite braucht keine Anmeldung: Der Test arbeitet unangemeldet über APP_URL und legt weder Konto
 * noch Testdaten an. Es wird nichts eingegeben und nichts abgesendet; ein Login-Ablauf (richtige oder
 * falsche Zugangsdaten) gehört nicht dazu.
 *
 * Beschriftungen gelten für `en-US` (Config), die Selektoren sind sprachunabhängig.
 */
import { expect, type Page, test } from "@playwright/test";
import { env, newSession } from "./helpers.ts";

const form = (page: Page) => page.locator('form[action="/auth/password/login"]');

async function openLogin(browser: Parameters<typeof newSession>[0]) {
  const ctx = await newSession(browser);
  const page = await ctx.newPage();
  const response = await page.goto(`${env("APP_URL")}/login`);
  return { ctx, page, response };
}

test.describe("Anmeldeseite", () => {
  test("Kriterium 1: /login lädt und zeigt das Formular mit E-Mail und Passwort", { tag: "@t82" }, async ({
    browser,
  }) => {
    const { ctx, page, response } = await openLogin(browser);
    try {
      expect(response?.ok()).toBe(true);
      await expect(form(page)).toBeVisible();
      const email = form(page).locator("#email");
      const password = form(page).locator("#password");
      await expect(email).toBeVisible();
      await expect(email).toHaveAttribute("type", "email");
      await expect(password).toBeVisible();
      await expect(password).toHaveAttribute("type", "password");
    } finally {
      await ctx.close();
    }
  });

  test("Kriterium 2: das Formular hat eine Schaltfläche zum Anmelden", { tag: "@t82" }, async ({
    browser,
  }) => {
    const { ctx, page } = await openLogin(browser);
    try {
      await expect(form(page).locator('button[type="submit"]')).toBeVisible();
    } finally {
      await ctx.close();
    }
  });
});
