/**
 * Ticket #114: Gehostetes Kundenkonto einführen und bestehende Waves migrieren.
 *
 * Das Kundenkonto (`customer_accounts`, `waves.account_id`) ist weder in `/api/me` noch in der Oberfläche
 * oder einer anderen Route zu sehen (`grep` über `apps/control/src/routes` und `apps/web/src`: kein Treffer).
 * Beobachtbar ist deshalb nur, was die Änderung für Wave, Mitglieder und Wave-Anlage nicht verändern darf.
 * Jeder Fall ist ein Kriterium des Tickets, soweit die Oberfläche es hergibt:
 *
 * - S1–S3 „Selfhosting ohne Abrechnung bleibt unbegrenzt, kein Kundenkonto nötig“: Wave ohne Abo anlegen,
 *   mehrere Mitglieder und mehrere Waves ohne Sperre. Das Testsystem ist hier der selbst betriebene Fall:
 *   `canCreateWave` ist wahr, `billing` einer Wave ist `null`. `createWave()` ohne Kontoangabe lässt
 *   `waves.account_id` leer; ginge dabei etwas schief, bliebe die Karte aus oder die Seite zeigte eine
 *   Konto-, Kontingent- oder Pausenmeldung.
 * - B1 „Keine erneute Geräteanmeldung, bestehende Waves und Mitglieder bleiben“: Wave-ID, Wave-Liste,
 *   Rollen, Mitgliederliste und Geräteliste, gelesen aus `/api/me`, der Mitgliederliste der Karte und
 *   `/api/waves/<id>/nodes`, sind nach Neuladen und in einer neuen Sitzung unverändert. Die Wave-ID
 *   trägt die Geräteanmeldung (Auth-Keys hängen an ihr); bleibt sie, braucht kein Gerät eine neue.
 *
 * Nicht über die Oberfläche prüfbar, mit Grund (Belege: Unit- und CLI-Tests aus PR #121):
 * - `wave-admin migrate-accounts`, Idempotenz (zweiter Lauf „nichts zu tun“, keine Schreibzugriffe): Es ist
 *   ein Kommando am Datenbestand des Servers (`kubectl exec … wave-admin migrate-accounts`), das das
 *   Testsystem von außen nicht aufruft. Beleg: `apps/control/test/migrate-accounts.test.ts`.
 * - `migrate-accounts` stoppt bei unklaren Fällen mit Bericht (doppelte Adresse, abweichender Eigentümer,
 *   keine Adresse), ohne zu schreiben, Exit ≠ 0: Ausgabe und Exit-Code gibt es nur auf der Konsole, die
 *   Fälle verlangen Datenbankzustände, die in der Oberfläche nicht herzustellen sind (z. B. ein Eigentümer
 *   ohne Adresse). Beleg: `apps/control/test/migrate-accounts.test.ts`.
 * - Genau ein Konto je Bezahlkunde: Das Konto kommt in keiner Antwort vor (siehe oben), und das Testsystem
 *   hat keine Bezahl-Waves, die Test-Waves haben kein Abo. Beleg: `apps/control/test/customer-accounts.test.ts`
 *   und `migrate-accounts.test.ts`.
 * - Das alte Control-Image läuft gegen das neue Schema (Rückfall): Das Austauschen des Images liegt außerhalb
 *   des Browsers. Beleg: `apps/control/test/customer-accounts-rollback.test.ts`.
 * - Der Zustand auf `dev` (vorhandene Waves nach dem Rollout, Migration gelaufen): Dieser Lauf prüft das
 *   Testsystem mit eigenen Testdaten und kennt die Waves auf `dev` nicht; fremde Daten werden nie angefasst.
 *   Die Migration ist ein Betriebsschritt nach dem Rollout (`--dry-run`, dann ohne Flag).
 * - Gerätelisten mit echten Geräten: Eine Geräteanmeldung entsteht nur durch die signierte Registrierung
 *   eines Clients (`/v1/machine/register`), ohne Client hat keine Wave ein Gerät. B1 belegt deshalb „keine
 *   Geräte verloren“ nur über die unveränderte (leere) Liste und die unveränderte Wave-ID.
 * - Kontingent-Durchsetzung: Sie ist nicht Teil des Tickets (`ensureSeatFor()` zählt weiter je Wave) und
 *   bei Waves ohne Abo nicht vorhanden; S2 prüft nur, dass sie nicht greift.
 *
 * Testdaten: Der Eigentümer (APP_USER) legt zwei Waves mit Lauf-Kennung im Namen an und lädt zwei Mitglieder
 * ein (Adressen mit Lauf-Kennung, abgeleitetes Passwort, siehe `helpers.ts`). Die Waves werden am Ende
 * entfernt; Konten lassen sich in der Oberfläche nicht löschen und bleiben bestehen (README), wie bei #78.
 *
 * Beschriftungen gelten für `en-US` (Config); Selektoren sonst über `name`, `action`, Rolle. Die
 * Fehlermeldungen werden zusätzlich sprachunabhängig über `/api/me` (`canCreateWave`, `billing`) ausgeschlossen.
 */
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import {
  accept,
  createWave,
  deleteWave,
  env,
  invite,
  login,
  memberRow,
  newSession,
  userIdOf,
  waveCard,
  waveId,
} from "./helpers.ts";

type Sess = { ctx: BrowserContext; page: Page };

const run = Math.random().toString(36).slice(2, 8);
const waveOne = `t114-wave-1-${run}`;
const waveTwo = `t114-wave-2-${run}`;
const mailOne = `t114-m1-${run}@example.test`;
const mailTwo = `t114-m2-${run}@example.test`;

let owner: Sess;
const members: Partial<Record<"one" | "two", Sess>> = {};
let waveOneId: string | undefined;
let waveTwoId: string | undefined;

async function session(browser: Parameters<typeof newSession>[0]): Promise<Sess> {
  const ctx = await newSession(browser);
  return { ctx, page: await ctx.newPage() };
}

interface Me {
  canCreateWave: boolean;
  waves: { id: string; name: string; role: string; billing: unknown }[];
}

async function me(page: Page): Promise<Me> {
  const res = await page.request.get("/api/me");
  expect(res.status()).toBe(200);
  return (await res.json()) as Me;
}

/** Texte, die bei Kontingent, Pause, Kundenkonto oder gesperrter Wave-Anlage erscheinen würden (en-US). */
const refusal = (page: Page) =>
  page.getByText(/No seat left|booked for \d+ people|This wave is paused|Waves come with a subscription/);

async function expectNoRefusal(page: Page): Promise<void> {
  await expect(refusal(page)).toHaveCount(0);
}

/** Geräteliste einer Wave, wie die Oberfläche sie bezieht. */
async function nodesOf(page: Page, id: string): Promise<unknown> {
  const res = await page.request.get(`/api/waves/${id}/nodes`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { nodes: unknown }).nodes;
}

/** Der Zustand, der „unverändert“ bleiben muss: Waves, Mitglieder mit Rolle und Nutzer-ID, Geräte. */
async function ownerState(page: Page) {
  await page.goto("/");
  const card = await waveCard(page, waveOne);
  await expect(card).toHaveCount(1);
  const id = await waveId(card);
  const rows: Record<string, string> = {};
  for (const mail of [mailOne, mailTwo]) {
    const row = memberRow(card, mail);
    await expect(row).toHaveCount(1);
    rows[`${mail}|${await row.locator('select[name="role"]').inputValue()}`] = await userIdOf(row);
  }
  const state = await me(page);
  return {
    waves: state.waves
      .map((w) => ({ id: w.id, name: w.name, role: w.role }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    waveOneId: id,
    members: rows,
    nodes: await nodesOf(page, id),
  };
}

test.describe("Kundenkonto: Selfhosting bleibt unbegrenzt, Waves und Mitglieder bleiben", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000);
    owner = await session(browser);
    await login(owner.page, env("APP_USER"), env("APP_PASSWORD"));
  });

  test.afterAll(async () => {
    test.setTimeout(240_000);
    const attempt = async (step: () => Promise<unknown>) => {
      try {
        await step();
      } catch {
        // Aufräumen läuft weiter; ein Rest steht im Bericht des Eigentümers, nicht hier.
      }
    };
    if (owner) {
      await attempt(() => deleteWave(owner.page, waveOne));
      await attempt(() => deleteWave(owner.page, waveTwo));
    }
    await Promise.all([owner, members.one, members.two].map((s) => s?.ctx.close().catch(() => undefined)));
  });

  test("S1 Wave ohne Abo anlegen: Karte erscheint, keine Kontingent-, Pause- oder Kontomeldung", {
    tag: "@t114",
  }, async () => {
    const { page } = owner;
    const before = await me(page);
    // Selbst betrieben: Wave-Anlage steht offen, ein Konto ist nicht nötig.
    expect(before.canCreateWave).toBe(true);

    const card = await createWave(page, waveOne, `${waveOne}.wave.internal`);
    await expect(card).toHaveCount(1);
    await expect(card.getByRole("heading", { level: 2, name: waveOne, exact: true })).toBeVisible();
    await expectNoRefusal(page);

    waveOneId = await waveId(card);
    const after = await me(page);
    const created = after.waves.find((w) => w.id === waveOneId);
    expect(created?.name).toBe(waveOne);
    expect(created?.role).toBe("owner");
    // Ohne Abo gibt es keine Abrechnung an der Wave, damit auch kein Kontingent.
    expect(created?.billing).toBeNull();
  });

  test("S2 Mehrere Mitglieder lassen sich ohne Sperre einladen und nehmen an", {
    tag: "@t114",
  }, async ({ browser }) => {
    test.setTimeout(240_000);
    const { page } = owner;
    for (const [key, mail] of [
      ["one", mailOne],
      ["two", mailTwo],
    ] as const) {
      await page.goto("/");
      const card = await waveCard(page, waveOne);
      const link = await invite(page, card, mail, "member");
      const guest = await session(browser);
      members[key] = guest;
      await accept(guest.page, link, mail);
      await expect(guest.page.getByRole("heading", { level: 2, name: waveOne, exact: true })).toBeVisible();
      await expectNoRefusal(guest.page);
    }

    await page.goto("/");
    const card = await waveCard(page, waveOne);
    // Beide Mitglieder stehen in der Liste, keiner wurde abgewiesen.
    for (const mail of [mailOne, mailTwo]) await expect(memberRow(card, mail)).toHaveCount(1);
    await expectNoRefusal(page);
  });

  test("S3 Eine zweite Wave desselben Eigentümers lässt sich ohne Sperre anlegen", {
    tag: "@t114",
  }, async () => {
    const { page } = owner;
    const card = await createWave(page, waveTwo, `${waveTwo}.wave.internal`);
    await expect(card).toHaveCount(1);
    await expect(card.getByRole("heading", { level: 2, name: waveTwo, exact: true })).toBeVisible();
    await expectNoRefusal(page);
    waveTwoId = await waveId(card);

    const state = await me(page);
    const mine = state.waves.filter((w) => w.id === waveOneId || w.id === waveTwoId);
    expect(mine.map((w) => w.name).sort()).toEqual([waveOne, waveTwo]);
    expect(mine.every((w) => w.role === "owner" && w.billing === null)).toBe(true);
    expect(waveTwoId).not.toBe(waveOneId);

    // Mit zwei Waves bietet die Startseite die Auswahl an, beide stehen darin.
    await page.goto("/");
    const options = await page.locator("#wave-select option").allInnerTexts();
    expect(options).toEqual(expect.arrayContaining([waveOne, waveTwo]));
  });

  test("B1 Wave-ID, Mitglieder und Wave-Liste bleiben nach Neuladen und in einer neuen Sitzung unverändert", {
    tag: "@t114",
  }, async ({ browser }) => {
    test.setTimeout(180_000);
    const first = await ownerState(owner.page);
    expect(first.waveOneId).toBe(waveOneId);
    // Der Eigentümer hat auf dem geteilten Testsystem weitere, fremde Waves: nur die eigenen müssen darin stehen.
    // Dass sich die ganze Liste (auch die fremden) nicht ändert, belegt `toEqual(first)` weiter unten.
    const ids = first.waves.map((w) => w.id);
    expect(ids).toEqual(expect.arrayContaining([waveOneId, waveTwoId]));
    expect(ids.filter((id) => id === waveOneId || id === waveTwoId)).toHaveLength(2);
    expect(Object.keys(first.members)).toHaveLength(2);

    // Neuladen derselben Sitzung.
    await owner.page.reload();
    expect(await ownerState(owner.page)).toEqual(first);

    // Neue Sitzung des Eigentümers: keine erneute Anmeldung eines Geräts nötig, derselbe Bestand.
    const fresh = await session(browser);
    try {
      await login(fresh.page, env("APP_USER"), env("APP_PASSWORD"));
      expect(await ownerState(fresh.page)).toEqual(first);
    } finally {
      await fresh.ctx.close().catch(() => undefined);
    }

    // Aus Sicht der Mitglieder: dieselbe Wave-ID, Rolle Mitglied, nichts abgewiesen.
    for (const guest of [members.one, members.two]) {
      expect(guest).toBeDefined();
      if (!guest) continue;
      await guest.page.reload();
      const state = await me(guest.page);
      const theirs = state.waves.find((w) => w.id === waveOneId);
      expect(theirs?.name).toBe(waveOne);
      expect(theirs?.role).toBe("member");
      expect(state.waves.find((w) => w.id === waveTwoId)).toBeUndefined();
      await expectNoRefusal(guest.page);
    }
  });
});
