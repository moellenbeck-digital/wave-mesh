/**
 * Ticket #41: Auch Admins sollen die Rollen der User ändern können.
 *
 * Aufbau: Der Eigentümer (APP_USER) legt eine eigene Wave an und lädt zwei Admins (A1, A2) und ein
 * Mitglied (M) ein; die Zweitkonten nehmen per Einladung an. Die Fälle bauen aufeinander auf (`serial`):
 *   K1 A1 stuft A2 herab            → A1 Admin, A2 Member, M Member
 *   K2 A1 stuft M hoch              → A1 Admin, A2 Member, M Admin
 *   K3 Owner stuft M herab, A2 hoch → A1 Admin, A2 Admin, M Member
 *   K4–K6 ändern nichts an den Rollen (nur Leserechte, 403/400).
 * Am Ende entfernt der Eigentümer die Wave wieder; die Zweitkonten bleiben, weil die Oberfläche keine
 * Konten löscht (feste Adressen, siehe helpers.ts).
 *
 * Beschriftungen gelten für `en-US` (Config).
 *
 * Audit-Log (K7): die Weboberfläche zeigt unter `/waves/<id>/access` nur Aktion und Ziel, nicht `from`/`to`.
 * `from`/`to` stehen im JSON von `GET /api/waves/<id>/audit` (Sitzung des Eigentümers).
 *
 * Nicht prüfbar: dass die Änderung die `role:`-Regeln der ACL erreicht und die Geräte eine neue Netzkarte
 * bekommen — das braucht ein verbundenes Gerät und liegt außerhalb der Oberfläche (deckt `members.test.ts` ab).
 */
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
  saveRole,
  userIdOf,
  waveCard,
  waveId,
} from "./helpers.ts";

const run = Math.random().toString(36).slice(2, 8);
const waveName = `t41-${run}`;
const admin1Mail = "t41-admin1@example.test";
const admin2Mail = "t41-admin2@example.test";
const memberMail = "t41-member@example.test";

type Who = { ctx: BrowserContext; page: Page };
let owner: Who;
let a1: Who;
let a2: Who;
let m: Who;
let id: string;
let ownerId: string;
let a1Id: string;
let a2Id: string;
let mId: string;

const ownerMail = () => env("APP_USER");
const card = (who: Who): Locator => waveCard(who.page, waveName);
const select = (row: Locator) => row.locator('select[name="role"]');
const rolePath = (userId: string) => `/waves/${id}/members/${userId}/role`;

async function open(who: Who): Promise<Locator> {
  await who.page.goto("/");
  const c = card(who);
  await expect(c).toHaveCount(1);
  return c;
}

async function session(browser: Parameters<typeof newSession>[0]): Promise<Who> {
  const ctx = await newSession(browser);
  return { ctx, page: await ctx.newPage() };
}

function post(who: Who, userId: string, role: string) {
  return who.ctx.request.post(rolePath(userId), { form: { role }, maxRedirects: 0 });
}

/** Die Rolle einer Person aus Sicht des Eigentümers (Wert der Auswahl in ihrer Zeile). */
async function roleSeenByOwner(email: string): Promise<string> {
  const c = await open(owner);
  return select(memberRow(c, email)).inputValue();
}

test.describe("Admins ändern Rollen", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    owner = await session(browser);
    a1 = await session(browser);
    a2 = await session(browser);
    m = await session(browser);

    await login(owner.page, ownerMail(), env("APP_PASSWORD"));
    const c = await createWave(owner.page, waveName, `${waveName}.wave.internal`);
    id = await waveId(c);

    const l1 = await invite(owner.page, c, admin1Mail, "admin");
    const l2 = await invite(owner.page, c, admin2Mail, "admin");
    const lm = await invite(owner.page, c, memberMail, "member");
    await accept(a1.page, l1, admin1Mail);
    await accept(a2.page, l2, admin2Mail);
    await accept(m.page, lm, memberMail);

    await owner.page.goto("/");
    const oc = card(owner);
    a1Id = await userIdOf(memberRow(oc, admin1Mail));
    a2Id = await userIdOf(memberRow(oc, admin2Mail));
    mId = await userIdOf(memberRow(oc, memberMail));
    // Die Zeile des Eigentümers hat kein Formular; seine ID liefert die Mitgliederliste der API (`userId` des Aufrufers).
    ownerId = await ownerUserId();
  });

  test.afterAll(async () => {
    try {
      if (owner) await deleteWave(owner.page, waveName);
    } finally {
      await Promise.all([owner?.ctx.close(), a1?.ctx.close(), a2?.ctx.close(), m?.ctx.close()]);
    }
  });

  async function ownerUserId(): Promise<string> {
    const res = await owner.ctx.request.get(`/api/waves/${id}/members`);
    if (!res.ok()) throw new Error(`Mitgliederliste liefert ${res.status()}`);
    const { userId } = (await res.json()) as { userId?: string };
    if (!userId) throw new Error("Nutzer-ID des Eigentümers nicht zu ermitteln");
    return userId;
  }

  test("K1 Admin A1 stuft Admin A2 zum Mitglied herab", { tag: "@t41" }, async () => {
    const c = await open(a1);
    const row = memberRow(c, admin2Mail);
    await expect(select(row)).toHaveCount(1);
    await expect(select(row)).toHaveValue("admin");
    await expect(row.getByRole("button", { name: "Save" })).toBeVisible();
    await saveRole(a1.page, row, "member");

    await expect(select(memberRow(card(a1), admin2Mail))).toHaveValue("member");
    await a1.page.reload();
    await expect(select(memberRow(card(a1), admin2Mail))).toHaveValue("member");
    // Gegenprobe aus fremder Sicht: A2 selbst und das Mitglied sehen die Rolle Member.
    await expect(memberRow(await open(m), admin2Mail)).toContainText("Member");
    await expect(memberRow(await open(m), admin2Mail)).not.toContainText("Administrator");
    await expect(memberRow(await open(a2), admin2Mail)).not.toContainText("Administrator");
  });

  test("K2 Admin A1 macht das Mitglied M zum Admin", { tag: "@t41" }, async () => {
    const c = await open(a1);
    const row = memberRow(c, memberMail);
    await expect(select(row)).toHaveValue("member");
    await saveRole(a1.page, row, "admin");

    await expect(select(memberRow(card(a1), memberMail))).toHaveValue("admin");
    await a1.page.reload();
    await expect(select(memberRow(card(a1), memberMail))).toHaveValue("admin");
    // Aus Sicht von M selbst (eigene Zeile ohne Auswahl): Rolle Administrator.
    await expect(memberRow(await open(m), memberMail)).toContainText("Administrator");
  });

  test("K3 Owner kann weiterhin beides: Admin herabstufen, Mitglied hochstufen", {
    tag: "@t41",
  }, async () => {
    // M ist jetzt Admin → Owner stuft M herab.
    let c = await open(owner);
    await expect(select(memberRow(c, memberMail))).toHaveValue("admin");
    await saveRole(owner.page, memberRow(c, memberMail), "member");
    await expect(select(memberRow(card(owner), memberMail))).toHaveValue("member");
    // A2 ist jetzt Member → Owner stuft A2 hoch.
    c = card(owner);
    await expect(select(memberRow(c, admin2Mail))).toHaveValue("member");
    await saveRole(owner.page, memberRow(c, admin2Mail), "admin");
    await owner.page.reload();
    await expect(select(memberRow(card(owner), admin2Mail))).toHaveValue("admin");
    await expect(select(memberRow(card(owner), memberMail))).toHaveValue("member");
    await expect(select(memberRow(card(owner), admin1Mail))).toHaveValue("admin");
  });

  test("K4 Mitglied M sieht keine Rollenauswahl; direkter POST liefert 403, Rolle bleibt", {
    tag: "@t41",
  }, async () => {
    const c = await open(m);
    await expect(memberRow(c, admin2Mail)).toHaveCount(1);
    await expect(c.locator('form[action$="/role"]')).toHaveCount(0);
    await expect(c.locator('select[name="role"]')).toHaveCount(0);

    // Herabstufen eines Admins und Selbstbeförderung.
    expect((await post(m, a2Id, "member")).status()).toBe(403);
    expect((await post(m, mId, "admin")).status()).toBe(403);
    expect(await roleSeenByOwner(admin2Mail)).toBe("admin");
    expect(await roleSeenByOwner(memberMail)).toBe("member");
  });

  test("K5 Owner-Zeile und eigene Zeile von A1: keine Auswahl; direkter POST 403, role=owner 400", {
    tag: "@t41",
  }, async () => {
    const c = await open(a1);
    await expect(memberRow(c, ownerMail())).toContainText("Owner");
    await expect(select(memberRow(c, ownerMail()))).toHaveCount(0);
    await expect(memberRow(c, admin1Mail)).toContainText("Administrator");
    await expect(select(memberRow(c, admin1Mail))).toHaveCount(0);
    // Die Zeilen anderer Mitglieder behalten die Auswahl (Gegenprobe, dass die Seite gerendert ist).
    await expect(select(memberRow(c, admin2Mail))).toHaveCount(1);

    expect((await post(a1, ownerId, "member")).status(), "Owner-Zeile").toBe(403);
    expect((await post(a1, a1Id, "member")).status(), "eigene Zeile").toBe(403);
    expect((await post(a1, a2Id, "owner")).status(), "role=owner").toBe(400);
    expect((await post(a1, mId, "owner")).status(), "role=owner").toBe(400);
    expect((await post(owner, a2Id, "owner")).status(), "role=owner als Owner").toBe(400);

    expect(await roleSeenByOwner(admin1Mail)).toBe("admin");
    expect(await roleSeenByOwner(admin2Mail)).toBe("admin");
    expect(await roleSeenByOwner(memberMail)).toBe("member");
    await expect(memberRow(card(owner), ownerMail())).toContainText("Owner");
  });

  test("K6 Abgrenzung: A1 kann A2 nicht entfernen (kein Remove-Knopf, direkter POST liefert 403)", {
    tag: "@t41",
  }, async () => {
    const c = await open(a1);
    await expect(memberRow(c, admin2Mail).getByRole("button", { name: "Remove" })).toHaveCount(0);
    // Gegenprobe: Mitglieder darf A1 weiterhin entfernen → Knopf an der Zeile von M sichtbar.
    await expect(memberRow(c, memberMail).getByRole("button", { name: "Remove" })).toHaveCount(1);

    const res = await a1.ctx.request.post(`/waves/${id}/members/${a2Id}/remove`, { maxRedirects: 0 });
    expect(res.status()).toBe(403);
    expect(await roleSeenByOwner(admin2Mail)).toBe("admin");
  });

  test("K7 Audit-Log: Eintrag member.role mit from und to", { tag: "@t41" }, async () => {
    const res = await owner.ctx.request.get(`/api/waves/${id}/audit?limit=200`);
    expect(res.status()).toBe(200);
    const { entries } = (await res.json()) as {
      entries: {
        actor: string;
        action: string;
        target: string | null;
        detail: { from?: string; to?: string } | null;
      }[];
    };
    const roles = entries.filter((e) => e.action === "member.role");
    const find = (actor: string, target: string) =>
      roles.find((e) => e.actor === actor && e.target === target);

    // K1: A1 stuft A2 herab; K2: A1 stuft M hoch; K3: Owner stuft M herab und A2 hoch.
    expect(find(admin1Mail, a2Id)?.detail).toEqual({ from: "admin", to: "member" });
    expect(find(admin1Mail, mId)?.detail).toEqual({ from: "member", to: "admin" });
    expect(roles.filter((e) => e.actor === ownerMail() && e.target === mId)[0]?.detail).toEqual({
      from: "admin",
      to: "member",
    });
    expect(roles.filter((e) => e.actor === ownerMail() && e.target === a2Id)[0]?.detail).toEqual({
      from: "member",
      to: "admin",
    });
    // Abgelehnte Aufrufe (K4–K6) schreiben nichts: genau vier Rollenwechsel.
    expect(roles).toHaveLength(4);

    // Oberfläche: die Zugriffsseite nennt die Aktion; from/to zeigt sie nicht.
    await owner.page.goto(`/waves/${id}/access`);
    await expect(owner.page.getByText("member.role").first()).toBeVisible();
  });
});
