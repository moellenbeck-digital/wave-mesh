import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { profileStatusFromSnapshot, type Status, type UpdateStatus } from "@wave/ipc";
import { setLocale } from "../src/messages.ts";
import { macosDialog, NotificationPrompt, parseMacosAnswer, promptEnv, promptText } from "../src/prompt.ts";
import { menuFor, tooltipFor } from "../src/view.ts";
import { windowView } from "../src/window-view.ts";
import { type Paint, windowLayout } from "../src/window-win32-layout.ts";

/**
 * The tray in German. Every other test reads English because none of them
 * sets a locale; this file sets one for each test and puts it back after, so
 * the order the files run in cannot leak German into them.
 */
beforeEach(() => setLocale("de"));
afterEach(() => setLocale("en"));

const controlUrl = "http://control.example";

const status = (update?: Partial<UpdateStatus>): Status => ({
  profiles: [
    profileStatusFromSnapshot(
      {
        controlUrl,
        interfaceName: "wave0",
        addresses: ["10.77.0.1/32"],
        self: { hostname: "laptop", dnsName: "laptop.rl.example.com", ipv4: "10.77.0.1" },
        peers: [
          {
            hostname: "nas",
            dnsName: "nas.rl.example.com",
            ipv4: "10.77.0.2",
            ipv6: "fd7a::2",
            services: [
              {
                name: "grafana",
                dnsName: "grafana.rl.example.com",
                ipv4: "10.77.0.9",
                url: "https://grafana.rl.example.com",
              },
              {
                name: "loki",
                dnsName: "loki.rl.example.com",
                ipv4: "10.77.0.10",
                url: "https://loki.rl.example.com",
              },
            ],
          },
        ],
      },
      { controlUrl, state: "up" },
    ),
  ],
  events: [],
  ...(update
    ? {
        daemon: {
          version: "0.1.0",
          platform: "linux-amd64",
          update: {
            autoUpdate: true,
            wish: null,
            channels: [],
            available: "0.2.0",
            state: "idle",
            message: null,
            notice: null,
            scheduledAt: null,
            ...update,
          },
        },
      }
    : {}),
});

const labels = (entries: ReturnType<typeof menuFor>) =>
  entries.filter((entry) => !entry.separator).map((entry) => entry.label);

describe("the menu and the tooltip", () => {
  test("speak German", () => {
    expect(tooltipFor(status())).toBe("10.77.0.1 — 0/1 Geräte erreichbar");
    expect(tooltipFor(null, "no-daemon")).toBe("der wave-Dienst läuft nicht");
    const menu = labels(menuFor(status()));
    expect(menu).toContain("Trennen");
    expect(menu).toContain("control.example öffnen");
    expect(menu).toContain("Tray-Symbol beenden");
    expect(menu.some((label) => label?.includes("verbinde…"))).toBe(true);
  });

  test("offer an update in German, and say in German why there is no button", () => {
    expect(labels(menuFor(status({})))).toContain("Update jetzt installieren");
    const unavailable = status({
      state: "unavailable",
      message: "this is a development build, not a release",
      notice: { code: "update-dev-build", params: {} },
    });
    const menu = labels(menuFor(unavailable));
    expect(menu).toContain("wave 0.2.0 ist verfügbar");
    expect(menu).toContain("das ist ein Entwicklungsbuild, kein Release");
    expect(menu).not.toContain("Update jetzt installieren");
  });
});

describe("the window", () => {
  test("carries its German headings and plural in the view", () => {
    const view = windowView(status(), "laptop");
    expect(view.labels?.connections).toBe("VERBINDUNGEN");
    expect(view.labels?.machines).toBe("MASCHINEN");
    expect(view.labels?.services(1)).toBe("1 Dienst");
    expect(view.labels?.services(2)).toBe("2 Dienste");
    expect(view.machines[0]?.path).toBe("verbinde…");
  });

  test("is drawn in German on Windows, from the view and nothing else", () => {
    const layout = windowLayout(windowView(status(), "laptop"), { scale: 1, scroll: 0 });
    const texts = [...layout.chrome, ...layout.list].flatMap((paint: Paint) =>
      paint.kind === "text" ? [paint.text] : [],
    );
    expect(texts).toContain("VERBINDUNGEN");
    expect(texts).toContain("MASCHINEN");
    expect(texts).toContain("10.77.0.2 · 2 Dienste");
    expect(texts).not.toContain("CONNECTIONS");
  });

  test.each(["window-gtk.ts", "window-macos.ts", "window-win32-layout.ts"])(
    "%s keeps no English copy of its own",
    (file) => {
      // GTK and Cocoa cannot be opened here, so the guard is on their source:
      // a heading or tooltip written into a backend would be English in
      // every language again.
      const source = readFileSync(join(import.meta.dir, "..", "src", file), "utf8");
      for (const english of [
        '"CONNECTIONS"',
        '"MACHINES"',
        '? "service" : "services"',
        "Show services",
        "`Copy ",
        "`Open ",
      ]) {
        expect(source).not.toContain(english);
      }
    },
  );
});

describe("the update dialog", () => {
  test("asks in German, with German buttons", () => {
    const text = promptText(status({}).daemon?.update as UpdateStatus, "0.1.0");
    expect(text?.title).toBe("wave-Update");
    expect(text?.body).toContain("wave 0.2.0 ist verfügbar (dieses Gerät hat 0.1.0)");
    expect(text?.install).toBe("Jetzt installieren");
    expect(text?.later).toBe("Später");
  });

  test("reads the German button back on macOS", () => {
    const text = promptText(status({}).daemon?.update as UpdateStatus, "0.1.0");
    if (!text) throw new Error("no prompt");
    // osascript answers with the name of the button: the one it was shown.
    expect(parseMacosAnswer("button returned:Jetzt installieren, gave up:false\n", text)).toBe(true);
    expect(parseMacosAnswer("button returned:Install now, gave up:false\n", text)).toBe(false);
    // The labels reach the script through the environment, like the text.
    expect(promptEnv(text, null)).toMatchObject({
      WAVE_PROMPT_INSTALL: "Jetzt installieren",
      WAVE_PROMPT_LATER: "Später",
    });
    expect(macosDialog(null).at(-1)).not.toContain("Jetzt installieren");
  });

  test("keeps the notification's action keys, and only translates their labels", async () => {
    const shown: string[][] = [];
    const prompt = new NotificationPrompt(
      {
        Notify: async (_a, _r, _i, _s, _b, actions) => shown.push(actions),
        on: () => {},
      },
      () => null,
    );
    const text = promptText(status({}).daemon?.update as UpdateStatus, "0.1.0");
    if (!text) throw new Error("no prompt");
    void prompt.ask(text);
    await Bun.sleep(0);
    expect(shown[0]).toEqual(["default", "Jetzt installieren", "install", "Jetzt installieren"]);
  });
});
