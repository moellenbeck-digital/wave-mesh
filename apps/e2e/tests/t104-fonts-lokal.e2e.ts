/**
 * Ticket #104: Schriften von apps/web liegen im Repo und kommen über next/font/local, nicht von Google.
 *
 *   F1 In apps/web/src gibt es keinen Import aus next/font/google (Dateiprüfung).
 *   F2 Die Font-Dateien und beide OFL-Texte liegen in apps/web/src/fonts; layout.tsx lädt sie über next/font/local
 *      mit --font-space-grotesk und --font-inter (Dateiprüfung).
 *   F3 Die Login-Seite (ohne Anmeldung erreichbar) setzt die Überschrift in der Space-Grotesk-Familie und den
 *      Fließtext in der Inter-Familie; beide Familien sind als FontFace tatsächlich geladen.
 *   F4 Beim Laden dieser Seite geht kein Request an fonts.googleapis.com oder fonts.gstatic.com; die woff2 kommen von
 *      der Seite selbst unter /_next/static/media/.
 *
 * Nicht als Oberflächentest prüfbar: Kriterium 5 (Typecheck und Web-Tests in apps/web); das läuft als
 * `bun run typecheck` und `bun test test/link-notice.test.tsx` in apps/web. Ebenso "optisch wie vorher":
 * geprüft wird nur, dass die richtigen Familien aktiv und geladen sind, kein Pixelvergleich.
 *
 * Braucht kein Konto und legt keine Testdaten an.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const webSrc = resolve(here, "../../web/src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js|jsx|mjs|css)$/.test(name) ? [path] : [];
  });
}

test("F1 kein Import aus next/font/google in apps/web/src", { tag: "@t104" }, () => {
  const files = sourceFiles(webSrc);
  expect(files.length).toBeGreaterThan(10);
  const hits = files.filter((file) => readFileSync(file, "utf8").includes("next/font/google"));
  expect(hits).toEqual([]);
});

test("F2 Font-Dateien, OFL-Texte und next/font/local mit den Variablen", { tag: "@t104" }, () => {
  const fonts = join(webSrc, "fonts");
  for (const name of [
    "space-grotesk-latin-500-normal.woff2",
    "space-grotesk-latin-600-normal.woff2",
    "space-grotesk-latin-700-normal.woff2",
    "inter-latin-wght-normal.woff2",
    "OFL-SpaceGrotesk.txt",
    "OFL-Inter.txt",
  ]) {
    expect(existsSync(join(fonts, name)), name).toBe(true);
    expect(statSync(join(fonts, name)).size, name).toBeGreaterThan(1000);
  }
  const layout = readFileSync(join(webSrc, "app/layout.tsx"), "utf8");
  expect(layout).toContain('from "next/font/local"');
  expect(layout).toContain('"--font-space-grotesk"');
  expect(layout).toContain('"--font-inter"');
});

/** Erste Familie einer font-family-Liste, ohne Anführungszeichen. */
const firstFamily = (list: string): string => (list.split(",")[0] ?? "").trim().replace(/^["']|["']$/g, "");

test("F3 Überschrift in Space Grotesk, Fließtext in Inter, beide geladen", { tag: "@t104" }, async ({
  page,
}) => {
  await page.goto("/login");
  const heading = page.locator("h1").first();
  await expect(heading).toBeVisible();
  const body = page.locator("main p").first();
  await expect(body).toBeVisible();

  const used = await page.evaluate(`(() => {
    const h = document.querySelector("h1");
    const p = document.querySelector("main p");
    const root = getComputedStyle(document.documentElement);
    return {
      headingFamily: getComputedStyle(h).fontFamily,
      bodyFamily: getComputedStyle(p).fontFamily,
      displayVar: root.getPropertyValue("--font-space-grotesk"),
      interVar: root.getPropertyValue("--font-inter"),
    };
  })()`);
  const {
    headingFamily = "",
    bodyFamily = "",
    displayVar = "",
    interVar = "",
  } = used as Record<string, string>;
  const display = firstFamily(displayVar);
  const inter = firstFamily(interVar);
  // Die Variablen tragen den von next/font vergebenen Familiennamen; Überschrift und Text müssen ihn führen.
  expect(firstFamily(headingFamily)).toBe(display);
  expect(firstFamily(bodyFamily)).toBe(inter);
  expect(firstFamily(headingFamily)).not.toBe(firstFamily(bodyFamily));

  // Beide Familien sind als FontFace wirklich geladen (nicht nur deklariert, nicht auf Fallback).
  await expect
    .poll(
      async () =>
        page.evaluate(
          `(async () => {
            await document.fonts.ready;
            const loaded = [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/^["']|["']$/g, ""));
            return loaded;
          })()`,
        ),
      { timeout: 15_000 },
    )
    .toEqual(expect.arrayContaining([display, inter]));
});

test("F4 kein Request an Google-Fonts, woff2 unter /_next/static/media/", { tag: "@t104" }, async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL ?? "http://localhost").origin;
  const urls: string[] = [];
  page.on("request", (request) => urls.push(request.url()));
  await page.goto("/login", { waitUntil: "networkidle" });
  await page.evaluate("document.fonts.ready.then(() => true)");

  const google = urls.filter((url) => /fonts\.(googleapis|gstatic)\.com/.test(url));
  expect(google).toEqual([]);

  const woff2 = urls.filter((url) => new URL(url).pathname.endsWith(".woff2"));
  expect(woff2.length).toBeGreaterThan(0);
  for (const url of woff2) {
    expect(new URL(url).origin).toBe(origin);
    expect(new URL(url).pathname.startsWith("/_next/static/media/")).toBe(true);
  }
});
