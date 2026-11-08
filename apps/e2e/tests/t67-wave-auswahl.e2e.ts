/**
 * Ticket #67: Mehrere Waves nicht untereinander anzeigen.
 *
 * Aufbau: Der Eigentümer (APP_USER) legt zwei eigene Waves A und B an und lädt ein Zweitkonto in beide ein.
 * Die Fälle bauen aufeinander auf (`serial`). Am Ende entfernt der Eigentümer beide Waves wieder; das
 * Zweitkonto bleibt, weil die Oberfläche keine Konten löscht (feste Adresse, siehe helpers.ts).
 *
 * Der Eigentümer kann auf dem geteilten Dev-System weitere Waves haben; geprüft wird deshalb nie die
 * Gesamtzahl der Karten oder Einträge, sondern dass A und B nicht gleichzeitig zu sehen sind. Das
 * Zweitkonto hat dagegen genau die Waves dieses Laufs: erst A (kein Dropdown), dann B (Dropdown).
 *
 * Beschriftungen gelten für `en-US` (Config).
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
  waveCard,
  waveId,
} from "./helpers.ts";

const run = Math.random().toString(36).slice(2, 8);
const nameA = `t67-a-${run}`;
const nameB = `t67-b-${run}`;
const soloMail = "t67-solo@example.test";

let owner: { ctx: BrowserContext; page: Page };
let solo: { ctx: BrowserContext; page: Page };
let idA: string;
let idB: string;
let linkB: string;
let urlAfterCreatingB: string;

const dropdown = (page: Page) => page.locator("#wave-select");
const heading = (page: Page, name: string) => page.getByRole("heading", { level: 2, name, exact: true });

async function session(browser: Parameters<typeof newSession>[0]) {
  const ctx = await newSession(browser);
  return { ctx, page: await ctx.newPage() };
}

test.describe("Wave-Auswahl", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    owner = await session(browser);
    solo = await session(browser);
    await login(owner.page, env("APP_USER"), env("APP_PASSWORD"));

    const a = await createWave(owner.page, nameA, `${nameA}.wave.internal`);
    idA = await waveId(a);
    const linkA = await invite(owner.page, a, soloMail, "member");

    const b = await createWave(owner.page, nameB, `${nameB}.wave.internal`);
    idB = await waveId(b);
    urlAfterCreatingB = owner.page.url();
    linkB = await invite(owner.page, b, soloMail, "member");

    await accept(solo.page, linkA, soloMail);
  });

  test.afterAll(async () => {
    try {
      if (owner) {
        await deleteWave(owner.page, nameA);
        await deleteWave(owner.page, nameB);
      }
    } finally {
      await Promise.all([owner?.ctx.close(), solo?.ctx.close()]);
    }
  });

  test("K5 Genau ein Wave: kein Dropdown, die Karte wie bisher", { tag: "@t67" }, async () => {
    const { page } = solo;
    await page.goto("/");
    await expect(heading(page, nameA)).toBeVisible();
    await expect(dropdown(page)).toHaveCount(0);
  });

  test("Anlegen wählt die neue Wave: der Redirect nennt B, B ist vorgewählt, A nicht zu sehen", {
    tag: "@t67",
  }, async () => {
    const { page } = owner;
    expect(new URL(urlAfterCreatingB).searchParams.get("wave")).toBe(idB);
    await page.goto(urlAfterCreatingB);
    await expect(heading(page, nameB)).toBeVisible();
    await expect(heading(page, nameA)).toHaveCount(0);
    await expect(dropdown(page).locator("option:checked")).toHaveText(nameB);
  });

  test("K1 Mehrere Waves: genau eine Karte, nicht A und B untereinander", { tag: "@t67" }, async () => {
    const { page } = owner;
    await page.goto(`/?wave=${idA}`);
    await expect(heading(page, nameA)).toBeVisible();
    await expect(heading(page, nameB)).toHaveCount(0);
    await expect(page.locator('form[action$="/invites"]')).toHaveCount(1);
  });

  test("K2 Das Dropdown führt alle Waves auf, die aktuelle ist vorgewählt, mit Beschriftung", {
    tag: "@t67",
  }, async () => {
    const { page } = owner;
    await page.goto(`/?wave=${idA}`);
    const select = dropdown(page);
    await expect(select).toBeVisible();
    await expect(page.getByLabel("Choose wave")).toHaveCount(1);
    await expect(select.locator("option", { hasText: nameA })).toHaveCount(1);
    await expect(select.locator("option", { hasText: nameB })).toHaveCount(1);
    await expect(select.locator("option:checked")).toHaveText(nameA);
    expect(await select.getAttribute("class")).toContain("wc-input");
  });

  test("K3 Wechsel im Dropdown zeigt die andere Karte, ohne die Seite zu verlassen, und behält ?joined=", {
    tag: "@t67",
  }, async () => {
    const { page } = owner;
    await page.goto(`/?joined=Demo&wave=${idA}`);
    await expect(heading(page, nameA)).toBeVisible();
    // Vor der Hydration geht ein Wechsel verloren; wiederholen, bis die Karte wechselt.
    await expect(async () => {
      await dropdown(page).selectOption({ label: nameB });
      await expect(heading(page, nameB)).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await expect(heading(page, nameA)).toHaveCount(0);
    const url = new URL(page.url());
    expect(url.pathname).toBe("/");
    expect(url.searchParams.get("wave")).toBe(idB);
    expect(url.searchParams.get("joined")).toBe("Demo");
    await expect(dropdown(page).locator("option:checked")).toHaveText(nameB);
  });

  test("K4 Die Auswahl übersteht Neuladen und das erneute Öffnen von /", { tag: "@t67" }, async () => {
    const { page } = owner;
    await page.goto(`/?wave=${idA}`);
    await expect(dropdown(page).locator("option:checked")).toHaveText(nameA);
    await page.reload();
    await expect(heading(page, nameA)).toBeVisible();
    await expect(dropdown(page).locator("option:checked")).toHaveText(nameA);

    // Ohne Parameter gilt das Cookie. Die Karte selbst wählt die Wave, das Cookie schreibt die Seite.
    await expect
      .poll(async () => (await owner.ctx.cookies()).find((c) => c.name === "wave_current")?.value)
      .toBe(idA);
    await page.goto("/");
    await expect(heading(page, nameA)).toBeVisible();
    await expect(heading(page, nameB)).toHaveCount(0);

    // Und der Wechsel auf B bleibt ebenso stehen.
    await (await waveCard(page, nameB)).waitFor();
    await expect
      .poll(async () => (await owner.ctx.cookies()).find((c) => c.name === "wave_current")?.value)
      .toBe(idB);
    await page.goto("/");
    await expect(heading(page, nameB)).toBeVisible();
    await expect(heading(page, nameA)).toHaveCount(0);
  });

  test("Ein ungültiger Parameter fällt auf das Cookie zurück", { tag: "@t67" }, async () => {
    const { page } = owner;
    await page.goto(`/?wave=${idA}`);
    await expect(heading(page, nameA)).toBeVisible();
    await expect
      .poll(async () => (await owner.ctx.cookies()).find((c) => c.name === "wave_current")?.value)
      .toBe(idA);
    await page.goto("/?wave=gibt-es-nicht");
    await expect(heading(page, nameA)).toBeVisible();
  });

  test("Beitreten wählt die neue Wave: nach der zweiten Einladung zeigt das Zweitkonto B mit Dropdown", {
    tag: "@t67",
  }, async () => {
    const { page } = solo;
    await page.goto(linkB.replace("/invite/", "/join/"));
    await page.locator('a[href^="/invite/"]').click();
    await page.waitForURL(/[?&]joined=/);
    expect(new URL(page.url()).searchParams.get("wave")).toBe(idB);
    await expect(heading(page, nameB)).toBeVisible();
    await expect(heading(page, nameA)).toHaveCount(0);
    await expect(dropdown(page).locator("option:checked")).toHaveText(nameB);
    await expect(dropdown(page).locator("option", { hasText: nameA })).toHaveCount(1);
  });

  test("Nach dem Löschen der gewählten Wave fällt die Auswahl auf eine verbleibende zurück", {
    tag: "@t67",
  }, async () => {
    const { page } = owner;
    await page.goto(`/?wave=${idB}`);
    await deleteWave(page, nameB);
    await page.goto(`/?wave=${idB}`);
    await expect(heading(page, nameB)).toHaveCount(0);
    await expect(page.locator("section h2").first()).toBeVisible();
  });
});
