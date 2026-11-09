/**
 * Ticket #78: Geführte, sichere Verknüpfung getrennter Konten nach OIDC-Anmeldung.
 *
 * Aufbau: Der Eigentümer (APP_USER) legt je Paar eine Wave `W` an und lädt das Konto A (Adresse mit Lauf-Kennung,
 * bestätigt, mit Passwort) als Mitglied ein. Danach meldet sich eine frische Mock-OIDC-Identität (`sub` mit
 * Lauf-Kennung, gleiche Adresse wie A, `email_verified=false`) an: Das ist das getrennte Konto B. Es gibt zwei
 * Paare: „a“ für alles, was nichts zusammenführt (K1–K4, K6, K7; die Fälle bauen aufeinander auf und teilen A
 * und B, jeder beendet eine offene Verknüpfungsanfrage mit „Cancel“), „m“ nur für K5, die Zusammenführung, die
 * nicht umkehrbar ist. Die Sitzung von A bleibt je Paar offen, damit der Zustand von A vor und nach einem
 * Vorgang lesbar ist (nie über eine Passwort-Anmeldung per Adresse, die auch B trägt).
 *
 * Zustand vergleichen („unverändert“): `/api/me` der jeweiligen Sitzung, also dieselbe Auskunft, aus der die
 * Oberfläche Wave-Liste, Anmeldungen und Hinweiskarte baut (Konto-ID, bestätigt, Waves, Anmeldearten).
 *
 * Nicht geprüft, mit Grund:
 * - Die Gerätefreigabe (`/devices/choose`): Eine Geräteanfrage entsteht nur durch die signierte Registrierung
 *   eines Clients (`/v1/machine/register`), ohne Client gibt es keine. Das Angebot des Waves von A nach der
 *   Zusammenführung steht deshalb nur über die Wave-Liste (`/api/me`, Übersicht) belegt, nicht dort.
 * - Abrechnung in der Zusammenfassung: Die Test-Waves haben kein Abo, der Satz erscheint nur bei vorhandener
 *   Abrechnung. Geräte ebenso: ohne Client hat B keine, geprüft wird die Aussage „keine Geräte“.
 * - Das Protokoll sicherheitsrelevanter Änderungen (`account.link`): In der Oberfläche nicht sichtbar.
 * - Der Control-Server ohne Web-Frontend (Variante mit eigenen Seiten): Das Testsystem läuft mit Frontend, die CI
 *   deckt die Variante ab.
 * - `/devices/choose` trägt die Hinweiskarte (ab PR #92), ist aber ohne Geräteanfrage nicht erreichbar: kein Fall.
 *   `/waves/new` (ab PR #92) ist in K1b geprüft.
 *
 * Testdaten: Die Waves der Paare werden am Ende entfernt (die von A/B gehörenden von deren Sitzung, die des
 * Eigentümers von ihm). Konten lassen sich in der Oberfläche nicht löschen und bleiben bestehen (Adressen
 * `t78-<paar>-<lauf>@example.test`, siehe README). Die Mock-Identität wird ausschließlich über „Claims frei
 * setzen“ mit eigenem `sub` angelegt, nie über die festen Testnutzer.
 *
 * Beschriftungen gelten für `en-US` (Config), K7 für `de-DE`; Selektoren sonst über `name`, `action`, Rolle.
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
  passwordFor,
  waveCard,
} from "./helpers.ts";

type Sess = { ctx: BrowserContext; page: Page };

interface Pair {
  mail: string;
  sub: string;
  /** Wave des Eigentümers, in der A Mitglied ist. */
  waveName: string;
  /** Wave, die B selbst anlegt (K4, K5). */
  bWave: string;
  a: Sess;
  b: Sess;
  bWaveCreated: boolean;
}

const run = Math.random().toString(36).slice(2, 8);
const identity = (tag: string) => ({
  mail: `t78-${tag}-${run}@example.test`,
  sub: `mock-user-t78-${tag}-${run}`,
  waveName: `t78-wave-${tag}-${run}`,
  bWave: `t78-bwave-${tag}-${run}`,
});

let owner: Sess;
let pa: Pair;
let pm: Pair;

const notice = (page: Page) => page.locator('section[aria-labelledby="link-notice-title"]');
const currentStep = (page: Page) => page.locator('ol li[aria-current="step"]');
const startForm = (page: Page) => page.locator('form[action="/account/link/start"]');
const passwordInput = (page: Page) => page.locator("#link-password");
const passwordForm = (page: Page) => page.locator('form[action="/account/link/control/password"]');
const confirmForm = (page: Page) => page.locator('form[action="/account/link/confirm"]');
const cancelForm = (page: Page) => page.locator('form[action="/account/link/cancel"]');

async function session(browser: Parameters<typeof newSession>[0]): Promise<Sess> {
  const ctx = await newSession(browser);
  return { ctx, page: await ctx.newPage() };
}

/** Die Authorize-Seite des Mock: „Claims frei setzen“ mit eigenem `sub` und der Adresse von A. */
async function pickClaims(page: Page, pair: Pair, verified: boolean): Promise<void> {
  await page.waitForURL((url) => url.pathname === "/authorize");
  await page.locator('input[name="sub"]').fill(pair.sub);
  await page.locator('input[name="email"]').fill(pair.mail);
  await page.locator('input[name="name"]').fill(`t78 ${run}`);
  const box = page.locator('input[name="email_verified"]');
  if (verified) await box.check();
  else await box.uncheck();
  await page.locator("#user-frei").click();
  await page.waitForURL((url) => url.origin === new URL(env("APP_URL")).origin);
}

/** Anmeldung per OIDC am Mock mit unbestätigter Adresse: legt B an bzw. meldet B wieder an. */
async function signInUnverified(page: Page, pair: Pair): Promise<void> {
  await page.goto("/auth/oidc/start");
  await pickClaims(page, pair, false);
}

/** Schritt 1 anstoßen: „Continue with …“, am Mock erneut anmelden mit dem angegebenen Bestätigungsstand. */
async function startStepOne(page: Page, pair: Pair, verified: boolean): Promise<void> {
  await page.goto("/account/link");
  await startForm(page).locator('button[type="submit"]').click();
  await pickClaims(page, pair, verified);
  await page.waitForURL((url) => url.pathname === "/account/link");
}

/** Schritt 2: Nachweis über Konto A mit dem richtigen Passwort, danach steht Schritt 3 da. */
async function proveControl(page: Page, pair: Pair): Promise<void> {
  await expect(passwordInput(page)).toBeVisible();
  await passwordInput(page).fill(passwordFor(pair.mail));
  await passwordForm(page).locator('button[type="submit"]').click();
  await expect(confirmForm(page)).toBeVisible();
  await expect(currentStep(page)).toContainText("3.");
}

async function cancelLink(page: Page): Promise<void> {
  await page.goto("/account/link");
  const cancel = cancelForm(page).locator('button[type="submit"]');
  if ((await cancel.count()) > 0) {
    await cancel.click();
    await page.waitForURL((url) => url.pathname === "/account");
  }
}

/** Was das Konto der Sitzung ist und hat, aus derselben Auskunft wie die Oberfläche. */
async function snapshot(page: Page) {
  const res = await page.request.get("/api/me");
  expect(res.status()).toBe(200);
  const me = (await res.json()) as {
    user: { id: string; emailVerified: boolean };
    account: { identities: { provider: string }[] };
    waves: { name: string }[];
  };
  return {
    user: me.user.id,
    verified: me.user.emailVerified,
    waves: me.waves.map((w) => w.name).sort(),
    identities: me.account.identities.map((i) => i.provider).sort(),
  };
}

/** Eigentümer legt W an und lädt A ein; A nimmt an (Sitzung bleibt offen); B meldet sich unbestätigt an. */
async function buildPair(browser: Parameters<typeof newSession>[0], tag: string): Promise<Pair> {
  const id = identity(tag);
  const card = await createWave(owner.page, id.waveName, `${id.waveName}.wave.internal`);
  const link = await invite(owner.page, card, id.mail, "member");

  const a = await session(browser);
  await accept(a.page, link, id.mail);
  await expect(a.page.getByRole("heading", { level: 2, name: id.waveName, exact: true })).toBeVisible();

  const b = await session(browser);
  const pair: Pair = { ...id, a, b, bWaveCreated: false };
  await signInUnverified(b.page, pair);
  return pair;
}

/** B legt seine eigene Wave an (einmal je Paar): Stoff für „eigene Waves“ in der Zusammenfassung. */
async function ensureBWave(pair: Pair): Promise<void> {
  if (pair.bWaveCreated) return;
  await createWave(pair.b.page, pair.bWave, `${pair.bWave}.wave.internal`);
  pair.bWaveCreated = true;
}

test.describe("Konten verknüpfen nach OIDC-Anmeldung", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(360_000);
    owner = await session(browser);
    await login(owner.page, env("APP_USER"), env("APP_PASSWORD"));
    pa = await buildPair(browser, "a");
    pm = await buildPair(browser, "m");
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
    for (const pair of [pa, pm]) {
      if (!pair) continue;
      await attempt(() => cancelLink(pair.b.page));
      // Die Wave von B gehört nach der Zusammenführung A (Paar m), sonst B.
      if (pair.bWaveCreated) {
        const holder = pair === pm ? pair.a : pair.b;
        await attempt(() => deleteWave(holder.page, pair.bWave));
      }
      if (owner) await attempt(() => deleteWave(owner.page, pair.waveName));
    }
    await Promise.all([owner, pa?.a, pa?.b, pm?.a, pm?.b].map((s) => s?.ctx.close().catch(() => undefined)));
  });

  test("K1 Getrenntes Konto B: Hinweiskarte nennt das aktive Konto und warum die Wave fehlt, Wave von A nicht sichtbar", {
    tag: "@t78",
  }, async () => {
    const { page } = pa.b;
    await page.goto("/");

    const card = notice(page);
    await expect(card).toBeVisible();
    await expect(page.locator("#link-notice-title")).toHaveText("You are signed in to a separate account");
    await expect(card).toContainText(`Active account: ${pa.mail}`);
    await expect(card).toContainText("did not confirm your email address");
    await expect(card).toContainText("a wave you expect can be missing");
    await expect(card.locator('a[href="/account/link"]')).toBeVisible();

    // Die Karte steht über dem Angebot, eine neue Wave anzulegen.
    const create = page.locator('a[href="/waves/new"]').first();
    await expect(create).toBeVisible();
    const noticeBox = await card.boundingBox();
    const createBox = await create.boundingBox();
    expect(noticeBox?.y).toBeLessThan(createBox?.y ?? 0);

    // Der Wave von A ist in B nicht zu sehen.
    await expect(page.getByRole("heading", { level: 2, name: pa.waveName, exact: true })).toHaveCount(0);
    await expect(page.getByText(pa.waveName)).toHaveCount(0);

    // Auch die Konto-Seite trägt die Karte.
    await page.goto("/account");
    await expect(notice(page)).toBeVisible();
    await expect(notice(page)).toContainText(`Active account: ${pa.mail}`);
  });

  test("K1b Neue Wave anlegen: auch die Wave-Anlage trägt die Hinweiskarte mit aktivem Konto und Grund", {
    tag: "@t78",
  }, async () => {
    const { page } = pa.b;
    await page.goto("/waves/new");
    await expect(page).toHaveURL(/\/waves\/new$/);

    const card = notice(page);
    await expect(card).toBeVisible();
    await expect(page.locator("#link-notice-title")).toHaveText("You are signed in to a separate account");
    await expect(card).toContainText(`Active account: ${pa.mail}`);
    await expect(card).toContainText("a wave you expect can be missing");
    await expect(card.locator('a[href="/account/link"]')).toBeVisible();
  });

  test("K2 Adresse beim Anbieter bestätigt: ohne Nachweis über Konto A (falsches Passwort) kein Schritt 3, nichts ändert sich", {
    tag: "@t78",
  }, async () => {
    const { page } = pa.b;

    // Schritt 1: Anbieter bestätigt jetzt die Adresse (gleicher `sub`, email_verified=true).
    await page.goto("/account/link");
    await expect(currentStep(page)).toContainText("1.");
    await startStepOne(page, pa, true);

    // Schritt 2: Nachweis über das andere Konto verlangt.
    await expect(currentStep(page)).toContainText("2.");
    await expect(page.getByRole("heading", { level: 2 })).toContainText(pa.mail);
    await expect(passwordInput(page)).toBeVisible();

    // Falsches Passwort: Fehler, weiter Schritt 2, keine Zusammenfassung, kein Schritt 3.
    await passwordInput(page).fill(`${passwordFor(pa.mail)}-falsch`);
    await passwordForm(page).locator('button[type="submit"]').click();
    await page.waitForURL((url) => url.pathname === "/account/link" && url.searchParams.has("error"));
    expect(new URL(page.url()).searchParams.get("error")).toBe("wrong-password");
    await expect(page.locator('p[role="alert"]')).toHaveText("That password did not work.");
    await expect(currentStep(page)).toContainText("2.");
    await expect(passwordInput(page)).toBeVisible();
    await expect(confirmForm(page)).toHaveCount(0);

    // Direktes Absenden von Schritt 3 ohne Nachweis führt nirgends hin.
    const direct = await page.request.post("/account/link/confirm", { maxRedirects: 0 });
    expect(direct.headers().location ?? "").not.toContain("/account/link/done");
    await page.goto("/account/link");
    await expect(currentStep(page)).toContainText("2.");
    await expect(confirmForm(page)).toHaveCount(0);

    // Nichts hat sich geändert: B bleibt B, die Wave von A bleibt unsichtbar.
    await page.goto("/");
    await expect(notice(page)).toBeVisible();
    await expect(page.getByText(pa.waveName)).toHaveCount(0);

    await cancelLink(page);
  });

  test("K3 Gleiche, aber unbestätigte Adresse führt nie zur Verknüpfung: Schritt 1 bleibt stehen", {
    tag: "@t78",
  }, async ({ browser }) => {
    // Erneutes Anmelden (frische Sitzung, gleicher `sub`, weiter unbestätigt): dasselbe getrennte Konto B.
    const again = await session(browser);
    try {
      const { page } = again;
      await signInUnverified(page, pa);
      await page.goto("/");
      await expect(notice(page)).toBeVisible();
      await expect(page.getByText(pa.waveName)).toHaveCount(0);

      // Schritt 1 direkt starten, der Anbieter bestätigt die Adresse weiterhin nicht.
      await startStepOne(page, pa, false);
      expect(new URL(page.url()).searchParams.get("error")).toBe("unverified");
      await expect(page.locator('p[role="alert"]')).toHaveText(
        "The sign-in service does not confirm this address. Nothing was changed.",
      );
      await expect(currentStep(page)).toContainText("1.");
      await expect(passwordInput(page)).toHaveCount(0);
      await expect(confirmForm(page)).toHaveCount(0);

      // Schritte 2 und 3 lassen sich nicht überspringen, auch nicht mit dem richtigen Passwort von A.
      const password = await page.request.post("/account/link/control/password", {
        form: { password: passwordFor(pa.mail) },
        maxRedirects: 0,
      });
      expect(password.headers().location ?? "").not.toContain("/account/link/done");
      const confirm = await page.request.post("/account/link/confirm", { maxRedirects: 0 });
      expect(confirm.headers().location ?? "").not.toContain("/account/link/done");

      await page.goto("/account/link");
      await expect(currentStep(page)).toContainText("1.");
      await expect(passwordInput(page)).toHaveCount(0);
      await expect(confirmForm(page)).toHaveCount(0);

      // B bleibt B: Hinweiskarte da, Wave von A nicht sichtbar.
      await page.goto("/");
      await expect(notice(page)).toBeVisible();
      await expect(page.getByText(pa.waveName)).toHaveCount(0);

      await cancelLink(page);
    } finally {
      await again.ctx.close();
    }
  });

  test("K4 Schritt 3 benennt vor dem Abschluss, was mit Anmeldungen, Mitgliedschaften, Waves, Geräten und Sitzungen geschieht; bis dahin ist nichts verändert", {
    tag: "@t78",
  }, async () => {
    const { page } = pa.b;
    await ensureBWave(pa);
    const beforeA = await snapshot(pa.a.page);
    const beforeB = await snapshot(page);
    expect(beforeB.waves).toEqual([pa.bWave]);

    await startStepOne(page, pa, true);
    await proveControl(page, pa);

    // Die Zusammenfassung nennt jede Folge, bevor sie eintritt.
    const heading = (name: string) => page.getByRole("heading", { level: 3, name, exact: true });
    await expect(page.getByRole("heading", { level: 2 })).toContainText(pa.mail);
    await expect(heading("Sign-ins")).toBeVisible();
    await expect(heading("Waves this account owns")).toBeVisible();
    await expect(heading("Memberships")).toBeVisible();
    await expect(heading("Devices")).toBeVisible();
    await expect(heading("Sessions")).toBeVisible();
    const summary = page.locator("section.wc-card");
    await expect(summary).toContainText(`move to ${pa.mail}`);
    await expect(summary).toContainText(`${pa.bWave} goes to ${pa.mail}.`);
    await expect(summary).toContainText("This account has no devices.");
    await expect(summary).toContainText(`Afterwards you are signed in as ${pa.mail}.`);
    await expect(page.locator('form[action="/account/link/confirm"] button[type="submit"]')).toHaveText(
      "Join the accounts",
    );

    // Das Öffnen von Schritt 3 (auch ein erneutes Laden) ändert nichts an A und B.
    await page.reload();
    await expect(confirmForm(page)).toBeVisible();
    expect(await snapshot(pa.a.page)).toEqual(beforeA);
    expect(await snapshot(page)).toEqual(beforeB);

    await cancelLink(page);
  });

  test("K6 Abbruch (Schritt 2 und 3) und Fehler lassen A und B unverändert, B meldet sich weiter an", {
    tag: "@t78",
  }, async ({ browser }) => {
    const { page } = pa.b;
    await ensureBWave(pa);
    const beforeA = await snapshot(pa.a.page);
    const beforeB = await snapshot(page);
    const unchanged = async () => {
      expect(await snapshot(pa.a.page)).toEqual(beforeA);
      expect(await snapshot(page)).toEqual(beforeB);
    };

    // Abbruch in Schritt 2.
    await startStepOne(page, pa, true);
    await expect(currentStep(page)).toContainText("2.");
    await cancelForm(page).locator('button[type="submit"]').click();
    await page.waitForURL((url) => url.pathname === "/account");
    await unchanged();
    await page.goto("/account/link");
    await expect(currentStep(page)).toContainText("1.");

    // Abbruch in Schritt 3.
    await startStepOne(page, pa, true);
    await proveControl(page, pa);
    await cancelForm(page).locator('button[type="submit"]').click();
    await page.waitForURL((url) => url.pathname === "/account");
    await unchanged();
    await page.goto("/account/link");
    await expect(currentStep(page)).toContainText("1.");
    await expect(confirmForm(page)).toHaveCount(0);

    // Fehlerfall: falsches Passwort.
    await startStepOne(page, pa, true);
    await passwordInput(page).fill(`${passwordFor(pa.mail)}-falsch`);
    await passwordForm(page).locator('button[type="submit"]').click();
    await page.waitForURL((url) => url.searchParams.get("error") === "wrong-password");
    await unchanged();
    await cancelLink(page);

    // B kann sich danach weiter anmelden: frische Sitzung, gleicher `sub`, dasselbe Konto B.
    const again = await session(browser);
    try {
      await signInUnverified(again.page, pa);
      expect(await snapshot(again.page)).toEqual(beforeB);
      await again.page.goto("/");
      await expect(notice(again.page)).toBeVisible();
    } finally {
      await again.ctx.close();
    }
  });

  test("K7 Deutsch: Hinweiskarte, Schritt 1 und Schritt 3 erscheinen mit de-DE auf Deutsch", {
    tag: "@t78",
  }, async ({ browser }) => {
    await ensureBWave(pa);
    const ctx = await browser.newContext({ baseURL: env("APP_URL"), locale: "de-DE" });
    try {
      const page = await ctx.newPage();
      await signInUnverified(page, pa);

      await page.goto("/");
      await expect(page.locator("#link-notice-title")).toHaveText(
        "Du bist an einem getrennten Konto angemeldet",
      );
      await expect(notice(page)).toContainText(`Aktives Konto: ${pa.mail}`);

      // Schritt 1.
      await page.goto("/account/link");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Konten verknüpfen");
      await expect(currentStep(page)).toContainText("Adresse bestätigen");
      await expect(startForm(page).locator('button[type="submit"]')).toHaveText(
        "Weiter mit Test-OIDC (Mock)",
      );

      // Fehlerfall in Schritt 2 auf Deutsch, dann Schritt 3.
      await startStepOne(page, pa, true);
      await passwordInput(page).fill(`${passwordFor(pa.mail)}-falsch`);
      await passwordForm(page).locator('button[type="submit"]').click();
      await page.waitForURL((url) => url.searchParams.get("error") === "wrong-password");
      await expect(page.locator('p[role="alert"]')).toHaveText("Dieses Passwort hat nicht funktioniert.");
      await proveControl(page, pa);

      await expect(page.getByRole("heading", { level: 2 })).toHaveText(
        `Prüfen, dann mit ${pa.mail} zusammenführen`,
      );
      await expect(page.getByRole("heading", { level: 3, name: "Anmeldungen", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { level: 3, name: "Sitzungen", exact: true })).toBeVisible();
      await expect(page.locator("section.wc-card")).toContainText(`${pa.bWave} geht an ${pa.mail}.`);
      await expect(confirmForm(page).locator('button[type="submit"]')).toHaveText("Konten zusammenführen");
      await expect(cancelForm(page).locator('button[type="submit"]')).toHaveText("Abbrechen");

      await cancelLink(page);
    } finally {
      await ctx.close();
    }
  });

  test("K5 Nach „Join the accounts“ führt dieselbe Mock-Identität in Konto A samt Wave, die Hinweiskarte ist weg", {
    tag: "@t78",
  }, async ({ browser }) => {
    const { page } = pm.b;
    await ensureBWave(pm);
    const beforeA = await snapshot(pm.a.page);
    const beforeB = await snapshot(page);
    expect(beforeA.waves).toEqual([pm.waveName]);
    expect(beforeA.identities).toEqual(["password"]);
    expect(beforeB.waves).toEqual([pm.bWave]);
    expect(beforeB.user).not.toBe(beforeA.user);

    // Der Weg: Adresse beim Anbieter, Nachweis über A, Zusammenfassung, Bestätigung.
    await startStepOne(page, pm, true);
    await proveControl(page, pm);
    await confirmForm(page).locator('button[type="submit"]').click();
    await page.waitForURL((url) => url.pathname === "/account/link/done");
    await expect(page.locator('p[role="status"]')).toBeVisible();
    expect(new URL(page.url()).searchParams.get("waves")).toBe("1");

    // Die Sitzung von B ist nun die von A: Konto A hält beide Waves und beide Anmeldearten.
    const merged = await snapshot(page);
    expect(merged.user).toBe(beforeA.user);
    expect(merged.verified).toBe(true);
    expect(merged.waves).toEqual([pm.waveName, pm.bWave].sort());
    // Die OIDC-Anmeldung wechselt zu A; sie heißt `oidc:<Issuer>`.
    expect(merged.identities).toHaveLength(2);
    expect(merged.identities[0]).toMatch(/^oidc/);
    expect(merged.identities[1]).toBe("password");
    expect(await snapshot(pm.a.page)).toEqual(merged);

    // Die Hinweiskarte ist weg, auf der Übersicht und auf der Konto-Seite.
    await page.goto("/");
    await expect(notice(page)).toHaveCount(0);
    await page.goto("/account");
    await expect(notice(page)).toHaveCount(0);

    // Die Mock-Anmeldung mit derselben Identität (gleicher `sub`, nun bestätigt) führt in Konto A.
    const again = await session(browser);
    try {
      await again.page.goto("/auth/oidc/start");
      await pickClaims(again.page, pm, true);
      expect((await snapshot(again.page)).user).toBe(beforeA.user);
      await again.page.goto("/");
      await expect(notice(again.page)).toHaveCount(0);
      await expect(await waveCard(again.page, pm.waveName)).toBeVisible();
    } finally {
      await again.ctx.close();
    }
  });
});
