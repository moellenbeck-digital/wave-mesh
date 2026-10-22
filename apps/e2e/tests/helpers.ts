import { createHash } from "node:crypto";
import { type Browser, type BrowserContext, expect, type Locator, type Page } from "@playwright/test";

/** Umgebungsvariable des Werkzeugs `e2e-test`; fehlt sie, ist der Lauf falsch aufgerufen. */
export function env(name: "APP_URL" | "APP_USER" | "APP_PASSWORD" | "APP_TICKET"): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} ist nicht gesetzt (Aufruf über e2e-test ausfuehren)`);
  return value;
}

/**
 * Passwort eines Zweitkontos. Konten lassen sich in der Oberfläche nicht löschen und bleiben deshalb
 * zwischen Läufen bestehen; das Passwort folgt aus dem des Eigentümers und steht nirgends im Repo.
 */
export function passwordFor(email: string): string {
  return createHash("sha256")
    .update(`${env("APP_PASSWORD")}|${email}`)
    .digest("hex")
    .slice(0, 32);
}

export async function newSession(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ baseURL: env("APP_URL"), locale: "en-US" });
}

export async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.locator('form[action="/auth/password/login"] button[type="submit"]').click();
  await expect(page.locator("#email")).toHaveCount(0);
}

/** Legt eine Wave an und liefert ihre Karte auf `/`. */
export async function createWave(page: Page, name: string, suffix: string): Promise<Locator> {
  await page.goto("/waves/new");
  await page.locator("#name").fill(name);
  await page.locator("#suffix").fill(suffix);
  await page.locator('form[action="/waves"] button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname === "/");
  return waveCard(page, name);
}

export function waveCard(page: Page, name: string): Locator {
  return page.locator("section").filter({ has: page.getByRole("heading", { level: 2, name, exact: true }) });
}

export async function waveId(card: Locator): Promise<string> {
  const action = await card.locator('form[action$="/invites"]').first().getAttribute("action");
  const id = action?.match(/^\/waves\/([^/]+)\/invites$/)?.[1];
  if (!id) throw new Error(`Wave-ID nicht zu ermitteln (action=${action})`);
  return id;
}

/** Die Zeile einer Person in der Mitgliederliste. */
export function memberRow(card: Locator, email: string): Locator {
  return card.locator("li").filter({ has: card.page().getByText(email, { exact: true }) });
}

export async function userIdOf(row: Locator): Promise<string> {
  const action = await row.locator('form[action$="/role"]').getAttribute("action");
  const id = action?.match(/\/members\/([^/]+)\/role$/)?.[1];
  if (!id) throw new Error(`Nutzer-ID nicht zu ermitteln (action=${action})`);
  return id;
}

/** Lädt ein und liefert den Pfad `/invite/<token>`; der Link steht nur auf der Seite danach. */
export async function invite(page: Page, card: Locator, email: string, role: "member" | "admin") {
  const form = card.locator('form[action$="/invites"]');
  await form.locator('input[name="email"]').fill(email);
  await form.locator('select[name="role"]').selectOption(role);
  await form.locator('button[type="submit"]').click();
  await page.waitForURL(/\/waves\/[^/]+\/invited\?/);
  const link = (await page.locator("pre").innerText()).trim();
  const path = new URL(link).pathname;
  expect(path).toMatch(/^\/invite\/.+/);
  await page.goto("/");
  return path;
}

/**
 * Nimmt eine Einladung an. Hat die Adresse schon ein Konto (Wiederverwendung aus einem früheren Lauf),
 * wird angemeldet, sonst legt die Einladung es mit dem abgeleiteten Passwort an.
 */
export async function accept(page: Page, invitePath: string, email: string): Promise<void> {
  const token = invitePath.replace("/invite/", "");
  await page.goto(`/join/${token}`);
  const password = passwordFor(email);
  const claim = page.locator("#password");
  if (await claim.isVisible().catch(() => false)) {
    await claim.fill(password);
    await page.locator('form[action$="/claim"] button[type="submit"]').click();
  } else {
    await page.locator(`a[href^="/login"]`).first().click();
    await page.locator("#email").fill(email);
    await page.locator("#password").fill(password);
    await page.locator('form[action="/auth/password/login"] button[type="submit"]').click();
  }
  await page.waitForURL(/[?&]joined=/);
}

/** Wählt eine Rolle in der Zeile und speichert; wartet auf die Antwort des Control-Servers. */
export async function saveRole(page: Page, row: Locator, role: "member" | "admin"): Promise<void> {
  await row.locator('select[name="role"]').selectOption(role);
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/role") && r.request().method() === "POST"),
    row.getByRole("button", { name: "Save" }).click(),
  ]);
  await page.waitForURL((url) => url.pathname === "/");
}

/** Entfernt die Wave des Eigentümers (Eintippen des Namens); fehlt sie schon, ist das der gewollte Zustand. */
export async function deleteWave(page: Page, name: string): Promise<void> {
  await page.goto("/");
  const card = waveCard(page, name);
  if ((await card.count()) === 0) return;
  const details = card.locator("details").filter({ has: card.locator('form[action$="/delete"]') });
  await details.locator("summary").click();
  await details.locator('input[name="name"]').fill(name);
  await details.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname === "/");
  await expect(waveCard(page, name)).toHaveCount(0);
}
