/**
 * Ticket #115: Gratis-Kontingent pro Kundenkonto, drei Personen über alle Waves, an jedem Eintrittsweg.
 *
 * Es gibt dafür keine neue Oberfläche; geprüft wird über die Routen, die die Oberfläche selbst benutzt
 * (`POST /waves/:id/invites`, `/invites/:id/revoke`, `/members/:id/remove`, `/join/:token`) und über
 * `/api/me` (Nutzung je Konto). Voraussetzung: gehosteter Server (mit `WAVE_BILLING_TOKEN`), nur dort
 * gibt es Kundenkonten und Grenzen; fehlt der Plan-Block in `/api/me`, überspringen die Fälle mit Grund.
 *
 * Ein bestätigtes Zweitkonto (`t115-nutzer@example.test`, feste Adresse, abgeleitetes Passwort, wird
 * wiederverwendet) entsteht über eine Einladung des Eigentümers (APP_USER) in eine eigene Wave; es legt zwei
 * Waves `t115-…` an und startet damit sein Gratis-Konto. Eine zweite feste Adresse (`t115-p1@example.test`)
 * nimmt eine Einladung an. Alle weiteren Adressen sind Einladungsziele mit Lauf-Kennung und werden mit den
 * Waves gelöscht. Die Waves des Zweitkontos werden am Anfang (Reste) und am Ende entfernt.
 *
 * Die Fälle bauen aufeinander auf (serial): K2 → K3 → K1 → K6 → K5 → K4 → K6b.
 *
 * - K1 „Vierte Person“: bei 3 Personen liefert `POST /waves/:id/invites` (Accept: JSON) 409 `people-limit`
 *   mit `used`=3, `limit`=3 und `upgradeUrl`.
 * - K2 „Dieselbe Person in zwei Waves zählt einmal“: eine Adresse in zwei Waves eingeladen; die Nutzung steigt
 *   nur um eins. Der Ersteller in zwei Waves zählt einmal.
 * - K3 „Zwei offene Einladungen derselben Adresse“ belegen einen Platz; Groß-/Kleinschreibung und Leerraum
 *   zählen als dieselbe Person.
 * - K4 „Annahme ersetzt die Reservierung“: Die Annahme einer offenen Einladung bei vollem Konto ändert die
 *   Nutzung nicht, es gibt keinen vierten Platz.
 * - K5 „Gleichzeitige Einladungen“: bei 2 von 3 belegt gelingt von zwei gleichzeitigen genau eine, in
 *   verschiedenen Waves und in derselben Wave.
 * - K6 „Platz wird frei“: Widerruf der letzten Einladung einer Person gibt den Platz frei (hat sie noch eine
 *   Einladung in der anderen Wave, bleibt er belegt); `removeMember` der letzten Mitgliedschaft ebenso.
 *
 * Nicht über die Oberfläche prüfbar, mit Grund (Belege: `apps/control/test/people-limit.test.ts` und
 * `people-limit-concurrency.test.ts`):
 * - Einladung gegen `wave-admin add-member` und Annahme gegen neue Einladung gleichzeitig: `wave-admin` ist
 *   eine CLI am Server, keine Oberfläche.
 * - Abgelaufene Einladung gibt den Platz frei: Ablaufzeit ist nicht einstellbar.
 * - Überhang nach Herabstufung (6 Personen): ein Konto-Abo und dessen Kündigung setzt nur die Abrechnungs-API
 *   (Bearer-Token).
 * - Selbsthosting ohne Grenze, bezahlte Konten unverändert: das Testsystem ist ein gehosteter Server mit
 *   Gratis-Konten.
 *
 * Beschriftungen gelten für `en-US` (Config); Selektoren sonst über `name`, `action` und `data-*`.
 */
import { type APIResponse, type BrowserContext, expect, type Page, test } from "@playwright/test";
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
const host = `t115-host-${run}`;
const userMail = "t115-nutzer@example.test";
const p1Mail = "t115-p1@example.test";
const qMail = `t115-q-${run}@example.test`;
const waveNames = [`t115-a-${run}`, `t115-b-${run}`];
const extra = (n: string) => `t115-${n}-${run}@example.test`;

let owner: Sess;
let user: Sess;
let p1: Sess;
let hostSkipped: string | undefined;
let waveA = "";
let waveB = "";
/** Einladungslink (Pfad `/invite/<token>`) von p1 in Wave A, für K4. */
let p1InviteA = "";

async function session(browser: Parameters<typeof newSession>[0]): Promise<Sess> {
  const ctx = await newSession(browser);
  return { ctx, page: await ctx.newPage() };
}

interface Me {
  waves: { id: string; name: string }[];
  account?: { plan?: "free" | "paid"; usage?: { people: number }; limits?: { people: number | null } };
}

async function me(page: Page): Promise<Me> {
  const res = await page.request.get("/api/me");
  expect(res.status()).toBe(200);
  return (await res.json()) as Me;
}

const people = async (page: Page): Promise<number | undefined> => (await me(page)).account?.usage?.people;

async function cleanUser(page: Page): Promise<void> {
  const state = await me(page);
  for (const wave of state.waves) {
    if (wave.name.startsWith("t115-")) await deleteWave(page, wave.name).catch(() => undefined);
  }
}

/** Lädt per POST ein; `json` verlangt die maschinenlesbare Abweisung. */
function send(page: Page, wave: string, email: string, json = false): Promise<APIResponse> {
  return page.request.post(`/waves/${wave}/invites`, {
    form: { email, role: "member" },
    headers: json ? { accept: "application/json" } : {},
    maxRedirects: 0,
  });
}

const created = (res: APIResponse): boolean => [200, 303].includes(res.status());

/** Der Einladungslink steht im Redirect (`token=`) oder, ohne Frontend, auf der Antwortseite. */
async function linkOf(res: APIResponse): Promise<string> {
  const location = res.headers().location;
  const token = location
    ? new URL(location, "http://x").searchParams.get("token")
    : (await res.text()).match(/\/invite\/([^<\s"]+)/)?.[1];
  if (!token) throw new Error("kein Einladungslink in der Antwort");
  return `/invite/${token}`;
}

async function invitesOf(page: Page, wave: string): Promise<{ id: string; email: string }[]> {
  const res = await page.request.get(`/api/waves/${wave}/members`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { invites: { id: string; email: string }[] }).invites;
}

async function revoke(page: Page, wave: string, email: string): Promise<void> {
  const found = (await invitesOf(page, wave)).filter((i) => i.email === email.trim().toLowerCase());
  expect(found.length).toBeGreaterThan(0);
  for (const i of found) {
    const res = await page.request.post(`/waves/${wave}/invites/${i.id}/revoke`, { maxRedirects: 0 });
    expect([200, 303]).toContain(res.status());
  }
}

test.describe("Personengrenze: drei Personen über alle Waves des Kontos", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    owner = await session(browser);
    await login(owner.page, env("APP_USER"), env("APP_PASSWORD"));
    if (!(await me(owner.page)).account?.plan) {
      hostSkipped =
        "Das Testsystem ist selbst betrieben (kein Plan-Block in /api/me): ohne WAVE_BILLING_TOKEN gibt es keine Gratis-Konten.";
      return;
    }
    const card = await createWave(owner.page, host, `${host}.wave.internal`);
    const link = await invite(owner.page, card, userMail, "member");
    user = await session(browser);
    await accept(user.page, link, userMail);
    await cleanUser(user.page);

    for (const name of waveNames) await createWave(user.page, name, `${name}.wave.internal`);
    await user.page.goto("/");
    waveA = await waveId(await waveCard(user.page, waveNames[0] ?? ""));
    waveB = await waveId(await waveCard(user.page, waveNames[1] ?? ""));
    p1 = await session(browser);
  });

  test.afterAll(async () => {
    test.setTimeout(300_000);
    const attempt = async (step: () => Promise<unknown>) => {
      try {
        await step();
      } catch {
        // Aufräumen läuft weiter; ein Rest steht im Bericht, nicht hier.
      }
    };
    if (user) await attempt(() => cleanUser(user.page));
    if (owner) await attempt(() => deleteWave(owner.page, host));
    await Promise.all([owner, user, p1].map((s) => s?.ctx.close().catch(() => undefined)));
  });

  test.beforeEach(() => {
    test.skip(hostSkipped !== undefined, hostSkipped);
  });

  test("K2 Dieselbe Person in zwei Waves zählt einmal", { tag: "@t115" }, async () => {
    const { page } = user;
    // Der Ersteller ist in beiden Waves Mitglied und zählt einmal.
    expect(await people(page)).toBe(1);
    const first = await send(page, waveA, p1Mail);
    expect(created(first)).toBe(true);
    p1InviteA = await linkOf(first);
    expect(await people(page)).toBe(2);
    // Dieselbe Adresse in der anderen Wave: möglich und kostenlos.
    expect(created(await send(page, waveB, p1Mail))).toBe(true);
    expect(await people(page)).toBe(2);
  });

  test("K3 Zwei offene Einladungen einer Adresse belegen einen Platz, auch bei anderer Schreibweise", {
    tag: "@t115",
  }, async () => {
    const { page } = user;
    expect(created(await send(page, waveA, qMail))).toBe(true);
    expect(await people(page)).toBe(3);
    expect(created(await send(page, waveB, `  ${qMail.toUpperCase()} `))).toBe(true);
    expect(await people(page)).toBe(3);
  });

  test("K1 Vierte Person: 409 people-limit mit used, limit und upgradeUrl", { tag: "@t115" }, async () => {
    const { page } = user;
    const res = await send(page, waveA, extra("r"), true);
    expect(res.status()).toBe(409);
    const body = (await res.json()) as { error: string; used: number; limit: number; upgradeUrl: string };
    expect(body.error).toBe("people-limit");
    expect(body.used).toBe(3);
    expect(body.limit).toBe(3);
    expect(body.upgradeUrl).toBeTruthy();
    expect(await people(page)).toBe(3);
  });

  test("K6 Widerruf der letzten Einladung gibt den Platz frei, vorher bleibt er belegt", {
    tag: "@t115",
  }, async () => {
    const { page } = user;
    // q hat noch eine Einladung in Wave B: der Platz bleibt belegt.
    await revoke(page, waveA, qMail);
    expect(await people(page)).toBe(3);
    expect((await send(page, waveA, extra("s"), true)).status()).toBe(409);
    // Die letzte Einladung weg: frei.
    await revoke(page, waveB, qMail);
    expect(await people(page)).toBe(2);
  });

  test("K5 Gleichzeitige Einladungen bei 2 von 3: genau eine gelingt", { tag: "@t115" }, async () => {
    const { page } = user;
    expect(await people(page)).toBe(2);

    // Verschiedene Waves.
    const across = await Promise.all([
      send(page, waveA, extra("x1"), true),
      send(page, waveB, extra("x2"), true),
    ]);
    expect(across.filter(created)).toHaveLength(1);
    expect(across.filter((r) => r.status() === 409)).toHaveLength(1);
    expect(await people(page)).toBe(3);

    // Platz wieder frei machen, dann dieselbe Wave.
    for (const [wave, mail] of [
      [waveA, extra("x1")],
      [waveB, extra("x2")],
    ] as const) {
      if ((await invitesOf(page, wave)).some((i) => i.email === mail)) await revoke(page, wave, mail);
    }
    expect(await people(page)).toBe(2);
    const same = await Promise.all([
      send(page, waveA, extra("x3"), true),
      send(page, waveA, extra("x4"), true),
    ]);
    expect(same.filter(created)).toHaveLength(1);
    expect(same.filter((r) => r.status() === 409)).toHaveLength(1);
    expect(await people(page)).toBe(3);
  });

  test("K4 Annahme ersetzt die Reservierung, es gibt keinen vierten Platz", { tag: "@t115" }, async () => {
    const { page } = user;
    expect(await people(page)).toBe(3);
    await accept(p1.page, p1InviteA, p1Mail);
    // p1 war reserviert und ist jetzt Mitglied: weiterhin drei Personen.
    expect(await people(page)).toBe(3);
    expect((await send(page, waveA, extra("z"), true)).status()).toBe(409);
  });

  test("K6b Entfernen der letzten Mitgliedschaft gibt den Platz frei", { tag: "@t115" }, async () => {
    const { page } = user;
    const res = await page.request.get(`/api/waves/${waveA}/members`);
    const members = ((await res.json()) as { members: { userId: string; email: string }[] }).members;
    const p1Member = members.find((m) => m.email === p1Mail);
    expect(p1Member).toBeTruthy();
    // p1 hat in Wave B noch eine offene Einladung: der Platz bleibt belegt.
    const out = await page.request.post(`/waves/${waveA}/members/${p1Member?.userId}/remove`, {
      maxRedirects: 0,
    });
    expect([200, 303]).toContain(out.status());
    expect(await people(page)).toBe(3);
    // Die letzte Spur von p1 weg: frei.
    await revoke(page, waveB, p1Mail);
    expect(await people(page)).toBe(2);
    expect(created(await send(page, waveA, extra("y"), true))).toBe(true);
  });
});
