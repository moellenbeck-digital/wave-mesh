/**
 * Ticket #119: Kontoübersicht, Personen-Hinweis und handlungsfähige Quotenfehler für gehostete Gratis-Konten.
 *
 * Voraussetzung: Das System ist ein **gehosteter** Server (mit `WAVE_BILLING_TOKEN`), nur dort gibt es
 * Kundenkonten und Grenzen. Fehlt der Plan-Block in `/api/me`, überspringen die gehosteten Fälle (K1–K3)
 * mit Grund, und stattdessen läuft K4 (Selfhosting ohne Quote). Auf einem gehosteten Server überspringt K4.
 *
 * Aufbau wie `t117`: Ein bestätigtes Zweitkonto (`t119-nutzer@example.test`, feste Adresse, abgeleitetes
 * Passwort, wird wiederverwendet) entsteht über eine Einladung des Eigentümers (APP_USER) in eine eigene
 * Wave (Lauf-Kennung im Namen, am Ende gelöscht). Alle Waves des Zweitkontos heißen `t119-…` und werden
 * am Anfang (Reste) und am Ende entfernt. Es entstehen nie Waves oder Personen fremder Konten.
 *
 * - K1 (Kriterium 1) „Kontoübersicht“: Nach drei Waves zeigt `/account#plan` Tarif, Waves, Personen und
 *   Geräte als „belegt von erlaubt“ (`[data-usage]`, `[data-field=used|limit]`), die Zahlen gleich
 *   `/api/me` → `account.usage/limits`; Englisch und Deutsch.
 * - K2 (Kriterium 2) „Personen-Hinweis“: Mitgliederliste (`/`) und `waves/<id>/invited` zeigen
 *   `[data-people-quota]` mit Zählregeln (alle Waves, offene Einladung reserviert, Mehrfachmitgliedschaft
 *   einmal), Zahlen aus `/api/me`; bei voller Belegung `data-full="true"` und `[data-field=next-step]`
 *   mit Link auf `/account#plan`. Englisch und Deutsch.
 * - K3 (Kriterium 3) „Quotenfehler“: Das vierte Wave (`/waves/new` und `POST /waves`) und die vierte Person
 *   (`POST /waves/<id>/invites`) liefern Seite bzw. JSON mit `used / limit`, nächstem Schritt und
 *   `upgradeUrl`; Codes `wave-limit` (403) und `people-limit` (409). Englisch und Deutsch.
 * - K4 (Kriterium 4) „Selfhosting ohne Quote“: Ohne Plan-Block in `/api/me` gibt es keinen Abschnitt
 *   „Tarif und Nutzung“ auf `/account`, und Mitgliederliste und `invited` zeigen keinen Personen-Hinweis.
 *
 * Nicht über die Oberfläche prüfbar, mit Grund (Beleg: `apps/control/test/free-accounts.test.ts`,
 * `device-limit.test.ts`, `account-overview.test.ts`, `apps/web/test/people-quota.test.tsx`,
 * `account-usage.test.tsx`, `wave-limit.test.ts`):
 * - Gerätelimit (`device_limit` mit `limit`, `used`, `upgradeUrl`, Seite DE/EN): Es braucht 100 registrierte
 *   Geräte im Konto; sie auf einem geteilten System anzulegen ist nicht vertretbar (siehe `t116`).
 * - Kriterium 5 (Konto-Abo: Limits `null`, „unbegrenzt“): Ein Konto-Abo setzt nur die Abrechnungs-API mit
 *   Token, nicht die Oberfläche.
 * - Kriterium 6 (Doku): kein Oberflächenverhalten; Prüfung per `grep` auf `docs/`.
 *
 * Beschriftungen gelten für `en-US` (Config) und `de-DE` (eigener Kontext); Selektoren sonst über `name`,
 * `action` und `data-*`.
 */
import { type Browser, type BrowserContext, expect, type Locator, type Page, test } from "@playwright/test";
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
const host = `t119-host-${run}`;
const userMail = "t119-nutzer@example.test";
const names = [`t119-a-${run}`, `t119-b-${run}`, `t119-c-${run}`];
const fourth = `t119-d-${run}`;
const NEXT = "/account#plan";

let owner: Sess;
let user: Sess;
let german: Sess;
let hosted = false;
let invitedUrl: string | undefined;
let firstWaveId: string | undefined;

async function session(browser: Browser): Promise<Sess> {
  const ctx = await newSession(browser);
  return { ctx, page: await ctx.newPage() };
}

/** Dieselbe Anmeldung wie `user`, aber Browsersprache Deutsch. */
async function germanOf(browser: Browser, from: Sess): Promise<Sess> {
  const ctx = await browser.newContext({
    baseURL: env("APP_URL"),
    locale: "de-DE",
    storageState: await from.ctx.storageState(),
  });
  return { ctx, page: await ctx.newPage() };
}

interface Counts {
  waves: number | null;
  people: number | null;
  devices: number | null;
}
interface Me {
  canCreateWave: boolean;
  waves: { id: string; name: string }[];
  account?: { plan?: "free" | "paid"; limits?: Counts; usage?: Counts };
}

async function me(page: Page): Promise<Me> {
  const res = await page.request.get("/api/me");
  expect(res.status()).toBe(200);
  return (await res.json()) as Me;
}

async function cleanUser(page: Page): Promise<void> {
  const state = await me(page);
  for (const wave of state.waves) {
    if (wave.name.startsWith("t119-")) await deleteWave(page, wave.name).catch(() => undefined);
  }
}

/** Lädt per Formular ein und bleibt auf der Seite `waves/<id>/invited`; liefert deren Adresse. */
async function inviteStay(page: Page, card: Locator, email: string): Promise<string> {
  const form = card.locator('form[action$="/invites"]');
  await form.locator('input[name="email"]').fill(email);
  await form.locator('select[name="role"]').selectOption("member");
  await form.locator('button[type="submit"]').click();
  await page.waitForURL(/\/waves\/[^/]+\/invited\?/);
  return page.url();
}

test.describe("Gehostet: Kontoübersicht, Personen-Hinweis, Quotenfehler", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    owner = await session(browser);
    await login(owner.page, env("APP_USER"), env("APP_PASSWORD"));
    const mine = await me(owner.page);
    hosted = mine.account?.plan !== undefined;
    if (!hosted) return;

    await owner.page.goto("/");
    const card = await createWave(owner.page, host, `${host}.wave.internal`);
    const link = await invite(owner.page, card, userMail, "member");
    user = await session(browser);
    await accept(user.page, link, userMail);
    await cleanUser(user.page);
    german = await germanOf(browser, user);
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
    if (owner && hosted) await attempt(() => deleteWave(owner.page, host));
    await Promise.all([owner, user, german].map((s) => s?.ctx.close().catch(() => undefined)));
  });

  test.beforeEach(() => {
    test.skip(
      !hosted,
      "Das System ist selbst betrieben (kein Plan-Block in /api/me): ohne WAVE_BILLING_TOKEN keine Gratis-Konten.",
    );
  });

  test("K1 Kontoübersicht: Tarif, Waves, Personen, Geräte als belegt von erlaubt, gleich /api/me, EN und DE", {
    tag: "@t119",
  }, async () => {
    const { page } = user;
    for (const name of names) {
      await expect(await createWave(page, name, `${name}.wave.internal`)).toHaveCount(1);
    }
    const state = await me(page);
    expect(state.account?.plan).toBe("free");
    const usage = state.account?.usage;
    const limits = state.account?.limits;
    expect(limits).toEqual({ waves: 3, people: 3, devices: 100 });
    expect(usage?.waves).toBe(3);

    const check = async (p: Page, plan: string, of: (n: number) => string) => {
      await p.goto("/account");
      const section = p.locator("#plan");
      await expect(section).toBeVisible();
      await expect(section).toHaveAttribute("data-plan", "free");
      await expect(section.locator('[data-field="plan"]')).toHaveText(plan);
      for (const key of ["waves", "people", "devices"] as const) {
        const row = section.locator(`[data-usage="${key}"]`);
        await expect(row.locator('[data-field="used"]')).toHaveText(String(usage?.[key]));
        await expect(row.locator('[data-field="limit"]')).toHaveText(of(limits?.[key] ?? 0));
      }
    };
    await check(page, "Free", (n) => `of ${n} used`);
    await check(german.page, "Gratis", (n) => `von ${n} belegt`);
  });

  test("K2 Personen-Hinweis in Mitgliederliste und invited, Zählregeln, bei voller Belegung nächster Schritt", {
    tag: "@t119",
  }, async () => {
    const { page } = user;
    await page.goto("/");
    const card = await waveCard(page, names[0] ?? "");
    firstWaveId = await waveId(card);

    // Vor der Einladung: Hinweis da, Platz frei, kein nächster Schritt.
    const quota = card.locator("[data-people-quota]");
    await expect(quota).toHaveAttribute("data-people-quota", "free");
    await expect(quota).toHaveAttribute("data-full", "false");
    await expect(quota.locator('[data-field="next-step"]')).toHaveCount(0);
    const before = (await me(page)).account?.usage?.people ?? -1;
    await expect(quota).toContainText(`${before} of 3 used`);
    await expect(quota).toContainText("across all");
    await expect(quota).toContainText("open invitation reserves a place");
    await expect(quota).toContainText("in several waves counts once");

    // Die erste Einladung füllt noch nicht, die Seite danach nennt die neue Zahl.
    invitedUrl = await inviteStay(page, card, `t119-p1-${run}@example.test`);
    const mid = (await me(page)).account?.usage?.people ?? -1;
    expect(mid).toBe(before + 1);
    const invitedQuota = page.locator("[data-people-quota]");
    await expect(invitedQuota).toContainText(`${mid} of 3 used`);
    await expect(invitedQuota).toContainText("reserves a place");

    // Die zweite füllt die drei Plätze: voll, nächster Schritt mit Link.
    await page.goto("/");
    const again = await waveCard(page, names[0] ?? "");
    invitedUrl = await inviteStay(page, again, `t119-p2-${run}@example.test`);
    const full = (await me(page)).account?.usage?.people ?? -1;
    expect(full).toBe(3);
    await expect(invitedQuota).toHaveAttribute("data-full", "true");
    await expect(invitedQuota.locator('[data-field="next-step"] a')).toHaveAttribute("href", NEXT);

    await page.goto("/");
    const listQuota = (await waveCard(page, names[0] ?? "")).locator("[data-people-quota]");
    await expect(listQuota).toHaveAttribute("data-full", "true");
    await expect(listQuota).toContainText("3 of 3 used");
    await expect(listQuota.locator('[data-field="next-step"] a')).toHaveAttribute("href", NEXT);

    // Deutsch: dieselben Seiten mit denselben Zahlen.
    await german.page.goto("/");
    const deList = (await waveCard(german.page, names[0] ?? "")).locator("[data-people-quota]");
    await expect(deList).toHaveAttribute("data-full", "true");
    await expect(deList).toContainText("3 von 3 belegt");
    await expect(deList).toContainText("Wer in mehreren Waves ist, zählt einmal");
    await expect(deList.locator('[data-field="next-step"] a')).toHaveAttribute("href", NEXT);
    await german.page.goto(invitedUrl ?? "/");
    const deInvited = german.page.locator("[data-people-quota]");
    await expect(deInvited).toHaveAttribute("data-full", "true");
    await expect(deInvited).toContainText("3 von 3 belegt");
  });

  test("K3 Quotenfehler: 4. Wave und 4. Person mit used / limit, nächstem Schritt und upgradeUrl, EN und DE", {
    tag: "@t119",
  }, async () => {
    const { page } = user;
    const jsonHeaders = (lang: string) => ({ accept: "application/json", "accept-language": lang });
    const withLang = (lang: string) => ({ "accept-language": lang });

    // Seite /waves/new
    for (const [p, title, used, step] of [
      [page, "Free limit reached", "3 / 3", "Next step"],
      [german.page, "Kostenlose Grenze erreicht", "3 / 3", "Nächster Schritt"],
    ] as const) {
      await p.goto("/waves/new");
      await expect(p.getByRole("heading", { name: title })).toBeVisible();
      await expect(p.locator('form[action="/waves"]')).toHaveCount(0);
      const body = p.locator('[data-error="wave-limit"]');
      await expect(body).toContainText(used);
      await expect(body).toContainText(step);
      await expect(body.locator(`a[href="${NEXT}"]`)).toHaveCount(1);
    }

    // POST /waves: JSON
    for (const [lang, step] of [
      ["en-US", "Next step"],
      ["de-DE", "Nächster Schritt"],
    ] as const) {
      const res = await page.request.post("/waves", {
        headers: jsonHeaders(lang),
        form: { name: fourth, suffix: `${fourth}.wave.internal` },
        maxRedirects: 0,
      });
      expect(res.status()).toBe(403);
      const json = (await res.json()) as {
        error: string;
        limit: number;
        used: number;
        message: string;
        upgradeUrl: string;
      };
      expect(json).toMatchObject({ error: "wave-limit", limit: 3, used: 3 });
      expect(json.message).toContain("3 / 3");
      expect(json.message).toContain(step);
      expect(
        new URL(json.upgradeUrl, env("APP_URL")).pathname + new URL(json.upgradeUrl, env("APP_URL")).hash,
      ).toBe(NEXT);
    }
    // POST /waves: Seite
    for (const [lang, title] of [
      ["en-US", "Free limit reached"],
      ["de-DE", "Kostenlose Grenze erreicht"],
    ] as const) {
      const res = await page.request.post("/waves", {
        headers: withLang(lang),
        form: { name: fourth, suffix: `${fourth}.wave.internal` },
        maxRedirects: 0,
      });
      expect(res.status()).toBe(403);
      const html = await res.text();
      expect(html).toContain('data-error="wave-limit"');
      expect(html).toContain(title);
      expect(html).toContain("3 / 3");
      expect(html).toContain(`href="${NEXT}"`);
    }
    expect((await me(page)).waves.some((w) => w.name === fourth)).toBe(false);

    // Die vierte Person
    const id = firstWaveId ?? "";
    expect(id).not.toBe("");
    for (const [lang, step] of [
      ["en-US", "Next step"],
      ["de-DE", "Nächster Schritt"],
    ] as const) {
      const res = await page.request.post(`/waves/${id}/invites`, {
        headers: jsonHeaders(lang),
        form: { email: `t119-p3-${lang}-${run}@example.test`, role: "member" },
        maxRedirects: 0,
      });
      expect(res.status()).toBe(409);
      const json = (await res.json()) as {
        error: string;
        limit: number;
        used: number;
        plan: string;
        message: string;
        upgradeUrl: string;
      };
      expect(json).toMatchObject({ error: "people-limit", limit: 3, used: 3, plan: "free" });
      expect(json.message).toContain("3 / 3");
      expect(json.message).toContain(step);
      expect(new URL(json.upgradeUrl, env("APP_URL")).hash).toBe("#plan");
    }
    for (const [lang, title, step] of [
      ["en-US", "No room for another person", "Next step"],
      ["de-DE", "Kein Platz für eine weitere Person", "Nächster Schritt"],
    ] as const) {
      const res = await page.request.post(`/waves/${id}/invites`, {
        headers: withLang(lang),
        form: { email: `t119-p4-${lang}-${run}@example.test`, role: "member" },
        maxRedirects: 0,
      });
      expect(res.status()).toBe(409);
      const html = await res.text();
      expect(html).toContain(title);
      expect(html).toContain("3 / 3");
      expect(html).toContain(step);
    }
    // Abgewiesene Einladungen belegen nichts.
    expect((await me(page)).account?.usage?.people).toBe(3);
  });
});

test.describe("Selfhosting: keine künstliche Gratisquote", () => {
  const wave = `t119-self-${run}`;
  let self: Sess;
  let selfHosted = false;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000);
    self = await session(browser);
    await login(self.page, env("APP_USER"), env("APP_PASSWORD"));
    selfHosted = (await me(self.page)).account?.plan === undefined;
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    if (self && selfHosted) await deleteWave(self.page, wave).catch(() => undefined);
    await self?.ctx.close().catch(() => undefined);
  });

  test("K4 Ohne Plan-Block: kein Abschnitt Tarif und Nutzung, kein Personen-Hinweis", {
    tag: "@t119",
  }, async () => {
    test.skip(
      !selfHosted,
      "Gehosteter Server: Selfhosting ist hier nicht zu beobachten (Beleg: account-overview.test.ts, people-quota.test.tsx).",
    );
    const { page } = self;
    const state = await me(page);
    expect(state.account?.plan).toBeUndefined();

    await page.goto("/account");
    await expect(page.locator("#plan")).toHaveCount(0);

    await page.goto("/");
    const card = await createWave(page, wave, `${wave}.wave.internal`);
    await expect(card.locator("[data-people-quota]")).toHaveCount(0);
    const stay = await inviteStay(page, card, `t119-self-${run}@example.test`);
    expect(stay).toContain("/invited");
    await expect(page.locator("[data-people-quota]")).toHaveCount(0);
  });
});
