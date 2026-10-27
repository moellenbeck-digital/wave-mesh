/**
 * Ticket #41 (Nacharbeit): Rollen-Auswahl in der Mitgliederliste lesbar machen.
 *
 * Aufbau: Der Eigentümer (APP_USER) legt eine eigene Wave an, lädt einen Admin (A) und ein Mitglied (M)
 * ein (die Zweitkonten nehmen an) und lässt eine dritte Einladung offen. Damit gibt es vier Zeilenarten:
 * Owner (nicht änderbar), Admin und Mitglied (änderbar), offene Einladung. Am Ende entfernt der Eigentümer
 * die Wave wieder (mit ihr die offene Einladung); die Zweitkonten bleiben (feste Adressen, siehe helpers.ts).
 *
 * Kriterien → Fälle
 *   1 Rollenname vollständig lesbar, de und en, Owner und Admin   → L1
 *   2 beide Optionen vollständig lesbar                           → L2
 *   3 „Speichern“ neben der Auswahl, nichts abgeschnitten         → L3
 *   4 Spalten von Mitglieds- und Einladungszeilen fluchten        → L4
 *   5 Rollenänderung funktioniert, Owner gesperrt, Member ohne    → t41-admin-rollen.e2e.ts (K1, K2, K4, K5)
 *   6 schmale Ansicht (< md = 768 px)                             → L5 (320, 375, 767 px), L6 (768 px: Grenze)
 *   7 Rolle-Spalte bearbeitbar breiter als nur lesbar (Member-Sicht) → L7
 *
 * Nicht prüfbar: das aufgeklappte Auswahlmenü des Browsers. Es ist ein natives Popup außerhalb des DOM und
 * erscheint weder in Playwright-Screenshots noch in der Diagnose-Sitzung. L2 misst deshalb die Textbreite
 * jeder Option gegen die Breite der Auswahl (das Popup ist mindestens so breit wie die Auswahl).
 *
 * Sprache: `en-US` per Config; Deutsch über das Cookie `wave_lang` (wie der Umschalter im Seitenkopf).
 * Die Fälle bauen aufeinander auf (`serial`).
 */
/// <reference lib="dom" />
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
  waveCard,
} from "./helpers.ts";

const run = Math.random().toString(36).slice(2, 8);
const waveName = `t41l-${run}`;
const adminMail = "t41-admin1@example.test";
const memberMail = "t41-member@example.test";
const pendingMail = `t41-wartend-${run}@example.test`;

type Who = { ctx: BrowserContext; page: Page };
let owner: Who;
let admin: Who;
let member: Who;

const ownerMail = () => env("APP_USER");
const select = (row: Locator) => row.locator('select[name="role"]');
const saveButton = (row: Locator) => row.locator('form[action$="/role"] button[type="submit"]');

type Box = { x: number; y: number; width: number; height: number };
const right = (b: Box) => b.x + b.width;

async function session(browser: Parameters<typeof newSession>[0]): Promise<Who> {
  const ctx = await newSession(browser);
  return { ctx, page: await ctx.newPage() };
}

async function setLocale(who: Who, locale: "en" | "de"): Promise<void> {
  await who.ctx.addCookies([{ name: "wave_lang", value: locale, url: env("APP_URL") }]);
}

/** Öffnet `/` in der gewünschten Sprache und Breite und liefert die Karte der Test-Wave. */
async function open(who: Who, locale: "en" | "de", width = 1280): Promise<Locator> {
  await setLocale(who, locale);
  await who.page.setViewportSize({ width, height: 900 });
  await who.page.goto("/");
  const card = waveCard(who.page, waveName);
  await expect(card).toHaveCount(1);
  await expect(memberRow(card, memberMail)).toHaveCount(1);
  return card;
}

async function box(l: Locator, what: string): Promise<Box> {
  const b = await l.boundingBox();
  if (!b) throw new Error(`${what} nicht sichtbar`);
  return b;
}

/** Textbreite jeder Option (in der Schrift der Auswahl) gegen die nutzbare Innenbreite. */
async function fit(sel: Locator) {
  return sel.evaluate((el) => {
    const s = el as HTMLSelectElement;
    const cs = getComputedStyle(s);
    const c = document.createElement("canvas").getContext("2d");
    if (!c) throw new Error("kein Canvas");
    c.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const inner = s.clientWidth - Number.parseFloat(cs.paddingLeft) - Number.parseFloat(cs.paddingRight);
    return {
      inner,
      selected: s.selectedOptions[0]?.textContent ?? "",
      options: Array.from(s.options).map((o) => ({
        text: o.textContent ?? "",
        width: c.measureText(o.textContent ?? "").width,
      })),
    };
  });
}

/** Die Kinder der Zeile (Name, Rolle, Geräte/Frist, Aktion) mit ihrer Lage. */
async function cells(row: Locator): Promise<{ x: number; width: number }[]> {
  return row.evaluate((li) =>
    Array.from(li.children).map((c) => {
      const r = c.getBoundingClientRect();
      return { x: r.x, width: r.width };
    }),
  );
}

async function shot(who: Who, row: Locator, name: string): Promise<void> {
  await row.scrollIntoViewIfNeeded();
  await who.page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
}

test.describe("Rollen-Auswahl in der Mitgliederliste", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    owner = await session(browser);
    admin = await session(browser);
    member = await session(browser);
    try {
      await login(owner.page, ownerMail(), env("APP_PASSWORD"));
      const c = await createWave(owner.page, waveName, `${waveName}.wave.internal`);
      const la = await invite(owner.page, c, adminMail, "admin");
      const lm = await invite(owner.page, c, memberMail, "member");
      await invite(owner.page, c, pendingMail, "member");
      await accept(admin.page, la, adminMail);
      await accept(member.page, lm, memberMail);
    } catch (e) {
      await member.ctx.close();
      throw e;
    }
  });

  test.afterAll(async () => {
    try {
      if (owner) await deleteWave(owner.page, waveName);
    } finally {
      await Promise.all([owner?.ctx.close(), admin?.ctx.close(), member?.ctx.close()]);
    }
  });

  test("L1 Der gewählte Rollenname ist in der Auswahl vollständig lesbar (de und en, Owner und Admin)", {
    tag: "@t41",
  }, async () => {
    for (const [name, who] of [
      ["Owner", owner],
      ["Admin", admin],
    ] as const) {
      for (const locale of ["en", "de"] as const) {
        const card = await open(who, locale);
        for (const mail of [memberMail, ...(who === owner ? [adminMail] : [])]) {
          const row = memberRow(card, mail);
          const sel = select(row);
          await expect(sel, `${name}/${locale}/${mail}: Auswahl`).toHaveCount(1);
          const f = await fit(sel);
          const need = f.options.find((o) => o.text === f.selected)?.width ?? Number.POSITIVE_INFINITY;
          expect(
            need,
            `${name}/${locale}/${mail}: „${f.selected}“ braucht ${need}px, Innenbreite ${f.inner}px`,
          ).toBeLessThanOrEqual(f.inner);
          expect(
            (await box(sel, "Auswahl")).width,
            `${name}/${locale}: Breite der Auswahl`,
          ).toBeGreaterThanOrEqual(160);
        }
        if (who === owner) await shot(who, memberRow(card, memberMail), `L1-${name}-${locale}`);
      }
    }
  });

  test("L2 Beide Optionen sind vollständig lesbar (längster Name „Administrator“)", {
    tag: "@t41",
  }, async () => {
    for (const locale of ["en", "de"] as const) {
      const card = await open(owner, locale);
      const f = await fit(select(memberRow(card, memberMail)));
      expect(
        f.options.map((o) => o.text),
        `${locale}: Optionen`,
      ).toHaveLength(2);
      for (const o of f.options) {
        expect(
          o.width,
          `${locale}: „${o.text}“ ${o.width}px gegen Innenbreite ${f.inner}px`,
        ).toBeLessThanOrEqual(f.inner);
      }
      expect(
        f.options.map((o) => o.text),
        `${locale}`,
      ).toContain("Administrator");
    }
  });

  test("L3 „Speichern“ steht neben der Auswahl, nichts abgeschnitten oder überlagert", {
    tag: "@t41",
  }, async () => {
    for (const locale of ["en", "de"] as const) {
      const card = await open(owner, locale);
      for (const mail of [memberMail, adminMail]) {
        const row = memberRow(card, mail);
        const btn = saveButton(row);
        // elementFromPoint arbeitet mit Fensterkoordinaten: erst in den Sichtbereich holen, dann messen.
        await btn.scrollIntoViewIfNeeded();
        const sel = await box(select(row), "Auswahl");
        await expect(btn).toHaveText(locale === "de" ? "Speichern" : "Save");
        const save = await box(btn, "Speichern");
        const rowBox = await box(row, "Zeile");
        const tag = `${locale}/${mail}`;
        expect(save.x, `${tag}: Knopf rechts neben der Auswahl`).toBeGreaterThanOrEqual(right(sel));
        expect(right(save), `${tag}: Knopf innerhalb der Zeile`).toBeLessThanOrEqual(right(rowBox) + 1);
        // Gleiche Zeile: die Mittellinien liegen nah beieinander, der Knopf bricht nicht um.
        expect(
          Math.abs(sel.y + sel.height / 2 - (save.y + save.height / 2)),
          `${tag}: gleiche Höhe`,
        ).toBeLessThan(8);
        expect(save.height, `${tag}: Beschriftung einzeilig`).toBeLessThan(60);
        const clipped = await btn.evaluate((el) => el.scrollWidth > el.clientWidth);
        expect(clipped, `${tag}: Beschriftung abgeschnitten`).toBe(false);
        // Nichts liegt über dem Knopf: der Treffer in seiner Mitte ist der Knopf selbst.
        const onTop = await btn.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return hit === el || el.contains(hit);
        });
        expect(onTop, `${tag}: Knopf überlagert`).toBe(true);
      }
    }
  });

  test("L4 Die Spalten von Mitglieds- und Einladungszeilen fluchten (Rolle, Geräte, Aktion)", {
    tag: "@t41",
  }, async () => {
    for (const [name, who] of [
      ["Owner", owner],
      ["Admin", admin],
    ] as const) {
      const card = await open(who, "en");
      const rows = {
        owner: memberRow(card, ownerMail()),
        member: memberRow(card, memberMail),
        admin: memberRow(card, adminMail),
        invite: memberRow(card, pendingMail),
      };
      await expect(rows.invite, `${name}: offene Einladung`).toHaveCount(1);
      await expect(rows.invite).toContainText("Member");
      const all = await Promise.all(Object.entries(rows).map(async ([k, r]) => [k, await cells(r)] as const));
      const [, ref] = all[0] ?? [];
      for (const [kind, cols] of all) {
        expect(cols, `${name}/${kind}: vier Spalten`).toHaveLength(4);
        for (const [i, col] of cols.entries()) {
          expect(
            Math.abs(col.x - (ref?.[i]?.x ?? Number.NaN)),
            `${name}/${kind}: Spalte ${i + 1} Beginn`,
          ).toBeLessThan(1);
          expect(
            Math.abs(col.width - (ref?.[i]?.width ?? Number.NaN)),
            `${name}/${kind}: Spalte ${i + 1} Breite`,
          ).toBeLessThan(1);
        }
      }
      // Die Rolle-Spalte hält Platz für Auswahl und Knopf (≥ 17rem = 272 px).
      expect(ref?.[1]?.width ?? 0, `${name}: Rolle-Spalte`).toBeGreaterThanOrEqual(272 - 1);
      if (who === owner) await shot(who, rows.invite, "L4-Owner-en");
    }
  });

  test("L5 Schmale Ansicht (< md): Auswahl lesbar, Knopf daneben, nichts bricht aus der Zeile", {
    tag: "@t41",
  }, async () => {
    for (const width of [320, 375, 767]) {
      for (const [name, who] of [
        ["Owner", owner],
        ["Admin", admin],
      ] as const) {
        for (const locale of ["en", "de"] as const) {
          const card = await open(who, locale, width);
          const tag = `${name}/${locale}/${width}px`;
          const overflow = await who.page.evaluate(() => ({
            doc: document.documentElement.scrollWidth,
            view: window.innerWidth,
          }));
          expect(
            overflow.doc,
            `${tag}: Seite scrollt seitwärts (${overflow.doc} > ${overflow.view})`,
          ).toBeLessThanOrEqual(overflow.view);

          for (const mail of [memberMail, adminMail]) {
            const row = memberRow(card, mail);
            const rowBox = await box(row, "Zeile");
            const sel = await box(select(row), "Auswahl");
            const save = await box(saveButton(row), "Speichern");
            const f = await fit(select(row));
            const t = `${tag}/${mail}`;
            expect(sel.width, `${t}: Auswahl ≥ 10rem`).toBeGreaterThanOrEqual(160 - 0.5);
            for (const o of f.options) {
              expect(o.width, `${t}: „${o.text}“ ${o.width}px gegen ${f.inner}px`).toBeLessThanOrEqual(
                f.inner,
              );
            }
            expect(sel.x, `${t}: Auswahl links in der Zeile`).toBeGreaterThanOrEqual(rowBox.x - 0.5);
            expect(save.x, `${t}: Knopf neben der Auswahl`).toBeGreaterThanOrEqual(right(sel));
            expect(right(save), `${t}: Knopf in der Zeile`).toBeLessThanOrEqual(right(rowBox) + 1);
            expect(right(save), `${t}: Knopf im Bildschirm`).toBeLessThanOrEqual(width);
            expect(
              Math.abs(sel.y + sel.height / 2 - (save.y + save.height / 2)),
              `${t}: gleiche Höhe`,
            ).toBeLessThan(8);
            // Einspaltig: die Spalten stehen untereinander, nicht nebeneinander.
            const cols = await cells(row);
            expect(new Set(cols.map((c) => Math.round(c.x))).size, `${t}: einspaltig`).toBe(1);
          }
          // Auch die Zeilen ohne Auswahl und die Einladung bleiben im Bild.
          for (const mail of [ownerMail(), pendingMail]) {
            const row = memberRow(card, mail);
            const rowBox = await box(row, "Zeile");
            for (const [i, c] of (await cells(row)).entries()) {
              expect(c.x + c.width, `${tag}/${mail}: Spalte ${i + 1} im Bild`).toBeLessThanOrEqual(
                Math.min(right(rowBox), width) + 1,
              );
            }
            const buttons = row.getByRole("button");
            for (let i = 0; i < (await buttons.count()); i++) {
              expect(
                right(await box(buttons.nth(i), "Knopf")),
                `${tag}/${mail}: Knopf im Bild`,
              ).toBeLessThanOrEqual(width);
            }
          }
          if (name === "Owner" && locale === "en")
            await shot(who, memberRow(card, memberMail), `L5-${width}`);
          if (name === "Owner" && locale === "de" && width === 375)
            await shot(who, memberRow(card, memberMail), "L5-375-de");
        }
      }
    }
  });

  test("L6 Grenze md (768 px): vier Spalten, nichts überlagert, Seite scrollt nicht seitwärts", {
    tag: "@t41",
  }, async () => {
    for (const locale of ["en", "de"] as const) {
      const card = await open(owner, locale, 768);
      const overflow = await owner.page.evaluate(() => ({
        doc: document.documentElement.scrollWidth,
        view: window.innerWidth,
      }));
      expect(overflow.doc, `${locale}: Seite scrollt seitwärts`).toBeLessThanOrEqual(overflow.view);
      const row = memberRow(card, memberMail);
      const sel = await box(select(row), "Auswahl");
      const save = await box(saveButton(row), "Speichern");
      const rowBox = await box(row, "Zeile");
      expect(sel.width, `${locale}: Auswahl ≥ 10rem`).toBeGreaterThanOrEqual(159.5);
      expect(save.x, `${locale}: Knopf neben der Auswahl`).toBeGreaterThanOrEqual(right(sel));
      expect(right(save), `${locale}: Knopf in der Zeile`).toBeLessThanOrEqual(right(rowBox) + 1);
      const cols = await cells(row);
      expect(cols, `${locale}: vier Spalten`).toHaveLength(4);
      for (let i = 1; i < cols.length; i++) {
        const prev = cols[i - 1];
        const col = cols[i];
        if (prev && col)
          expect(col.x, `${locale}: Spalte ${i + 1} überlappt Spalte ${i}`).toBeGreaterThanOrEqual(
            prev.x + prev.width - 0.5,
          );
      }
      if (locale === "en") await shot(owner, row, "L6-768");
    }
  });
  test("L7 Rolle-Spalte: bearbeitbar sichtbar breiter als nur lesbar (Member-Sicht)", {
    tag: "@t41",
  }, async () => {
    const editable = await cells(memberRow(await open(owner, "en"), memberMail));
    const mCard = await open(member, "en");
    const readOnly = await cells(memberRow(mCard, adminMail));
    await expect(select(memberRow(mCard, adminMail)), "Member: keine Auswahl").toHaveCount(0);
    const e = editable[1]?.width ?? 0;
    const r = readOnly[1]?.width ?? 0;
    expect(e, `Rolle-Spalte bearbeitbar ${e}px gegen nur lesbar ${r}px`).toBeGreaterThanOrEqual(r + 20);
    await shot(member, memberRow(mCard, adminMail), "L7-member");
  });
});
