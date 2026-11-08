/**
 * Ticket #66: DNS-Provider-Seite überarbeiten (`/waves/<id>/dns`).
 *
 * Aufbau: Der Eigentümer (APP_USER) legt eine eigene Wave mit echter Domain an (`.example.test`, nicht die
 * Platzhalter-Domain `.wave.internal`, für die die Seite gar kein Formular zeigt). Die Fälle bauen aufeinander
 * auf (`serial`): erst ohne Provider, dann Provider einrichten, bearbeiten, entfernen. Am Ende entfernt der
 * Eigentümer die Wave wieder.
 *
 * Nicht prüfbar: ein Wechsel auf einen anderen Provider als `manual`. Cloudflare, Hetzner, IONOS und INWX
 * schreiben vor dem Speichern einen TXT-Record in die Zone; das scheitert ohne echte Zugangsdaten und ohne
 * echte Zone. K4 speichert deshalb `manual` erneut und prüft, dass das Formular danach zu ist und die
 * Anzeige den gespeicherten Stand nennt. Dass `manual` auch für die Anzeige zählt, ist damit abgedeckt.
 *
 * Selektoren sind Ids der Komponenten (`dns-current-<id>`, `dns-edit-<id>`, `dns-remove-<id>`,
 * `dns-cancel-<id>`, `dns-kind-<id>` für das Formular). Beschriftungen gelten für `en-US` (Config); der
 * deutsche Fall öffnet dafür einen eigenen Kontext.
 */
import { type Dialog, expect, type Page, test } from "@playwright/test";
import { createWave, deleteWave, env, login, newSession, waveId } from "./helpers.ts";

const run = Math.random().toString(36).slice(2, 8);
const name = `t66-${run}`;

let owner: Awaited<ReturnType<typeof newSession>>;
let page: Page;
let id: string;

const current = () => page.locator(`#dns-current-${id}`);
const edit = () => page.locator(`#dns-edit-${id}`);
const remove = () => page.locator(`#dns-remove-${id}`);
const cancel = () => page.locator(`#dns-cancel-${id}`);
const kind = () => page.locator(`#dns-kind-${id}`);
const submit = () => kind().locator("xpath=ancestor::form").locator('button[type="submit"]');

async function open() {
  await page.goto(`/waves/${id}/dns`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

/** Vor der Hydration tut ein Klick nichts; wiederholen, bis `done` eintritt. */
async function clickUntil(button: () => ReturnType<typeof edit>, done: () => Promise<void>) {
  await expect(async () => {
    await button().click();
    await done();
  }).toPass({ timeout: 20_000 });
}

test.describe("DNS-Provider-Seite", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000);
    owner = await newSession(browser);
    page = await owner.newPage();
    await login(page, env("APP_USER"), env("APP_PASSWORD"));
    id = await waveId(await createWave(page, name, `${name}.example.test`));
  });

  test.afterAll(async () => {
    try {
      if (page) await deleteWave(page, name);
    } finally {
      await owner?.close();
    }
  });

  test("K6 Ohne Provider: Hinweis und offenes Formular, weder Bearbeiten noch Entfernen", {
    tag: "@t66",
  }, async () => {
    await open();
    await expect(page.getByText("No provider is set", { exact: false })).toBeVisible();
    await expect(kind()).toBeVisible();
    await expect(current()).toHaveCount(0);
    await expect(edit()).toHaveCount(0);
    await expect(remove()).toHaveCount(0);
    await expect(cancel()).toHaveCount(0);
  });

  test("Einrichten ohne Provider: nach dem Speichern zeigt die Seite den Provider, das Formular ist zu", {
    tag: "@t66",
  }, async () => {
    await open();
    await expect(async () => {
      await kind().selectOption("manual");
      await submit().click();
      await expect(current()).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 20_000 });
    await expect(kind()).toHaveCount(0);
  });

  test("K1 Der Bereich nennt den Provider beim Namen, mit Einrichtungsdatum", { tag: "@t66" }, async () => {
    await open();
    await expect(current()).toBeVisible();
    await expect(current()).toContainText("Manual — any hoster");
    await expect(current()).toContainText(/Set up .+/);
  });

  test("K2 Genau ein Bearbeiten und ein Entfernen, sichtbar, ohne etwas aufzuklappen", {
    tag: "@t66",
  }, async () => {
    await open();
    await expect(edit()).toHaveCount(1);
    await expect(remove()).toHaveCount(1);
    await expect(edit()).toBeVisible();
    await expect(remove()).toBeVisible();
    await expect(edit()).toBeInViewport();
    await expect(remove()).toBeInViewport();
    // Das Formular ist in diesem Zustand zu.
    await expect(kind()).toHaveCount(0);
  });

  test("K3 Bearbeiten öffnet das Formular mit dem aktuellen Provider, Abbrechen schließt es ohne Änderung", {
    tag: "@t66",
  }, async () => {
    await open();
    await clickUntil(edit, () => expect(kind()).toBeVisible({ timeout: 2_000 }));
    await expect(kind()).toHaveValue("manual");
    await expect(cancel()).toBeVisible();
    await cancel().click();
    await expect(kind()).toHaveCount(0);
    await expect(current()).toContainText("Manual — any hoster");
    await expect(edit()).toBeVisible();
    await expect(remove()).toBeVisible();
  });

  test("K4 Speichern über Bearbeiten: Formular zu, Anzeige zeigt den gespeicherten Provider", {
    tag: "@t66",
  }, async () => {
    await open();
    await clickUntil(edit, () => expect(kind()).toBeVisible({ timeout: 2_000 }));
    await kind().selectOption("manual");
    await submit().click();
    await expect(kind()).toHaveCount(0);
    await expect(current()).toContainText("Manual — any hoster");
    await expect(page.getByRole("status")).toBeVisible();
    await expect(edit()).toBeVisible();
    // Nach dem Neuladen derselbe Stand: die Anzeige kommt vom Server, nicht aus dem Zustand der Komponente.
    await page.reload();
    await expect(current()).toContainText("Manual — any hoster");
    await expect(kind()).toHaveCount(0);
  });

  test("K7 Texte auf Deutsch; Zugangsdaten tauchen nie in Anzeige oder Antwort auf", { tag: "@t66" }, async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ baseURL: env("APP_URL"), locale: "de-DE" });
    try {
      const de = await ctx.newPage();
      await login(de, env("APP_USER"), env("APP_PASSWORD"));
      await de.goto(`/waves/${id}/dns`);
      await expect(de.locator(`#dns-current-${id}`)).toContainText("Manuell — jeder Hoster");
      await expect(de.locator(`#dns-current-${id}`)).toContainText("Eingerichtet");
      await expect(de.locator(`#dns-edit-${id}`)).toHaveText("Bearbeiten");
      await expect(de.locator(`#dns-remove-${id}`)).toHaveText("Entfernen");
      await expect(de.locator(`#dns-current-${id} input`)).toHaveCount(0);
    } finally {
      await ctx.close();
    }

    await open();
    await expect(edit()).toHaveText("Edit");
    await expect(remove()).toHaveText("Remove");
    const res = await page.request.get(`/api/waves/${id}/dns`);
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.provider).toBe("manual");
    for (const key of ["token", "password", "totpSecret", "user", "secret", "credentials"]) {
      expect(body).not.toHaveProperty(key);
    }
  });

  test("K5 Entfernen: Abbrechen der Rückfrage ändert nichts, Bestätigen führt in den Zustand ohne Provider", {
    tag: "@t66",
  }, async () => {
    await open();

    // Playwright schlägt eine Rückfrage ohne Handler selbst aus; hier entscheidet der Test.
    let answer: "dismiss" | "accept" = "dismiss";
    const asked: string[] = [];
    const onDialog = (dialog: Dialog) => {
      asked.push(dialog.message());
      void (answer === "accept" ? dialog.accept() : dialog.dismiss());
    };
    page.on("dialog", onDialog);
    try {
      // Vor der Hydration tut der Klick nichts; wiederholen, bis die Rückfrage kommt.
      await expect
        .poll(
          async () => {
            await remove().click();
            await page.waitForTimeout(300);
            return asked.length;
          },
          { timeout: 20_000 },
        )
        .toBeGreaterThan(0);
      expect(asked[0]).toContain("Remove the provider?");
      await expect(current()).toContainText("Manual — any hoster");
      await expect(edit()).toBeVisible();
      await expect(remove()).toBeVisible();
      await expect(kind()).toHaveCount(0);

      answer = "accept";
      await remove().click();
    } finally {
      page.off("dialog", onDialog);
    }
    await expect(current()).toHaveCount(0);
    await expect(page.getByText("No provider is set", { exact: false })).toBeVisible();
    await expect(kind()).toBeVisible();
    await expect(edit()).toHaveCount(0);
    await expect(remove()).toHaveCount(0);

    await page.reload();
    await expect(page.getByText("No provider is set", { exact: false })).toBeVisible();
    await expect(edit()).toHaveCount(0);
  });
});
