import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpdateStatus } from "@wave/ipc";
import {
  macosDialog,
  NotificationPrompt,
  type Notifications,
  parseMacosAnswer,
  parseWindowsAnswer,
  promptEnv,
  promptText,
  windowsDialog,
  writePromptIcon,
} from "../src/prompt.ts";

const update = (overrides: Partial<UpdateStatus> = {}): UpdateStatus => ({
  autoUpdate: true,
  wish: null,
  channels: [],
  available: "0.2.0",
  state: "idle",
  message: null,
  notice: null,
  scheduledAt: null,
  ...overrides,
});

describe("what the popup says", () => {
  test("names both versions and asks", () => {
    const text = promptText(update(), "0.1.0");
    expect(text?.title).toBe("wave update");
    expect(text?.body).toContain("wave 0.2.0 is available (this device runs 0.1.0)");
    expect(text?.body).toContain("Install it now?");
  });

  test("says when it would install by itself", () => {
    const now = new Date("2026-10-01T10:00:00");
    const text = promptText(update({ state: "scheduled", scheduledAt: "2026-10-01T15:42:00" }), "0.1.0", now);
    // The format follows the locale (15:42, 03:42 PM); the minute is in every one.
    expect(text?.body).toMatch(/installs by itself at [^.]*42/);
  });

  test("says nothing where there is nothing to install, or nothing this copy can install", () => {
    expect(promptText(update({ available: null }), "0.1.0")).toBeNull();
    expect(promptText(update({ state: "installing" }), "0.1.0")).toBeNull();
    // A development build or a package-managed one: a button would only fail.
    expect(promptText(update({ state: "unavailable" }), "0.1.0")).toBeNull();
  });
});

const icon = writePromptIcon(mkdtempSync(join(tmpdir(), "wave-prompt-test-")));

describe("the icon", () => {
  test("is the wave mark as a PNG and as an .ico", () => {
    const png = readFileSync(icon.png);
    expect(Array.from(png.subarray(1, 4))).toEqual([0x50, 0x4e, 0x47]);
    expect(png.readUInt32BE(16)).toBe(128);
    const ico = readFileSync(icon.ico);
    expect([ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([1, 4]);
    // The last entry is 256 px, which the format writes as 0.
    expect(ico[6 + 16 * 3]).toBe(0);
  });

  test("reaches the dialogs through the environment, and only when there is one", () => {
    const text = { title: "t", body: "b" };
    expect(promptEnv(text, icon)).toMatchObject({ WAVE_PROMPT_ICON: icon.png, WAVE_PROMPT_ICO: icon.ico });
    expect(promptEnv(text, null)).not.toHaveProperty("WAVE_PROMPT_ICON");
  });

  test("replaces the stock symbol on macOS, which stays the fallback", () => {
    // osascript shows no dialog at all when the icon file is missing.
    expect(macosDialog(icon).at(-1)).toContain(
      'with icon (POSIX file (system attribute "WAVE_PROMPT_ICON"))',
    );
    expect(macosDialog(null).at(-1)).toContain("with icon note");
  });

  test("is the image and the title bar icon of the Windows dialog", () => {
    const script = windowsDialog().at(-1) ?? "";
    expect(script).toContain("Image]::FromFile($env:WAVE_PROMPT_ICON)");
    expect(script).toContain("Icon($env:WAVE_PROMPT_ICO)");
    // Without an icon, or should the form fail, the MessageBox still asks.
    expect(script).toContain("MessageBox]::Show(");
  });
});

describe("the dialogs on macOS and Windows", () => {
  test("take their text from the environment, never from the script", () => {
    // The version comes from a server; it must not be able to become code.
    for (const argv of [macosDialog(icon), windowsDialog()]) {
      const script = argv.at(-1) ?? "";
      expect(script).toContain("WAVE_PROMPT_BODY");
      expect(script).toContain("WAVE_PROMPT_TITLE");
      expect(script).not.toContain("0.2.0");
    }
  });

  test("read the answer the way each one gives it", () => {
    expect(parseMacosAnswer("button returned:Install now, gave up:false\n")).toBe(true);
    expect(parseMacosAnswer("button returned:Install now, gave up:true\n")).toBe(false);
    // "Later" is the cancel button: osascript prints nothing and fails.
    expect(parseMacosAnswer("")).toBe(false);
    expect(parseWindowsAnswer("Yes\r\n")).toBe(true);
    expect(parseWindowsAnswer("No\r\n")).toBe(false);
  });
});

describe("the notification on Linux", () => {
  /** A notification server that remembers what it was asked and answers on cue. */
  function fakeServer() {
    const listeners: Record<string, (id: number, value: never) => void> = {};
    const shown: Array<{ appIcon: string; actions: string[]; expireTimeout: number }> = [];
    const notifications: Notifications = {
      Notify: async (_app, _replaces, appIcon, _summary, _body, actions, _hints, expireTimeout) => {
        shown.push({ appIcon, actions, expireTimeout });
        return shown.length;
      },
      on: (event: string, listener: (id: number, value: never) => void) => {
        listeners[event] = listener;
      },
    };
    const emit = (event: string, id: number, value: unknown) => listeners[event]?.(id, value as never);
    return { notifications, shown, emit };
  }

  const text = { title: "wave update", body: "…" };

  test("installs on the button and on a click on the notification itself", async () => {
    const server = fakeServer();
    const prompt = new NotificationPrompt(server.notifications, () => icon);

    const byButton = prompt.ask(text);
    await Bun.sleep(0);
    server.emit("ActionInvoked", 1, "install");
    expect(await byButton).toBe(true);

    // A daemon without buttons (mako) runs the default action on a click.
    const byClick = prompt.ask(text);
    await Bun.sleep(0);
    server.emit("ActionInvoked", 2, "default");
    expect(await byClick).toBe(true);
  });

  test("does not install when it is closed, and never expires on its own", async () => {
    const server = fakeServer();
    const prompt = new NotificationPrompt(server.notifications, () => icon);
    const answer = prompt.ask(text);
    await Bun.sleep(0);
    expect(server.shown[0]?.expireTimeout).toBe(0);
    expect(server.shown[0]?.actions).toEqual(["default", "Install now", "install", "Install now"]);
    server.emit("NotificationClosed", 1, 2);
    expect(await answer).toBe(false);
  });

  test("shows the wave mark, and a theme icon only when there is none", async () => {
    const server = fakeServer();
    void new NotificationPrompt(server.notifications, () => icon).ask(text);
    void new NotificationPrompt(server.notifications, () => null).ask(text);
    await Bun.sleep(0);
    expect(server.shown[0]?.appIcon).toBe(`file://${icon.png}`);
    expect(server.shown[1]?.appIcon).toBe("system-software-update");
  });

  test("ignores the answers to other notifications", async () => {
    const server = fakeServer();
    const prompt = new NotificationPrompt(server.notifications, () => icon);
    const answer = prompt.ask(text);
    await Bun.sleep(0);
    server.emit("ActionInvoked", 99, "install");
    server.emit("NotificationClosed", 1, 2);
    expect(await answer).toBe(false);
  });
});
