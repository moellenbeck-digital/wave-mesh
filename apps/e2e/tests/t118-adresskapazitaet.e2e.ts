/**
 * Ticket #118: Adresskapazität für mehrere gehostete Waves.
 *
 * Über die Oberfläche beobachtbar ist nur der Anteil, der Nutzern auffällt: Auf einem gehosteten Server
 * (mit `WAVE_BILLING_TOKEN`) legt ein Gratis-Konto Waves an, und die Anlage scheitert nicht an der neuen
 * Adressvergabe (/24 je Gratis-Wave) oder der Reserve. Ein bestätigtes Zweitkonto (`t118-nutzer@example.test`,
 * feste Adresse, abgeleitetes Passwort, wird wiederverwendet) entsteht über eine Einladung des Eigentümers
 * (APP_USER) in eine eigene Wave mit Lauf-Kennung. Alle Waves des Zweitkontos heißen `t118-…` und werden am
 * Anfang und am Ende entfernt. Auf einem selbst betriebenen Server gibt es keine Gratis-Konten: dann
 * überspringen die Fälle mit Grund.
 *
 * - C1 „Zwei Gratis-Anmeldungen/Waves gehen durch“: Das Zweitkonto legt zwei Waves an; beide Karten sind da,
 *   `/api/me` meldet Plan „free“ und `canCreateWave` bleibt wahr (Kriterium 1, soweit sichtbar: Anlage ohne
 *   Adressfehler; und Kriterium 3 im Normalfall: die Reserve sperrt nicht, solange Platz da ist).
 *
 * Nicht über die Oberfläche prüfbar, mit Grund (kein Präfix, keine Kapazität und keine Konfiguration in
 * Oberfläche oder `/api/me`; eine Admin-Weboberfläche gibt es nicht, das ist akzeptiert). Belege: Unit-Tests
 * und CLI am lokalen Stand:
 * - Kriterium 1 (kein Überlapp, bestehende /16 unverändert), Kriterium 3 (`NoWaveCapacityError`, kein Konto
 *   ohne Wave), Kriterium 4 (Startfehler bei /27): `apps/control/test/address-capacity.test.ts`.
 * - Kriterium 2 (`wave-admin capacity`, `--json`): `wave-admin` am lokalen Stand (CLI, keine Oberfläche).
 * - Kriterium 5 (PTR nur eigene Adressen, fremde NXDOMAIN): `packages/dns/src/dns.test.ts`.
 *
 * Beschriftungen gelten für `en-US` (Config); Selektoren sonst über `name`, `action` und `data-*`.
 */
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { accept, createWave, deleteWave, env, invite, login, newSession } from "./helpers.ts";

type Sess = { ctx: BrowserContext; page: Page };

const run = Math.random().toString(36).slice(2, 8);
const host = `t118-host-${run}`;
const userMail = "t118-nutzer@example.test";
const names = [`t118-a-${run}`, `t118-b-${run}`];

let owner: Sess;
let user: Sess;
let hostSkipped: string | undefined;

async function session(browser: Parameters<typeof newSession>[0]): Promise<Sess> {
  const ctx = await newSession(browser);
  return { ctx, page: await ctx.newPage() };
}

interface Me {
  canCreateWave: boolean;
  waves: { id: string; name: string }[];
  account?: { plan?: "free" | "paid" };
}

async function me(page: Page): Promise<Me> {
  const res = await page.request.get("/api/me");
  expect(res.status()).toBe(200);
  return (await res.json()) as Me;
}

async function cleanUser(page: Page): Promise<void> {
  const state = await me(page);
  for (const wave of state.waves) {
    if (wave.name.startsWith("t118-")) await deleteWave(page, wave.name).catch(() => undefined);
  }
}

test.describe("Adresskapazität: Gratis-Waves entstehen", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    owner = await session(browser);
    await login(owner.page, env("APP_USER"), env("APP_PASSWORD"));
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

  test("C1 Zwei Gratis-Waves entstehen ohne Adress- oder Kapazitätsfehler", { tag: "@t118" }, async () => {
    const { page } = user;
    for (const name of names) {
      const card = await createWave(page, name, `${name}.wave.internal`);
      await expect(card).toHaveCount(1);
    }
    const state = await me(page);
    expect(state.account?.plan).toBe("free");
    expect(state.waves.filter((w) => w.name.startsWith("t118-"))).toHaveLength(2);
    expect(state.canCreateWave).toBe(true);
  });
});
