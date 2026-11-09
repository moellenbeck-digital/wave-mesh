/**
 * Ticket #71: „Wave löschen“, „Wave verlassen“ und „Komplett abmelden“ sind im Control auffindbar.
 *
 * Aufbau: Der Eigentümer (APP_USER) legt zwei eigene Waves an: `t71-<lauf>` (Anzeige-Fälle, Verlassen) und
 * `t71d-<lauf>` (Wegwerf-Wave für das Löschen). Ein Admin und ein Mitglied (feste Adressen, siehe helpers.ts)
 * nehmen per Einladung an der ersten teil. Die Fälle sind `serial`; Anzeige-Fälle laufen je einmal für `en`
 * und `de` (Kriterium 8, Sprache über das Cookie `wave_lang`), Löschen und Verlassen (K9) am Ende auf `en`.
 * Am Ende entfernt der Eigentümer beide Waves, soweit noch vorhanden; die Zweitkonten bleiben bestehen.
 *
 * Kriterien: K1 Eigentümer sieht „Aufräumen“ offen; K2 Löschen nur mit exaktem Namen; K3 Admin/Mitglied sehen
 * „Verlassen“ und kein Löschformular; K4 Hinweise im Lösch-Bereich; K5 Hinweis beim Verlassen; K6 Header-Link
 * und Abschnitt `/account#abmelden`; K7 Header bei 360 px; K9 Löschen und Verlassen end to end.
 *
 * Nicht prüfbar: dass beim Löschen/Verlassen verbundene Geräte tatsächlich ihre Anmeldung verlieren — das
 * braucht ein verbundenes Gerät (die Zahl „0 Geräte“ in K4 gilt für das frische Wave).
 */
import { type Browser, type BrowserContext, expect, type Locator, type Page, test } from "@playwright/test";
import {
  accept,
  createWave,
  deleteWave,
  env,
  invite,
  login,
  memberRow,
  newSession,
  waveCard,
} from "./helpers.ts";

const run = Math.random().toString(36).slice(2, 8);
const waveName = `t71-${run}`;
const waveSuffix = `${waveName}.wave.internal`;
const dropName = `t71d-${run}`;
const adminMail = "t71-admin@example.test";
const memberMail = "t71-member@example.test";

type Lang = "en" | "de";

const T = {
  en: {
    cleanup: "Clean up",
    deleteWave: "Delete wave",
    deleteBtn: "Delete for good",
    deleteLabel: (n: string) => `Type ${n} to confirm`,
    deleteHint: (people: number, suffix: string) =>
      `Takes 0 devices and ${people} people with it. Every device loses its sign-in and has to be approved again, and ${suffix} is free again afterwards. This cannot be undone.`,
    ownerCannotLeave:
      "As the owner you cannot leave this wave, and ownership cannot be handed over yet. For you, leaving means deleting the wave.",
    leaveWave: "Leave wave",
    leaveBtn: "Leave this wave",
    leaveHint:
      "You leave this wave, and your devices in it leave with you. Coming back takes a new invitation.",
    signOut: "Sign out",
    signOutHelp: "How do I sign out completely?",
    title: "Sign out completely",
    webLabel: "Sign out in the header",
    web: "Ends only this browser session",
    cliLabel: "wave logout <wave> on a device",
    cli: "Signs that device out of that wave",
    leaveLabel: "Leave the wave",
    leave: "Removes you and your devices from that wave",
    where: "Leaving and deleting are at the bottom of each wave on the overview.",
    overview: "overview",
  },
  de: {
    cleanup: "Aufräumen",
    deleteWave: "Wave löschen",
    deleteBtn: "Endgültig löschen",
    deleteLabel: (n: string) => `Zum Bestätigen ${n} eintippen`,
    deleteHint: (people: number, suffix: string) =>
      `Nimmt 0 Geräte und ${people} Personen mit. Jedes Gerät verliert seine Anmeldung und muss neu freigegeben werden, und ${suffix} ist danach wieder frei. Rückgängig geht das nicht.`,
    ownerCannotLeave:
      "Als Eigentümer kannst du diesen Wave nicht verlassen, und die Eigentümerschaft lässt sich noch nicht übertragen. Für dich heißt Verlassen: den Wave löschen.",
    leaveWave: "Wave verlassen",
    leaveBtn: "Diesen Wave verlassen",
    leaveHint:
      "Du verlässt diesen Wave, und deine Geräte darin gehen mit. Zurück geht es nur mit einer neuen Einladung.",
    signOut: "Abmelden",
    signOutHelp: "Wie melde ich mich komplett ab?",
    title: "Komplett abmelden",
    webLabel: "Abmelden im Kopf der Seite",
    web: "Beendet nur diese Browser-Sitzung",
    cliLabel: "wave logout <Wave> am Gerät",
    cli: "Meldet dieses Gerät aus dem Wave ab",
    leaveLabel: "Wave verlassen",
    leave: "Entfernt dich und deine Geräte aus diesem Wave",
    where: "Verlassen und Löschen stehen am Ende jedes Waves auf der Übersicht.",
    overview: "Übersicht",
  },
} as const;

type Who = { ctx: BrowserContext; page: Page };

let owner: Who;
let admin: Who;
let member: Who;
let dropId: string;

const ownerMail = () => env("APP_USER");

async function session(browser: Browser): Promise<Who> {
  const ctx = await newSession(browser);
  return { ctx, page: await ctx.newPage() };
}

/** Sprache der Oberfläche über das Cookie des Umschalters (es gewinnt gegen Accept-Language). */
async function setLang(who: Who, lang: Lang): Promise<void> {
  await who.ctx.addCookies([{ name: "wave_lang", value: lang, url: env("APP_URL") }]);
}

async function open(who: Who, name = waveName): Promise<Locator> {
  await who.page.goto("/");
  const c = await waveCard(who.page, name);
  await expect(c).toHaveCount(1);
  return c;
}

const cleanupHeading = (c: Locator, lang: Lang) =>
  c.getByRole("heading", { level: 3, name: T[lang].cleanup });

/** Wave-ID aus dem Löschformular der Karte. */
async function idFromDelete(c: Locator): Promise<string> {
  const action = await c.locator('form[action$="/delete"]').getAttribute("action");
  const found = action?.match(/^\/waves\/([^/]+)\/delete$/)?.[1];
  if (!found) throw new Error(`Wave-ID nicht zu ermitteln (action=${action})`);
  return found;
}

test.describe("Löschen, Verlassen, Abmelden auffindbar", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    owner = await session(browser);
    admin = await session(browser);
    member = await session(browser);

    await login(owner.page, ownerMail(), env("APP_PASSWORD"));
    const c = await createWave(owner.page, waveName, waveSuffix);
    const adminLink = await invite(owner.page, c, adminMail, "admin");
    const memberLink = await invite(owner.page, c, memberMail, "member");
    await accept(admin.page, adminLink, adminMail);
    await accept(member.page, memberLink, memberMail);

    const d = await createWave(owner.page, dropName, `${dropName}.wave.internal`);
    dropId = await idFromDelete(d);
  });

  test.afterAll(async () => {
    try {
      if (owner) {
        await setLang(owner, "en");
        // Jedes Wave für sich: scheitert das erste, soll das zweite trotzdem entfernt werden.
        try {
          await deleteWave(owner.page, dropName);
        } finally {
          await deleteWave(owner.page, waveName);
        }
      }
    } finally {
      await Promise.all([owner?.ctx.close(), admin?.ctx.close(), member?.ctx.close()]);
    }
  });

  for (const lang of ["en", "de"] as const) {
    const t = T[lang];

    test(`K1 [${lang}] Eigentümer: „${t.cleanup}“ ganz unten ohne Klick, mit Namensfeld und Lösch-Knopf`, {
      tag: "@t71",
    }, async () => {
      await setLang(owner, lang);
      const c = await open(owner);
      // Offen sichtbar, kein Klappbereich um das Formular, und der letzte Abschnitt der Karte.
      const heading = cleanupHeading(c, lang);
      await expect(heading).toBeVisible();
      await expect(c.locator("h3").last()).toHaveText(t.cleanup);
      await expect(c.locator("details").locator('form[action$="/delete"]')).toHaveCount(0);
      const form = c.locator('form[action$="/delete"]');
      await expect(form.locator('input[name="name"]')).toBeVisible();
      await expect(form.getByRole("button", { name: t.deleteBtn })).toBeVisible();
      await expect(c.getByRole("heading", { level: 4, name: t.deleteWave })).toBeVisible();
      // Kein „Wave verlassen“ für den Eigentümer.
      await expect(c.getByRole("button", { name: t.leaveBtn })).toHaveCount(0);
      await expect(c.locator('form[action$="/leave"]')).toHaveCount(0);
      // Steht unter der Personenliste, nicht darüber.
      const tops = await c
        .locator("h3")
        .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
      expect(tops.length).toBeGreaterThanOrEqual(3);
      expect(tops.at(-1) ?? 0).toBeGreaterThan(tops.at(-2) ?? Number.POSITIVE_INFINITY);
      // Lesbare Schrift: Hinweis in Fließtextgröße (14 px), nicht mehr als 13-px-Beschriftung.
      // Als String: der Ausdruck läuft im Browser, die Typprüfung hier kennt kein DOM.
      const hintSize = Number(
        await c
          .getByText(t.ownerCannotLeave, { exact: true })
          .evaluate("(el) => Number.parseFloat(getComputedStyle(el).fontSize)"),
      );
      expect(hintSize).toBeGreaterThanOrEqual(14);
    });

    test(`K2 [${lang}] Löschen nur mit exakt getipptem Namen: falscher Name löscht nichts`, {
      tag: "@t71",
    }, async () => {
      await setLang(owner, lang);
      const c = await open(owner, dropName);
      await expect(c.locator('form[action$="/delete"] label')).toHaveText(t.deleteLabel(dropName));
      for (const wrong of ["falsch", dropName.toUpperCase(), `${dropName} `, dropName.slice(0, -1)]) {
        const form = (await open(owner, dropName)).locator('form[action$="/delete"]');
        await form.locator('input[name="name"]').fill(wrong);
        await form.getByRole("button", { name: t.deleteBtn }).click();
        await owner.page.waitForLoadState("load");
        // Die Wave steht danach unverändert in der Übersicht.
        await expect(await open(owner, dropName)).toHaveCount(1);
      }
      // Auch der direkte POST mit falschem Namen löscht nichts.
      const res = await owner.ctx.request.post(`/waves/${dropId}/delete`, {
        form: { name: "falsch" },
        maxRedirects: 0,
      });
      expect(res.status(), "POST mit falschem Namen").not.toBe(500);
      await expect(await open(owner, dropName)).toHaveCount(1);
      await expect(await open(owner)).toHaveCount(1);
    });

    for (const [rolle, who] of [
      ["Admin", () => admin],
      ["Mitglied", () => member],
    ] as const) {
      test(`K3 [${lang}] ${rolle}: „${t.leaveWave}“ ohne Klick sichtbar, kein Löschformular`, {
        tag: "@t71",
      }, async () => {
        await setLang(who(), lang);
        const c = await open(who());
        await expect(cleanupHeading(c, lang)).toBeVisible();
        await expect(c.locator("h3").last()).toHaveText(t.cleanup);
        await expect(c.getByRole("heading", { level: 4, name: t.leaveWave })).toBeVisible();
        await expect(c.locator("details").locator('form[action$="/leave"]')).toHaveCount(0);
        await expect(c.getByRole("button", { name: t.leaveBtn })).toBeVisible();
        await expect(c.locator('form[action$="/delete"]')).toHaveCount(0);
        await expect(c.locator('input[name="name"][id^="delete-"]')).toHaveCount(0);
        await expect(c.getByRole("button", { name: t.deleteBtn })).toHaveCount(0);
      });
    }

    test(`K4 [${lang}] Lösch-Bereich nennt Geräte, Personen, Neu-Freigabe, Suffix, nicht rückgängig; Eigentümer kann nicht verlassen`, {
      tag: "@t71",
    }, async () => {
      await setLang(owner, lang);
      const c = await open(owner);
      // Eigentümer, Admin und Mitglied: drei Personen.
      for (const mail of [ownerMail(), adminMail, memberMail])
        await expect(memberRow(c, mail)).toHaveCount(1);
      const people = 3;
      await expect(c.getByText(t.deleteHint(people, waveSuffix), { exact: true })).toBeVisible();
      await expect(c.getByText(t.ownerCannotLeave, { exact: true })).toBeVisible();
    });

    test(`K5 [${lang}] Verlassen: Geräte gehen mit, zurück nur mit neuer Einladung`, {
      tag: "@t71",
    }, async () => {
      for (const who of [admin, member]) {
        await setLang(who, lang);
        const c = await open(who);
        await expect(c.getByText(t.leaveHint, { exact: true })).toBeVisible();
      }
    });

    test(`K6 [${lang}] Header-Link führt zu /account#abmelden; Abschnitt sichtbar, nicht unter dem Header, drei Wege, Link zur Übersicht`, {
      tag: "@t71",
    }, async () => {
      await setLang(owner, lang);
      const page = owner.page;
      await page.goto("/");
      // Der Link steht neben „Abmelden“; seine Beschriftung ist auch der zugängliche Name.
      const link = page.locator("header").getByRole("link", { name: t.signOutHelp });
      await expect(link).toBeVisible();
      await expect(link).toHaveText(t.signOutHelp);
      await expect(page.locator("header").getByRole("button", { name: t.signOut })).toBeVisible();
      await link.click();
      await page.waitForURL((url) => url.pathname === "/account" && url.hash === "#abmelden");

      const section = page.locator("section#abmelden");
      await expect(section).toBeVisible();
      await expect(section.getByRole("heading", { name: t.title })).toBeVisible();
      // Nicht vom festen Header verdeckt (der Anker scrollt erst nach dem Laden).
      const headerBottom = await page.locator("header").evaluate((el) => el.getBoundingClientRect().bottom);
      await expect
        .poll(async () => (await section.boundingBox())?.y ?? -1, { timeout: 5_000 })
        .toBeGreaterThanOrEqual(headerBottom - 1);

      // Drei Wege.
      await expect(section.locator("dt")).toHaveText([t.webLabel, t.cliLabel, t.leaveLabel]);
      await expect(section.locator("dd").nth(0)).toContainText(t.web);
      await expect(section.locator("dd").nth(1)).toContainText(t.cli);
      await expect(section.locator("dd").nth(2)).toContainText(t.leave);

      // Link zur Übersicht mit Verlassen und Löschen.
      await expect(section.getByText(t.where, { exact: true })).toBeVisible();
      await section.getByRole("link", { name: t.overview, exact: true }).click();
      await page.waitForURL((url) => url.pathname === "/");
      await expect(cleanupHeading(await open(owner), lang)).toBeVisible();
    });

    test(`K7 [${lang}] 360 px: Header zeigt nur „?“ mit aria-label, nichts läuft über`, {
      tag: "@t71",
    }, async ({ browser }) => {
      const ctx = await browser.newContext({
        baseURL: env("APP_URL"),
        locale: "en-US",
        viewport: { width: 360, height: 800 },
      });
      try {
        await ctx.addCookies([{ name: "wave_lang", value: lang, url: env("APP_URL") }]);
        const page = await ctx.newPage();
        await login(page, ownerMail(), env("APP_PASSWORD"));
        for (const path of ["/", "/account"]) {
          await page.goto(path);
          const link = page.locator('header a[href="/account#abmelden"]');
          await expect(link).toBeVisible();
          await expect(link).toHaveText("?");
          await expect(link).toHaveAttribute("aria-label", t.signOutHelp);
          const signOut = page.locator("header").getByRole("button", { name: t.signOut });
          await expect(signOut).toBeVisible();
          // Nichts läuft über: weder die Seite noch Link und Knopf im Header.
          // Als String: der Ausdruck läuft im Browser, die Typprüfung hier kennt kein DOM.
          const overflow = await page.evaluate<number>(
            "document.documentElement.scrollWidth - window.innerWidth",
          );
          expect(overflow, `Seite ${path} breiter als 360 px`).toBeLessThanOrEqual(0);
          for (const el of [link, signOut]) {
            const box = await el.boundingBox();
            expect((box?.x ?? -1) + (box?.width ?? 0)).toBeLessThanOrEqual(360);
            expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
          }
        }
      } finally {
        await ctx.close();
      }
    });
  }

  test("K9 Löschen end to end: Eigentümer löscht das Wegwerf-Wave mit getipptem Namen", {
    tag: "@t71",
  }, async () => {
    await setLang(owner, "en");
    const c = await open(owner, dropName);
    const form = c.locator('form[action$="/delete"]');
    await form.locator('input[name="name"]').fill(dropName);
    await Promise.all([
      owner.page.waitForResponse((r) => r.url().endsWith("/delete") && r.request().method() === "POST"),
      form.getByRole("button", { name: T.en.deleteBtn }).click(),
    ]);
    await owner.page.waitForURL((url) => url.pathname === "/");
    await owner.page.reload();
    await expect(await waveCard(owner.page, dropName)).toHaveCount(0);
    // Das andere Wave des Eigentümers ist unberührt.
    await expect(await open(owner)).toHaveCount(1);
  });

  for (const [rolle, who, mail] of [
    ["Mitglied", () => member, memberMail],
    ["Admin", () => admin, adminMail],
  ] as const) {
    test(`K9 Verlassen end to end: ${rolle} verlässt das Wave, die Mitgliedschaft ist weg`, {
      tag: "@t71",
    }, async () => {
      await setLang(who(), "en");
      const c = await open(who());
      await Promise.all([
        who().page.waitForResponse((r) => r.url().endsWith("/leave") && r.request().method() === "POST"),
        c.getByRole("button", { name: T.en.leaveBtn }).click(),
      ]);
      await who().page.waitForURL((url) => url.pathname === "/" || url.pathname.startsWith("/waves"));
      await who().page.goto("/");
      await expect(await waveCard(who().page, waveName)).toHaveCount(0);
      // Aus Sicht des Eigentümers: Person weg, er selbst noch da.
      const co = await open(owner);
      await expect(memberRow(co, mail)).toHaveCount(0);
      await expect(memberRow(co, ownerMail())).toHaveCount(1);
    });
  }
});
