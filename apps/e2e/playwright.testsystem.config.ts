import { defineConfig } from "@playwright/test";

/**
 * Oberflächentests gegen das Dev-System. Aufgerufen wird sie vom Werkzeug
 * `e2e-test ausfuehren <nr>`, das die Umgebung setzt:
 * APP_URL (Adresse), APP_USER/APP_PASSWORD (Konto des Eigentümers), APP_TICKET (Ticketnummer).
 * Jeder Fall trägt die Marke als Tag `@t<nr>`; ohne `--grep` filtert APP_TICKET.
 */
const ticket = process.env.APP_TICKET;

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.e2e.ts",
  // Das Dev-System ist geteilt und die Fälle eines Tickets bauen aufeinander auf.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  grep: ticket ? new RegExp(`@t${ticket}(?!\\d)`) : undefined,
  outputDir: `./testsystem-artefakte/t${ticket ?? "alle"}`,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: `./testsystem-bericht/t${ticket ?? "alle"}` }],
  ],
  use: {
    baseURL: process.env.APP_URL,
    // Die Fälle prüfen Beschriftungen, deshalb eine feste Sprache.
    locale: "en-US",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
