/**
 * Ticket #85: Probe der roten Schleife, Oberflächentest der Anmeldeseite `/login`.
 *
 * Absichtlich rot: Die Anmeldeseite zeigt den Text „A-62-Probe-rot“ nicht, und er wird nicht eingebaut.
 * Der Test scheitert deshalb allein am fehlenden Text (`getByText`), nicht an Login, Netz oder Aufbau.
 *
 * Die Seite braucht keine Anmeldung: Der Test arbeitet unangemeldet über APP_URL und legt weder Konto
 * noch Testdaten an, es gibt nichts aufzuräumen.
 *
 * Beschriftungen gelten für `en-US` (Config).
 */
import { expect, test } from "@playwright/test";
import { env, newSession } from "./helpers.ts";

test.describe("Probe rot", () => {
  test("Kriterium 2: die Anmeldeseite zeigt den Text „A-62-Probe-rot“", { tag: "@t85" }, async ({
    browser,
  }) => {
    const ctx = await newSession(browser);
    const page = await ctx.newPage();
    try {
      await page.goto(`${env("APP_URL")}/login`);
      await expect(page.getByText("A-62-Probe-rot")).toBeVisible();
    } finally {
      await ctx.close();
    }
  });
});
