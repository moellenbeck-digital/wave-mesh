/**
 * Ticket #35: Admins sollen im Control Server UI die Rollen der Benutzer ändern können.
 *
 * Aufbau: Der Eigentümer (APP_USER) legt eine eigene Wave an und lädt ein Mitglied als Admin und eines als
 * Member ein; beide Zweitkonten nehmen per Einladung an. Die Fälle bauen aufeinander auf (`serial`) und
 * ändern die Rollen in dieser Reihenfolge: A (Admin) → Member → Admin, dann befördert A das Mitglied M.
 * Am Ende entfernt der Eigentümer die Wave wieder; die Zweitkonten bleiben, weil die Oberfläche keine Konten
 * löscht (feste Adressen, siehe helpers.ts).
 *
 * Beschriftungen gelten für `en-US` (Config). Kriterium 9 (Einladen mit Rolle, Entfernen, Verlassen) steht
 * im ersten und im letzten Fall.
 *
 * Nicht prüfbar: dass die Änderung die `role:`-Regeln der ACL erreicht und die Geräte eine neue Netzkarte
 * bekommen — das braucht ein verbundenes Gerät und liegt außerhalb der Oberfläche (deckt `members.test.ts` ab).
 */
import { type BrowserContext, expect, type Locator, type Page, test } from "@playwright/test";
import {
  accept,
  createWave,
  deleteWave,
  env,
  invite,
  login,
  memberRow,
  newSession,
  saveRole,
  userIdOf,
  waveCard,
  waveId,
} from "./helpers.ts";

const run = Math.random().toString(36).slice(2, 8);
const waveName = `t35-${run}`;
const adminMail = "t35-admin@example.test";
const memberMail = "t35-member@example.test";

let owner: { ctx: BrowserContext; page: Page };
let admin: { ctx: BrowserContext; page: Page };
let member: { ctx: BrowserContext; page: Page };
let id: string;
let adminId: string;
let memberId: string;

const ownerMail = () => env("APP_USER");
const card = (page: Page): Locator => waveCard(page, waveName);
const select = (row: Locator) => row.locator('select[name="role"]');

async function open(who: { page: Page }): Promise<Locator> {
  await who.page.goto("/");
  const c = card(who.page);
  await expect(c).toHaveCount(1);
  return c;
}

async function session(browser: Parameters<typeof newSession>[0]) {
  const ctx = await newSession(browser);
  return { ctx, page: await ctx.newPage() };
}

test.describe("Rollen ändern", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    owner = await session(browser);
    admin = await session(browser);
    member = await session(browser);

    await login(owner.page, ownerMail(), env("APP_PASSWORD"));
    const c = await createWave(owner.page, waveName, `${waveName}.wave.internal`);
    id = await waveId(c);

    const adminLink = await invite(owner.page, c, adminMail, "admin");
    const memberLink = await invite(owner.page, c, memberMail, "member");
    await accept(admin.page, adminLink, adminMail);
    await accept(member.page, memberLink, memberMail);

    await owner.page.goto("/");
    adminId = await userIdOf(memberRow(card(owner.page), adminMail));
    memberId = await userIdOf(memberRow(card(owner.page), memberMail));
  });

  test.afterAll(async () => {
    try {
      if (owner) await deleteWave(owner.page, waveName);
    } finally {
      await Promise.all([owner?.ctx.close(), admin?.ctx.close(), member?.ctx.close()]);
    }
  });

  test("K9 Einladen mit Rolle: die Eingeladenen kommen mit der gewählten Rolle an", {
    tag: "@t35",
  }, async () => {
    const c = await open(owner);
    await expect(select(memberRow(c, adminMail))).toHaveValue("admin");
    await expect(select(memberRow(c, memberMail))).toHaveValue("member");
  });

  test("K1 Owner sieht bei jedem Nicht-Owner eine Rollenauswahl Member/Admin mit Speichern", {
    tag: "@t35",
  }, async () => {
    const c = await open(owner);
    for (const mail of [adminMail, memberMail]) {
      const row = memberRow(c, mail);
      await expect(select(row)).toHaveCount(1);
      await expect(select(row).locator("option")).toHaveText(["Member", "Administrator"]);
      await expect(row.getByRole("button", { name: "Save" })).toBeVisible();
    }
  });

  test("K2 Owner: Admin → Member speichern, Liste zeigt Member auch nach Neuladen", {
    tag: "@t35",
  }, async () => {
    const c = await open(owner);
    await saveRole(owner.page, memberRow(c, adminMail), "member");
    await expect(select(memberRow(card(owner.page), adminMail))).toHaveValue("member");
    await owner.page.reload();
    await expect(select(memberRow(card(owner.page), adminMail))).toHaveValue("member");
  });

  test("K3 Owner: Member → Admin speichern, Liste zeigt Admin auch nach Neuladen", {
    tag: "@t35",
  }, async () => {
    const c = await open(owner);
    await saveRole(owner.page, memberRow(c, adminMail), "admin");
    await expect(select(memberRow(card(owner.page), adminMail))).toHaveValue("admin");
    await owner.page.reload();
    await expect(select(memberRow(card(owner.page), adminMail))).toHaveValue("admin");
  });

  test("K7 Einfaches Member sieht in der Liste keine Rollenauswahl", { tag: "@t35" }, async () => {
    const c = await open(member);
    await expect(memberRow(c, ownerMail())).toHaveCount(1);
    await expect(memberRow(c, adminMail)).toContainText("Administrator");
    await expect(c.locator('form[action$="/role"]')).toHaveCount(0);
    await expect(c.locator('select[name="role"]')).toHaveCount(0);
  });

  test("K6 Owner-Zeile und eigene Zeile haben bei keinem Betrachter eine Rollenauswahl", {
    tag: "@t35",
  }, async () => {
    // Eigentümer: seine Zeile ist zugleich die Owner-Zeile.
    const co = await open(owner);
    await expect(memberRow(co, ownerMail())).toContainText("Owner");
    await expect(select(memberRow(co, ownerMail()))).toHaveCount(0);
    // Admin: Owner-Zeile und eigene Zeile.
    const ca = await open(admin);
    await expect(memberRow(ca, ownerMail())).toContainText("Owner");
    await expect(select(memberRow(ca, ownerMail()))).toHaveCount(0);
    await expect(memberRow(ca, adminMail)).toContainText("Administrator");
    await expect(select(memberRow(ca, adminMail))).toHaveCount(0);
    // Member: Owner-Zeile und eigene Zeile.
    const cm = await open(member);
    await expect(select(memberRow(cm, ownerMail()))).toHaveCount(0);
    await expect(memberRow(cm, memberMail)).toContainText("Member");
    await expect(select(memberRow(cm, memberMail))).toHaveCount(0);
  });

  test("K4 Admin befördert ein Member zum Admin, Liste zeigt Admin", { tag: "@t35" }, async () => {
    const c = await open(admin);
    const row = memberRow(c, memberMail);
    await expect(select(row)).toHaveValue("member");
    await saveRole(admin.page, row, "admin");
    await expect(memberRow(card(admin.page), memberMail)).toContainText("Administrator");
    await admin.page.reload();
    await expect(memberRow(card(admin.page), memberMail)).toContainText("Administrator");
  });

  test("K5 Admin darf einen anderen Admin herabstufen (seit #41): Auswahl sichtbar, direkter POST wirkt", {
    tag: "@t35",
  }, async () => {
    // Bis #41 durfte das nur der Eigentümer (Auswahl fehlte, POST lieferte 403); jetzt dürfen es alle, die verwalten.
    const c = await open(admin);
    const row = memberRow(c, memberMail);
    await expect(row).toContainText("Administrator");
    await expect(select(row)).toHaveCount(1);
    await expect(row.getByRole("button", { name: "Save" })).toBeVisible();

    const response = await admin.ctx.request.post(`/waves/${id}/members/${memberId}/role`, {
      form: { role: "member" },
      maxRedirects: 0,
    });
    expect(response.status()).toBe(303);

    // Die Rolle hat sich geändert (Sicht des Eigentümers).
    await open(owner);
    await expect(select(memberRow(card(owner.page), memberMail))).toHaveValue("member");
  });

  test("K8 Ungültige Rolle (owner, foo) per direktem POST liefert 400 und ändert nichts", {
    tag: "@t35",
  }, async () => {
    for (const role of ["owner", "foo"]) {
      const response = await owner.ctx.request.post(`/waves/${id}/members/${adminId}/role`, {
        form: { role },
        maxRedirects: 0,
      });
      expect(response.status(), `role=${role}`).toBe(400);
    }
    await open(owner);
    await expect(select(memberRow(card(owner.page), adminMail))).toHaveValue("admin");
    await expect(memberRow(card(owner.page), ownerMail())).toContainText("Owner");
  });

  test("K9 Regression Entfernen und Verlassen funktionieren unverändert", { tag: "@t35" }, async () => {
    // Entfernen: der Eigentümer nimmt M aus der Wave.
    const co = await open(owner);
    await Promise.all([
      owner.page.waitForResponse((r) => r.url().endsWith("/remove") && r.request().method() === "POST"),
      memberRow(co, memberMail).getByRole("button", { name: "Remove" }).click(),
    ]);
    await owner.page.waitForURL((url) => url.pathname === "/");
    await expect(memberRow(card(owner.page), memberMail)).toHaveCount(0);

    // Verlassen: A geht selbst.
    const ca = await open(admin);
    await ca.locator("summary", { hasText: "Leave wave" }).click();
    await Promise.all([
      admin.page.waitForResponse((r) => r.url().endsWith("/leave") && r.request().method() === "POST"),
      ca.getByRole("button", { name: "Leave this wave" }).click(),
    ]);
    await admin.page.waitForURL((url) => url.pathname === "/" || url.pathname.startsWith("/waves"));
    await owner.page.goto("/");
    await expect(memberRow(card(owner.page), adminMail)).toHaveCount(0);
    await expect(memberRow(card(owner.page), ownerMail())).toHaveCount(1);
  });
});
