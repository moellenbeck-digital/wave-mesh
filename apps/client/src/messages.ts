import type { Locale } from "@wave/i18n";

/**
 * What `wave` says to the person at the terminal, in their language.
 *
 * Only what a person reads: usage, answers, the status view, the install.
 * Log lines stay English wherever they are written -- the journal is searched,
 * pasted into issues and grepped by the end-to-end tests, and a line that
 * changes with the language of whoever started the daemon is useless for all
 * three. The daemon itself never picks a language (see @wave/ipc notice.ts).
 */

const en = {
  // ---- cli.ts ----
  usage: (statePath: string, socketPath: string, mtu: number) => `wave — mesh VPN client

  wave install    set everything up: service, tray, autostart  (needs root)
  wave uninstall  remove the service again                     (needs root)

  wave login <url>   join the wave run by that control server
                     (--auth-key <key> for a machine with no browser,
                      --new-wave for a further wave at a server already joined)
  wave profiles      list the waves this device belongs to
  wave up    [wave]  connect and show the tunnels (all of them by default)
  wave down  [wave]  tear them down (keeps the enrolment)
  wave status        watch the tunnels and their peers until Ctrl-C
  wave logout <wave> leave one wave and forget its keys

  A wave is named by its server, or -- with several at one server -- by its
  name in "wave profiles" (its DNS domain).

  wave cert  [name…] get a TLS certificate for this device and keep it renewed
  wave certs         list the certificates this device holds

  wave version    which build this is, and the service's update state
  wave update     install the newest release on offer now, instead of later
                  (--channel <name|server>, --auto-update on|off change settings)

  wave daemon     run the privileged part in the foreground
  wave tray       run the tray icon in the foreground

"wave install" sets up the machine and knows no server; joining one is always
"wave login <url>", and a device may join as many as it likes -- several at one
server too, with --new-wave. A wave is named by its control server, or by its
own name when one server runs several; a command without one means every wave
at once. After the install the everyday
commands need no privileges. Without the service they do the work themselves
and have to run as root.

Options:
  --control <url>   the server for "wave login", if not given as an argument
  --state <path>    state file (default: ${statePath})
  --daemon <path>   daemon control socket (default: ${socketPath})
  --no-daemon       do the work here even if a daemon is running
  --once            print one status instead of watching (implied off a tty)
  --socket <path>   WireGuard UAPI socket
  --interface <n>   tunnel interface name (default: wave0)
  --port <n>        WireGuard listen port (default: 41641)
  --mtu <bytes>     tunnel MTU (default: ${mtu})
  --stun <list>     comma-separated STUN servers, e.g. relay.example:3478
  --no-dns          do not serve the wave's names or touch resolver settings
  --group <name>    group allowed to use the control socket (install)
  --auth-key <key>  enrol without a browser, e.g. in a cluster (WAVE_AUTH_KEY)
  --hook <cmd>      run this after every renewal, e.g. 'systemctl reload caddy'
  --wildcard        ask for *.<wave domain> (an operator has to allow it first)
  --control <url>   also picks the wave for "wave cert" on a multi-wave device
  --channel <name>  update channel to ask for: stable, insiders, develop, or
                    "server" to take each server's default (update, install)
  --auto-update on|off  whether the service installs updates by itself

The language follows the system (LANG, LC_ALL, …); WAVE_LANG=en|de overrides it.
`,
  channelFlag: (channels: string) => `--channel takes ${channels} or server`,
  autoUpdateFlag: "--auto-update takes on or off",
  autoUpdateLine: (on: boolean, channel: string | null) =>
    `auto-update ${on ? "on" : "off"}, channel ${channel ?? "as the servers say"}`,
  channelOffers: (label: string, channel: string, offered: string) =>
    `  ${label}: ${channel} (offers ${offered})`,
  installingAt: (at: string) => `, installing at ${at}`,
  installingNow: ", installing now",
  updateInstallsNow: "; `wave update` installs it now",
  updateAvailable: (version: string, when: string) => `update to ${version} available${when}`,
  upToDate: "up to date with what the servers offer",
  watchHint: "Ctrl-C to stop watching; the tunnels keep running.",
  detachedUp: "Detached. The tunnels keep running; use `wave down` to stop them.",
  detachedNothing: "Detached. Nothing is up; the service keeps trying.",
  notEnrolled: "not in any wave yet — `wave login <control-server-url>` joins one",
  noSuchWave: (name: string) => `not in a wave at ${name}; \`wave profiles\` lists the ones there are`,
  severalWaves: (count: number, labels: string) =>
    `this device is in ${count} waves (${labels}); name one by its control server, or use the daemon, which handles them together`,
  socketDenied: (socket: string, command: string) =>
    `The wave service is running, but this account may not use its control socket (${socket}).\n` +
    "The socket belongs to a group chosen when the service was installed. If you were added\n" +
    "to that group during the install, this session predates it -- log out and back in.\n" +
    `For right now:  sudo wave ${command}`,
  socketSilent: (socket: string) =>
    `A control socket exists at ${socket} but nothing answers; doing the work here.`,
  serviceOlder: "the service runs an older build that does not say its version",
  serviceRuns: (version: string) => `the service runs ${version}`,
  updateNeedsService:
    "updating needs the service: it holds the offers and owns the installation (wave install)",
  installedRestarting: "installed; the service is restarting with the new version",
  unexpectedAnswer: "unexpected answer",
  nameTheServer: "name the server: `wave login <control-server-url>`",
  newWaveNeedsDaemon:
    "--new-wave needs the wave service: it keeps several waves at one server apart. Install it with `sudo wave install`.",
  notAControlUrl: (typed: string) => `${typed} is not a control server address`,
  down: "down",
  nameTheWaveToLeave:
    "name the wave to leave: `wave logout <control-server-url>` (`wave profiles` lists them)",
  left: (label: string) => `left ${label}`,
  notEnrolledRow: "not enrolled",
  unknownCommand: (command: string, usage: string) => `unknown command: ${command}\n\n${usage}`,
  // The status view without a daemon: only what WireGuard knows.
  wgInterface: (name: string, node: string | null, port: number) =>
    `interface ${name} (node ${node ?? "unenrolled"}), port ${port}`,
  wgNoPeers: "  no peers",
  wgAgo: (seconds: number) => `${seconds}s ago`,
  wgNever: "never",
  // Kept "via" in both languages: the end-to-end scripts look for it, and an
  // endpoint is an address either way.
  wgPeer: (ips: string, endpoint: string | null, handshake: string) =>
    `  ${ips} via ${endpoint ?? "no endpoint"} — handshake ${handshake}`,
  wgSilent: (name: string, reason: string) => `${name} is not answering (${reason})`,
  stillWaiting: "Still waiting for the record. Run `wave cert` again once it is live.",
  recordsIntro: (name: string) => `\nThis wave answers dns-01 by hand, so ${name} needs a record first:\n`,
  recordsOutro: [
    "A short TTL (60s) helps. Nothing else has to be changed, and the record",
    "can go again once the certificate is there.",
    "Waiting... Ctrl-C is safe: `wave cert` takes the same order up again.\n",
  ].join("\n"),
  noCertificates: "no certificates yet — `wave cert` asks for one",
  certUntil: (until: string) => `until ${until}`,

  // ---- render.ts ----
  waitingForApproval: "Waiting for approval.",
  openLink: "Open this link to connect this device:",
  failed: "failed",
  starting: "Starting…",
  notConnected: "Not connected.",
  name: "name",
  dns: "dns",
  relay: "relay",
  connected: "connected",
  noPeers: "No peers yet. Run `wave up` on another device to add one.",
  columns: { peer: "PEER", address: "ADDRESS", path: "PATH", handshake: "HANDSHAKE" },
  ago: (seconds: number) => `${seconds}s ago`,
  minutesAgo: (minutes: number) => `${minutes}m ago`,
  recent: "recent",
  daemon: "daemon",
  updateTo: (version: string) => `update to ${version}`,
  renderInstallingNow: "installing now",
  renderInstallingAt: (at: string) => `installing at ${at}`,
  renderUpdateInstalls: "`wave update` installs it",
  noWave: "No wave yet. Run `wave login <url>` to join one.",
  disconnectHint: "Ctrl-C to disconnect.",

  // ---- install.ts ----
  needsRoot: (command: "install" | "uninstall") =>
    `wave ${command} needs to run as root: sudo wave ${command}`,
  stepFailed: (command: string, output: string) => `${command} failed: ${output}`,
  alreadyInPlace: (target: string) => `${target} is already in place.`,
  installedFrom: (target: string, source: string) => `installed ${target} (from ${source})`,
  installed: (path: string) => `installed ${path}`,
  runningCopy: (binary: string) =>
    `${binary} is the copy running right now, so it stays as it is.\n` +
    "To upgrade, run the new build instead:  sudo ./dist/wave install",
  wrote: (path: string) => `wrote ${path}`,
  windowsUpdateSettings:
    "Update settings are set through the service on Windows: wave update --channel … --auto-update …",
  updatesSetting: (on: boolean, channel: string | null) =>
    `updates: ${on ? "on" : "off"}, channel ${channel ?? "as the servers say"}`,
  relogForGroup: (group: string) =>
    `The '${group}' group applies only to sessions started after this one, so log out and back in — until then: sudo wave status`,
  stepsFailed: (count: number) =>
    `${count} step${count === 1 ? "" : "s"} above failed; wave is not set up. The messages say why.`,
  installedRunning: "wave is installed and running. Try: wave status",
  removed: (path: string) => `removed ${path}`,
  serviceRemoved: "service removed. The binary and this device's keys are untouched.",
  groupByHand: (name: string, own: string | null) =>
    `The '${name}' group does not exist, so only root can use the control socket. ` +
    `Create it and put your account in it${
      own
        ? `, or hand the socket to a group you already have: sudo wave install --group ${own} (which lets every member of '${own}' use it)`
        : ""
    }.`,
  noRunAs: (user: string) =>
    `Nothing here can run a command as ${user}; start the tray yourself: systemctl --user enable wave-tray && systemctl --user start wave-tray`,
  groupAlready: (group: string) =>
    `The control socket belongs to group '${group}', which this account already has.`,
  windowsElevated:
    "Run this from an elevated prompt: creating the task and a tunnel adapter both need Administrator.",
  windowsTask:
    'The daemon runs as a scheduled task under LocalSystem, not as a service — `schtasks /query /tn "wave daemon"` is where to look, not services.msc.',
  windowsBeside:
    "wireguard-go and wintun.dll are installed beside wave.exe; the daemon looks there and nowhere else.",
  windowsTrayAs: (user: string) =>
    `The tray icon runs as ${user}: started now, and again at every sign-in. If no icon appeared, this prompt belongs to another account — start it there with: wave tray`,
  windowsNoTray: "No account to run the tray icon as, so none was set up. Start it yourself with: wave tray",
  unsupportedInstall: (platform: string) =>
    `wave install does not support ${platform} yet. Run \`wave daemon\` by hand for now.`,
  missingWireguard: (install: string[], looked: string) =>
    [
      "wave needs wireguard-go to create the tunnel, and could not find it.",
      "",
      ...install,
      "",
      "Then either put it on the PATH as wireguard-go, or point WAVE_WIREGUARD_GO at it.",
      `Looked at: ${looked}, …`,
    ].join("\n"),
  wintunToo: [
    "Windows also needs wintun.dll from https://www.wintun.net next to the",
    "executable — wireguard-go cannot create an adapter without it.",
  ],
  missingWintun: (dll: string, looked: string) =>
    [
      `wave needs ${dll} on Windows, and could not find it.`,
      "",
      "  Download https://www.wintun.net, and take the DLL for this machine's",
      "  architecture out of bin\\<amd64|arm64>\\ in the zip.",
      "",
      `Then put it beside wave.exe, or point WAVE_WINTUN_DLL at it.`,
      `Looked at: ${looked}, …`,
    ].join("\n"),
};

const de: typeof en = {
  usage: (statePath, socketPath, mtu) => `wave — Mesh-VPN-Client

  wave install    alles einrichten: Dienst, Tray, Autostart     (braucht root)
  wave uninstall  den Dienst wieder entfernen                    (braucht root)

  wave login <url>   dem Wave dieses Control-Servers beitreten
                     (--auth-key <key> für eine Maschine ohne Browser,
                      --new-wave für einen weiteren Wave am selben Server)
  wave profiles      die Waves auflisten, in denen dieses Gerät ist
  wave up    [wave]  verbinden und die Tunnel zeigen (ohne Angabe alle)
  wave down  [wave]  sie abbauen (die Anmeldung bleibt)
  wave status        Tunnel und Peers beobachten, bis Strg-C
  wave logout <wave> einen Wave verlassen und seine Schlüssel vergessen

  Ein Wave heißt nach seinem Server oder -- bei mehreren am selben Server --
  nach seinem Namen in "wave profiles" (seiner DNS-Domain).

  wave cert  [name…] ein TLS-Zertifikat für dieses Gerät holen und erneuern
  wave certs         die Zertifikate dieses Geräts auflisten

  wave version    welcher Build das ist, und der Update-Stand des Dienstes
  wave update     das neueste angebotene Release jetzt installieren statt später
                  (--channel <name|server>, --auto-update on|off ändern Einstellungen)

  wave daemon     den privilegierten Teil im Vordergrund laufen lassen
  wave tray       das Tray-Icon im Vordergrund laufen lassen

"wave install" richtet die Maschine ein und kennt keinen Server; beigetreten
wird immer mit "wave login <url>", und ein Gerät darf so vielen beitreten, wie
es mag -- mit --new-wave auch mehreren am selben Server. Ein Wave heißt nach
seinem Control-Server, oder nach seinem eigenen Namen, wenn ein Server mehrere
führt; ein Befehl ohne einen meint alle Waves auf einmal. Nach dem
Install brauchen die Alltagsbefehle keine Rechte. Ohne den Dienst machen sie
die Arbeit selbst und müssen als root laufen.

Optionen:
  --control <url>   der Server für "wave login", falls nicht als Argument
  --state <path>    Zustandsdatei (Vorgabe: ${statePath})
  --daemon <path>   Steuersocket des Dienstes (Vorgabe: ${socketPath})
  --no-daemon       die Arbeit hier machen, auch wenn ein Dienst läuft
  --once            einen Stand ausgeben statt zu beobachten (abseits eines Terminals immer)
  --socket <path>   WireGuard-UAPI-Socket
  --interface <n>   Name des Tunnel-Interfaces (Vorgabe: wave0)
  --port <n>        WireGuard-Port (Vorgabe: 41641)
  --mtu <bytes>     MTU des Tunnels (Vorgabe: ${mtu})
  --stun <list>     STUN-Server, durch Komma getrennt, z. B. relay.example:3478
  --no-dns          die Namen des Waves nicht beantworten und den Resolver nicht anfassen
  --group <name>    Gruppe, die den Steuersocket benutzen darf (install)
  --auth-key <key>  ohne Browser anmelden, z. B. in einem Cluster (WAVE_AUTH_KEY)
  --hook <cmd>      nach jeder Erneuerung ausführen, z. B. 'systemctl reload caddy'
  --wildcard        *.<Wave-Domain> anfordern (ein Operator muss es erst erlauben)
  --control <url>   wählt auf einem Gerät in mehreren Waves auch den für "wave cert"
  --channel <name>  gewünschter Update-Kanal: stable, insiders, develop, oder
                    "server" für die Vorgabe jedes Servers (update, install)
  --auto-update on|off  ob der Dienst Updates selbst installiert

Die Sprache folgt dem System (LANG, LC_ALL, …); WAVE_LANG=en|de setzt sie fest.
`,
  channelFlag: (channels) => `--channel nimmt ${channels} oder server`,
  autoUpdateFlag: "--auto-update nimmt on oder off",
  autoUpdateLine: (on, channel) =>
    `automatische Updates ${on ? "an" : "aus"}, Kanal ${channel ?? "wie die Server sagen"}`,
  channelOffers: (label, channel, offered) => `  ${label}: ${channel} (bietet ${offered})`,
  installingAt: (at) => `, wird um ${at} installiert`,
  installingNow: ", wird gerade installiert",
  updateInstallsNow: "; `wave update` installiert es sofort",
  updateAvailable: (version, when) => `Update auf ${version} verfügbar${when}`,
  upToDate: "auf dem Stand dessen, was die Server anbieten",
  watchHint: "Strg-C beendet die Anzeige; die Tunnel laufen weiter.",
  detachedUp: "Getrennt. Die Tunnel laufen weiter; `wave down` stoppt sie.",
  detachedNothing: "Getrennt. Nichts ist oben; der Dienst versucht es weiter.",
  notEnrolled: "noch in keinem Wave — `wave login <control-server-url>` tritt einem bei",
  noSuchWave: (name) => `kein Wave unter ${name}; \`wave profiles\` zeigt, welche es gibt`,
  severalWaves: (count, labels) =>
    `dieses Gerät ist in ${count} Waves (${labels}); nenne einen über seinen Control-Server, oder nimm den Dienst, der sie zusammen führt`,
  socketDenied: (socket, command) =>
    `Der wave-Dienst läuft, aber dieses Konto darf seinen Steuersocket nicht benutzen (${socket}).\n` +
    "Der Socket gehört einer Gruppe, die beim Install festgelegt wurde. Bist du während des\n" +
    "Installs in diese Gruppe gekommen, ist diese Sitzung älter -- ab- und wieder anmelden.\n" +
    `Für den Moment:  sudo wave ${command}`,
  socketSilent: (socket) =>
    `Unter ${socket} gibt es einen Steuersocket, aber nichts antwortet; die Arbeit passiert hier.`,
  serviceOlder: "der Dienst läuft mit einem älteren Build, der seine Version nicht nennt",
  serviceRuns: (version) => `der Dienst läuft mit ${version}`,
  updateNeedsService:
    "Aktualisieren braucht den Dienst: er hält die Angebote und besitzt die Installation (wave install)",
  installedRestarting: "installiert; der Dienst startet mit der neuen Version neu",
  unexpectedAnswer: "unerwartete Antwort",
  nameTheServer: "nenne den Server: `wave login <control-server-url>`",
  newWaveNeedsDaemon:
    "--new-wave braucht den wave-Dienst: er hält mehrere Waves an einem Server auseinander. Einrichten mit `sudo wave install`.",
  notAControlUrl: (typed) => `${typed} ist keine Adresse eines Control-Servers`,
  down: "getrennt",
  nameTheWaveToLeave:
    "nenne den Wave, den du verlassen willst: `wave logout <control-server-url>` (`wave profiles` zeigt sie)",
  left: (label) => `${label} verlassen`,
  notEnrolledRow: "nicht angemeldet",
  unknownCommand: (command, usage) => `unbekannter Befehl: ${command}\n\n${usage}`,
  wgInterface: (name, node, port) => `Interface ${name} (Knoten ${node ?? "nicht angemeldet"}), Port ${port}`,
  wgNoPeers: "  keine Peers",
  wgAgo: (seconds) => `vor ${seconds}s`,
  wgNever: "nie",
  wgPeer: (ips, endpoint, handshake) =>
    `  ${ips} via ${endpoint ?? "kein Endpunkt"} — Handshake ${handshake}`,
  wgSilent: (name, reason) => `${name} antwortet nicht (${reason})`,
  stillWaiting: "Der Record fehlt noch. Ruf `wave cert` noch einmal auf, sobald er steht.",
  recordsIntro: (name) =>
    `\nDieser Wave beantwortet dns-01 von Hand, also braucht ${name} zuerst einen Record:\n`,
  recordsOutro: [
    "Eine kurze TTL (60s) hilft. Sonst muss nichts geändert werden, und der Record",
    "darf wieder weg, sobald das Zertifikat da ist.",
    "Warte... Strg-C ist sicher: `wave cert` nimmt denselben Auftrag wieder auf.\n",
  ].join("\n"),
  noCertificates: "noch keine Zertifikate — `wave cert` fordert eins an",
  certUntil: (until) => `bis ${until}`,

  waitingForApproval: "Wartet auf Freigabe.",
  openLink: "Öffne diesen Link, um dieses Gerät zu verbinden:",
  failed: "gescheitert",
  starting: "Startet…",
  notConnected: "Nicht verbunden.",
  name: "Name",
  dns: "DNS",
  relay: "Relay",
  connected: "verbunden",
  noPeers: "Noch keine Peers. Führe `wave up` auf einem anderen Gerät aus, um eines hinzuzufügen.",
  columns: { peer: "PEER", address: "ADRESSE", path: "PFAD", handshake: "HANDSHAKE" },
  ago: (seconds) => `vor ${seconds}s`,
  minutesAgo: (minutes) => `vor ${minutes}m`,
  recent: "zuletzt",
  daemon: "Dienst",
  updateTo: (version) => `Update auf ${version}`,
  renderInstallingNow: "wird gerade installiert",
  renderInstallingAt: (at) => `wird um ${at} installiert`,
  renderUpdateInstalls: "`wave update` installiert es",
  noWave: "Noch kein Wave. `wave login <url>` tritt einem bei.",
  disconnectHint: "Strg-C trennt die Verbindung.",

  needsRoot: (command) => `wave ${command} muss als root laufen: sudo wave ${command}`,
  stepFailed: (command, output) => `${command} gescheitert: ${output}`,
  alreadyInPlace: (target) => `${target} ist schon an seinem Platz.`,
  installedFrom: (target, source) => `${target} installiert (aus ${source})`,
  installed: (path) => `${path} installiert`,
  runningCopy: (binary) =>
    `${binary} ist die Kopie, die gerade läuft, also bleibt sie, wie sie ist.\n` +
    "Zum Aktualisieren stattdessen den neuen Build ausführen:  sudo ./dist/wave install",
  wrote: (path) => `${path} geschrieben`,
  windowsUpdateSettings:
    "Update-Einstellungen gehen unter Windows über den Dienst: wave update --channel … --auto-update …",
  updatesSetting: (on, channel) =>
    `Updates: ${on ? "an" : "aus"}, Kanal ${channel ?? "wie die Server sagen"}`,
  relogForGroup: (group) =>
    `Die Gruppe '${group}' gilt erst für Sitzungen, die nach dieser beginnen, also ab- und wieder anmelden — bis dahin: sudo wave status`,
  stepsFailed: (count) =>
    `${count} ${count === 1 ? "Schritt" : "Schritte"} oben gescheitert; wave ist nicht eingerichtet. Die Meldungen sagen, warum.`,
  installedRunning: "wave ist installiert und läuft. Probier: wave status",
  removed: (path) => `${path} entfernt`,
  serviceRemoved: "Dienst entfernt. Das Binary und die Schlüssel dieses Geräts bleiben unberührt.",
  groupByHand: (name, own) =>
    `Die Gruppe '${name}' gibt es nicht, also kann nur root den Steuersocket benutzen. ` +
    `Leg sie an und nimm dein Konto auf${
      own
        ? `, oder gib den Socket einer Gruppe, in der du schon bist: sudo wave install --group ${own} (damit darf ihn jedes Mitglied von '${own}' benutzen)`
        : ""
    }.`,
  noRunAs: (user) =>
    `Nichts hier kann einen Befehl als ${user} ausführen; starte das Tray selbst: systemctl --user enable wave-tray && systemctl --user start wave-tray`,
  groupAlready: (group) => `Der Steuersocket gehört der Gruppe '${group}', in der dieses Konto schon ist.`,
  windowsElevated:
    "Aus einer Eingabeaufforderung mit Administratorrechten ausführen: der Task und der Tunneladapter brauchen beide Administrator.",
  windowsTask:
    'Der Dienst läuft als geplanter Task unter LocalSystem, nicht als Windows-Dienst — nachsehen mit `schtasks /query /tn "wave daemon"`, nicht in services.msc.',
  windowsBeside:
    "wireguard-go und wintun.dll liegen neben wave.exe; der Dienst sucht dort und nirgends sonst.",
  windowsTrayAs: (user) =>
    `Das Tray-Icon läuft als ${user}: jetzt gestartet, und wieder bei jeder Anmeldung. Ist kein Icon erschienen, gehört diese Eingabeaufforderung einem anderen Konto — dort starten mit: wave tray`,
  windowsNoTray:
    "Kein Konto, unter dem das Tray-Icon laufen könnte, also wurde keins eingerichtet. Selbst starten mit: wave tray",
  unsupportedInstall: (platform) =>
    `wave install unterstützt ${platform} noch nicht. Vorerst \`wave daemon\` von Hand starten.`,
  missingWireguard: (install, looked) =>
    [
      "wave braucht wireguard-go, um den Tunnel zu bauen, und hat es nicht gefunden.",
      "",
      ...install,
      "",
      "Dann entweder als wireguard-go auf den PATH legen oder WAVE_WIREGUARD_GO darauf zeigen lassen.",
      `Gesucht in: ${looked}, …`,
    ].join("\n"),
  wintunToo: [
    "Windows braucht außerdem wintun.dll von https://www.wintun.net neben der",
    "ausführbaren Datei — ohne sie kann wireguard-go keinen Adapter anlegen.",
  ],
  missingWintun: (dll, looked) =>
    [
      `wave braucht unter Windows ${dll} und hat es nicht gefunden.`,
      "",
      "  https://www.wintun.net herunterladen und die DLL für die Architektur",
      "  dieser Maschine aus bin\\<amd64|arm64>\\ im Zip nehmen.",
      "",
      "Dann neben wave.exe legen oder WAVE_WINTUN_DLL darauf zeigen lassen.",
      `Gesucht in: ${looked}, …`,
    ].join("\n"),
};

let current: Locale = "en";

/**
 * Set once, by the CLI at start, from the system's language. Everything else
 * reads it through {@link t}; tests never set it and so read English, which is
 * what they assert.
 */
export function setLocale(locale: Locale): void {
  current = locale;
}

export const locale = (): Locale => current;

// Not `satisfies Messages`: the column headings are an object and two texts
// are line lists, which the generic shape has no room for. `typeof en` on the
// German catalog is what keeps the two in step.
const catalogs: Record<Locale, typeof en> = { en, de };

export const t = (): typeof en => catalogs[current];
