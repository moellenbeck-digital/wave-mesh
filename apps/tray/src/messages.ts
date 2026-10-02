import type { Locale } from "@wave/i18n";

/**
 * What the tray says to the person at this machine, in their language: the
 * menu, the tooltip, the card behind the icon and the update dialog.
 *
 * Log lines stay English, as in the CLI -- they end up in the journal, which
 * is searched and pasted into issues. How a peer is reached comes from
 * `pathWords()` in @wave/ipc instead, because the CLI says the same words.
 *
 * The labels a window backend draws on its own -- section headings, the count
 * of services, tooltips -- are under `window` and travel inside the
 * `WindowView`, so GTK, Cocoa and the Windows card render what they are given
 * rather than each keeping an English copy.
 */

export interface WindowLabels {
  connections: string;
  machines: string;
  /** "2 services", on the row of a machine that has some. */
  services: (count: number) => string;
  showServices: string;
  hideServices: string;
  open: (url: string) => string;
  copy: (text: string) => string;
  /**
   * The copy button's title where there is no symbol to draw -- macOS before
   * 11, which Bun does not run on, so in practice never; the button is 38
   * points wide and a longer word would be clipped.
   */
  copyButton: string;
}

const enWindow: WindowLabels = {
  connections: "CONNECTIONS",
  machines: "MACHINES",
  services: (count: number) => `${count} ${count === 1 ? "service" : "services"}`,
  showServices: "Show services",
  hideServices: "Hide services",
  open: (url: string) => `Open ${url}`,
  copy: (text: string) => `Copy ${text}`,
  copyButton: "Copy",
};

const en = {
  // ---- view.ts ----
  connected: "connected",
  peersReachable: (reachable: number, total: number) => `${reachable}/${total} peer(s) reachable`,
  wavesConnected: (up: number, total: number) => `${up}/${total} waves connected`,
  denied: "not allowed to use the daemon — log out and back in",
  noDaemon: "the wave service is not running",
  unreachable: "the wave service is not answering",
  waitingForDaemon: "waiting for the daemon",
  noWaveYet: "no wave yet — run `wave login`",
  deniedGroup: "Your account is in the 'wave' group,",
  deniedSession: "but this session started before that.",
  quit: "Quit the tray icon",
  connect: "Connect",
  disconnect: "Disconnect",
  connectWave: (wave: string) => `Connect ${wave}`,
  disconnectWave: (wave: string) => `Disconnect ${wave}`,
  openWave: (wave: string) => `Open ${wave}`,
  notInAnyWave: "Not in any wave yet",
  joinWith: "Join one with: wave login <control-server-url>",
  installing: (version: string) => `Installing wave ${version}…`,
  available: (version: string) => `wave ${version} is available`,
  updateAt: (version: string, at: string) => `Update to ${version} at ${at}`,
  updateAvailable: (version: string) => `Update to ${version} available`,
  installNow: "Install update now",

  // ---- window-view.ts ----
  failed: "failed",
  notConnected: "not connected",
  emptyNoWave: "Join a wave to see its machines.",
  emptyOffline: "Connect to see the machines in this wave.",
  emptyAlone: "No other machines in this wave yet.",
  window: enWindow,

  // ---- prompt.ts ----
  promptTitle: "wave update",
  promptBody: (available: string, current: string, when: string | null) =>
    `wave ${available} is available (this device runs ${current}).` +
    (when ? ` It installs by itself at ${when}.` : "") +
    "\n\nInstall it now? The tunnels drop for a few seconds while the service restarts.",
  promptInstall: "Install now",
  promptLater: "Later",

  // ---- backend.ts, window.ts, index.ts ----
  noTrayBackend: (platform: string) =>
    `wave has no tray backend for ${platform} yet. ` +
    "The tunnel itself is unaffected: use `wave status` or `wave up`.",
  noWindowBackend: (platform: string) =>
    `wave has no tray window for ${platform} yet. ` +
    "The icon and its menu still work, and so does `wave status`.",
  menuStillThere: "Everything is still in the icon's menu: open it with the right button.",
};

// Short on purpose: a tray menu is narrow, and the web pages already address
// the reader with "du" and say "der Wave".
const de: typeof en = {
  connected: "verbunden",
  peersReachable: (reachable, total) => `${reachable}/${total} Geräte erreichbar`,
  wavesConnected: (up, total) => `${up}/${total} Waves verbunden`,
  denied: "kein Zugriff auf den Dienst — einmal ab- und wieder anmelden",
  noDaemon: "der wave-Dienst läuft nicht",
  unreachable: "der wave-Dienst antwortet nicht",
  waitingForDaemon: "warte auf den Dienst",
  noWaveYet: "noch kein Wave — `wave login` ausführen",
  deniedGroup: "Dein Konto ist in der Gruppe 'wave',",
  deniedSession: "aber diese Sitzung ist älter.",
  quit: "Tray-Symbol beenden",
  connect: "Verbinden",
  disconnect: "Trennen",
  connectWave: (wave) => `${wave} verbinden`,
  disconnectWave: (wave) => `${wave} trennen`,
  openWave: (wave) => `${wave} öffnen`,
  notInAnyWave: "Noch in keinem Wave",
  joinWith: "Beitreten mit: wave login <control-server-url>",
  installing: (version) => `Installiere wave ${version}…`,
  available: (version) => `wave ${version} ist verfügbar`,
  updateAt: (version, at) => `Update auf ${version} um ${at}`,
  updateAvailable: (version) => `Update auf ${version} verfügbar`,
  installNow: "Update jetzt installieren",

  failed: "fehlgeschlagen",
  notConnected: "nicht verbunden",
  // About as long as the English: the Windows card draws this on one line of
  // a fixed width and ellipsises the rest.
  emptyNoWave: "Tritt einem Wave bei, um Maschinen zu sehen.",
  emptyOffline: "Verbinde dich, um seine Maschinen zu sehen.",
  emptyAlone: "Noch keine anderen Maschinen in diesem Wave.",
  window: {
    connections: "VERBINDUNGEN",
    machines: "MASCHINEN",
    services: (count) => `${count} ${count === 1 ? "Dienst" : "Dienste"}`,
    showServices: "Dienste zeigen",
    hideServices: "Dienste ausblenden",
    open: (url) => `${url} öffnen`,
    copy: (text) => `${text} kopieren`,
    copyButton: "Kopieren",
  },

  promptTitle: "wave-Update",
  promptBody: (available, current, when) =>
    `wave ${available} ist verfügbar (dieses Gerät hat ${current}).` +
    (when ? ` Es installiert sich um ${when} von selbst.` : "") +
    "\n\nJetzt installieren? Die Tunnel sind für ein paar Sekunden weg, während der Dienst neu startet.",
  promptInstall: "Jetzt installieren",
  promptLater: "Später",

  noTrayBackend: (platform) =>
    `wave hat für ${platform} noch kein Tray-Symbol. ` +
    "Der Tunnel selbst ist davon unberührt: `wave status` oder `wave up` gehen weiter.",
  noWindowBackend: (platform) =>
    `wave hat für ${platform} noch kein Tray-Fenster. ` +
    "Das Symbol und sein Menü funktionieren weiter, `wave status` auch.",
  menuStillThere: "Alles steht weiter im Menü des Symbols: mit der rechten Maustaste öffnen.",
};

let current: Locale = "en";

/**
 * Set once, by the tray at start, from the session's language. Everything else
 * reads it through {@link t}; tests never set it and so read English, which is
 * what they assert.
 */
export function setLocale(locale: Locale): void {
  current = locale;
}

export const locale = (): Locale => current;

// Not `satisfies Messages`: the window labels are an object, which the generic
// shape has no room for. `typeof en` on the German catalog keeps the two in step.
const catalogs: Record<Locale, typeof en> = { en, de };

export const t = (): typeof en => catalogs[current];
