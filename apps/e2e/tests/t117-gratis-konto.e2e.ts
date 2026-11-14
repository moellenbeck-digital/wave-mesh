/**
 * Ticket #117 (Nacharbeit): Gratis-Konto, Grenzen, Plan und Nutzung in der Oberfläche.
 *
 * Voraussetzung: Das Testsystem ist ein **gehosteter** Server, also mit `WAVE_BILLING_TOKEN`. Nur dort
 * gibt es Kundenkonten und Grenzen; auf einem selbst betriebenen Server (wie bei `t114`/`t116`) kommt
 * `/api/me` ohne Plan-Block, und es gibt nichts zu beobachten. Fehlt der Block, überspringen die Fälle
 * mit Grund, statt etwas Falsches zu behaupten.
 *
 * Ein bestätigtes Zweitkonto (`t117-nutzer@example.test`, feste Adresse, abgeleitetes Passwort, wird
 * wiederverwendet) startet das Gratis-Konto. Es entsteht über eine Einladung des Eigentümers
 * (APP_USER) in eine eigene Wave, denn nur so legt die Oberfläche ein bestätigtes Konto an. Die
 * Einladung belegt einen Platz im Konto des Eigentümers; die Wave heißt mit Lauf-Kennung und wird am
 * Ende gelöscht. Alle Waves des Zweitkontos heißen `t117-…` und werden am Anfang (Reste eines
 * abgebrochenen Laufs) und am Ende entfernt.
 *
 * - C1 „Gratis-Start mit zwei Waves“: Das Zweitkonto legt zwei Waves an. `/api/me` meldet einen Plan
 *   „free“ mit Grenzen 3 Waves / 3 Personen / 100 Geräte und 2 Waves in der Nutzung, ein Konto ist da.
 * - C2 „Dritter Wave geht, vierter wird abgewiesen“: Der dritte Wave entsteht. Danach zeigt `/waves/new`
 *   „Free limit reached“ statt des Formulars, und ein direktes POST wird mit 403 und dem Code
 *   `wave-limit` abgewiesen. Es entsteht kein vierter Wave.
 * - C3 „Vierte Person bei den Einladungen“: In einer der Waves sind das Konto-Mitglied und zwei
 *   Einladungen drei Personen; die vierte Einladung zeigt „No room for another person“.
 * - C4 „Konto-Bereich“: `/account` zeigt den Plan „Free“ und die Nutzung mit 3 von 3 Waves und 3 von 3
 *   Personen, ohne Überhang.
 *
 * Nicht über die Oberfläche prüfbar, mit Grund (Beleg: `apps/control/test/account-overview.test.ts`,
 * `free-accounts.test.ts`, `account-subscriptions.test.ts`):
 * - Überhang mit Zahlen und je Wave Personen und Geräte, Konto-Abo und Kündigung: Ein Konto-Abo setzt nur
 *   die Seite über die Abrechnungs-API (mit Token), und Geräte lassen sich nur mit signierter
 *   Registrierung anlegen. Belege: „after a cancellation the account is free again, and the overhang is
 *   concrete“ (Control) und `account-usage.test.tsx` (Darstellung, Deutsch und Englisch).
 * - `downgrade-check`: Bearer-Token der Abrechnung, nicht in der Oberfläche. Belege: die Tests zu
 *   `GET /api/billing/accounts/:id/downgrade-check`.
 *
 * Beschriftungen gelten für `en-US` (Config); Selektoren sonst über `name`, `action` und `data-*`.
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

type Sess = { ctx: BrowserContext; page: Page };

const run = Math.random().toString(36).slice(2, 8);
const host = `t117-host-${run}`;
const userMail = "t117-nutzer@example.test";
const names = [`t117-a-${run}`, `t117-b-${run}`, `t117-c-${run}`];
const fourth = `t117-d-${run}`;

let owner: Sess;
let user: Sess;
let hostSkipped: string | undefined;

async function session(browser: Parameters<typeof newSession>[0]): Promise<Sess> {
  const ctx = await newSession(browser);
  return { ctx, page: await ctx.newPage() };
}

interface Me {
  canCreateWave: boolean;
  waveCreation?: { allowed: boolean; reason: string | null };
  waves: { id: string; name: string }[];
  account?: {
    accountId?: string | null;
    plan?: "free" | "paid";
    limits?: { waves: number | null; people: number | null; devices: number | null };
    usage?: { waves: number; people: number; devices: number };
    overhang?: { waves: number; people: number; devices: number };
  };
}

async function me(page: Page): Promise<Me> {
  const res = await page.request.get("/api/me");
  expect(res.status()).toBe(200);
  return (await res.json()) as Me;
}

/** Räumt die Waves des Zweitkontos auf, die dieser Test anlegt oder ein früherer Lauf liegen ließ. */
async function cleanUser(page: Page): Promise<void> {
  const state = await me(page);
  for (const wave of state.waves) {
    if (wave.name.startsWith("t117-")) await deleteWave(page, wave.name).catch(() => undefined);
  }
}

test.describe("Gratis-Konto: Start, Grenzen, Konto-Bereich", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    owner = await session(browser);
    await login(owner.page, env("APP_USER"), env("APP_PASSWORD"));
    // Gehostet? Nur dann trägt `/api/me` den Plan-Block.
    const mine = await me(owner.page);
    if (!mine.account?.plan) {
      hostSkipped =
        "Das Testsystem ist selbst betrieben (kein Plan-Block in /api/me): ohne WAVE_BILLING_TOKEN gibt es keine Gratis-Konten.";
      return;
    }

    await owner.page.goto("/");
    const card = await createWave(owner.page, host, `${host}.wave.internal`);
    const link = await invite(owner.page, card, userMail, "member");
    user = await session(browser);
    await accept(user.page, link, userMail);
    // Reste eines früheren Laufs, bevor gezählt wird.
    await cleanUser(user.page);
  });

  test.afterAll(async () => {
    test.setTimeout(240_000);
    const attempt = async (step: () => Promise<unknown>) => {
      try {
        await step();
      } catch {
        // Aufräumen läuft weiter; ein Rest steht im Bericht, nicht hier.
      }
    };
    if (user) await attempt(() => cleanUser(user.page));
    if (owner) await attempt(() => deleteWave(owner.page, host));
    await Promise.all([owner, user].map((s) => s?.ctx.close().catch(() => undefined)));
  });

  test.beforeEach(() => {
    test.skip(hostSkipped !== undefined, hostSkipped);
  });

  test("C1 Gratis-Start: zwei Waves, Plan free, Grenzen und Nutzung in /api/me", {
    tag: "@t117",
  }, async () => {
    const { page } = user;
    for (const name of names.slice(0, 2)) {
      const card = await createWave(page, name, `${name}.wave.internal`);
      await expect(card).toHaveCount(1);
    }
    const state = await me(page);
    expect(state.account?.plan).toBe("free");
    expect(state.account?.accountId).toBeTruthy();
    expect(state.account?.limits).toEqual({ waves: 3, people: 3, devices: 100 });
    expect(state.account?.usage?.waves).toBe(2);
    expect(state.account?.overhang).toMatchObject({ waves: 0, people: 0, devices: 0 });
    expect(state.canCreateWave).toBe(true);
  });

  test("C2 Dritter Wave geht, danach „Free limit reached“ und 403 wave-limit", { tag: "@t117" }, async () => {
    const { page } = user;
    const card = await createWave(page, names[2] ?? "", `${names[2]}.wave.internal`);
    await expect(card).toHaveCount(1);

    const state = await me(page);
    expect(state.canCreateWave).toBe(false);
    expect(state.waveCreation).toMatchObject({ allowed: false, reason: "wave-limit" });

    // Die Oberfläche bietet kein Formular mehr an, sondern den Grund.
    await page.goto("/waves/new");
    await expect(page.getByRole("heading", { name: "Free limit reached" })).toBeVisible();
    await expect(page.locator('form[action="/waves"]')).toHaveCount(0);

    // Ein POST braucht kein Formular: der Server weist ihn mit stabilem Code ab.
    const res = await page.request.post("/waves", {
      headers: { accept: "application/json" },
      form: { name: fourth, suffix: `${fourth}.wave.internal` },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("wave-limit");
    const after = await me(page);
    expect(after.waves.some((w) => w.name === fourth)).toBe(false);
    expect(after.account?.usage?.waves).toBe(3);
  });

  test("C3 Vierte Person: „No room for another person“", { tag: "@t117" }, async () => {
    const { page } = user;
    await page.goto("/");
    const card = await waveCard(page, names[0] ?? "");
    const id = await waveId(card);
    const send = async (email: string) => {
      const res = await page.request.post(`/waves/${id}/invites`, {
        form: { email, role: "member" },
        maxRedirects: 0,
      });
      return res;
    };
    // Das Konto-Mitglied ist die erste Person, zwei Einladungen füllen die drei Plätze.
    expect([200, 303]).toContain((await send(`t117-p1-${run}@example.test`)).status());
    expect([200, 303]).toContain((await send(`t117-p2-${run}@example.test`)).status());

    const refused = await send(`t117-p3-${run}@example.test`);
    expect(refused.status()).toBe(409);
    expect(await refused.text()).toContain("No room for another person");
  });

  test("C4 Konto-Bereich zeigt Plan und Nutzung gegen die Grenzen, ohne Überhang", {
    tag: "@t117",
  }, async () => {
    const { page } = user;
    await page.goto("/account");
    const plan = page.locator("#plan");
    await expect(plan).toBeVisible();
    await expect(plan).toHaveAttribute("data-plan", "free");
    await expect(plan.locator('[data-field="plan"]')).toHaveText("Free");

    const usage = (key: "waves" | "people" | "devices") => plan.locator(`[data-usage="${key}"]`);
    await expect(usage("waves")).toContainText("of 3");
    await expect(usage("waves").locator('[data-field="used"]')).toHaveText("3");
    await expect(usage("people")).toContainText("of 3");
    await expect(usage("people").locator('[data-field="used"]')).toHaveText("3");
    await expect(usage("devices")).toContainText("of 100");
    await expect(plan.locator("[data-overhang]")).toHaveCount(0);

    // Dieselbe Wahrheit auf der Schnittstelle: die Seite zeigt, was /api/me meldet.
    const state = await me(page);
    expect(state.account?.usage).toMatchObject({ waves: 3, people: 3 });
  });
});
