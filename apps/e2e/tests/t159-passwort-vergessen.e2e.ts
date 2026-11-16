/**
 * Ticket #159: „Passwort vergessen“ auf der Anmeldeseite (Mail mit einmaligem Link, neues Passwort).
 *
 * Voraussetzung für P3: `MAILPIT_URL` (HTTP-API von Mailpit, z. B. `http://localhost:8025`), an das der Server seine
 * Mail schickt (`WAVE_SMTP_URL=smtp://<mailpit>:1025`), und `passwordSignup` (ein Konto mit Passwort entsteht über die
 * Registrierung, wie in t150). Fehlt eines davon, überspringt P3 mit Grund. Fehlt `MAILPIT_URL`, entfällt außerdem
 * das Aufräumen von P2.
 *
 * Zustand: Wie in t147/t150 entscheidet das Testsystem, nicht dieser Test. Er liest ohne Anmeldung
 * `GET /api/auth/providers` (`passwordReset`: wahr, wenn `WAVE_SMTP_URL`/`WAVE_MAIL_FROM` gesetzt sind) und führt nur die
 * Fälle des vorgefundenen Zustands aus; die anderen überspringen mit Grund. Die Fälle gelten für beide Fassungen
 * (Frontend und schlichte Seiten von Control), Selektoren über `data-*`, `name` und `href`.
 *
 * - P1 „Link“ (Mail an): die Passwort-Anmeldung zeigt den Link „Passwort vergessen“ (`href="/password/forgot"`),
 *   er führt auf das Formular „E-Mail“ (`data-reset="request-form"`).
 * - P1b „Ohne Mailversand“ (Mail aus): kein Link auf der Anmeldung, `/password/forgot` und `/password/reset` liefern 404,
 *   `POST /auth/password/forgot` und `POST /auth/password/reset` ebenso, `passwordReset≠true` in `/api/auth/providers`.
 * - P2 „Neutrale Antwort“ (Mail an): eine Adresse mit Passwort-Konto (`APP_USER`) und eine unbekannte führen auf dieselbe
 *   Seite „Mail ist unterwegs“ (`data-reset="sent"`, Pfad `/password/forgot/sent`) mit identischem Text.
 * - P3 „Kernpfad“ (Mail an, Mailpit, Registrierung): Konto anlegen und anmelden (Sitzung A) → „Passwort vergessen“ in
 *   frischer Sitzung → Mail „Reset your wave-mesh password“ aus Mailpit (Gültigkeit „1 hour“) → Link: Formular
 *   „Neues Passwort“ (`data-reset="form"`) → zu kurzes Passwort wird abgelehnt (`data-error="password-too-short"`)
 *   → neues Passwort → Anmeldeseite mit Hinweis „Password changed“ (`data-login="notice"`), keine Sitzung
 *   (`/api/me` 401) → altes Passwort geht nicht, neues geht → Sitzung A ist beendet (`/api/me` 401) → derselbe Link
 *   zeigt „Link gilt nicht mehr“ (`data-reset="gone"`).
 * - P4 „Link ungültig“ (Mail an): `/password/reset?token=…` mit erfundenem Token zeigt „Link gilt nicht mehr“ mit Link
 *   zum neuen Anfordern (`data-reset="again"`); das Formular fehlt.
 *
 * - P5 „Referrer-Policy“ (Mail an): die Reset-Seite (`/password/reset?token=…`) gilt mit `same-origin` (Response-Header
 *   `Referrer-Policy`, im Frontend das Meta-Tag `referrer`), nie mit `no-referrer`: Chromium sendet bei diesem Wert beim
 *   Formular-POST `Origin: null`, und der Server lehnt das mit 403 ab (Fehler des Tickets, nur im echten Browser sichtbar).
 * - P6 „Kein Referer an Fremdseiten“ (Mail an): ein von der Reset-Seite aus angeklickter Link auf eine fremde Adresse sendet
 *   keinen `Referer` (Token bleibt geschützt). Die Seite hat keinen eigenen externen Link; der Test setzt einen ein und fängt
 *   die Anfrage im Browser ab, ins Netz geht nichts.
 * - P7 „Fremde Herkunft“ (Mail an): `POST /auth/password/reset` mit `Origin: null`, mit fremdem `Origin` und mit
 *   `Sec-Fetch-Site: cross-site` endet mit 403 (erfundener Token, es wird nichts verbraucht).
 * - Der Formular-POST in P3 wird als echte Browser-Anfrage beobachtet: Status nie 403.
 *
 * Aufräumen: Die Mails der Adressen löscht der Test in Mailpit; das Konto von P3 löscht er über `/account/delete` (#31).
 *
 * Nicht über die Oberfläche prüfbar, mit Grund (Beleg: `apps/control/test/password-reset.test.ts`):
 * - Ablauf nach einer Stunde, Widerruf älterer Links durch eine neue Anfrage, Drosselung (429), Zweitfaktor bleibt
 *   erhalten, gleiche Laufzeit: Jede Probe würde Mails an fremde Postfächer schicken, das geteilte System sperren
 *   oder eine Stunde warten.
 *
 * Beschriftungen gelten für `en-US` (Config).
 */
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { env, newSession } from "./helpers.ts";

interface Options {
  providers: string[];
  signup?: boolean;
  passwordSignup?: boolean;
  passwordReset?: boolean;
}

let ctx: BrowserContext;
let page: Page;
let options: Options;

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const UNKNOWN = `t159-unbekannt-${RUN}@example.test`;
const FLOW_ADDRESS = `t159-flow-${RUN}@example.test`;
const OLD_PASSWORD = `t159-${RUN}-altes-passwort`;
const NEW_PASSWORD = `t159-${RUN}-neues-passwort`;
const MAILPIT_URL = process.env.MAILPIT_URL?.replace(/\/+$/, "");
const NO_MAILPIT =
  "MAILPIT_URL ist nicht gesetzt: ohne das Postfach des Systems ist der Mailweg nicht prüfbar.";
const NO_RESET = "Das Testsystem bietet „Passwort vergessen“ nicht an (passwordReset≠true): Fall P1b gilt.";

interface MailpitMessage {
  ID: string;
  Subject: string;
}

async function mailsTo(p: Page, address: string): Promise<MailpitMessage[]> {
  const res = await p.request.get(`${MAILPIT_URL}/api/v1/search`, { params: { query: `to:"${address}"` } });
  expect(res.status(), "Mailpit /api/v1/search").toBe(200);
  return ((await res.json()) as { messages?: MailpitMessage[] }).messages ?? [];
}

/** Wartet auf die Mail mit diesem Betreff und liefert ihren Text. */
async function mailText(p: Page, address: string, subject: string): Promise<string> {
  let id = "";
  await expect
    .poll(
      async () => {
        id = (await mailsTo(p, address)).find((m) => m.Subject === subject)?.ID ?? "";
        return id;
      },
      {
        message: `Mail „${subject}“ an ${address} in Mailpit`,
        timeout: 30_000,
        intervals: [500, 1_000, 2_000],
      },
    )
    .not.toBe("");
  const res = await p.request.get(`${MAILPIT_URL}/api/v1/message/${id}`);
  expect(res.status(), "Mailpit /api/v1/message").toBe(200);
  return ((await res.json()) as { Text: string }).Text;
}

/** Löscht die Mails der Adressen wieder; Aufräumen scheitert nie den Fall. */
async function deleteMails(p: Page, addresses: string[]): Promise<void> {
  if (!MAILPIT_URL) return;
  try {
    const ids = (await Promise.all(addresses.map((a) => mailsTo(p, a)))).flat().map((m) => m.ID);
    if (ids.length > 0) await p.request.delete(`${MAILPIT_URL}/api/v1/messages`, { data: { IDs: ids } });
  } catch {
    // Mailpit weg oder anders konfiguriert: nichts aufzuräumen.
  }
}

/** Der Link aus dem Mailtext als Pfad mit Query: der Test öffnet ihn gegen `APP_URL`, nicht gegen `WAVE_BASE_URL`. */
function resetPath(text: string): string {
  const found = text.match(/https?:\/\/\S+\/password\/reset\?token=[\w%-]+/);
  expect(found, "Link zum Zurücksetzen im Mailtext").toBeTruthy();
  const url = new URL(found?.[0] ?? "");
  return `${url.pathname}${url.search}`;
}

/** Die Login-Seite: `/login` im Frontend, sonst die schlichte Seite von Control. */
async function openLogin(p: Page): Promise<void> {
  const res = await p.goto("/login");
  if (res?.status() === 404) await p.goto("/auth/password/login");
}

async function signIn(p: Page, email: string, password: string): Promise<void> {
  await openLogin(p);
  await p.locator("#email").fill(email);
  await p.locator("#password").fill(password);
  await p.locator('form[action="/auth/password/login"] button[type="submit"]').click();
}

/** Das Formular „Passwort vergessen“ ausfüllen und abschicken. */
async function requestReset(p: Page, email: string): Promise<void> {
  await p.goto("/password/forgot");
  await p.locator('[data-reset="request-form"] [data-field="email"]').fill(email);
  await p.locator('[data-action="reset-request"]').click();
}

test.describe("Passwort vergessen", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    ctx = await newSession(browser);
    page = await ctx.newPage();
    const res = await page.request.get("/api/auth/providers");
    expect(res.status()).toBe(200);
    options = (await res.json()) as Options;
  });

  test.afterAll(async () => {
    await deleteMails(page, [env("APP_USER"), UNKNOWN, FLOW_ADDRESS]);
    await ctx?.close();
  });

  test("P1 Link „Passwort vergessen“ auf der Anmeldung führt zum Formular", { tag: "@t159" }, async () => {
    test.skip(options.passwordReset !== true, NO_RESET);

    await openLogin(page);
    const link = page.locator('a[href="/password/forgot"]');
    await expect(link).toBeVisible();
    await link.click();
    await page.waitForURL((url) => url.pathname === "/password/forgot");
    await expect(page.locator('[data-reset="request-form"]')).toBeVisible();
    await expect(page.locator('[data-reset="request-form"] [data-field="email"]')).toHaveAttribute(
      "type",
      "email",
    );
  });

  test("P1b Ohne Mailversand: kein Link, Seiten und Endpunkte 404", { tag: "@t159" }, async () => {
    test.skip(
      options.passwordReset === true,
      "Das Testsystem hat Mailversand (passwordReset=true in /api/auth/providers): Fälle P1–P4 gelten.",
    );

    await openLogin(page);
    await expect(page.locator('a[href="/password/forgot"]')).toHaveCount(0);
    expect((await page.goto("/password/forgot"))?.status()).toBe(404);
    expect((await page.goto("/password/reset?token=x"))?.status()).toBe(404);
    for (const path of ["/auth/password/forgot", "/auth/password/reset"]) {
      const res = await page.request.post(path, {
        form: { email: UNKNOWN, token: "x", password: OLD_PASSWORD },
        maxRedirects: 0,
      });
      expect(res.status(), `POST ${path}`).toBe(404);
    }
  });

  test("P2 Bestehendes Konto und unbekannte Adresse: dieselbe Seite „Mail ist unterwegs“", {
    tag: "@t159",
  }, async () => {
    test.skip(options.passwordReset !== true, NO_RESET);

    const sentTextFor = async (address: string): Promise<string> => {
      await requestReset(page, address);
      await expect(page.locator('[data-reset="sent"]')).toBeVisible();
      expect(new URL(page.url()).pathname).toBe("/password/forgot/sent");
      return (await page.locator('[data-reset="sent"]').innerText()).trim();
    };

    const known = await sentTextFor(env("APP_USER"));
    const unknown = await sentTextFor(UNKNOWN);
    expect(known.length).toBeGreaterThan(0);
    expect(unknown).toBe(known);
  });

  test("P3 Kernpfad: Mail → Link → neues Passwort → Anmeldung; alte Sitzung beendet, Link verbraucht", {
    tag: "@t159",
  }, async ({ browser }) => {
    test.setTimeout(180_000);
    test.skip(options.passwordReset !== true, NO_RESET);
    test.skip(!MAILPIT_URL, NO_MAILPIT);
    test.skip(
      options.passwordSignup !== true,
      "passwordSignup≠true: kein Konto mit Passwort anlegbar (Registrierung).",
    );

    // Konto mit Passwort über die Registrierung (wie in t150).
    await page.goto("/signup");
    await page.locator('[data-field="email"]').fill(FLOW_ADDRESS);
    await page.locator('[data-field="password"]').fill(OLD_PASSWORD);
    await page.locator('[data-action="signup-submit"]').click();
    await expect(page.locator('[data-signup="sent"]')).toBeVisible();
    const confirm = await mailText(page, FLOW_ADDRESS, "Confirm your wave-mesh account");
    const confirmLink = confirm.match(/https?:\/\/\S+\/signup\/confirm\?token=[\w-]+/)?.[0] ?? "";
    expect(confirmLink, "Bestätigungslink im Mailtext").not.toBe("");
    const confirmUrl = new URL(confirmLink);
    await page.goto(`${confirmUrl.pathname}${confirmUrl.search}`);
    await page.locator('[data-action="signup-confirm"]').click();
    await expect(page.locator('a[data-signup="login"]')).toBeVisible();

    // Sitzung A: bleibt bis zum Zurücksetzen angemeldet.
    await signIn(page, FLOW_ADDRESS, OLD_PASSWORD);
    await page.waitForURL((url) => url.pathname !== "/login" && url.pathname !== "/auth/password/login");
    expect((await page.request.get("/api/me")).status()).toBe(200);

    // Frische Sitzung B fordert den Link an.
    const other = await newSession(browser);
    try {
      const b = await other.newPage();
      await requestReset(b, FLOW_ADDRESS);
      await expect(b.locator('[data-reset="sent"]')).toBeVisible();

      const text = await mailText(b, FLOW_ADDRESS, "Reset your wave-mesh password");
      expect(text).toContain("1 hour");
      const path = resetPath(text);

      // Öffnen verbraucht nichts: zweimal dasselbe Formular.
      for (let i = 0; i < 2; i++) {
        await b.goto(path);
        await expect(b.locator('[data-reset="form"]')).toBeVisible();
      }

      // Zu kurz: abgelehnt, der Link bleibt gut.
      const field = b.locator('[data-reset="form"] [data-field="password"]');
      await field.evaluate((el) => el.removeAttribute("minlength"));
      await field.fill("elf-zeichen");
      await b.locator('[data-action="reset-submit"]').click();
      await expect(b.locator('[data-reset="error"][data-error="password-too-short"]')).toBeVisible();

      await b.locator('[data-reset="form"] [data-field="password"]').fill(NEW_PASSWORD);
      // Echter Formular-POST des Browsers: kein 403 „Not from this page“ (Origin: null bei no-referrer).
      const [post] = await Promise.all([
        b.waitForResponse(
          (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/auth/password/reset",
        ),
        b.locator('[data-action="reset-submit"]').click(),
      ]);
      expect(post.status(), "POST /auth/password/reset aus dem Formular").not.toBe(403);
      expect(await post.request().headerValue("origin"), "Origin des Formular-POSTs").not.toBe("null");

      // Keine automatische Anmeldung: die Anmeldeseite mit Hinweis.
      await expect(b.locator('[data-login="notice"]')).toContainText("Password changed");
      expect((await b.request.get("/api/me")).status()).toBe(401);

      await signIn(b, FLOW_ADDRESS, OLD_PASSWORD);
      await expect(b.locator("#email")).toBeVisible();
      expect((await b.request.get("/api/me")).status()).toBe(401);
      await signIn(b, FLOW_ADDRESS, NEW_PASSWORD);
      await b.waitForURL((url) => url.pathname !== "/login" && url.pathname !== "/auth/password/login");
      expect((await b.request.get("/api/me")).status()).toBe(200);

      // Der Link ist verbraucht.
      await b.goto(path);
      await expect(b.locator('[data-reset="gone"]')).toBeVisible();
      await expect(b.locator('[data-reset="form"]')).toHaveCount(0);

      // Die Sitzung von vorher ist beendet.
      expect((await page.request.get("/api/me")).status()).toBe(401);

      // Aufräumen: das Konto löschen (#31).
      await b.goto("/account/delete");
      await b.locator("#delete-confirm").fill(FLOW_ADDRESS.toUpperCase());
      await b.locator('#delete-form button[type="submit"]').click();
      await expect(b.getByTestId("delete-done")).toBeVisible();
    } finally {
      await other.close();
    }
  });

  test("P4 Ungültiger Link endet auf „Link gilt nicht mehr“", { tag: "@t159" }, async () => {
    test.skip(options.passwordReset !== true, NO_RESET);

    await page.goto(`/password/reset?token=t159-${RUN}-erfunden`);
    await expect(page.locator('[data-reset="gone"]')).toBeVisible();
    await expect(page.locator('[data-reset="form"]')).toHaveCount(0);
    await expect(page.locator('a[data-reset="again"]')).toHaveAttribute("href", "/password/forgot");
  });

  test("P5 Reset-Seite gilt mit Referrer-Policy same-origin, nicht no-referrer", {
    tag: "@t159",
  }, async () => {
    test.skip(options.passwordReset !== true, NO_RESET);

    const res = await page.goto(`/password/reset?token=t159-${RUN}-policy`);
    expect(res?.status(), "Reset-Seite").toBeLessThan(500);
    // Control setzt den Header, das Frontend das Meta-Tag; wirksam ist, was der Browser sieht.
    const header = res?.headers()["referrer-policy"];
    const metaTag = page.locator('meta[name="referrer"]').first();
    const meta = (await metaTag.count()) > 0 ? await metaTag.getAttribute("content") : null;
    expect(header ?? meta, "wirksame Referrer-Policy (Header, sonst Meta-Tag)").toBe("same-origin");
    expect(header ?? "", "Header Referrer-Policy").not.toContain("no-referrer");
    expect(meta ?? "", "Meta-Tag referrer").not.toBe("no-referrer");
  });

  test("P6 Link zu einer Fremdseite sendet keinen Referer (Token bleibt geschützt)", {
    tag: "@t159",
  }, async ({ browser }) => {
    test.skip(options.passwordReset !== true, NO_RESET);

    const other = await newSession(browser);
    try {
      const p = await other.newPage();
      const seen: Array<string | null> = [];
      await p.route("https://fremdseite.example.test/**", async (route) => {
        seen.push(await route.request().headerValue("referer"));
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><title>fremd</title>",
        });
      });

      await p.goto(`/password/reset?token=t159-${RUN}-fremd`);
      // Die Seite hat keinen eigenen externen Link: einen setzen, wie ihn ein Mailclient oder eine Erweiterung einfügte.
      await p.locator("body").evaluate((body) => {
        const a = body.ownerDocument.createElement("a");
        a.href = "https://fremdseite.example.test/";
        a.id = "t159-extern";
        a.textContent = "extern";
        body.appendChild(a);
      });
      await p.locator("#t159-extern").click();
      await p.waitForURL("https://fremdseite.example.test/**");

      expect(seen.length, "Anfrage an die Fremdseite").toBe(1);
      expect(seen[0], "Referer an die Fremdseite").toBeNull();
    } finally {
      await other.close();
    }
  });

  test("P7 Fremde Herkunft und Origin: null werden mit 403 abgelehnt", { tag: "@t159" }, async () => {
    test.skip(options.passwordReset !== true, NO_RESET);

    const form = { token: `t159-${RUN}-erfunden`, password: NEW_PASSWORD };
    const variants: Array<[string, Record<string, string>]> = [
      ["Origin: null", { origin: "null" }],
      ["fremder Origin", { origin: "https://fremdseite.example.test" }],
      ["Sec-Fetch-Site: cross-site", { "sec-fetch-site": "cross-site" }],
    ];
    for (const [name, headers] of variants) {
      const res = await page.request.post("/auth/password/reset", { form, headers, maxRedirects: 0 });
      expect(res.status(), `POST /auth/password/reset mit ${name}`).toBe(403);
    }
  });
});
