/**
 * Ticket #31: Konto in der Weboberfläche löschen (`/account/delete`; Google Play, DSGVO Art. 17).
 *
 * Jeder Fall ist ein Kriterium des Tickets:
 *
 * - L1 „Ohne Sitzung leitet `/account/delete` zum Login und danach zurück“: frische Sitzung, Aufruf der Seite,
 *   Anmeldung auf der Login-Seite, danach steht die Sitzung wieder auf `/account/delete`.
 * - L2 „Die Vorschau zeigt die Folgen“: Mitglied einer fremden Wave sieht sie unter „verlassen“, das Feld
 *   verlangt die Adresse, kein Code-Feld (kein TOTP), die Schaltfläche wartet auf die Eingabe.
 * - L3 „Falsche Adresse löscht nichts“: eigene Meldung, `/api/me` antwortet danach weiter mit 200.
 * - L4 „Löschen mit Adresse, Groß-/Kleinschreibung egal; danach ist die Anmeldung nicht mehr möglich“: Seite
 *   „Konto gelöscht“, `/api/me` 401, Login mit denselben Daten abgelehnt, die Wave des Eigentümers bleibt.
 * - L5 „Letzter Administrator mit weiteren Mitgliedern: Meldung mit Namen, Formular gesperrt“.
 * - L6 „Nach Übergabe oder Löschen der Wave geht es durch“: A löscht die Wave und danach das Konto; B löscht seins.
 *
 * Nicht über die Oberfläche prüfbar, mit Grund:
 * - Der Fall `confirmation: "word"` (Konto ohne Adresse, z. B. Instagram) und der TOTP-Code: Dafür braucht es ein
 *   Konto ohne Adresse bzw. mit eingerichtetem zweiten Faktor, und ein Code wäre nur mit dem Geheimnis aus der
 *   Einrichtung zu berechnen, das der Test nicht kennt. Beleg: `apps/web/test/delete-account.test.tsx` (Seite)
 *   und `apps/control/test/account-delete.test.ts` (Server).
 * - Abgerechnete Waves mit Kundenportal-Hinweis: Das Testsystem hat keine Bezahl-Waves. Beleg: ebenda.
 * - Zweisprachigkeit: Die Konfiguration setzt `en-US`; Deutsch belegt der Unit-Test.
 *
 * Testdaten: Alle Konten haben Adressen mit Lauf-Kennung und abgeleitetes Passwort (`helpers.ts`) und werden im
 * Test selbst gelöscht, auch das ist der Gegenstand des Tickets; die Waves entfernt der Besitzer. `afterAll`
 * räumt Reste best effort weg. Selektoren: `id`, `name`, `data-testid`; Beschriftungen nur `en-US`.
 */
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import {
  accept,
  createWave,
  deleteWave,
  env,
  invite,
  login,
  newSession,
  passwordFor,
  waveCard,
} from "./helpers.ts";

type Sess = { ctx: BrowserContext; page: Page };

const run = Math.random().toString(36).slice(2, 8);
const sharedWave = `t31-shared-${run}`;
const teamWave = `t31-team-${run}`;
const mailM = `t31-m-${run}@example.test`;
const mailA = `t31-a-${run}@example.test`;
const mailB = `t31-b-${run}@example.test`;

let owner: Sess;
const sessions: Partial<Record<"m" | "a" | "b", Sess>> = {};
const gone = new Set<string>();
let teamCreated = false;

async function session(browser: Browser): Promise<Sess> {
  const ctx = await newSession(browser);
  return { ctx, page: await ctx.newPage() };
}

async function signInOnLoginPage(page: Page, email: string): Promise<void> {
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(passwordFor(email));
  await page.locator('form[action="/auth/password/login"] button[type="submit"]').click();
}

async function status(page: Page): Promise<number> {
  return (await page.request.get("/api/me")).status();
}

/** Löscht das Konto der Sitzung über die Seite, mit der Adresse in anderer Schreibweise. */
async function deleteAccountOf(page: Page, email: string): Promise<void> {
  await page.goto("/account/delete");
  await page.locator("#delete-confirm").fill(email.toUpperCase());
  await page.locator('#delete-form button[type="submit"]').click();
  await expect(page.getByTestId("delete-done")).toBeVisible();
  gone.add(email);
}

test.describe("Konto löschen in der Weboberfläche", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    owner = await session(browser);
    const { page } = owner;
    await login(page, env("APP_USER"), env("APP_PASSWORD"));

    // Die Wave des Eigentümers, in die M als einfaches Mitglied und A als Mitglied eintreten: Das Konto entsteht
    // mit der Einladung.
    const card = await createWave(page, sharedWave, `${sharedWave}.wave.internal`);
    for (const mail of [mailM, mailA]) {
      const path = await invite(page, card, mail, "member");
      const guest = await session(browser);
      await accept(guest.page, path, mail);
      sessions[mail === mailM ? "m" : "a"] = guest;
      await page.goto("/");
    }
  });

  test.afterAll(async () => {
    test.setTimeout(240_000);
    const attempt = async (step: () => Promise<unknown>) => {
      try {
        await step();
      } catch {
        // Aufräumen läuft weiter.
      }
    };
    // Reste: Konten, die der Test nicht mehr bis zum Löschen gebracht hat.
    for (const [key, mail] of [
      ["a", mailA],
      ["b", mailB],
      ["m", mailM],
    ] as const) {
      const guest = sessions[key];
      if (!guest || gone.has(mail)) continue;
      await attempt(async () => {
        if (key === "a" && teamCreated) await deleteWave(guest.page, teamWave);
        await deleteAccountOf(guest.page, mail);
      });
    }
    if (owner) await attempt(() => deleteWave(owner.page, sharedWave));
    await Promise.all(
      [owner, sessions.m, sessions.a, sessions.b].map((s) => s?.ctx.close().catch(() => undefined)),
    );
  });

  test("L1 ohne Sitzung führt die Seite zum Login und danach zurück", { tag: "@t31" }, async ({
    browser,
  }) => {
    const anonymous = await session(browser);
    try {
      await anonymous.page.goto("/account/delete");
      await expect(anonymous.page).toHaveURL(
        (url) => url.pathname === "/login" && url.searchParams.get("next") === "/account/delete",
      );
      await signInOnLoginPage(anonymous.page, mailM);
      await expect(anonymous.page).toHaveURL((url) => url.pathname === "/account/delete");
      await expect(anonymous.page.locator("#delete-form")).toBeVisible();
    } finally {
      await anonymous.ctx.close();
    }
  });

  test("L2 die Vorschau nennt die Folgen, das Formular verlangt die Adresse", { tag: "@t31" }, async () => {
    const m = sessions.m;
    if (!m) throw new Error("Sitzung von M fehlt");
    await m.page.goto("/account");
    await m.page.locator('a[href="/account/delete"]').click();
    await expect(m.page).toHaveURL((url) => url.pathname === "/account/delete");

    // M ist einfaches Mitglied der Wave des Eigentümers: sie bleibt, M verlässt sie.
    await expect(m.page.getByTestId("delete-left")).toContainText(sharedWave);
    await expect(m.page.getByTestId("delete-deleted")).toHaveCount(0);
    await expect(m.page.getByTestId("delete-blocked")).toHaveCount(0);
    await expect(m.page.locator("#delete-confirm")).toHaveAttribute("type", "email");
    await expect(m.page.locator("#delete-code")).toHaveCount(0);
    await expect(m.page.locator('#delete-form button[type="submit"]')).toBeDisabled();
  });

  test("L3 eine falsche Adresse löscht nichts und bekommt eine eigene Meldung", { tag: "@t31" }, async () => {
    const m = sessions.m;
    if (!m) throw new Error("Sitzung von M fehlt");
    await m.page.goto("/account/delete");
    await m.page.locator("#delete-confirm").fill(`other-${run}@example.test`);
    await m.page.locator('#delete-form button[type="submit"]').click();
    await expect(m.page.getByTestId("delete-error")).toBeVisible();
    await expect(m.page.getByTestId("delete-done")).toHaveCount(0);
    expect(await status(m.page)).toBe(200);
  });

  test("L4 Löschen mit der Adresse in anderer Schreibweise; danach ist die Anmeldung nicht mehr möglich", {
    tag: "@t31",
  }, async ({ browser }) => {
    const m = sessions.m;
    if (!m) throw new Error("Sitzung von M fehlt");
    await deleteAccountOf(m.page, mailM);
    expect(await status(m.page)).toBe(401);

    // Mit denselben Daten geht es nicht mehr.
    const again = await session(browser);
    try {
      await again.page.goto("/login");
      await signInOnLoginPage(again.page, mailM);
      await expect(again.page.locator("#email")).toBeVisible();
      expect(await status(again.page)).toBe(401);
    } finally {
      await again.ctx.close();
    }

    // Die Wave des Eigentümers bleibt, ohne M.
    await owner.page.goto("/");
    const card = await waveCard(owner.page, sharedWave);
    await expect(card).toHaveCount(1);
    await expect(card.getByText(mailM, { exact: true })).toHaveCount(0);
  });

  test("L5 letzter Administrator mit weiteren Mitgliedern: Meldung mit Namen, Formular gesperrt", {
    tag: "@t31",
  }, async ({ browser }) => {
    const a = sessions.a;
    if (!a) throw new Error("Sitzung von A fehlt");
    // A besitzt eine eigene Wave mit B darin; ohne Wave-Anlage (hosted, Grenze) lässt sich der Fall nicht bauen.
    const me = (await (await a.page.request.get("/api/me")).json()) as { canCreateWave?: boolean };
    test.skip(me.canCreateWave === false, "A darf auf diesem System keine Wave anlegen");
    const card = await createWave(a.page, teamWave, `${teamWave}.wave.internal`);
    teamCreated = true;
    const path = await invite(a.page, card, mailB, "member");
    const b = await session(browser);
    sessions.b = b;
    await accept(b.page, path, mailB);

    await a.page.goto("/account/delete");
    const blocked = a.page.getByTestId("delete-blocked");
    await expect(blocked).toBeVisible();
    await expect(blocked).toContainText(teamWave);
    await expect(a.page.locator("#delete-confirm")).toBeDisabled();
    await expect(a.page.locator('#delete-form button[type="submit"]')).toBeDisabled();
    // Keine Folgenliste, solange nichts passieren kann.
    await expect(a.page.getByTestId("delete-left")).toHaveCount(0);
    expect(await status(a.page)).toBe(200);
  });

  test("L6 nach dem Löschen der Wave geht es durch, und auch B kann gehen", { tag: "@t31" }, async () => {
    const a = sessions.a;
    const b = sessions.b;
    test.skip(!teamCreated || !a || !b, "L5 hat die Wave nicht angelegt");
    if (!a || !b) return;
    await deleteWave(a.page, teamWave);
    teamCreated = false;

    await a.page.goto("/account/delete");
    await expect(a.page.getByTestId("delete-blocked")).toHaveCount(0);
    await expect(a.page.locator("#delete-confirm")).toBeEnabled();
    await deleteAccountOf(a.page, mailA);
    expect(await status(a.page)).toBe(401);

    // B war nur in der gelöschten Wave: auch dieses Konto geht ohne Hindernis.
    await deleteAccountOf(b.page, mailB);
    expect(await status(b.page)).toBe(401);
  });
});
