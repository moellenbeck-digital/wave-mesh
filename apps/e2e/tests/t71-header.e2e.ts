/**
 * Ticket #71, Nacharbeit K7: Header im Control bei schmalen und breiten Schirmen.
 *
 * Ergänzt `t71-aufraeumen.e2e.ts` (dort: 360 px, „?“ sichtbar, Link und Abmelden im Viewport, kein Überlauf der Seite,
 * mit kurzer und mit langer Adresse). Hier zusätzlich:
 *   H1 Header selbst läuft bei 360 px nicht über (scrollWidth ≤ clientWidth), auf `/` und `/account`, en und de.
 *   H2 Ab `md` (768 und 1024 px) zeigt der Link den Langtext, das „?“ ist ausgeblendet; Link und Abmelden liegen im Viewport.
 *   H3 Die Login-Seite ohne Benutzer läuft bei 360 px nicht über.
 *
 * Alle Fälle brauchen nur das Konto des Eigentümers (APP_USER), keine Waves und keine Testdaten.
 * Nicht geprüft: Verhalten unter 360 px (dort verschwindet die Adresse; kein Kriterium des Tickets).
 */
import { expect, type Page, test } from "@playwright/test";
import { env, login } from "./helpers.ts";

type Lang = "en" | "de";

const signOutHelp: Record<Lang, string> = {
  en: "How do I sign out completely?",
  de: "Wie melde ich mich komplett ab?",
};
const signOut: Record<Lang, string> = { en: "Sign out", de: "Abmelden" };

const overflow = (page: Page): Promise<number> =>
  // Als String: der Ausdruck läuft im Browser, die Typprüfung hier kennt kein DOM.
  page.evaluate<number>("document.documentElement.scrollWidth - window.innerWidth");

for (const lang of ["en", "de"] as const) {
  test(`H1 [${lang}] 360 px: der Header selbst läuft nicht über`, { tag: "@t71" }, async ({ browser }) => {
    const ctx = await browser.newContext({
      baseURL: env("APP_URL"),
      locale: "en-US",
      viewport: { width: 360, height: 800 },
    });
    try {
      await ctx.addCookies([{ name: "wave_lang", value: lang, url: env("APP_URL") }]);
      const page = await ctx.newPage();
      await login(page, env("APP_USER"), env("APP_PASSWORD"));
      for (const path of ["/", "/account"]) {
        await page.goto(path);
        await expect(page.locator("header a[href='/account#abmelden']")).toBeVisible();
        // Als String: der Ausdruck läuft im Browser, die Typprüfung hier kennt kein DOM.
        const header = await page.evaluate<{ scroll: number; client: number }>(
          `(() => { const el = document.querySelector("header > div"); return { scroll: el.scrollWidth, client: el.clientWidth }; })()`,
        );
        expect(
          header.scroll,
          `Header auf ${path}: scrollWidth ${header.scroll} > clientWidth ${header.client}`,
        ).toBeLessThanOrEqual(header.client);
        expect(await overflow(page), `Seite ${path} breiter als 360 px`).toBeLessThanOrEqual(0);
      }
    } finally {
      await ctx.close();
    }
  });

  for (const width of [768, 1024]) {
    test(`H2 [${lang}] ${width} px: Link zeigt den Langtext, „?“ ist ausgeblendet`, { tag: "@t71" }, async ({
      browser,
    }) => {
      const ctx = await browser.newContext({
        baseURL: env("APP_URL"),
        locale: "en-US",
        viewport: { width, height: 800 },
      });
      try {
        await ctx.addCookies([{ name: "wave_lang", value: lang, url: env("APP_URL") }]);
        const page = await ctx.newPage();
        await login(page, env("APP_USER"), env("APP_PASSWORD"));
        for (const path of ["/", "/account"]) {
          await page.goto(path);
          const link = page.locator('header a[href="/account#abmelden"]');
          await expect(link.getByText(signOutHelp[lang], { exact: true })).toBeVisible();
          await expect(link.getByText("?", { exact: true })).toBeHidden();
          const button = page.locator("header").getByRole("button", { name: signOut[lang] });
          await expect(button).toBeVisible();
          for (const [name, el] of [
            ["Link", link],
            ["Abmelden-Knopf", button],
          ] as const) {
            const box = await el.boundingBox();
            expect(
              (box?.x ?? -1) + (box?.width ?? 0),
              `${name} auf ${path}: rechte Kante`,
            ).toBeLessThanOrEqual(width);
            expect(box?.x ?? -1, `${name} auf ${path}: linke Kante`).toBeGreaterThanOrEqual(0);
          }
          expect(await overflow(page), `Seite ${path} bei ${width} px zu breit`).toBeLessThanOrEqual(0);
        }
      } finally {
        await ctx.close();
      }
    });
  }

  test(`H3 [${lang}] /login ohne Benutzer läuft bei 360 px nicht über`, { tag: "@t71" }, async ({
    browser,
  }) => {
    const ctx = await browser.newContext({
      baseURL: env("APP_URL"),
      locale: "en-US",
      viewport: { width: 360, height: 800 },
    });
    try {
      await ctx.addCookies([{ name: "wave_lang", value: lang, url: env("APP_URL") }]);
      const page = await ctx.newPage();
      await page.goto("/login");
      await expect(page.locator("#email")).toBeVisible();
      expect(await overflow(page), "Login-Seite breiter als 360 px").toBeLessThanOrEqual(0);
    } finally {
      await ctx.close();
    }
  });
}
