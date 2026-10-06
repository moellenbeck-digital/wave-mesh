# wave-mesh

Selbst hostbares Mesh-VPN auf WireGuard-Basis. Architektur und Meilensteine
stehen in [`docs/PLAN.md`](docs/PLAN.md) (Entscheidungen D1–D14, Roadmap M0–M14).
Erledigt: M0–M6 sowie M11, M10 (bis auf den Lauf auf echter Hardware, siehe
„Telefone") und M13 (bis auf den ersten echten Release, siehe
„Selbstaktualisierung"). M5 und M6 sind zusammen fertig geworden, weil beide dieselbe
Arbeit brauchten: Schreibzugriff auf die echte Zone. Der Server schreibt jetzt
über eine Provider-API hinein, und genau das ist zugleich die Verifikation —
wer die Zone schreiben kann, besitzt sie (siehe „Zertifikate"). Offen bleiben
die optionalen öffentlichen A/AAAA-Records, die CNAME-Delegation (braucht
autoritatives DNS, also M9) und die Aliase aus D6.

## Befehle

```bash
bun test                 # 904 Tests, kein Docker nötig
bun run check            # Biome (Lint + Format)
bun run typecheck        # tsc --noEmit, strict inkl. noUncheckedIndexedAccess
bun run db:up            # Postgres für die Entwicklung
cd apps/control && bun run db:migrate

bun run build:client     # ./dist/wave für diese Maschine
bun run build:clients    # alle sechs Ziele (Linux/macOS/Windows × amd64/arm64)
bun run images:build     # Control- und Relay-Image aus der docker-compose.yml
bun run stack:up         # Postgres, Migration, Control und Relay im Container
bun run stack:down

bun run dev:web          # Next.js auf :3000 (API-Pfade gehen an :8080)
bun run build:web        # Produktionsbuild des Frontends
cd apps/web && bun run typecheck   # eigener Lauf: DOM und JSX, nicht Bun

./test/e2e/two-nodes.sh      # Tunnel im LAN
./test/e2e/two-waves.sh      # ein Gerät in zwei Waves gleichzeitig
./test/e2e/nat-traversal.sh  # Hole Punching durch zwei NATs
./test/e2e/relay-fallback.sh # symmetrisches NAT → Relay
./test/e2e/acl.sh            # eine Policy: Peers über die Netzkarte, Ports über nftables

./test/e2e/mobile-core.sh    # der Go-Kern an einem echten TUN: zwei Waves, ein Interface
./test/e2e/mobile-nat.sh                # derselbe Kern durch zwei NATs, direkter Pfad
./test/e2e/mobile-nat.sh --symmetric    # ... und über das Relay, wo Punching nicht geht

./mobile/build.sh check      # der Go-Kern: gofmt, go vet, go test -race, gobind
./mobile/build.sh ios        # Wavemobile.xcframework (nur macOS, braucht Xcode)
./mobile/build.sh android    # wavemobile.aar (braucht ANDROID_HOME mit NDK)
cd mobile/fixtures && bun run generate   # Vergleichsdaten für die Go-Tests

bun scripts/release-key.ts               # neues Release-Schlüsselpaar (D13)
WAVE_RELEASE_SIGNING_KEY=… bun scripts/release-manifest.ts dist   # signiertes manifest.json
```

Die E2E-Tests brauchen **kein root**: sie starten sich in einem unprivilegierten
User-Namespace neu und legen dort Netns, veth, NAT und TUN an. Voraussetzungen:
`wireguard-go` (`go install golang.zx2c4.com/wireguard@latest` → `~/go/bin/wireguard`),
`nftables`, `tc`.

## Aufbau

| Pfad | Inhalt |
|---|---|
| `apps/control` | Login (Passwort/OIDC), Node-Registrierung, signierte Netmaps, Mitglieder und Einladungen, `/v1/control` (WS) |
| `apps/relay` | STUN (UDP) und Relay (WS) in einem Prozess |
| `apps/client` | ein Binary, alle Rollen: `wave up/status/login/profiles`, `wave daemon`, `wave tray`, `wave install` |
| `packages/ipc` | Protokoll und Client des Steuersockets, von CLI und Tray genutzt |
| `packages/proto` | Zod-Schemas — der Vertrag zwischen beiden Seiten |
| `packages/crypto` | Schlüssel, Signaturen, kanonisches JSON, Request-Signierung, DER/CSR/X.509 |
| `packages/disco` | authentifizierte Discovery-Pakete (X25519 + XChaCha20-Poly1305) |
| `packages/magicsock` | UDP-Multiplexer vor WireGuard, STUN-Client, Relay-Client |
| `packages/dns` | DNS-Codec und Split-DNS-Resolver |
| `packages/i18n` | welche Sprache jemand liest: Cookie, `Accept-Language`, Systemsprache, Rückfall Englisch |
| `apps/tray` | Tray-Icon: Linux über D-Bus, macOS über `bun:ffi` und Cocoa |
| `apps/connector` | Cluster-Seite von D11: leitet die Dienstadressen des Waves an den internen Ingress-Controller weiter |
| `apps/operator` | liest `Ingress`/`HTTPRoute` der Klasse `wave` und meldet die Namen dem Control-Server |
| `apps/web` | Next.js-Oberfläche: Anmeldung, Wave- und Geräteübersicht, Gerätefreigabe, Mitglieder und Einladungen |
| `mobile/core` | der Go-Kern für iOS und Android (D10) — dieselben Verträge, ein Tunnel, N Waves |
| `mobile/ios`, `mobile/android` | die Plattform-Hosts: `NEPacketTunnelProvider` und `VpnService`, beide absichtlich dünn |

**Das zentrale Konstrukt:** Der MagicSock besitzt den einzigen öffentlichen
UDP-Port. wireguard-go lauscht nur auf Loopback, und jeder Peer bekommt einen
eigenen Loopback-Socket, den WireGuard als dessen Endpoint sieht. Ein
Pfadwechsel fasst die WireGuard-Konfiguration deshalb nie an, und das Relay ist
kein Sonderfall, sondern ein Pfad wie jeder andere — Pfade werden nach RTT
sortiert, ein direkter gewinnt automatisch.

Der Loopback-Socket ist dabei ein Behelf, kein Teil der Idee: er existiert, weil
Bun wireguard-go keine `conn.Bind` anbieten kann. Auf dem Telefon nimmt der
Go-Kern die echte entgegen, und der Endpoint ist dort der Peer statt einer
Adresse — siehe „Telefone".

## Oberfläche und Control-Server

Der Control-Server bleibt der einzige öffentliche Port. `WAVE_WEB_URL` schaltet
das Frontend dazu: gesetzt, leitet er die Browser-Routen auf dessen Seiten um
(`/login`, `/devices/connected`, `/devices/expired`) und reicht alles, was er
nicht selbst besitzt, per `hono/proxy` dorthin weiter. Ungesetzt bleibt das
heutige, absichtlich karge HTML — genau das, wogegen die E2E-Tests laufen, die
`bun src/index.ts` allein starten.

Zwei Dinge hängen daran:

- **Der Proxy folgt keinen Weiterleitungen** (`redirect: "manual"`). Täte er es,
  stünde der Browser weiter auf `/` und sähe die Login-Seite.
- **Ein WebSocket lässt sich über `fetch` nicht upgraden.** Deshalb gehört jede
  Socket-Route zum Control-Server, `/v1/control` und `/api/events` tun das
  schon. Aus demselben Grund läuft es in der Entwicklung andersherum: der
  Browser spricht mit `next dev` auf :3000, und `next.config.ts` leitet die
  API-Pfade an :8080 — sonst gäbe es kein Hot Reload. Next leitet dabei auch
  den Upgrade weiter, der Socket geht also in beiden Richtungen über dieselbe
  Herkunft wie die Seite; nachgemessen am 26.09.2026 gegen `next dev`.

Das Frontend fasst die Datenbank nie an; alles kommt über `/api/me`,
`/api/waves/:id/nodes` und `/api/auth/providers` mit dem Sitzungscookie des
Browsers. Wer was sehen darf, entscheidet damit nur eine Stelle.

Gestalterisch folgt die Oberfläche <https://wavecenter.org/de>: dieselbe Palette
(`#fffdf8` Papier, `#0f2744` Navy, `#7c8b9a` Slate), Space Grotesk und Inter,
dieselben `wc-*`-Komponenten. Eigen ist nur der Akzent — dort Gold, hier Petrol
`#0f6e6e`. Die Tokens stehen in `apps/web/src/app/globals.css`; wer dort etwas
hinzufügt, das keine Seite trägt, lässt es besser weg. Farben, Typografie,
Komponenten und Regeln für Web und Tray sind in `DESIGN.md` zusammengefasst —
wer dort oder an den Tokens etwas ändert, zieht das andere nach.

## Sprachen

Alles, was ein Mensch liest, gibt es auf **Deutsch und Englisch** — Web,
die eigenen Seiten des Control-Servers, CLI, Tray, `wave-admin` und die beiden
Apps. **Englisch ist der Rückfall**, für jede Sprache, die keine von beiden ist,
und für `LANG=C` auf einem Server. Im Deutschen wird geduzt, und es heißt
*der* Wave.

Wer welche Sprache bekommt, steht an genau einer Stelle, in `@wave/i18n`
(`packages/i18n`), und sonst nirgends:

- **Im Browser** gilt das Cookie `wave_lang` (der Umschalter DE | EN in der
  Kopfzeile), dann `Accept-Language`, dann Englisch — `requestLocale()`. Web
  und Control-Server fragen beide diese Funktion, denn sie liefern Seiten unter
  derselben Herkunft aus; zwei Regeln hießen zwei Sprachen auf einem Bildschirm.
- **Auf der Maschine** gilt `WAVE_LANG`, dann `LANGUAGE`/`LC_ALL`/
  `LC_MESSAGES`/`LANG`, dann die Einstellung von macOS bzw. Windows —
  `systemLocale()` in `@wave/i18n/system`. Ein Tray, das launchd oder der
  Aufgabenplaner startet, hat kein `LANG`; dort ist die Systemeinstellung die
  einzige Quelle.

Die Texte selbst liegen beim jeweiligen Programm, als Katalog
`const en = {…}` und `const de: typeof en = {…}` — ein fehlender oder
überzähliger Schlüssel im Deutschen ist damit ein Typfehler, kein leeres
Etikett. Keine Bibliothek: der Client wird mit `bun build --compile` gebaut,
und genau dort zerlegen sich Abhängigkeiten still (siehe Tray).

Was daran festliegt:

- **Logs bleiben englisch**, überall: Journal, Daemon-Log, die `recent`-Zeilen
  in `wave status`, die Logs des Control-Servers. Sie werden gesucht, in Issues
  kopiert und von den E2E-Skripten gegrept; eine Zeile, die sich mit der
  Sprache dessen ändert, der den Dienst gestartet hat, taugt für nichts davon.
  Das Maschinenprotokoll (`/v1/*`, die Control-WebSocket) bleibt es ebenso.
- **Der Daemon kennt keine Sprache.** Er läuft als root ohne das `LANG` von
  irgendwem, und systemd gibt Diensten das aus `/etc/locale.conf` mit — deshalb
  setzt `cli.ts` für `wave daemon` ausdrücklich keine. Was er einem Menschen
  sagt, schickt er als **Code mit Parametern** (`notice` in `@wave/ipc`,
  `notice.ts`), CLI und Tray sagen es in ihrer Sprache. Daneben steht immer der
  englische Satz in `message`: ein älterer Client liest nur den, und das
  Journal bekommt dieselben Worte. Ein Grund, der aus Netz oder Dateisystem
  kommt, bleibt, wie er kam — ihn zu übersetzen hieße raten.
- **Gemeinsame Wörter liegen einmal in `@wave/ipc`** (`words.ts`): wie ein Peer
  erreicht wird und „wartet auf Freigabe im Browser“. CLI, Tray-Menü und
  Tray-Fenster sagten sie vorher dreimal.
- **Tests sehen Englisch.** Kein Test setzt eine Sprache, also gilt der
  Rückfall, und die englischen Zusicherungen bleiben, wie sie sind. Die
  E2E-Skripte setzen `WAVE_LANG=en` in `lib.sh`, weil sie an einer Stelle
  CLI-Ausgabe lesen.
- **Die Apps nehmen die Sprache des Telefons**, über String Catalog (iOS) und
  `values-de/strings.xml` (Android); einen Umschalter gibt es dort nicht.
  Ungeprüft wie alles Mobile: die Schlüssel interpolierter Strings unter iOS
  müssen in Xcode einmal nachgesehen werden (`mobile/README.md`).

## Die Geräteliste lebt

`/api/events` ist das Gegenstück zu `/v1/control` für die andere Seite: ein
Knoten bekommt eine signierte Netzkarte geschoben, ein Browser die Geräteliste,
die er gerade zeichnet. Sie ändert sich, wenn ein Gerät sich verbindet oder
verschwindet, wenn eines dazukommt oder entfernt wird und wenn ein Connector
andere Dienste meldet — ohne dass jemand neu lädt.

Es ist ein nackter WebSocket, **kein socket.io**. Der Grund ist nicht
Geschmack: `Bun.serve` nimmt genau einen `websocket`-Handler entgegen, und
darüber liegt schon die Route der Knoten; socket.io bräuchte dagegen einen
`node:http`-Server, an den es sich hängt, dazu seinen eigenen Handshake mit
HTTP-Polling als Rückfallebene und eine zweite Herkunft für den
Sitzungscookie. Gegengerechnet steht ein Reconnect mit Backoff in zwanzig
Zeilen im Frontend, und die Verträge — Zod-Schemas, signierte Dokumente —
gehören hier ohnehin uns.

Was daran festliegt:

- **Der `NetmapHub` ist der eine Haken.** Alles, was eine Geräteliste ändert,
  schiebt ohnehin schon eine Netzkarte: Freigabe, Registrierung, Entfernen,
  Dienste. Der Feed hängt deshalb an `hub.onChange()` und nicht an den
  Aufrufern — der nächste Aufrufer vergäße es, und eine Seite, die nie
  aktualisiert, sieht nicht kaputt aus. Online und offline kann ohnehin nur der
  Hub wissen: es ist eine gehaltene Verbindung, nichts in der Datenbank.
- **Verglichen wird, was ein Browser sähe.** Die meisten Netzkarten-Stöße sind
  Kandidaten, und die zeigt keine Seite. Der Feed baut die Liste, vergleicht
  ihr JSON mit dem zuletzt gesendeten und schweigt, wenn sich nichts geändert
  hat. Ein Schwung — zwanzig Knoten melden nach einem Netzwechsel ihre
  Endpunkte — fällt damit auf einen Push zusammen, und gleichzeitige Läufe
  sammeln sich zu einem Nachlauf.
- **Immer die ganze Liste, nie ein Delta.** Dasselbe wie bei den Diensten (D11):
  ein verpasstes Delta hinterlässt eine Seite mit einem Gerät, das es nicht mehr
  gibt, und nichts, woran das auffiele.
- **Ein Socket je Seite, und welche Waves er trägt, entscheidet der Server.**
  Aus der Sitzung, nicht aus einem Parameter — dieselbe eine Stelle, die auch
  für `/api/waves/:id/nodes` entscheidet, wer was sehen darf. Wofür er sich
  anmeldet, steht danach für die Dauer der Verbindung fest — wer einem weiteren
  Wave beitritt, lädt die Seite dabei ohnehin neu.
- **Der Socket sagt, was er hören will; die Datenbank sagt, was er bekommt.**
  Vor jedem Push wird die Mitgliedschaft nachgesehen. Wer aus einem Wave
  entfernt wird, behält seine Sitzung, und sein offener Socket bekäme sonst
  weiter die Liste eines Waves, in dem er nicht mehr ist — auch dann, wenn das
  Entfernen von der Shell kam, wo es keinen Feed gibt, dem man es sagen könnte.
  Der Wave fliegt dabei aus dem Socket, die Antwort kostet also eine Abfrage
  und nicht eine je Push.
- **Was den Socket schützt, ist `SameSite=Lax`** — genau wie die Formulare
  daneben. Ein WebSocket-Handshake ist keine Top-Level-Navigation, das
  Sitzungscookie geht also von einer fremden Seite aus nicht mit, und ohne
  Sitzung wird mit 4401 geschlossen. Deshalb gibt es hier auch keinen Token im
  Query-String: der stünde in jedem Proxy-Log.
- **Die Dienste liegen eingeklappt unter ihrem Gerät.** Ein Connector bringt
  beliebig viele mit, und ausgeschrieben schöben sie die Geräte darunter aus
  dem Blick — aufgemacht wird auf Klick. Das ist dabei ein echter `<button>`
  und kein anklickbares `div`: Tastatur, Fokus und `aria-expanded` gibt es
  damit geschenkt. Den Knopf bekommt nur ein Gerät, das auch Dienste hat; eines
  ohne wäre ein Knopf, der nichts tut. Der Zustand gehört der Zeile, nicht der
  Liste — ein Push ersetzt die Geräte, und über `key={node.id}` bleibt ein
  offenes Gerät offen.
- **Die Karte bleibt serverseitig, nur die Geräte darin sind gelebt.**
  `DeviceFeed` ist der Provider um die Karten herum, `LiveNodeList` und die
  beiden Zähler sind seine einzigen Leser. `@/lib/control` importiert
  `next/headers` — wer daraus mehr als Typen in eine Client-Komponente zieht,
  bricht den Build, und das ist die Grenze, an der diese Teilung hängt.
- **Zeiten fallen beim Hydrieren auseinander.** „vor drei Minuten" zählt ab
  jetzt, und der Server steht auf UTC, der Browser nicht. Die Zelle trägt
  deshalb `suppressHydrationWarning`: die Fassung des Browsers ist die richtige,
  und über den Unterschied muss niemand gewarnt werden.
- **Der Feed lebt im Prozess, wie der Hub.** Derselbe Grund, aus dem Control
  mit genau einer Replika läuft (siehe Deployment) — ein zweiter Pod hätte die
  Hälfte der Browser und erführe nie, dass die andere Hälfte etwas Neues braucht.
- **Eine unterbrochene Verbindung sagt das.** Das Frontend verbindet mit
  Backoff neu und beim Sichtbarwerden des Tabs sofort — ein Hintergrundtab
  bekommt seinen Socket eingefroren. Solange keiner steht, sagt die Seite, dass
  die Geräte so dastehen wie beim Laden; still veraltet zu sein wäre schlimmer
  als gar nicht zu leben.

**Dieselben Dienste stehen auch auf dem Gerät**, seit dem 26.09.2026: im
Tray-Fenster und in `wave status`. Der Weg dorthin ist die Netzkarte, nicht die
Browser-API — sie nennt je Dienst den Knoten, der ihn trägt, und
`servicesOf()` in `engine.ts` dreht das um, sodass jeder Peer im IPC-Status
seine eigenen mitbringt. **Die Adresse bringt er fertig mit** und keine
Oberfläche setzt sie zusammen; dass Browser und Gerät dieselbe Zeichenkette
bekommen, hält ein Test in `web-api.test.ts` fest. Zwei Dinge unterscheiden die
drei Oberflächen, und beides folgt aus dem, womit man es bedient:

- **Im Terminal wird nichts weggeklappt.** `wave status` zeichnet im
  Sekundentakt neu und hat nichts, worauf man klicken könnte; die Dienste
  stehen deshalb eingerückt unter ihrer Maschine, mit Schema und Adresse. Der
  Preis ist bekannt: ein Cluster mit zwanzig Ingressen schreibt zwanzig Zeilen.
- **Auch die eigenen.** Nur dort — läuft der Bun-Client selbst als Connector,
  sind seine Dienste in `addresses` sonst bloß nackte Adressen. Das Tray-Fenster
  listet Maschinen, und die eigene ist keine.

## Plattformen

Der Bun-Client zielt auf **macOS, Linux und Windows**, jeweils auf **arm64 und
amd64**. iOS und Android sind nicht in dieser Liste und werden es nicht: dort
läuft von diesem Client nichts, und die Plattformweichen unten haben keine
Entsprechung. Sie bekommen den Go-Kern aus `mobile/` — siehe „Telefone". Alles, was im Client dazukommt, muss auf allen dreien laufen. Wo das
(noch) nicht geht, sagt die Plattformweiche es ausdrücklich, statt still etwas
anderes zu tun — `UnsupportedPlatform` im Tray ist das Muster: benennen, dass
es dort nichts gibt, und dazusagen, dass der Tunnel davon unberührt bleibt.

Die Weichen stehen an drei Stellen, und nur dort gehört Plattformwissen hin:

| Weiche | Zuständig für |
|---|---|
| `apps/client/src/link-platform.ts` | Interface, Adressen, Routen, DNS (`LinkBackend`) — Linux, macOS, Windows |
| `apps/tray/src/backend.ts` | Tray-Icon |
| `apps/tray/src/window.ts` | Das Fenster hinter dem Icon |
| `apps/tray/src/prompt.ts` | Der Update-Dialog (D13) |
| `planInstall()` in `apps/client/src/install.ts` | Dienst, Autostart, Dateiorte |

Die Engine fragt die Weiche, statt selbst zu entscheiden — `resolverAddress()`
ist das jüngste Beispiel: dass der Resolver unter macOS auf Loopback lauschen
muss, weiß das Backend, nicht `syncDns()`.

Unter Windows trägt der Tunnel: Link-Backend (`link-windows.ts`), Install-Plan
und UAPI stehen, seit dem 17.09.2026 das Tray-Icon mit seinem Menü
(`backend-win32.ts`) und seit dem 21.09.2026 auch das Fenster dahinter
(`window-win32.ts`) — ein Linksklick öffnet dieselbe Karte wie unter Linux und
macOS. Ungeprüft ist alles davon auf echter Hardware: es gibt hier keine
Windows-Maschine, die Backends sind über injizierte Runner und reine
Layout-Funktionen getestet, nicht gefahren.

Sechs Dinge sind dort anders, und jedes hat einen Grund:

- **PowerShell statt `netsh`.** `netsh` druckt für Menschen und ist
  **lokalisiert** — auf einem deutschen Windows heißt die Spalte „IP-Adresse",
  und jeder gegen die englische Ausgabe geschriebene Parser findet still nichts.
  Die NetTCPIP-Cmdlets geben Objekte zurück, deren Eigenschaftsnamen in jeder
  Sprache dieselben sind, und `ConvertTo-Json` macht sie lesbar, ohne
  Spaltenpositionen zu raten. `ConvertTo-Json` liefert allerdings bei *einem*
  Ergebnis kein Array, sondern das nackte Objekt — `parseJsonList()` faltet
  beide Formen und die leere dazu.
- **Die Routen des Kernels heißen `Local`, unsere `NetMgmt`.** Windows leitet
  aus jeder Adresse On-Link-, Host- und Multicast-Routen ab; sie zu löschen
  bricht den Adapter. Das ist dieselbe Unterscheidung wie die S/I/i/m-Flags
  unter macOS, nur als Feld. Der Wert kommt je nach Serialisierung als Name
  oder als Zahl (3), also werden beide akzeptiert.
- **Alles in den `ActiveStore`.** Eine persistente Route überlebte den Neustart
  und zeigte auf einen Adapter, den es noch nicht gibt — der Wave wäre bis zum
  Hochkommen des Tunnels ein schwarzes Loch.
- **Split-DNS ist die NRPT, Search ist das Connection-Specific Suffix.** Eine
  NRPT-Regel schickt einen Namensraum an einen Server und lässt den Rest der
  Auflösung in Ruhe — genau die Anforderung. Und anders als unter macOS geht
  hier auch die Search-Seite: das Suffix hängt am Adapter, reicht also nicht
  über den Tunnel hinaus. `Set-DnsClientGlobalSetting` wäre systemweit und ist
  deshalb tabu. Wichtig: **eine NRPT-Regel kennt keinen Port**, der Resolver
  muss also auf 53 lauschen — was geht, weil jeder Wave unter Windows wie unter
  Linux eine eigene Tunneladresse hat. Fehlen die Cmdlets, wird die
  DNS-Konfiguration verweigert, nicht improvisiert.
- **Der wintun-Adapter gehört dem Prozess, wie ein utun unter macOS.** Es gibt
  kein Kommando, das ihn löscht; `remove()` signalisiert eine PID aus
  `%PROGRAMDATA%\wave\run\<iface>.pid`. Deshalb läuft wireguard-go dort im
  Vordergrund — aber **ohne `-f`**: unter Windows forkt es ohnehin nicht, und
  das Flag gibt es dort nicht.
- **Die UAPI ist eine Named Pipe, kein Socket.** `uapiExchange()` spricht
  deshalb `node:net` statt `Bun.connect` — dieselbe Aufrufform liefert beides,
  derselbe Grund wie beim Steuersocket. Und **Bereitschaft wird durch Verbinden
  geprüft, nicht durch `existsSync`**: eine Pipe taucht nie im Dateisystem auf,
  eine Datei-Prüfung hätte auf einem längst fertigen Tunnel das Timeout
  ausgesessen (`uapiReady()`).

**Der Daemon läuft als geplanter Task unter LocalSystem, nicht als Dienst.**
Das ist keine Bequemlichkeit, sondern zwei Messungen vom 17.09.2026:

- **wireguard-go verlangt LocalSystem.** Seine UAPI-Pipe entsteht mit dem
  Security-Descriptor `O:SYD:P(A;;GA;;;SY)(A;;GA;;;BA)S:(ML;;NWNRNX;;;HI)` —
  Eigentümer SYSTEM. Einen Eigentümer darf ein Prozess nur auf eine SID seines
  eigenen Tokens setzen, und SYSTEM steht dort auch bei einem *erhöhten*
  Administrator nicht. Sonst Fehler 1307, „Diese Sicherheitskennung kann nicht
  als Besitzer des Objekts zugeordnet werden". Ein erhöhter Prompt reicht also
  nicht; nur LocalSystem reicht. Deshalb ist der Fallback `runHere()` in der
  CLI unter Windows eine Sackgasse — dort trägt ausschließlich der Daemon.
- **Ein echter Dienst ist mit `bun:ffi` nicht baubar.** Ein Dienst muss
  `StartServiceCtrlDispatcher` aufrufen und `ServiceMain` auf dem Thread des
  SCM halten, bis er stoppt. Ein `JSCallback` kann das nicht: mit
  `threadsafe: true` reicht er den Aufruf an die Eventloop seines Besitzers
  weiter und **kehrt sofort zurück** (gemessen: Fremd-Thread nach ~0 ms weg,
  JS-Rumpf lief noch 1500 ms), ohne `threadsafe` hängt der Fremd-Thread und der
  Rumpf läuft **nie**. `sc create` auf `wave.exe` endet damit immer in 1053,
  „hat nicht rechtzeitig auf die Startanforderung reagiert". Der Versuch ist
  gemacht; er muss nicht wiederholt werden. Ein In-Process-Ausweg gäbe es nur
  über selbst geschriebenen Maschinencode für zwei Architekturen.

Nachgesehen wird deshalb mit `schtasks /query /tn "wave daemon"`, nicht in
`services.msc`. Drei Dinge hängen daran:

- **Die Definition ist eine XML-Datei, keine Kommandozeile.** Zwei der
  nötigen Einstellungen haben kein Flag: `<RestartOnFailure>` und
  `<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>`. Ohne Letzteres beendet der
  Aufgabenplaner den Daemon nach drei Tagen — ein Fehlerbild, das nach Netz
  aussieht. Die Datei wird als **UTF-16 mit BOM** geschrieben: `schtasks /xml`
  nimmt das seit je, UTF-8 erst neuere Windows-Versionen. Der Preis gegenüber
  `sc failure restart/2000` ist die Mindestwartezeit: `PT1M` ist der Boden,
  den der Aufgabenplaner erzwingt.
- **Erst `wave down`, dann `/end`.** Einen Task zu beenden ist ein harter Kill,
  und die NRPT-Regeln eines Waves sind Registry-Einträge — die überlebten den
  Prozess und schickten einen Namensraum weiter an einen Resolver, den es nicht
  mehr gibt. Dasselbe Paar steht in `uninstall()`.
- **Eine laufende `.exe` lässt sich nicht ersetzen.** Der Daemon *ist* diese
  Datei, also muss er weg sein, bevor irgendetwas geschrieben wird — dafür gibt
  es `InstallPlan.before`, das vor dem Binary läuft. Das Tray gehört dort
  dazu: es ist dieselbe `wave.exe` und hält sie genauso fest. Unter Unix
  braucht es das nicht: über eine laufende Datei umzubenennen ist genau das,
  worauf `replaceFile()` baut.
- **Das Tray ist ein zweiter Task, und aus denselben Gründen eine XML-Datei.**
  Es gehört dem angemeldeten Benutzer, nicht der Maschine: Logon-Trigger,
  `InteractiveToken` und `LeastPrivilege` — ein Icon gehört in eine Sitzung,
  ein erhöhtes ließe sich vom Desktop darunter nicht bedienen, und ohne
  Passwort registrieren lässt sich nur das. Ohne `<ExecutionTimeLimit>PT0S`
  wäre das Icon nach drei Tagen weg, und `DisallowStartIfOnBatteries` stünde
  auf seiner Vorgabe, die es auf einem Laptop meist gar nicht erst starten
  ließe — dieselben zwei Einstellungen ohne Flag wie beim Daemon. `wave
  install` **startet es sofort**, wie launchd und systemd es auf den anderen
  beiden tun, aber als *optionalen* Schritt: ein erhöhter Prompt eines anderen
  Kontos kann keine fremde Sitzung bespielen, und ein Tray, das nicht startet,
  ist kein Tunnel, der gescheitert ist.

**`InstallPlan.before` ist Best effort und schweigt.** Bei einer
Erstinstallation gibt es nichts zu stoppen, und das Binary, das diese Schritte
aufrufen, existiert noch gar nicht — `spawnRunner()` fängt deshalb auch den
Spawn-Fehler ab. Die Fehlschläge zu klassifizieren statt zu schweigen ist keine
Option: `schtasks` ist **lokalisiert** (dieselbe Falle wie bei `netsh`), und
**Bun kappt einen Windows-Exit-Status auf acht Bit** — 1053 kommt als 29 an,
1073 als 49. Weder Text noch Zahl taugen als Merkmal.

**Und `sc.exe` schreibt seine Meldungen auf stdout, nicht auf stderr.** Deshalb
liest `spawnRunner()` beide Ströme in *ein* Feld. Solange nur stderr gelesen
wurde, war es leer, der Rauschfilter konnte nie greifen, und ein Lauf, in dem
alles erwartbar war, meldete drei Fehlschläge ohne eine einzige Meldung — und
`install()` sagte danach trotzdem „wave is installed and running" und gab 0
zurück. Fehlschläge werden jetzt gezählt; einer genügt für Status 1.

**`wave install` legt die Abhängigkeiten immer mit hin.** Der Daemon läuft als
root beziehungsweise LocalSystem und sieht weder PATH noch GOPATH des
Benutzers — was dort liegt, findet er nicht. Deshalb kopiert der Install
wireguard-go neben das Binary, und unter Windows dazu `wintun.dll`; ohne die
DLL startet wireguard-go, meldet ein Device und scheitert am ersten Adapter —
ein Fehlerbild, das nach Netz aussieht und keines ist. Drei Dinge daran:

- **Gesucht wird zuerst neben dem laufenden Binary** (`selfDir` in
  `findWireguardGo()` und `findWintun()`), erst danach auf dem PATH und in den
  üblichen Ecken. Ein entpacktes Archiv bringt damit die Fassung mit, die zu
  diesem Build gehört, statt an eine ältere auf dem PATH zu geraten. Nur
  `WAVE_WIREGUARD_GO` beziehungsweise `WAVE_WINTUN_DLL` schlägt das noch.
- **`wintun.dll` wird auch dort gesucht, wo wireguard-go gefunden wurde** —
  die beiden reisen in aller Regel zusammen.
- **Fehlt eines von beiden, ist der Install gescheitert**, nicht bloß
  kommentiert: er zählt es als Fehlschlag und endet mit Status 1. Ein Install,
  aus dem kein Tunnel werden kann, darf sich nicht gelungen nennen.

Beides liegt im Release-Archiv bei (siehe Images und Releases), der Install
findet also im Normalfall genau die Fassung, die zu diesem Build gehört.

Zur Architektur: keine Annahmen über Wortbreite oder Aufrufkonvention. Das
trifft vor allem `bun:ffi` — eine Signatur, die auf arm64 aufgeht, muss auch
auf amd64 stimmen, und variadische C-Funktionen wie `objc_msgSend` übergeben
ihre Argumente auf beiden Architekturen unterschiedlich.

## Ein Wave und seine Domain

**Ein Wave entsteht nicht von selbst.** Die Anmeldung legte früher ungefragt
einen an; heute landet ein erster Login auf `/waves/new` und der Wave entsteht
erst mit dem Absenden — mit Namen und **DNS-Suffix**, beide vom künftigen
Eigentümer. Der Grund ist der Suffix: unter ihm hängt jeder Gerätename
(`laptop.wave.example.com`), und ein öffentliches Zertifikat gibt es nur für
eine Domain, die dem Nutzer wirklich gehört (D6/D7). Das ist nichts, was ein
Server raten kann.

Der Standard ist `<name>.wave.internal`. `.internal` lässt sich nie delegieren,
ein Platzhalter kollidiert also nie mit einer echten Zone — er kann dafür aber
auch nie ein Zertifikat tragen. Wer keine Domain hat, behält ihn und zieht
später um.

Was daran festliegt:

- **Die Eingabe ist der ganze Suffix, nicht eine Basis.** `wave.example.com`
  ergibt `laptop.wave.example.com`, nicht `laptop.robin.wave.example.com`. Das
  Formular ist mit `<name>.wave.internal` vorbelegt, was man tippt, gilt —
  dieselbe Bedeutung, die `admin.ts set-domain` schon immer hatte.
- **Zwei Waves können nicht dieselbe Zone beantworten.** `dns_suffix` trägt
  einen Unique-Index; `createWave()` und `setWaveDomain()` fragen vorher nach
  und geben `{ conflict: "suffix" }` zurück, statt die Ausnahme des Index
  durchzureichen — die kann kein Aufrufer von „Datenbank weg" unterscheiden.
  Die Route macht daraus 409, nicht 500.
- **Der Umzug zählt `netmapVersion` hoch und schiebt.** Jedes Gerät hält eine
  Netmap mit dem alten Suffix; ohne den Stoß beantwortet sein Resolver weiter
  eine Zone, die der Wave verlassen hat. Auf denselben Wert zu setzen zählt
  nichts hoch — es hat sich nichts geändert.
- **`waveSetup()` ist die eine Stelle, die „hat der schon ein Netz?"
  beantwortet.** Login-Weiterleitung, `/api/me` und das Formular fragen alle
  dasselbe; drei eigene Antworten hießen, jemanden auf ein Formular zu
  schicken, das er nicht braucht.
- **Der `next`-Parameter läuft durch.** `wave login` auf einem frischen Konto
  geht Browser → Login → Formular → Gerätefreigabe: `/machine/authorize` ohne
  Wave leitet auf `/waves/new?next=…` weiter, statt wie früher mit 400 „no
  wave" zu antworten. Ohne das bliebe die Anfrage hängen und der Mensch müsste
  den Link aus dem Terminal noch einmal öffnen.
- **`ensureWaveForUser()` bleibt für den Weg ohne Browser.**
  `admin.ts set-password` kann niemanden fragen und nimmt deshalb weiter den
  Platzhalter. Eine wartende Einladung hält es dort nach wie vor zurück; das
  Formular dagegen zeigt die Einladung an und legt trotzdem an, wenn jemand
  darauf besteht — die Regel schützt vor *automatischen* Waves, nicht vor
  gewollten.

`bun test` deckt den Anmeldeweg nicht ab: `browser_login` in `test/e2e/lib.sh`
legt den Wave inzwischen mit einem eigenen POST an. Wer an Login, `up` oder dem
Daemon etwas ändert, fährt die E2E-Skripte.

## Zwei-Faktor-Anmeldung (TOTP)

Wer sich mit **E-Mail und Passwort** anmeldet, kann einen zweiten Faktor
einschalten: einen Code aus einer Authenticator-App (RFC 6238, SHA-1, 30 s,
sechs Ziffern — das, was jede App erzeugt). Eingerichtet wird auf `/account`
(der Link ist die eigene Adresse in der Kopfzeile), mit QR-Code, Bestätigung
durch einen ersten Code und zehn Wiederherstellungscodes, die genau einmal
angezeigt werden.

```bash
wave-admin disable-2fa <email>    # das verlorene Telefon
```

Was daran festliegt (`apps/control/src/auth/two-factor.ts`, `totp.ts`):

- **Nur der Passwort-Login fragt.** Google und Pocket ID bringen ihren eigenen
  zweiten Faktor mit; ein Konto ohne Passwort hat hier nichts einzurichten.
- **Zwischen Passwort und Code gibt es keine Sitzung**, sondern eine
  *Challenge*: ein Cookie `wave_2fa` (Pfad `/auth/password`), in der Tabelle
  `login_challenges` nur als SHA-256, fünf Minuten gültig, fünf Versuche. Sie
  öffnet nichts außer dem einen Formular.
- **Gedrosselt wird je Konto, nicht je Challenge.** Wer das Passwort hat, kann
  beliebig viele Challenges öffnen; zehn falsche Codes je Viertelstunde und
  Konto sind die Grenze, sonst ließe sich die Million Codes durchprobieren.
  Dieselbe Grenze gilt für Abschalten und neue Wiederherstellungscodes — eine
  gestohlene Sitzung soll sich nicht zum Abschalten durchraten können.
- **Jeder Code gilt einmal.** Angenommen wird ein Schritt davor und danach (Uhren
  laufen auseinander), aber nie ein Schritt, der nicht neuer ist als der zuletzt
  angenommene (`users.totp_last_step`). Hochgesetzt wird in *einer* Anweisung
  mit der Bedingung im `WHERE`, ebenso das Verbrauchen eines
  Wiederherstellungscodes — zwei gleichzeitige Anfragen mit demselben Code
  kommen nicht beide durch.
- **Aktiv erst nach einem bestätigten Code.** Ein QR-Code, den nie jemand
  gescannt hat, sperrt niemanden aus; bis dahin liegt das Geheimnis in
  `totp_pending_secret`.
- **Abschalten verlangt einen Code** (oder einen Wiederherstellungscode), nicht
  bloß die Sitzung. Ohne beides bleibt nur der Operator.
- **Das Geheimnis liegt unversiegelt in der Datenbank.** Abgewogen, nicht
  vergessen: es zählt nur zusammen mit dem Passwort, und das liegt als
  Argon2id-Hash daneben. Wer einen Dump hat *und* das Passwort knackt, kommt
  durch — dagegen hülfe ein eigener Schlüssel in der Umgebung wie bei den
  DNS-Tokens, um den Preis einer weiteren Variable, ohne die nichts geht.
- **Wiederherstellungscodes** sind 50 Bit, `abcde-fghij`, gespeichert als
  SHA-256 (zufällig genug, dass es nichts zu raten gibt — wie bei den
  Einladungen). Beim Eintippen zählen Groß-/Kleinschreibung, Leerzeichen und
  Bindestrich nicht.
- **Der QR-Code entsteht im Browser** (`qrcode`, als SVG). Das Geheimnis geht
  an keinen fremden Dienst.
- **`set-password` lässt den zweiten Faktor, wie er ist.** Ein neues Passwort ist
  kein Grund, den Code abzuschalten — dafür gibt es `disable-2fa`.

## Anmeldung über OIDC (Pocket ID)

Neben Passwort und Google gibt es einen OpenID-Connect-Provider, geschrieben
und getestet für [Pocket ID](https://pocket-id.org) — Passkeys und sonst
nichts, also die Anmeldung, bei der kein Mitglied je ein Passwort tippt.
Authelia, Authentik oder Keycloak sprechen dasselbe.

```bash
WAVE_OIDC_ISSUER=https://id.example.com   # wie der Provider sich selbst nennt
WAVE_OIDC_CLIENT_ID=…
WAVE_OIDC_CLIENT_SECRET=…                  # weglassen für einen öffentlichen Client
WAVE_OIDC_NAME="Pocket ID"                 # steht auf dem Knopf; Vorgabe: Host des Issuers
```

In Pocket ID ist die Callback-URL `<WAVE_BASE_URL>/auth/oidc/callback`.

Was daran festliegt (`apps/control/src/auth/oidc.ts`):

- **Von Hand, nicht über arctic.** arctic holt sich Token über das globale
  `fetch`; hier ist das Netz ein Parameter, und der Test stellt einen eigenen
  Provider auf, der den PKCE-Verifier so prüft wie Pocket ID.
- **Geprüft wird alles, was sich prüfen lässt:** die Discovery muss den
  konfigurierten Issuer nennen, die Signatur des ID-Tokens gegen die JWKS
  (RS*, PS256, ES256/384, EdDSA — nie `none`, nie HMAC), dazu `iss`, `aud`,
  `azp` und `exp`. Die Spezifikation erlaubte, sich stattdessen auf TLS zum
  Token-Endpunkt zu verlassen; prüfen kostet einen Schlüsselabruf und lässt
  nichts zu diskutieren. Ein unbekanntes `kid` holt die JWKS einmal neu —
  so sieht eine Schlüsselrotation aus.
- **PKCE immer**, mit und ohne Secret.
- **Der Issuer ist Teil der Identität.** Gespeichert wird `oidc:<issuer>` als
  Provider: `sub` ist nur innerhalb eines Ausstellers eindeutig, und ein Wave,
  der den Provider wechselt, darf dessen Nutzer 42 nicht in das Konto des
  alten lassen. Der Preis: nach einem Wechsel des Issuers ist jeder Login
  zunächst ein neues Konto, und erst eine *bestätigte* Adresse verknüpft es
  wieder mit dem alten.
- **`https://` ist Pflicht**, außer auf Loopback.
- **Einladungen brauchen `email_verified`.** Pocket ID sagt das nur, wenn die
  Einstellung „Emails Verified“ es tut — im strengen Modus erst, wenn die Person
  den Bestätigungslink geklickt hat. Ohne das meldet man sich an, kann aber
  keine Einladung annehmen und wird nicht mit einem bestehenden Konto
  verknüpft. Das ist die Regel aus „Mehrere Benutzer“, nicht ein Fehler hier.
- **Ist der Provider nicht erreichbar**, antwortet `/auth/oidc/start` mit 502,
  statt in die Leere weiterzuleiten. Die Discovery wird beim ersten Login
  geholt, nicht beim Start — ein Control-Server startet auch, wenn Pocket ID
  gerade nicht da ist.

## Zertifikate

**Der Node macht den Schlüssel, der Server redet mit der CA.** Das ist die
ganze Form von D7, und sie ist so geschnitten, dass keine Seite den Schaden der
anderen anrichten kann: Ein Node erzeugt einen P-256-Schlüssel und einen CSR
und schickt nur den CSR; der Control-Server prüft die Namen darin, beantwortet
die dns-01-Challenge in der Zone des Waves und reicht die fertige Kette zurück.
**Kein privater Schlüssel verlässt je einen Node, und kein Node bekommt je ein
DNS-Token** — ein Token, das `_acme-challenge` schreiben darf, darf die ganze
Zone schreiben.

```bash
# Operator, einmal je Wave
bun apps/control/src/admin.ts set-dns-provider    <wave> <cloudflare|hetzner|ionos|inwx|manual>
bun apps/control/src/admin.ts dns-provider        <wave>
bun apps/control/src/admin.ts remove-dns-provider <wave>
bun apps/control/src/admin.ts certs               <wave>
bun apps/control/src/admin.ts allow-wildcard      <wave> <gerät>
bun apps/control/src/admin.ts deny-wildcard       <wave> <gerät>

# auf dem Gerät
wave cert [name…] [--wildcard] [--hook 'systemctl reload caddy']
wave certs
```

**Es gibt zwei Betriebsarten, und `manual` ist keine zweite Wahl.** Es gibt
hunderte DNS-Hoster; jeder implementierte Provider deckt genau einen davon ab,
und für den eigenen ist das erfahrungsgemäß genau dann keiner, wenn man ihn
braucht. Im manuellen Modus nennt der Server den Record und wartet, bis er in
der Zone steht — bei jedem Hoster, ohne Zugangsdaten, und ohne dass hier
vorher jemand etwas gebaut haben muss. Der Preis steht in derselben Zeile: die
Erneuerung braucht dann auch wieder einen Menschen. Ein Provider ist die
Bequemlichkeit, `manual` die Zusicherung, dass es überhaupt geht.

```
$ wave cert

This wave answers dns-01 by hand, so laptop.wave.example.com needs a record first:

  name   _acme-challenge.laptop.wave.example.com
  type   TXT
  value  0Zq8…

Waiting... Ctrl-C is safe: `wave cert` takes the same order up again.
```

Was daran festliegt:

- **Das Staging-Verzeichnis ist der Vorgabewert.** `WAVE_ACME_DIRECTORY` zeigt
  ohne Zutun auf Let's Encrypts Staging; die Produktion zu erreichen ist eine
  bewusste Zeile. Deren Rate Limits verbrennt ein Fehlversuch für eine Woche,
  und ein Testlauf oder ein frischer Container darf da nicht hineinlaufen.
- **Ohne `WAVE_DNS_SECRET` wird kein Token gespeichert.** Die Tokens liegen
  AES-256-GCM-versiegelt in `dns_credentials`; der Schlüssel steht in der
  Umgebung, so wie der Signaturschlüssel. Ein Datenbank-Dump ist sonst ein Satz
  Schlüssel zu fremden Domains — das ist der eine Wert hier, dessen Verlust
  jemanden seine Domain kostet und nicht seinen Wave. `set-dns-provider`
  verweigert deshalb, statt im Klartext abzulegen.
- **`set-dns-provider` probiert den Token sofort** (`verifyZoneAccess`): ein
  TXT-Record wird geschrieben und gleich wieder entfernt. Das ist zugleich die
  Domain-Verifikation aus D6 — im Provider-Modus *ist* Schreibzugriff der
  Besitznachweis, es gibt nichts anderes zu prüfen. Und es scheitert dort, wo
  jemand zusieht, statt später in einer Challenge, die nie gültig wird.
- **Vier Provider, und einer davon hat keinen Token.** cloudflare, hetzner und
  ionos legen eine Zeichenkette hin; INWX kennt nichts, was sich auf eine Zone
  einschränken ließe, also ist die versiegelte Zeichenkette dort JSON
  (`user`, `password`, optional `totpSecret` und `sandbox`). Die Spalte bleibt
  eine — was darin steht, ist Sache des Providers, und `parseInwxAccount()`
  sagt beim Lesen, was fehlt, statt es die API sagen zu lassen. Ein Sub-Account
  nur für diese Domain ist bei INWX die einzige Art, die Vollmacht zu
  verkleinern; das steht auch in der Abfrage von `set-dns-provider`.
- **IONOS gibt es zweimal.** Dieser Provider spricht *Hosting* DNS
  (`api.hosting.ionos.com`, Key `<prefix>.<secret>`), nicht IONOS Cloud DNS.
  Getrennte Produkte, getrennte APIs, und der Key des einen ergibt beim anderen
  401 — das ist das Erste, was man prüft.
- **IONOS legt Records mit `POST` an, nicht mit dem `PATCH` der Zone.** Der
  PATCH wäre Lesen-Ändern-Zurückschreiben, und genau dort verlieren sich zwei
  gleichzeitige Aufträge: ein Wildcard und sein Apex schreiben denselben
  Recordnamen mit verschiedenen Werten, und beide müssen gleichzeitig
  dastehen. `POST` hängt an, und die Zusicherung von `setTxt` bleibt eine
  Eigenschaft des Aufrufs statt einer Hoffnung. Gelesen wird der Wert bei IONOS
  übrigens **in Anführungszeichen** zurück, anders als bei den anderen dreien.
- **Beide Neuen bekommen 300 Sekunden TTL** statt der 60 der anderen. Das ist
  der Boden, den INWX erzwingt, und er kostet nichts: der Record lebt Minuten,
  und niemand liest ihn über einen Cache — sowohl die CA als auch unsere eigene
  Prüfung fragen die autoritativen Server der Zone.
- **INWX ist eine Sitzung, kein Header.** Anmelden, Cookie mitführen, und
  zwischen zwei Zertifikaten liegen Monate — deshalb meldet `withSession()`
  sich bei Code 2200 genau einmal neu an, statt die Erneuerung an einem
  abgelaufenen Cookie scheitern zu lassen. Der zweite Faktor gehört dazu: ein
  INWX-Konto ohne 2FA ist keines, auf dem eine Domain liegen sollte, also steht
  RFC 6238 im Provider. Zweimal derselbe Code in einem 30-Sekunden-Schritt wird
  abgelehnt, deshalb wartet der zweite Login den nächsten Schritt ab.
- **Der Zonen-Fund ist bei INWX derselbe Aufruf wie das Lesen.**
  `nameserver.info` scheitert für eine Domain, die dem Konto nicht gehört —
  nach den Records zu fragen *ist* also die Frage, ob die Zone unsere ist. Auf
  welchen Fehlercode das genau hinausläuft, wird bewusst nicht geprüft: der
  Kandidat gilt als daneben und die letzte Meldung wird mitgetragen, damit ein
  echter Fehlschlag am Ende trotzdem sagt, was er war.
- **Ein Gerät bekommt nur seinen eigenen Namen.** `checkNames()` vergleicht mit
  `<hostname>.<dns_suffix>` aus der Netmap, nicht mit dem, was das Gerät
  behauptet. Ein Platzhalter-Suffix unter `.internal` wird abgelehnt, bevor
  irgendetwas bestellt wird — er ist nicht delegierbar, also kann keine CA ihn
  validieren.
- **Der Wildcard ist die eine Ausnahme, und sie ist keine von der Regel,
  sondern davon, wer entscheidet.** `*.<suffix>` steht für *jeden* Namen im
  Wave — es gibt keinen Test, nach dem er „diesem Gerät gehört". Deshalb
  braucht es einen Operator, der es über dieses Gerät sagt
  (`admin.ts allow-wildcard <wave> <gerät>`, gespeichert als
  `nodes.wildcard_allowed`), und dann trägt das Zertifikat auch den Namen der
  Zone selbst: eine Maschine, die den Wildcard fährt, fährt auch den Apex, und
  ihn zu verweigern erzwänge nur ein zweites Zertifikat mit derselben
  Reichweite. `wave cert --wildcard` fragt danach. Wer den Schlüssel hat, kann
  jeder Name im Wave sein — genau das steht auch in der Ausgabe von
  `allow-wildcard`, und `admin.ts devices` zeigt die Freigabe als `[wildcard]`.
- **Ein Wildcard *unterhalb* des Waves bleibt abgelehnt**, auch mit Freigabe:
  `*.sub.wave.example.com` deckte Namen ab, die gar nicht in diesem Wave
  liegen, und das ist nicht, was die Freigabe gewährt.
- **Wildcard heißt geteilter Schlüssel — deshalb bleibt per Node die
  Empfehlung** (D7). Sinnvoll ist er dort, wo *eine* Maschine mehrere Namen
  bedient, etwa ein Reverse Proxy: dann wird nichts verteilt, und die
  Gerätenamen landen nicht einzeln in den CT-Logs. Auf mehrere Maschinen
  verteilt ist er das Gegenteil von dem, wofür dieser Aufbau gebaut ist.
- **Der dns-01-Record eines Wildcards sitzt am Namen der Zone**, ohne Stern:
  für `*.wave.example.com` heißt er `_acme-challenge.wave.example.com`. Fragt
  ein Auftrag nach Wildcard *und* Apex, ergibt das zwei Autorisierungen mit
  demselben Recordnamen und verschiedenen Werten — beide müssen gleichzeitig
  dastehen. Genau deshalb *fügt* `setTxt` hinzu, statt zu ersetzen, und
  `removeTxt` löscht nur den Eintrag mit seinem eigenen Wert. Im manuellen
  Modus heißt das zwei TXT-Records mit demselben Namen; `wave cert` druckt
  beide.
- **Der CSR wird gelesen *und* seine Selbstsignatur geprüft.** Ohne die wäre
  ein CSR kein Besitznachweis, und ein Gerät könnte einen um den Schlüssel
  eines anderen herumgebauten Antrag einreichen. Zusätzlich müssen das Feld
  `names` und die SANs im CSR übereinstimmen: geprüft wird das Feld, ausgestellt
  wird nach dem CSR.
- **`wave cert` nennt seinen Wave mit `--control`, nicht als Positional.** Das
  Positional ist dort der *Name*; ihn an die Wave-Auswahl zu geben suchte einen
  Wave namens `laptop.wave.example.com` und fände keinen. Auf einem Gerät in
  genau einem Wave braucht es beides nicht.
- **Ein offener Auftrag je Gerät.** Jede Bestellung zählt gegen das Rate Limit
  der Domain; ein Node, der in einer Schleife wiederholt, gäbe eine Woche in
  einer Minute aus. **Ein wartender Auftrag wird dabei zurückgegeben, nicht
  ersetzt**: erneut zu fragen ist genau die Art, wie jemand sagt „ich habe den
  Record jetzt angelegt", und ein zweiter Auftrag hieße ein zweiter Record für
  nichts. Nur andere Namen fangen von vorn an.
- **Ein wartender Auftrag lebt in seiner Zeile, nicht im Speicher.** Challenge,
  Record, Challenge-URL und die Order-URL der CA stehen in
  `certificate_orders`; ein Neustart dazwischen verliert also nichts, und
  niemand muss einen Timer am Leben halten. Weitergetrieben wird er von dem,
  der nach ihm fragt — der Node pollt ohnehin.
- **Nachgesehen wird an den autoritativen Nameservern der Zone, nie über einen
  Resolver.** Der manuelle Modus fragt per Definition, bevor der Record
  existiert, und ein Resolver merkt sich dieses Nein so lange, wie die SOA der
  Zone sagt. Bei `rolenz-digital.de` sind das 3600 Sekunden: eine einzige zu
  frühe Frage, und der Record bliebe eine Stunde nach seiner Erzeugung
  unsichtbar — ein Fehlerbild, das wie ein Tippfehler aussieht. Ein
  autoritativer Server hat keinen Cache, den man vergiften könnte. Gesucht wird
  die Zone dabei von unten nach oben, wie bei den Providern.
- **Und nur mit dem richtigen Wert geht es weiter.** Steht ein falscher Wert
  dort, bleibt der Auftrag stehen, statt die CA hinschauen zu lassen: eine
  Autorisierung hat wenige Versuche, und die auf einen Tippfehler zu verbrennen
  kostet den ganzen Auftrag.
- **Der TXT-Record wird immer wieder abgeräumt**, auch wenn der Auftrag
  scheitert (`finally`). Ein misslungenes Aufräumen ist dabei nicht fatal: ein
  liegengebliebener Record ist unsauber, ein Fehler dabei, der eine gelungene
  Ausstellung verschluckt, wäre schlimmer.
- **Wann erneuert wird, entscheidet der Server**, weil nur er mit der CA
  spricht: ARI-Fenster, wenn die CA eines nennt — und darin ein *zufälliger*
  Punkt, denn der Sinn des Fensters ist, dass nicht alle zu seinem Beginn
  kommen —, sonst zwei Drittel der Laufzeit. Der Daemon sieht stündlich nach.
  Scheitert eine Erneuerung, bleibt das Datum in der Vergangenheit und der
  nächste Durchgang versucht es wieder. Ein *später* geändertes ARI-Fenster
  (Massenrückruf) erreicht ein Gerät erst mit der nächsten Ausstellung — das
  ist die bekannte Lücke.
- **Im manuellen Modus räumt niemand den Record weg.** Der Server hat nie die
  Mittel dazu gehabt; `wave certs` und `admin.ts certs` sagen, welcher Record zu
  welchem Auftrag gehört, und nach der Ausstellung darf er weg.
- **Eine Erneuerung, die einen Menschen braucht, wartet nicht.** Der Daemon
  meldet den fehlenden Record ins Log der Anmeldung und geht weiter; das
  Erneuerungsdatum bleibt in der Vergangenheit, der nächste Durchgang fragt
  wieder, und der Auftrag bei der CA bleibt so lange offen, wie die
  Autorisierung lebt. Eine Stunde in einem Ticker zu hängen wäre das Gegenteil
  von unbeaufsichtigt.
- **Jede Erneuerung erzeugt einen neuen Schlüssel.** Zertifikate sind billig;
  ein Schlüssel, der über Jahre und drei Erneuerungen auf der Platte liegt, ist
  genau das, was dieser Aufbau vermeiden soll.
- **Die Dateien liegen neben der State-Datei**
  (`<dir>/certs/<name>/{key.pem,fullchain.pem}`, ein Wildcard unter
  `wildcard.<suffix>` — ein `*` ist unter Unix ein gewöhnliches Zeichen, unter
  Windows ein verbotenes, und ein Verzeichnisname, der ein Glob ist, ist eine
  Falle für alles, was ihn je anfasst), damit sie derselben Teilung folgen wie
  die Schlüssel: systemweit unter dem Daemon, im Benutzerverzeichnis
  ohne ihn. `key.pem` bekommt 0600, die Kette 0644 — sie ist öffentlich, und
  ein Dienst muss sie lesen können.
- **Der Hook läuft durch die Shell**, mit `WAVE_CERT` und `WAVE_CERT_KEY` in
  der Umgebung. Was dort steht, ist `systemctl reload caddy`; das in einen
  Argumentvektor zu zerlegen zu verlangen, kaufte nichts. Ein Fehlschlag wird
  geloggt und nicht geworfen: das Zertifikat liegt dann schon gültig auf der
  Platte, und eine Erneuerung darf nicht wie eine ausgebliebene aussehen.

Drei Dinge, die beim Nachbauen Zeit kosten würden:

- **DER und PKCS#10 stehen selbst im Repo** (`packages/crypto/src/der.ts`,
  `x509.ts`), statt `@peculiar/x509` zu nehmen. Der Grund ist derselbe wie beim
  Tray: der Client wird mit `bun build --compile` übersetzt, und eine
  Bibliothek, die einen DI-Container und Laufzeitnamen mitbringt, ist genau die
  Sorte Abhängigkeit, die das still zerlegt. Beide Seiten brauchen den Code
  ohnehin — der Node schreibt den CSR, der Server liest ihn.
- **JWS will die Signatur roh, nicht als DER.** `createSign().sign()` liefert
  unter node:crypto die DER-Hülle; ES256 verlangt `r‖s` am Stück
  (`dsaEncoding: "ieee-p1363"`). Mit der Vorgabe antwortet jede CA mit
  „malformed signature", und der Fehler zeigt nirgends auf die Ursache.
- **Der TXT-Wert ist der SHA-256 der KeyAuthorization, nicht sie selbst** —
  das ist der Unterschied zwischen dns-01 und http-01. Und der Thumbprint
  darin ist das kanonische JWK *ohne ein einziges Leerzeichen*, in
  lexikographischer Reihenfolge. Beides ergibt sonst eine Challenge, die
  pending bleibt, bis sie abläuft.

**Die Zone härten:** ein CAA-Record, der nur Let's Encrypt, nur dns-01 und nur
unseren Account zulässt:

```
wave.example.com. CAA 0 issue "letsencrypt.org; validationmethods=dns-01; accounturi=<account_url>"
```

Die `account_url` steht in `acme_accounts.account_url`. Und: **jeder
ausgestellte Name landet dauerhaft in den öffentlichen CT-Logs** (crt.sh). Wer
`laptop-von-robin.wave.example.com` ausstellt, veröffentlicht das
unwiderruflich — deshalb wird nur auf Zuruf ausgestellt und nicht für jedes
Gerät automatisch.

**Geprüft ist das gegen eine nachgebaute CA** (`apps/control/test/fake-ca.ts`),
die jede JWS-Signatur verifiziert, jede Nonce verbraucht und eine Challenge nur
gelten lässt, wenn der Record wirklich in der (ebenfalls nachgebauten) Zone
steht. Was fehlt, ist ein Lauf gegen das echte Staging-Verzeichnis mit einer
echten Domain; die E2E-Skripte decken Zertifikate nicht ab, weil dafür eine
erreichbare Zone nötig wäre. Eine Oberfläche gibt es dafür ebenfalls noch
nicht — Provider und Zertifikate stehen nur auf der Shell des Servers.

## Selbstaktualisierung

**Der Daemon aktualisiert sich selbst, aus signierten Releases, über den
Control-Server** (D13, M13). Vertraut wird allein der Ed25519-Signatur mit
einem Schlüssel aus `RELEASE_PUBLIC_KEYS` (`packages/crypto/src/release.ts`),
nie dem Weg. Der Control-Server ist eine Quelle, keine Autorität: er **signiert
nie** — könnte er es, liefe auf jedem Gerät seines Waves Code als root, den
sein Betreiber geschrieben hat.

```bash
wave version                         # Build, Plattform, Stand des Dienstes
wave update                          # das beste Angebot jetzt statt nach dem Versatz
wave update --channel insiders       # Wunschkanal; "server" gibt die Wahl zurück
wave update --auto-update off        # nur anzeigen, nie selbst installieren
sudo wave install --channel … --auto-update on|off
```

Am Server: `WAVE_UPDATE_CHANNELS` (Liste, erster Eintrag ist die Vorgabe,
ungesetzt `stable`; die Kanäle heißen `stable`, `insiders`, `develop`),
`WAVE_UPDATE_REPO`, `WAVE_GITHUB_TOKEN` (Fine-grained, nur dieses Repository,
nur Contents: read). Ohne Token wird nichts angeboten. Im Release-Workflow:
das Secret `WAVE_RELEASE_SIGNING_KEY`; ohne es scheitert der Release, statt ein
Manifest zu schreiben, das kein Gerät annimmt.

Was daran festliegt:

- **Kanal und Version stehen *im* signierten Manifest.** Signierte Hashes allein
  ließen einen Server einem Gerät auf `stable` ein echtes `develop`-Build
  unterschieben. Das Gerät prüft deshalb, dass der Kanal des Manifests zu dem
  passt, den der Server ihm zugewiesen hat (`channelAccepts`). Signiert heißt
  auch hier: `looseObject`, kein `.default()` — dieselbe Regel wie bei der
  Netzkarte.
- **Die Kanäle gehören dem Server, die Wahl darin dem Gerät.** Das `hello`
  trägt einen Wunsch; steht er nicht in `WAVE_UPDATE_CHANNELS`, gilt der erste
  Eintrag. Ein Gerät in mehreren Waves hört alle Server und nimmt das höchste
  gültige Angebot — welchem Betreiber es glaubt, muss es nie entscheiden.
- **Kein Downgrade, nie.** Ein altes Release mit gültiger Signatur ist genau
  die Art, wie ein Server eine geschlossene Lücke zurückbrächte.
- **Nur der Daemon installiert, und nur die installierte Kopie.** CLI und Tray
  dürfen über IPC ein Update *anstoßen*, aber nie sagen, welches — sonst ließe
  jedes Mitglied der Socket-Gruppe root ein Binary seiner Wahl ausführen.
  `updateBlocker()` lässt nur `defaultBinaryPath()` zu: was woanders liegt,
  gehört einem Paketmanager oder einem entpackten Archiv, und keines davon
  startet ein Dienstverwalter neu.
- **Der Tausch ist nur Umbenennen.** Jede Datei wird zu `.old`, die neue
  rückt nach. Das geht über laufende Dateien auf allen drei Plattformen —
  Windows verbietet das Überschreiben einer laufenden `.exe`, nicht das
  Umbenennen. Gestaged wird deshalb **neben** dem Binary
  (`.wave-update-<version>`), nicht in `/tmp`: über Dateisystemgrenzen gibt es
  kein Umbenennen.
- **`pending` wird geschrieben, bevor sich die erste Datei bewegt**, und
  `broken`, bevor die alte zurückkommt. Ein Stromausfall mittendrin findet
  beim nächsten Start in beiden Fällen den Weg.
- **Die Probezeit läuft an der Uhr, nicht an einem Timer.** Die neue Fassung hat
  fünf Minuten für eine Control-Verbindung; `Updater.init()` prüft das vor
  jedem Tunnel. Eine Fassung, die immer wieder abstürzt, kommt bei jedem
  Neustart dort vorbei und rollt zurück, sobald die Frist um ist. Eine Fassung,
  die abstürzt, bevor sie den Zustand liest, erreicht das nicht — das ist die
  bekannte Lücke.
- **Neu gestartet wird durch Beenden.** systemd (`Restart=always`) und launchd
  (`KeepAlive`) starten jeden Ausgang neu. Der Aufgabenplaner nicht: unter
  Windows startet ein losgelöster `schtasks /run` den Task fünf Sekunden
  später, und der Fehlerstatus ist der Rückfall über `RestartOnFailure` (eine
  Minute). Ungeprüft, wie alles dort.
- **Das Tray sagt ein Update an drei Stellen, alle aus `updateNotice()`:**
  Tooltip, Menü (mit „Install update now", außer wo diese Kopie sich nicht
  selbst aktualisiert) und die Unterzeile der Karte. Gewählt, weil alle drei
  Plattformen sie schon zeichnen — es ist eine reine View-Änderung ohne
  Toolkit-Code.
- **Und einmal je Version als Dialog mit „Install now"** (`prompt.ts`):
  unter Linux eine Desktop-Benachrichtigung mit Aktion über D-Bus (GNOME und
  KDE zeichnen einen Knopf, mako führt beim Klick die Standardaktion aus — die
  ist dieselbe), unter macOS `osascript`, unter Windows ein kleines
  WinForms-Fenster über PowerShell. Die beiden Letzten laufen **als eigener Prozess**, nicht über
  die FFI des Trays: ein modaler Dialog im Tray-Thread hielte Icon und
  Steuersocket an, solange er dasteht, und ein Angebot steht womöglich
  stundenlang. Der Text geht **über die Umgebung** hinein, nie ins Skript —
  er trägt eine Version, die von einem Server kam. Welche Version installiert
  wird, entscheidet auch hier der Daemon; der Dialog sagt nur „jetzt".
  Geprüft ist unter Linux, dass der Benachrichtigungsdienst die Aktionen
  annimmt; macOS und Windows nur als Befehlszeilen.
- **Der Dialog trägt immer das wave-Zeichen**, nie ein Systemsymbol — er
  fragt, ob als root etwas installiert werden darf, und soll auf einen Blick
  sagen, wessen Frage das ist. Keiner der drei nimmt Pixel, also schreibt
  `promptIcon()` das Zeichen einmal je Tray als PNG und `.ico` in ein eigenes
  `mkdtemp`-Verzeichnis (0700, kein vorhersagbarer Name in einem geteilten
  `/tmp`), und der Pfad geht wie der Text über die Umgebung hinein. Drei
  Dinge daran: `display dialog … with icon` nimmt ein PNG (unter macOS 26
  nachgesehen), verweigert aber **den ganzen Dialog**, wenn die Datei fehlt —
  deshalb fällt er ohne Datei auf `note` zurück statt auf nichts. Eine
  MessageBox kann kein eigenes Symbol, also ist es unter Windows ein Formular,
  und weil das dort ungefahren ist, zeigt sein `catch` die alte MessageBox.
  Unter Linux geht die Datei als `file://`-URI in `app_icon`.
- **Das Tray beendet sich, wenn der Daemon eine andere Version meldet**
  (`Status.daemon.version`), mit Status 75 — Neustart bringt die neue Fassung.
  Es ist dieselbe Datei, aber ein eigener Prozess, und liefe sonst mit altem
  Code weiter.
- **Ein lokaler Build heißt `X.Y.Z+local`.** Build-Metadaten zählen beim
  Vergleich nicht; als Vorab-Suffix sähe jeder lokale Build älter aus als das
  Release, aus dem er stammt, und würde darauf „aktualisiert".
- **Der Server ist kein offener Proxy.** `/v1/update/…` reicht nur Archive aus
  einem gerade angebotenen Manifest, nur an angemeldete Knoten, und folgt der
  Umleitung auf den Speicher von Hand und **ohne Token**.

## Mehrere Waves auf einem Gerät

Ein Gerät kann in mehreren Waves gleichzeitig sein — verschiedene Server,
verschiedene Benutzer. Der State hält dafür eine Liste von **Anmeldungen**
(`apps/client/src/state.ts`), jede mit eigenen Schlüsseln, eigener Node-ID,
eigenem gepinnten Signaturschlüssel, eigenem Interface und eigenem UDP-Port:
`wave0`/41641, `wave1`/41642 und so weiter. Der Daemon hält je Anmeldung einen
Tunnel; `wave up` ohne Adresse bringt alle mit `autoStart`,
`wave logout <url>` verlässt genau eine.

**Der Control-Server ist die Identität — es gibt keinen zweiten Namen.** Jedes
Kommando, das eine Anmeldung meint, nennt ihre URL: `wave up <url>`,
`wave down <url>`, `wave logout <url>`. Im IPC-Protokoll heißt das Feld deshalb
`controlUrl` und nicht `profile`, und `waveLabel()` in `@wave/ipc` kürzt die
URL fürs Anzeigen auf Host und Port — ein Etikett, nie ein Schlüssel. Zwei
Identitäten nebeneinander zu führen war genau der Fehler, der weiter unten
beschrieben ist.

**`wave install` kennt keinen Server.** Es richtet die Maschine ein — Dienst,
Tray, Autostart — und sonst nichts; es gibt keine Datei, in der „der" Server
stünde. Beigetreten wird ausschließlich mit `wave login <control-server-url>`,
so oft man mag. Das war einmal anders, und der Umweg hat gekostet: der Daemon
wurde mit einem `WAVE_CONTROL_URL` installiert, `wave up` legte daraus
stillschweigend eine erste Anmeldung an, und die Adresse stand danach an zwei
Stellen — in `/etc/wave/wave.env` und in der Anmeldung. Zog der Server um,
änderte das Bearbeiten der Env-Datei nichts, weil der Daemon aus `controlUrl`
startet. Ein Gerät, das plötzlich in einem Wave war, den niemand genannt hatte,
kam aus derselben Ecke.

Daraus folgen drei Regeln, die der Code jetzt einhält:

- **`up` tritt nie bei.** Ohne Anmeldung sagt es, dass `wave login` der Weg
  ist, und legt nichts an — weder in der CLI noch im Daemon.
- **Eine unbekannte URL ist immer ein weiterer Wave, nie ein Ersatz.** Damit
  gibt es den Fall „Server umgezogen" nicht mehr als Automatik: wechselt eine
  Adresse, ist das eine neue Anmeldung, und die alte wird mit
  `wave logout <alte-url>` los. Das kostet eine erneute Freigabe und ist der
  Preis dafür, dass nichts mehr rät. (Sauberer wäre, den Umzug am gepinnten
  Signaturschlüssel zu erkennen — der identifiziert den Control-Server
  ohnehin. Das ist offen.)
- **`login` prüft die Adresse, bevor sie im Zustand landet.** Der nackte Host
  ist das, was `wave profiles` druckt, also auch das, was man zurücktippt —
  wörtlich gespeichert wird daraus eine Anmeldung, deren `controlUrl` keine URL
  ist: sie belegt einen Interface-Platz, scheitert für immer an „Invalid URL"
  und steht neben der echten in der Liste. `normaliseControlUrl()` ergänzt
  fehlendes `https://`, wirft den Schrägstrich am Ende weg und lehnt alles ab,
  was danach keine http(s)-URL ist. Am 16.09.2026 einmal so passiert, mit zwei
  Leichen im Zustand.
- **Eine Verweigerung muss beim Aufrufer ankommen, nicht nur im Journal.** Der
  Daemon protokollierte „not in a wave at …" und antwortete trotzdem `ok`; die
  CLI druckte darauf `left …` und endete mit 0 — ein Logout, das nichts entfernt
  hatte, sah aus wie Erfolg. `up`, `down` und `logout` geben deshalb eine
  Meldung zurück statt `void`, und der Handler macht daraus ein `error`.
- **Jeder „Best effort"-Netzaufruf braucht eine Schranke.** `logout` sagt dem
  Server Bescheid und räumt lokal auf; ohne Zeitlimit hing der unerreichbare
  Server länger als das 20-s-Limit der CLI, und ein lokal gelungenes Logout
  meldete „the daemon did not answer". Fünf Sekunden reichen, danach wird
  lokal aufgeräumt.
- **Was `wave profiles` druckt, muss `wave logout` auch annehmen.** Die erste
  Spalte ist das kurze Etikett, und genau das tippt man zurück — die volle URL
  zu verlangen hieße, die eben ausgegebene Zeichenkette abzulehnen.
  `matchProfiles()` nimmt deshalb beides und dazu den nackten Host, in dieser
  Reihenfolge. Bei mehreren Treffern **rät es nicht**, sondern nennt sie: zwei
  Waves auf demselben Host unter verschiedenen Ports gibt es, und den falschen
  Tunnel abzuräumen wirft Schlüssel weg.
- **Alle Kommandos lesen dieselbe Quelle.** `wave profiles` fragt den Daemon,
  wenn einer läuft, und liest die Datei nur sonst. Vorher las es immer die
  Datei — und ein unprivilegierter Aufruf sah damit seinen eigenen, leeren
  Zustand statt dem, was die Maschine wirklich fährt, während `wave status`
  daneben die Wahrheit zeigte.

Das Tray hängt an derselben Liste: es zeigt jede Anmeldung mit ihrem Server,
ihren Maschinen und einem eigenen Schalter. Ohne Anmeldung sagt es das und
nennt `wave login` — einen „Connect"-Knopf bietet es nur, wenn es den Daemon
gar nicht erst fragen konnte, denn das ist etwas anderes als „nirgends
angemeldet".

Die alte Ein-Enrolment-Datei wird beim Lesen gefaltet (`loadProfiles()`), damit
ein bestehendes Gerät seine Schlüssel behält.

- **Adressen dürfen sich nicht überschneiden.** Der Server gibt jedem Wave ein
  `/16` aus `10.64.0.0/10` (siehe D5). Zwei unabhängige Server wissen nichts
  voneinander, deshalb `WAVE_IPV4_CONTAINER`. Bleibt trotzdem eine
  Überschneidung, **verweigert der Client den zweiten Wave**
  (`apps/client/src/overlap.ts`) und nennt beide, statt eine Route still zu
  überschreiben — der laufende Tunnel bleibt oben.
- **Nie in `100.64.0.0/10` hinein adressieren.** Der Bereich ist verlockend
  (andere Mesh-VPNs nehmen ihn, Heimnetze nicht), aber wo ein solches läuft,
  verwirft es unter Umständen Pakete daraus, die auf einem fremden Interface
  ankommen. Ein Wave darin
  verliert IPv4 in Antwortrichtung und behält IPv6 — ein Fehlerbild, das nach
  allem aussieht außer nach dem Adressplan. Am 14.09.2026 einmal durchgemacht:
  Migration 0003 hinein, 0004 wieder heraus.
- **Je Tunnel ein WireGuard-UAPI-Socket.** Der Pfad in `--wg-socket` benennt
  nicht einen Socket, sondern das Verzeichnis: `wave1` bekommt
  `<dir>/wave1.sock`. Teilen sich zwei Tunnel einen, redet der zweite mit dem
  Gerät des ersten und sein Interface entsteht nie.
- **Je Tunnel ein Resolver.** Unter Linux hat jeder Wave eine eigene
  Tunneladresse, Port 53 ist auf allen frei. Unter macOS teilen sie sich
  Loopback, deshalb `resolverEndpoint()` statt `resolverAddress()`: ab 5354
  aufwärts, und `/etc/resolver/<domain>` bekommt eine `port`-Zeile dazu.
- **Der Suchpfad addiert sich.** Jede Wave-Zone ist auf ihrem Interface eine
  Search-Domain, ein nackter Name wird also in jedem Wave probiert und die erste
  Antwort gewinnt. Bei gleichnamigen Knoten in zwei Waves ist das mehrdeutig —
  eine Eigenschaft, keine Panne.
- **Der Status ist eine Liste.** `Status` im IPC-Protokoll trägt
  `profiles: ProfileStatus[]`, je Eintrag mit seiner `controlUrl` als Schlüssel;
  ein alter `wave` gegen einen neuen `waved`
  scheitert sichtbar am Schema, statt still das falsche anzuzeigen.

## Mehrere Benutzer in einem Wave

Ein Wave ist ein Netz mehrerer Menschen, nicht eines Kontos. `wave_members`
hält je Mitglied eine Rolle — `owner`, `admin`, `member` —, und **alle Geräte
aller Mitglieder sehen sich gegenseitig**: `buildNetmap()` fragt den Wave, nicht
den Benutzer. Damit ist offene Frage 5 aus `docs/PLAN.md` mit „voller Mesh"
beantwortet; ACLs bleiben M7.

Hineingekommen wird auf zwei Wegen, und beide enden in derselben Tabelle:

```bash
# Operator auf der Shell des Servers
bun apps/control/src/admin.ts members       <wave>
bun apps/control/src/admin.ts add-member    <wave> <email> [admin|member]
bun apps/control/src/admin.ts remove-member <wave> <email>
bun apps/control/src/admin.ts invite        <wave> <email> [admin|member]
bun apps/control/src/admin.ts revoke-invite <wave> <email>
bun apps/control/src/admin.ts devices       <wave>
bun apps/control/src/admin.ts remove-device <wave> <hostname|node-id>
bun apps/control/src/admin.ts set-domain    <wave> <domain>
bun apps/control/src/admin.ts delete-wave   <wave>
```

`<wave>` ist Name, Id oder die Adresse des Eigentümers — bei mehreren Treffern
nennt `resolveWave()` sie, statt einen zu nehmen. Im Alltag reicht die
Oberfläche: die Personenliste steht in der Wave-Karte neben den Geräten, mit
Einladungsformular und je Zeile einem Knopf zum Entfernen — und die Geräteliste
darüber trägt denselben Knopf, sichtbar nur für Eigentümer und Admins.

Was daran nicht verhandelbar ist:

- **Eine Einladung gehört zu einer Adresse.** Ein Link, den jeder einlösen kann,
  wäre eine Registrierungsseite mit Umweg — und die gibt es hier absichtlich
  nicht. `acceptInvite()` prüft die Adresse *und* dass der Anmeldedienst sie
  bestätigt: sonst könnte sich bei einem schlampigen Provider jemand unter
  fremder Adresse anmelden und den Platz nehmen. Dieselbe Lücke, wegen der
  Konten nie über unverifizierte Adressen verknüpft werden.
- **Der Token ist das Geheimnis, gespeichert wird nur sein SHA-256.** 32
  Zufallsbytes, kein Argon2id: bei der Entropie gibt es nichts zu raten, und
  der Vergleich läuft bei jedem Klick. Der Link ist deshalb **einmal** sichtbar,
  auf der Seite direkt nach dem Anlegen; verloren heißt neu einladen. Eine
  zweite Einladung für dieselbe Adresse zieht die erste zurück — zwei gültige
  Links für einen Platz wären das Gegenteil von Zurückziehen.
- **Eine wartende Einladung verhindert den eigenen Wave.** `ensureWaveForUser()`
  legt nichts an, wenn für die Adresse eine Einladung offen ist. Sonst
  entschiede die Reihenfolge zweier Klicks: wer sich anmeldet, bevor er den Link
  öffnet, hätte hinterher zwei Waves, einen davon hat niemand bestellt — und
  sein nächstes Gerät müsste gefragt werden, in welchen es gehört. `/api/me`
  liefert die offenen Einladungen deshalb mit, damit die leere Übersicht sagen
  kann, warum sie leer ist.
- **Ein Gerät gehört zu genau einem Wave, und bei mehreren fragt der Server.**
  `approveRequest()` nimmt bei einer Mitgliedschaft die eine (der Normalfall,
  und der, den die E2E-Skripte gehen) und legt bei mehreren die Auswahl in den
  Browser — dort sitzt der Mensch, der es weiß. Eine unbekannte Wave-Id wird
  **erneut gefragt**, nicht mit der ersten beantwortet: ein altes Formular darf
  kein Gerät irgendwohin legen. Ohne Frontend ist das Formular ein schlichtes
  auf `/machine/authorize`, mit Frontend die Seite `/devices/choose` — und
  zwar **immer**, auch bei genau einer Wave.
- **Das Öffnen des Links ist nicht die Freigabe, das Absenden ist es.** Der
  `GET /machine/authorize` zeigt nur; aufgenommen wird im POST. Das war lange
  andersherum, mit der Begründung, die Request-Id sei unerratbar und habe im
  eigenen Terminal gestanden. Die Begründung zeigt in die falsche Richtung:
  unerratbar ist die Id für *Dritte*, aber sie ist nicht das Geheimnis des
  Nutzers — ein Angreifer bekommt eine, indem er `wave login` gegen diesen
  Server laufen lässt, wofür es weder Konto noch Einladung braucht. Danach
  genügt es, ein angemeldetes Mitglied auf den Link zu locken: `SameSite=Lax`
  schickt das Sitzungscookie bei einer Top-Level-**GET**-Navigation mit,
  anders als beim Cross-Site-POST, auf dem die Wave-Formulare ruhen. Am
  23.09.2026 nachgebaut — ein fremdes Gerät bekam `10.64.0.1` im Wave des
  Opfers. Die eine Klick-Reibung, die eingespart werden sollte, ist genau das,
  was den Schritt trägt; der Test dazu steht in
  `apps/control/test/machine-approval.test.ts`. Für die E2E-Skripte heißt das
  `approve_device` in `test/e2e/lib.sh` statt eines `curl` auf den Link.
- **Entfernen nimmt die Geräte mit.** Bliebe der Knoten stehen, behielte ein
  Ausgeschiedener eine signierte Netmap, seine Adresse und einen Peer-Eintrag
  auf jedem fremden WireGuard-Interface. `removeMember()` löscht deshalb die
  Knoten des Mitglieds in diesem Wave, zählt `netmapVersion` hoch und der
  Handler schiebt danach — erst das entfernt ihn aus den Netzkarten der anderen.
- **Ein einzelnes Gerät geht auch allein hinaus.** `removeNode()` ist der
  kleinere der beiden Schnitte, und wer Mitglieder verwalten darf, darf ihn
  führen: für die Maschine, die verloren, verkauft oder irgendwo stehen
  geblieben ist, gibt es `wave logout` nicht mehr — genau sie ist die, auf der
  niemand mehr etwas ausführen kann. Drei Dinge daran:
  - **Die Wave steht in der Bedingung, nicht nur die Node-Id.** Ein fremdes
    Gerät ist über den eigenen Wave nicht erreichbar, und ein altes Formular
    greift nicht hinüber. Es gibt nicht und schon entfernt sind dieselbe
    Antwort (404), aus demselben Grund wie beim Wave, in dem man nicht ist.
  - **Das entfernte Gerät wird getrennt, nicht bloß vergessen.**
    `NetmapHub.disconnect()` schickt ihm `{ type: "logout", reason:
    "node-removed" }` und schließt mit 4404. Ohne das bliebe der Socket oben:
    es antwortete weiter auf Heartbeats, stünde in derselben Liste, aus der es
    eben entfernt wurde, noch als verbunden, und säße auf der letzten Netzkarte
    — während alle Peers es längst fallen gelassen haben.
  - **Von der Shell entfernt merkt es der Heartbeat.** `admin.ts remove-device`
    läuft in einem anderen Prozess und hat keinen Hub. Deshalb meldet das
    `lastSeenAt`-Update im `ping`-Zweig, ob es überhaupt noch eine Zeile
    getroffen hat; null Zeilen heißt dasselbe Logout und derselbe Close. Das
    ist auch die einzige Stelle, an der es auffallen kann.
- **Der Eigentümer bleibt.** Ein Wave ohne ihn wäre nicht administrierbar; die
  Übergabe ist ein eigener Schritt und fehlt noch. Ein `admin` darf Mitglieder
  entfernen, über andere Admins entscheidet nur der Eigentümer.
- **Den Wave löschen darf nur der Eigentümer, und nur mit getipptem Namen.**
  Jeder andere Schnitt ist umkehrbar — wer entfernt wurde, wird wieder
  aufgenommen. Dieser nicht: jedes Gerät verliert seine Anmeldung, die Adressen
  fallen zurück, und der Suffix ist wieder frei. Deshalb ist es weder ein
  Admin-Recht noch ein Knopf: `deleteWave()` löscht nur die Zeile in `waves`,
  den Rest nehmen die `on delete cascade`-Fremdschlüssel von `wave_members`,
  `wave_invites` und `nodes` mit. Was die Datenbank nicht kann, ist den Geräten
  Bescheid sagen — deshalb gibt `deleteWave()` die Node-Ids zurück und die
  Route trennt jede Verbindung einzeln. **Ein `broadcast()` danach gibt es
  nicht**: eine Netzkarte gehört zu einem Wave, und den gibt es nicht mehr.
- **Wer nicht Mitglied ist, bekommt 404, nicht 403.** Für Mitgliederliste,
  Einladungen und Knoten gleich: wer in welchem Wave ist, ist nicht öffentlich.
- **Die Formulare sind gewöhnliche POSTs an den Control-Server, ohne
  JavaScript.** Was sie schützt, ist `SameSite=Lax` am Sitzungscookie: ein
  fremdes Formular kommt ohne Sitzung an und wird als unangemeldet abgewiesen.
  Deshalb dürfen diese Routen nie auf GET umgestellt werden.
- **Ein Konto legt nur der Token an.** `/invite/<token>/claim` setzt ein
  Passwort für die eingeladene Adresse — aber **nur, wenn es zu ihr noch kein
  Konto gibt**. Sonst könnte jeder, der einladen darf, ein fremdes Konto
  übernehmen, indem er dessen Adresse einlädt.

## Wer wen erreicht (ACLs, M7)

**Ohne Policy sieht jedes Gerät jedes andere** — der volle Mesh aus D9, und
weiterhin die Vorgabe. Mit einer Policy ist nichts erlaubt, was keine Regel
erlaubt. Die Policy ist ein JSON-Dokument je Wave (`acl_policies`), Tags hängen
am Gerät (`nodes.tags`):

```bash
bun apps/control/src/admin.ts tag        <wave> <gerät> tag:nas
bun apps/control/src/admin.ts untag      <wave> <gerät> [tag:…]
bun apps/control/src/admin.ts set-acl    <wave> policy.json    # oder - für stdin
bun apps/control/src/admin.ts acl        <wave>                # Policy und wer wen erreicht
bun apps/control/src/admin.ts remove-acl <wave>
bun apps/control/src/admin.ts audit      <wave> [--limit N]    # wer was wann geändert hat
```

Im Browser steht dasselbe auf `/waves/<id>/access`, verlinkt aus der Wave-Karte
für Eigentümer und Admins — als **Graph** (`components/acl-graph`): jede Karte
ist ein Selektor, jeder Pfeil eine Regel, Ports hängen an der Kante, Gruppen
und Tags werden dort angelegt und gefüllt. Darunter, wer danach wen erreicht,
welche Geräte ihre Ports nicht halten, die Policy als JSON zum Aufklappen und
der Verlauf. Drei Dinge daran:

- **Ausgewertet wird nie im Browser.** Jeder Entwurf — Policy *und* Tags —
  geht an `POST /api/waves/:id/acl/preview` (`acl/preview.ts`), und dort
  rechnet dieselbe `compilePolicy()`, die die Netzkarten baut. Gespeichert wird
  dabei nichts. Ein zweites `covers()` im Frontend wäre eine zweite Antwort,
  und eine Seite, die etwas anderes verspricht als die Geräte tun, sieht nicht
  kaputt aus.
- **Der erste Pfeil im vollen Mesh schaltet die Policy ein** und fragt vorher:
  ab dann gilt nur, was ein Pfeil erlaubt. Einen Knopf „alle Verbindungen
  entfernen" gibt es deshalb nicht.
- **Eine Regel mit mehreren Quellen und Zielen wird zu einem Pfeil je Paar**
  und beim Speichern nach Quelle und Ports wieder zusammengefasst. Gleiche
  Bedeutung, nicht unbedingt gleiche Form — wer die Form pflegt, nimmt das
  JSON. Gespeichert werden erst die Tags, dann die Policy; die Lage der Karten
  merkt sich nur der Browser.

```json
{
  "groups": { "group:family": ["a@example.com"] },
  "acls": [
    { "src": ["user:robin@example.com"], "dst": ["tag:nas"],     "ports": ["445", "tcp:5000-5001"] },
    { "src": ["group:family"],           "dst": ["svc:grafana"] }
  ]
}
```

Selektoren sind `*`, `user:<email>`, `group:<name>`, `role:owner|admin|member`,
`tag:<name>` und — nur als Ziel — `svc:<name>` und `svc:*`. Ports sind `*`, `22`,
`5000-5001`, wahlweise mit `tcp:`/`udp:`; ohne `ports` alle. Dieselbe API gibt
es für die Oberfläche: `GET/PUT/DELETE /api/waves/:id/acl`,
`POST /api/waves/:id/acl/preview` und `PUT /api/waves/:id/nodes/:nodeId/tags`,
nur für Eigentümer und Admins, nur als `application/json`.

**Durchgesetzt wird zweistufig, und die erste Stufe ist der Schutz:**

1. **Die Netzkarte.** `buildNetmap()` gibt einem Gerät nur die Peers und Dienste,
   mit denen es laut Policy zu tun hat. Wer nicht in der Netzkarte steht, ist
   kein WireGuard-Peer, und was er schickt, verwirft WireGuard, bevor irgendein
   Dienst es sieht. Das gilt auf jedem Client, auch auf alten, und ist vom
   Server allein gemacht.
2. **Die Ports**, beim *Empfänger*. Die Netzkarte trägt dafür `packetFilter`:
   von wem, an welche eigene Adresse, auf welchen Ports. Unter Linux wird das
   eine nftables-Tabelle `wave-acl-<iface>`, unter macOS ein pf-Anchor
   `com.apple/wave.<utunN>`, unter Windows eine Firewall-Gruppe
   `wave-acl-<iface>`, im Go-Kern prüft der Demultiplexer.

Was daran festliegt:

- **Ein Tag ersetzt den Besitzer.** Ein getaggtes Gerät ist für die Policy seine
  Tags und nicht mehr das Gerät seines Besitzers — `user:`, `group:` und
  `role:` treffen es nicht, nur `tag:` und `*`. Der Connector ist mit dem
  Pre-Auth-Key des Eigentümers angemeldet; eine Regel für dessen Geräte, die
  ihn still mitnähme, gäbe dem Cluster alles, was der Eigentümer erreicht.
  Tags vergibt deshalb nur ein Operator, nie das Gerät selbst — derselbe Grund
  wie beim Wildcard.
- **Sichtbar ist ein Peer in beide Richtungen einer Freigabe.** Darf A zu B,
  muss B A kennen, sonst könnte es nicht antworten. Die *Richtung* hält erst
  der Portfilter: Antworten auf eigene Verbindungen kommen durch
  (`ct state established,related` beziehungsweise die Flusstabelle im Go-Kern),
  neue Verbindungen nur, wenn eine Regel sie nennt. ICMP geht immer — Ping und
  Path-MTU-Discovery öffnen nichts, und ohne sie ist ein Tunnel nicht zu
  debuggen.
- **`svc:*` ist jeder Dienst und kein Gerät** — die Freigabe „alles aus dem
  Cluster“ ohne das „und jeder Laptop im Wave“, das `*` mitbrächte. Sie wird
  wie alles andere bei jedem Bau einer Netzkarte gegen die Dienste ausgewertet,
  die es *dann* gibt: ein Dienst, den der Operator morgen meldet, ist ohne
  Änderung an der Policy dabei. Genau deshalb steht die Karte im Graph immer
  da, auch ohne einen einzigen Dienst, und es gibt keine Warnung „kein Dienst
  namens *“.
- **Ein Dienst bringt seinen Connector mit, und der Connector seine Aufrufer.**
  Ist ein Dienst nicht freigegeben, fehlt er in `services` *und* in den
  `allowedIps` des Connector-Peers — er wird weder aufgelöst noch geroutet,
  auch wenn der Connector für einen anderen Dienst Peer ist. Die eigenen
  Dienste stehen in der Netzkarte des Connectors immer, er beantwortet sie für
  jeden, der darf.
- **`packetFilter` fehlt oder ist da — beides heißt etwas anderes.** Fehlt es,
  gibt es keine Policy und alles kommt durch; ist es da, auch leer, gilt
  „alles verboten außer Antworten und ICMP“. Deshalb optional, ohne
  `.default()`, und im Go-Kern ein Zeiger — dieselbe Regel wie für alles
  unterhalb von `Netmap`, hier mit dem Unterschied, dass ein Default nicht nur
  die Signatur bräche, sondern „keine Policy“ in „alles verboten“ verwandelte.
- **Die nftables-Kette hängt an `prerouting`, Priorität −150.** Nach conntrack
  (−200), also gilt `ct state`, und *vor* dem DNAT des Connectors (−100), also
  trägt ein Paket noch die Adresse, an die es geschickt wurde. Dieselbe Regel
  deckt damit die Dienste eines Laptops und die Dienstadressen ab, die ein
  Connector in den Cluster weiterleitet. Die Kette heißt `rules`: `policy` ist
  in nftables ein Schlüsselwort, und der erste Entwurf scheiterte genau daran.
  **Und `nft` bekommt eine Datei, keine Pipe:** die Fassung in Ubuntu 24.04
  (1.0.9) beantwortet `nft -f -` mit `Not a regular file: "/dev/stdin"`,
  neuere lesen die Pipe. Lokal fiel das nicht auf, erst `acl.sh` im CI —
  jeder Desktop auf diesem Release wäre ohne Ports gelaufen.
  `spawnWithInputFile()` legt die Regeln 0600 in ein eigenes Verzeichnis und
  räumt es danach weg. (Der Connector schreibt seine eigene Regel noch über
  stdin; sein Alpine-nft liest die Pipe.)
- **Ein Filter, der nicht installiert werden kann, reißt den Tunnel nicht mit —
  er wird gesagt.** `syncFilter()` wirft nie; die Engine schreibt einmal je
  Änderung „policy NOT enforced here (…)“. Wer wen erreicht, begrenzt dann
  weiterhin die Netzkarte, nur die Ports nicht. Angewendet wird nur bei einer
  Änderung, und ein Fehlschlag wird mit der nächsten Netzkarte wiederholt.
- **Der Filter kommt vor dem WireGuard-Update**, in `Tunnel.apply()` wie in
  `applyNetmap()`: es gibt keinen Moment, in dem ein neuer Peer senden kann und
  seine Ports noch offen sind.
- **Der Punch-Hinweis geht nur an die, die sich begegnen dürfen.** Er trägt die
  Kandidaten des Absenders, also genau die Adressen, die eine Netzkarte vor
  einem ausgeschlossenen Gerät verbirgt.
- **Was die Shell ändert, kommt mit dem Herzschlag.** `wave-admin` läuft in
  einem anderen Prozess und hat keinen Hub; es zählt nur `netmapVersion` hoch.
  Der `ping`-Zweig von `/v1/control` vergleicht deshalb bei jedem Herzschlag
  (alle 30 s) die Version mit der zuletzt gesendeten und schickt nach. Für eine
  Policy, die Zugriff *entzieht*, wäre „mit der nächsten Netzkarte, wann immer
  die kommt“ nicht gut genug — das gilt seitdem auch für `set-domain` und
  `remove-device` von der Shell. Die API schiebt sofort.
- **Jedes Gerät sagt, ob es die Ports hält**, und der Server zeigt es:
  `{ type: "filter", enforced, reason }` über `/v1/control`, gespeichert als
  `nodes.filter_enforced`/`filter_reason`, zu sehen in `acl`, `devices` und auf
  der Zugriffsseite. Drei Antworten, nicht zwei: `true`, `false` mit Grund, und
  *nichts* — ein Client von vor der Policy kann gar nicht melden und setzt die
  Ports auch nicht durch. Die Meldung ist, was das Gerät über sich sagt; prüfen
  kann der Server sie nicht.
- **macOS: ein Anchor unter `com.apple/`.** Die `/etc/pf.conf` des Systems wertet
  `anchor "com.apple/*"` aus, Regeln darin wirken also, ohne dass jemand die
  Systemkonfiguration anfasst. pf ist zustandsbehaftet; `pass out … keep state`
  ist, was die Antworten auf eigene Verbindungen hereinlässt. Eingeschaltet
  wird pf **per Referenz** (`pfctl -E` gibt ein Token, `pfctl -X` gibt es
  zurück) — so schaltet wave pf nie unter jemand anderem ab. Das Token lebt im
  Prozess; ein Absturz lässt pf eingeschaltet, was nichts öffnet und nichts
  schließt.
- **Windows: nur Block-Regeln, für das Komplement.** In der Windows-Firewall
  schlägt eine Block-Regel jede Allow-Regel, „alles blockieren, das hier
  erlauben“ geht dort nicht. Geschrieben wird deshalb: alles von Quellen, denen
  die Policy nichts gibt (`complementAddresses()`), und von jeder anderen
  Quelle TCP und UDP auf allen Ports außerhalb der freigegebenen
  (`complementPorts()`). Antworten auf eigene Verbindungen prüfen eingehende
  Regeln nicht. Die Regeln sind persistent, deshalb räumt `remove()` sie weg,
  und ist die Firewall für ein Profil aus, meldet der Client „nicht
  durchgesetzt“ statt Regeln, die nicht greifen.
- **Das Audit-Log schreibt jede Änderung an einem Wave** (`audit_log`): Policy,
  Tags, Mitglieder, Einladungen, Geräte (Freigabe, Anmeldung per Schlüssel,
  Entfernen), Domain, Name, und alles, was `wave-admin` ändert. `audit()` wirft
  nie — die Änderung ist schon geschehen, und sie danach als gescheitert zu
  melden, wäre falsch; ein verlorener Eintrag steht auf stderr. In `wave-admin`
  schreibt ihn eine Stelle, `done()`, für jeden Befehl in `CHANGES`: der nächste
  Befehl kann ihn nicht vergessen. Eine Policy wird ganz abgelegt, nicht als
  Diff. Ein gelöschter Wave nimmt sein Log mit.

**Ungeprüft auf echter Hardware sind pf und die Windows-Firewall.** Beide sind
als reine Funktionen getestet — Regeltext, Komplemente, Token-Handhabung —, aber
weder ein `pfctl` noch eine Windows-Firewall hat sie hier je gelesen; unter Linux
gibt es keines von beiden. nftables dagegen ist gegen ein echtes `nft` und mit
`test/e2e/acl.sh` durch echte Tunnel gefahren. Derselbe Stand wie beim
Windows-Tray: benannt, nicht verschwiegen.

## Dienste im Wave (Kubernetes)

**Ein Dienst ist eine Adresse, kein Knoten.** Das ist der Kern von D11: Ein
Ingress hat keine Schlüssel, und zwanzig davon wären zwanzig WireGuard-Peers in
einem Pod. Stattdessen meldet sich je Cluster **ein Connector** als ganz
gewöhnlicher Knoten an, und jeder exponierte Name bekommt eine eigene Adresse
aus dem `/16` des Waves, die in den `allowedIps` des Connectors steht.

```bash
# auf dem Server
bun apps/control/src/admin.ts auth-key       <wave> connector --reusable
bun apps/control/src/admin.ts services       <wave>
bun apps/control/src/admin.ts remove-service <wave> <name>

# im Cluster
cd deployment/cluster/overlays/example
cp secret.env.example secret.env   # den Schlüssel eintragen
kubectl apply -k .
```

Der Weg eines Namens: Der Operator sieht einen `Ingress` mit
`ingressClassName: wave` (oder eine `HTTPRoute` an einem `Gateway` derselben
Klasse), liest dessen `host` und meldet die **ganze Menge** an
`POST /v1/services`. Der Server vergibt Namen und Adressen, `buildNetmap()`
trägt sie zweimal ein — als `services`-Eintrag, aus dem `syncDns()` einen Record
macht, und als zusätzliche `allowedIps` am Connector-Peer, woraus
`desiredRoutes()` auf jedem Gerät eine Route macht.

Was daran festliegt:

- **Der Client hat dafür fast nichts gelernt.** `desiredRoutes()`,
  `syncAddresses()` und `syncRoutes()` sind unverändert: sie sehen nur
  `allowedIps`, und dass darin jetzt Adressen stehen, die keinem Gerät gehören,
  ist ihnen gleich. Geändert hat sich eine Zeile in `syncDns()`. Wer hier etwas
  umbaut, sollte wissen, dass genau diese Eigenschaft die Entscheidung trägt.
- **Der Connector braucht keine Liste seiner Dienste.** WireGuard hat schon
  entschieden, welche Adressen bei ihm ankommen dürfen — Cryptokey-Routing
  lässt auf `wave0` nur durch, was in seinen eigenen `allowedIps` steht. „Kam
  auf wave0 an und ist nicht für mich" *ist* also „für einen meiner Dienste",
  und die eine nftables-Regel gilt weiter, während Dienste kommen und gehen.
  Kein Reload, kein Watcher, kein `kubectl apply`, das eine Regel anfasst.
- **Der Wave-Name *ist* der Ingress-Host.** Der Connector ist ein reiner
  L4-Weiterleiter: Host-Header und SNI bleiben unangetastet, damit der interne
  Controller die richtige Regel und das richtige Zertifikat wählt. Ein Proxy,
  der den Host umschriebe, müsste TLS terminieren und wäre ein zweiter Ort, an
  dem Routing-Wissen liegt.
- **Das Protokoll kommt aus dem Ingress, nicht aus der Oberfläche.** Ob ein
  Dienst `http` oder `https` spricht, weiß nur der Cluster — es hängt an
  `spec.tls` des Ingress beziehungsweise am Listener des Gateways. Der Operator
  meldet deshalb neben `names` die Teilmenge `secure`, der Server legt sie als
  Spalte `scheme` ab, und Oberfläche wie `admin.ts services` bauen den Link
  daraus — und zwar aus *einer* Funktion: `serviceUrl()` in
  `waves/services.ts`. **Was den Server verlässt, ist die fertige Adresse, nie
  ihre Teile.** Das Schema gehört dem Cluster, die Zone dem Wave, und beides
  weiß nur diese Seite; vier Oberflächen, die sich jede ihre eigene URL
  zusammensetzen, sind vier Schreibweisen derselben Adresse, und genau so
  laufen sie auseinander. Seit dem 26.09.2026 steht sie deshalb als `url` auch
  **in der Netzkarte** — optional und ohne `.default()`, wie alles unterhalb
  von `Netmap` —, und ein Gerät hat damit überhaupt erst einen Link: eine
  Netzkarte trägt kein Schema. Ein älterer Server lässt das Feld weg, und die
  eine Stelle, die das auffängt, ist `servicesOf()` im Client — `https` auf den
  Namen, dieselbe Vorgabe, die der Server heute gäbe. Der Go-Kern liest das
  Feld nicht; er baut die kanonische Form aus den Bytes, die ankamen, und
  braucht für Routen und DNS keine URL. Die Dienste kommen dabei **nach Namen
  sortiert**, so wie die Liste im Browser: eine umsortierte Netzkarte sähe
  sonst aus wie eine geänderte. Vier Dinge daran:
  - **Wird ein Name beides serviert, gewinnt https.** Der Klartextweg ist
    bestenfalls eine Weiterleitung, und ein Name unter der Domain des Waves ist
    dafür da, ein Zertifikat zu tragen (D7). `secure` ist deshalb eine
    Vereinigung über alle Objekte: ein Ingress mit TLS genügt.
  - **`secure` ist eine zweite Liste, kein Feld je Eintrag.** `names` bleibt
    unverändert die *ganze* Menge — das eine, was nie auseinanderlaufen darf —,
    und ein Operator von vor dieser Änderung meldet weiter nur Namen. Sagt
    niemand etwas, bleibt alles auf der Vorgabe `https`, also genau dem, was
    vorher fest im Code stand. Ein Name in `secure`, der nicht in `names` steht,
    bedeutet nichts.
  - **Ein `tls`-Block ohne `hosts` deckt die Regeln seines Ingress.** So sieht
    ein Default-Zertifikat aus; als leere Liste gelesen wären genau diese
    Dienste still `http`.
  - **Ein gewechseltes Schema zählt `netmapVersion` nicht hoch.** Die Netzkarte
    trägt kein Schema; ein Stoß schöbe jedem Gerät ein identisches Dokument für
    eine Spalte, die nur der Browser liest. Der Operator muss den Wechsel aber
    melden — `sameServices()` vergleicht deshalb Name *und* Schema, sonst bliebe
    ein neu ausgestelltes Zertifikat unsichtbar, bis sich zufällig ein Name
    ändert.
- **Namen und Adressen liegen in *einem* Namensraum mit den Geräten.**
  `grafana` kann nicht zugleich ein Gerät und ein Dienst sein. Über zwei
  Tabellen hinweg gibt es keinen Unique-Index, deshalb läuft `syncServices()`
  unter `select … for update` auf der `waves`-Zeile — dort sitzt mit
  `netmap_version` ohnehin der Serialisierungspunkt.
- **Die ganze Menge, nicht einzelne Aufrufe.** Die Objekte eines Clusters kommen
  und gehen; „das sind die Dienste jetzt" ist die einzige Form, die nicht
  auseinanderlaufen kann. Ein verpasstes Delete hinterließe sonst für immer
  einen Namen, den nichts beantwortet.
- **Der Operator ist kein zweiter Wahrheitsort** und hält keine Zuordnung. Er
  pollt (alle 10 s, und ruft nur bei Änderung an) statt zu watchen: ein Watch
  ist eine lange Verbindung mit einer Resource-Version, aus der man
  wiederaufsetzt, und das falsch zu machen heißt entweder eine stille Lücke
  oder ein Reconnect-Gewitter. Fällt er aus, tragen die Routen weiter — die
  Netmap ist signiert und liegt auf jedem Gerät.
- **Operator und Connector sind ein Teilnehmer, nicht zwei.** Der Operator
  weist sich mit dem Maschinenschlüssel des Connectors aus, aus derselben
  Zustandsdatei. Eine zweite Identität wäre ein zweiter Knoten im Wave, der nie
  Verkehr trägt.
- **Die Cluster-CIDR bleibt draußen.** Der Wave sieht nur Adressen aus seinem
  eigenen Block; zwei Cluster mit derselben Service-CIDR stören sich nie, und
  `overlap.ts` bekommt nichts Neues zu tun.
- **„Nur aus dem Wave erreichbar" kommt aus dem Cluster.** Nötig sind ein
  interner Ingress-Controller mit ClusterIP (nie LoadBalancer) und eine
  NetworkPolicy, die nur den Connector-Pod zu ihm lässt. wave macht einen Dienst
  erreichbar; *un*erreichbar machen kann es ihn nicht.
- **Kein eingehender Port im Cluster.** STUN und der Relay-Fallback tragen den
  Tunnel heraus; der Pod braucht `NET_ADMIN` und `/dev/net/tun`, sonst nichts.
  MSS-Clamping gehört auf beide Richtungen von `wave0`, sonst ist die 1280er MTU
  ein Fehlerbild, das erst bei großen Antworten auffällt.

**Und die andere Richtung: aus dem Cluster in den Wave** (`apps/connector/src/
egress.ts`, Komponente `deployment/cluster/components/egress`). Ein Pod in
Cluster B ruft `https://plausible.wave.example.com` auf, einen Dienst, den
Cluster A in den Wave stellt. CoreDNS beantwortet jeden Namen unter der
Wave-Domain mit dem Service `wave-egress`, der zeigt auf den Connector, und der
liest den Namen — SNI bei TLS, `Host` bei HTTP — und reicht die Verbindung an
die Adresse aus seiner Netzkarte weiter. Was daran festliegt:

- **TLS wird nie aufgebrochen.** Der Pod prüft das Zertifikat dessen, was er
  aufruft; kein Connector sieht die Anfrage. Deshalb nach Namen und nicht als
  Reverse Proxy.
- **Nur Namen aus der Netzkarte.** Alles andere bekommt bei TLS den Alert
  `unrecognized_name`, bei HTTP eine 421 — sonst wäre der Connector ein offener
  Proxy ins Internet für jeden Pod. Und weil die Netzkarte schon durch die ACL
  gegangen ist, ist ein Ziel, das die Policy dem Connector nicht gibt, hier
  schlicht kein Name.
- **Gebunden an die Pod-Adresse, nie an `0.0.0.0`** (`WAVE_POD_IP` aus der
  Downward-API; ohne sie verweigert der Connector den Start). Der Pod teilt sein
  Netz mit `wave0`: überall gebunden, wäre der Proxy auch über die Wave-Adresse
  des Connectors erreichbar und jeder Peer hätte ein Sprungbrett zu jedem
  anderen.
- **Die eigenen Dienste gehen direkt an den internen Ingress.** Verkehr, der im
  Pod entsteht, läuft durch OUTPUT, nicht durch PREROUTING; das DNAT auf `wave0`
  sähe ihn nie.
- **Nur HTTP und HTTPS.** SMB, SSH oder eine Datenbank tragen keinen Namen im
  Protokoll; dafür bräuchte es ein ausdrücklich benanntes Ziel je Port — ein
  anderer Entwurf, nicht gebaut.
- **Der Verkehr tritt als der Connector auf**, also als seine Tags. Mit einer
  Policy braucht er eine Regel zu den Zielen, am saubersten mit einem Tag je
  Cluster (`tag:cluster-b` → `svc:plausible`).
- **Aus, solange nicht eingeschaltet** (`WAVE_EGRESS=1`, setzt die Komponente).
  Der CoreDNS-Eintrag liegt als `coredns.example.yaml` daneben und wird nicht
  mit angewendet: unter k3s ist `coredns-custom` *eine* ConfigMap für alle
  Ergänzungen, und ein Apply überschriebe, was dort steht.

Geprüft ist die Weiterleitung über echte Sockets — SNI aus einem echten
ClientHello, auch auf zwei Records verteilt, Bytes unverändert, Verweigerung,
eigene Dienste —, nicht in einem Cluster. Der CoreDNS-Block ist ungefahren.

**Pre-Auth-Keys** sind die Voraussetzung dafür: ein Connector wird deployt, nicht
geklickt. `admin.ts auth-key <wave>` gibt einen Schlüssel aus — einmal sichtbar,
gespeichert nur als SHA-256, mit Ablauf, widerrufbar, und einmalig, solange
nicht `--reusable` dabeisteht. `wave login <url> --auth-key <key>` (oder
`WAVE_AUTH_KEY`) benutzt ihn. Zwei Dinge daran: die Zählung des Verbrauchs läuft
in derselben Anweisung wie die Prüfung, damit zwei gleichzeitige Registrierungen
nicht beide den letzten Zug eines Einmalschlüssels machen — und ein Gerät, das
schon im Wave ist, verbraucht beim erneuten Registrieren **keinen** Zug, sonst
kostete jede Schlüsselrotation einen Schlüssel.

**Eine Regel, die zwei Ausfälle gekostet hat: in einem signierten Dokument darf
nichts wegfallen und nichts hinzukommen.** Die Netmap ist signiert, und die
Signatur deckt ihre kanonische Form. Zod verwirft unbekannte Felder — ein alter
Client hätte `services` weggeworfen, anders kanonisiert und eine einwandfreie
Netmap als gefälscht gemeldet. Und ein `.default([])` erfindet umgekehrt ein
Feld, das ein älterer Server nie gesendet hat, mit demselben Ergebnis. Deshalb
ist alles unterhalb von `Netmap` ein `looseObject` **und** frei von
`.default()`. Beide Richtungen sind beim Hinzufügen von `services` wirklich
umgefallen, und beide melden sich als „netmap signature does not verify", was
wie ein Angriff aussieht und keiner ist.

**Die Manifeste stehen als Kustomize-Bäume in `deployment/`**, und zwar in
zweien: `deployment/server` (Control, Web, Relay und die Datenbank) läuft dort,
wo der Wave gehostet wird, `deployment/cluster` (Connector und Operator) in *dem* Cluster,
dessen Dienste exponiert werden. Ein `apply -k`, das beides auf einmal
installiert, wäre für beide Seiten falsch. Was darin nicht offensichtlich ist,
steht als Kommentar daneben; zwei Dinge sind es wert, hier zu stehen:

- **Control und Relay laufen mit genau einer Replika.** Der `NetmapHub` hält die
  offenen `/v1/control`-Sockets in einer Map im Prozess, der Geräte-Feed seine
  `/api/events` daneben, das Relay seine Sitzungen ebenso. Ein zweiter Pod bekäme die Hälfte der Geräte und erführe
  nie, dass die andere Hälfte eine neue Netmap braucht — ein Gerät bliebe auf
  einer alten Netzkarte stehen, ohne dass irgendwo etwas rot wird. Mehr Relays
  gibt es stattdessen als weitere Einträge in `WAVE_RELAYS`.
- **Der STUN-Service braucht `externalTrafficPolicy: Local`.** Mit der Vorgabe
  `Cluster` macht kube-proxy SNAT, und der Relay meldete die Adresse eines
  Cluster-Knotens als reflexive Adresse zurück — jedes Hole Punching liefe gegen
  einen Endpunkt, den es nicht gibt. Jede Portweiterleitung mit SNAT im Pfad
  stellt dieselbe Falle; ein STUN-Server wird deshalb **immer von außen**
  gemessen, nie über Loopback, sonst prüft man den Proxy statt den Server.

**Ungeprüft ist alles, was einen Cluster braucht.** Connector-Regeln, Operator
und Manifeste sind gegen Fakes getestet — die nftables-Regel als Text, der
Operator gegen einen erfundenen API-Server —, aber nie in einem echten Cluster
gefahren; von den Kustomize-Bäumen ist geprüft, dass sie bauen, mehr nicht. Das
ist derselbe Stand wie beim Windows-Tray: benannt, nicht verschwiegen.

## Telefone

Auf iOS und Android läuft vom Bun-Client nichts: kein `Bun.spawn`, also kein
wireguard-go als Sidecar; kein `ip`, `resolvectl` oder `route`, also fällt
`LinkBackend` ersatzlos weg; und die iOS-Tunnel-Extension ist bei rund 50 MB
gedeckelt, was eine JS-Runtime darin ausschließt. Portabel ist allein der
Vertrag. Deshalb ein **gemeinsamer Kern in Go** (`mobile/core`), über
`gomobile bind` als `.xcframework` und `.aar` gebunden, die Oberfläche nativ
(D10). Das Ganze steht in [`mobile/README.md`](mobile/README.md); hier nur, was
man wissen muss, bevor man es anfasst.

**Beide Plattformen erlauben genau einen Tunnel je App.** Das Modell aus
`state.ts` — je Anmeldung ein Interface `waveN` und ein UDP-Port 4164N —
existiert dort nicht. Also:

| Schicht | Auf dem Telefon |
|---|---|
| Control | **N-fach, unverändert** — N Sockets, N Machine-Keys, N gepinnte Signaturschlüssel |
| MagicSock | **eine**, ein öffentlicher UDP-Port; Peers unter `(wave, nodeKey)` |
| WireGuard | **N Devices** über einem TUN, Node-Key je Anmeldung |
| OS-Settings | **eines** — Adressen und Routen als Vereinigung, MTU als Minimum |
| DNS | **ein Resolver** mit Suffix→Wave-Tabelle, ohne eigenen Socket |

**Die Wave heißt hier wie überall sonst: nach ihrem Control-Server.** Nicht nach
der `waveId` aus der Netmap — die gibt es erst, wenn die erste Netmap da ist,
und ein zweiter Name wäre einer, den man in Übereinstimmung halten müsste.

Was daran festliegt:

- **Der Loopback-Socket je Peer entfällt, und der Endpoint *ist* der Peer.**
  wireguard-go nimmt als Bibliothek eine `conn.Bind` entgegen; die MagicSock
  *ist* dann der Bind, und jede Wave bekommt eine Sicht darauf, die nur ihre
  Pakete liefert. `bindLoopback()` existiert auf dem Desktop nur, weil Bun keine
  `conn.Bind` anbieten kann. In der UAPI steht deshalb `endpoint=wave://<nodeKey>`
  — die Zusicherung „ein Pfadwechsel fasst die WireGuard-Konfiguration nie an"
  wird damit stärker statt schwächer, weil dort gar keine Adresse mehr steht,
  die man ändern könnte.
- **Schlüssel dürfen sich so wenig überschneiden wie Adressen.** Disco-Pakete
  tragen den Absenderschlüssel im Klartext, und auf einem gemeinsamen Socket
  schlägt die Zuordnung über *alle* Waves hinweg nach — anders geht es nicht,
  denn vor der Zuordnung weiß niemand, zu welcher Wave ein Paket gehört. Ein
  bösartiger Control-Server könnte sonst einen Peer mit dem Disco-Key einer
  fremden Wave ankündigen und sich in deren Nachschlagen hängen. `waveoverlap`
  lehnt die zweite Wave deshalb ab und nennt beide, genau wie bei Adressen.
- **Erst die Vereinigung, dann anwenden.** `setTunnelNetworkSettings` ist atomar
  und kennt kein Teilversagen, also wird die Overlap-Prüfung von der
  Vorsichtsmaßnahme zur **Vorbedingung**. Und weil erneutes Anwenden den Tunnel
  kurz unterbricht, geht eine Netmap, die nichts geändert hat, gar nicht erst an
  die Plattform: `wavesettings.Union()` sortiert und dedupliziert, damit eine
  umsortierte Netmap nicht wie eine Änderung aussieht, und `Equal()` entscheidet.
- **Der Netzwechsel ist der Normalfall, nicht die Ausnahme.** WLAN→LTE löst
  sofort Rebind, Neusammeln der Kandidaten und `publishEndpoints` aus
  (`NWPathMonitor`, `ConnectivityManager.NetworkCallback` → `Core.NetworkChanged`).
  Auf dem Desktop greift der Rebind-Timer erst, wenn Peers unerreichbar sind;
  hier wäre das der Unterschied zwischen einer Pause, die niemand bemerkt, und
  zehn Sekunden ohne alles.
- **Android tauscht bei jedem `establish()` den Deskriptor**, iOS behält seinen
  Packet Flow. `VpnService.Builder` gibt einen neuen zurück und schließt den
  alten — ein Kern, der noch den ersten liest, sieht einen Tunnel, der einfach
  still wird. Deshalb `Core.ReplaceTunnel()` und `Multiplexer.ReplaceLink()`:
  die Waves, ihre Devices und ihre Warteschlangen überleben, nur der Deskriptor
  darunter wechselt. Das ist der einzige Punkt, an dem die beiden Plattformen
  wirklich auseinanderlaufen.
- **Der Resolver hat keinen Socket und rechnet seine Prüfsummen selbst.** Die
  Anfrage kommt als Paket auf dem Tunnel an, der Demultiplexer erkennt die
  Adresse und schreibt die Antwort als IP-Paket zurück. Also tut diese Schicht,
  was sonst der Kernel täte — und über IPv6 ist die UDP-Prüfsumme **nicht
  optional**.
- **Die Resolver-Adresse ist geroutet und niemandem zugewiesen.** Darauf steht
  das Ganze: ein Paket an eine Adresse, die das Interface *hält*, liefert der
  Kernel lokal aus — dort lauscht nichts, es kommt ICMP port unreachable
  zurück, und der Tunnel sieht die Anfrage nie. Deshalb **reserviert der Wave
  eine**: die 53. seines Blocks (`RESOLVER_OFFSET` in
  `apps/control/src/net/addressing.ts`), die der Allokator nie an ein Gerät
  vergibt und die `buildNetmap()` in `dns.resolverAddress` mitschickt. Vergeben
  kann sie nur der Server, weil nur er Adressen vergibt.
  - **Das Feld ist optional, nicht vorbelegt.** Ein Wave, der vor der
    Reservierung nummeriert wurde, kann die Adresse längst an einen Knoten
    vergeben haben; dann lässt der Server sie **weg**, statt das DNS aller
    Geräte auf ein Gerät zu zeigen. Und weglassen geht nur ohne `.default()` —
    ein Default erfände das Feld beim Lesen, die kanonische Form wiche von der
    signierten ab, und eine einwandfreie Netmap meldete sich als gefälscht.
    Genau die Regel, die für alles unterhalb von `Netmap` gilt; `resolverAddress`
    und `upstream` hatten sie bis dahin verletzt.
  - **Fehlt die Reservierung, fällt der Kern auf die eigene Adresse zurück** und
    sagt in einer Logzeile, dass Auflösung *auf dem Gerät selbst* damit nicht
    geht. Über den Tunnel — ein Peer fragt uns — funktioniert sie weiter.
- **Zwei Waves auf einem Interface brauchen eine Quelladressen-Regel.** Mit
  lauter `/32` gibt es keine, nach der der Kernel wählen könnte: er nimmt die
  erste Adresse des Interfaces, ein Paket in die zweite Wave geht mit der
  Quelladresse der ersten hinaus, und die WireGuard-Gegenseite verwirft es —
  sie steht nicht in ihren `allowedIps`. Der Tunnel sieht auf beiden Seiten oben
  aus und trägt in einer Richtung nichts. Deshalb zwei Dinge: die eigenen
  Adressen bekommen den Präfix, der *ihre* Wave abdeckt (`prefix.go`, abgeleitet
  aus der Netmap, nicht aus D5 angenommen), und jede Route trägt ihre
  Quelladresse mit (`wavesettings.Route`). Das Erste ist alles, was iOS und
  Android können — deren APIs nehmen Adresse und Präfixlänge, aber keine Quelle
  je Route —, das Zweite nutzt Linux. Gemessen mit
  `test/e2e/mobile-core.sh`: ohne beides erreichte das Gerät die erste Wave und
  die zweite nicht.
- **Ein Neustart darf den UDP-Port nicht wechseln.** Er ist das, wohin die Peers
  senden gelernt haben; auf einem frischen Port senden sie 15 Sekunden weiter
  an den alten, bis ihr Pfad verfällt (`PATH_TIMEOUT_MS`) — ein Tunnel, der
  beidseitig oben aussieht und nichts trägt. Deshalb ist `DefaultListenPort`
  dieselbe 41641 wie auf dem Desktop, und nur der Rebind nach einem
  Netzwechsel zieht absichtlich um (dort ist das Wegkommen von einem
  möglicherweise vergifteten Mapping der Zweck).
- **wireguard-go schließt und öffnet eine `conn.Bind` im Normalbetrieb.** Jedes
  `device.Up()`, jedes `Down()` und jedes `BindUpdate` geht durch `Close` und
  dann `Open`. Ein Bind, das `Close` für endgültig nahm, funktionierte genau
  einmal und antwortete danach für den Rest des Prozesses „bind is closed" —
  ein Tunnel, der nie hochkommt, gemeldet als etwas, das wie ein Socket-Fehler
  klingt. Die Warteschlange gehört deshalb der *Sitzung*, nicht dem Bind; nur
  das Verlassen einer Wave schließt ihn für immer (`retire()`).
- **Android setzt DNS geräteweit.** `VpnService.Builder.addDnsServer()` kennt
  kein `matchDomains` wie iOS. Die Invariante „nie den System-Resolver
  übernehmen" ist dort nicht haltbar, und aus dem sonst optionalen Weiterreichen
  an die vorherigen Upstreams wird eine **Pflicht** — sonst bräche jeder Name
  auf dem Telefon, der nicht in einem Wave liegt. `wavedns.Config.SystemWide`
  ist die Stelle, an der das ausgesprochen wird.
- **Unsere eigenen Sockets müssen aus unserem eigenen Tunnel heraus.** Unter
  Android ist das `VpnService.protect`; ohne das liefe der verschlüsselte
  Verkehr in den Tunnel, den er trägt — ein Fehlerbild, das wie ein Peer
  aussieht, der nie antwortet, und die häufigste Art, wie ein `VpnService` still
  kaputtgeht. Der Kern reicht deshalb *jeden* Socket durch
  `Callbacks.ProtectSocket`, auch den des DNS-Weiterleiters.
- **Das Relay ist eine Verbindung *je Wave*, nicht je Gerät.** Es authentifiziert
  und routet nach Disco-Key, und den hat jede Anmeldung für sich. Eine einzige
  Verbindung mit dem Schlüssel einer Wave ließe das Relay ohne Sitzung für alle
  anderen — deren Relay-Verkehr käme nie an, und zwar still. N Verbindungen sind
  der Preis der Schlüsseltrennung, und den zahlt D10 bewusst. Nur STUN ist
  wirklich geräteweit: ein Socket, eine reflexive Adresse.
- **Die Framing-Frage wird gesagt, nicht geraten.** Ein utun-Deskriptor stellt
  jedem Paket vier Byte Adressfamilie voran, Androids nicht. Falsch geraten
  ergibt das einen Tunnel, in dem nie etwas geparst wird — deshalb ist es ein
  Parameter von `Core.Start()`.

**Der Vertrag wird gegen die TypeScript-Seite geprüft, nicht behauptet.**
`mobile/fixtures` erzeugt mit dem Code, der produktiv läuft, kanonisches JSON,
eine signierte Netmap, versiegelte Disco-Pakete, eine STUN-Antwort aus unserem
eigenen Server und DNS-Antworten; die Go-Tests lesen sie. Eine kanonische
Kodierung, die sich in einem Zeichen unterscheidet, ist eine Signatur, die nicht
verifiziert — und auf dem Telefon liest sich das als „netmap signature does not
verify": wie ein Angriff, obwohl es ein Tippfehler ist. Wer an `canonicalJson`,
an WaveSig, am Disco-Format oder am DNS-Codec etwas ändert, ändert **beide**
Seiten und erzeugt die Fixtures neu.

**In Go ist der Fehler, der `services` zweimal umgeworfen hat, strukturell
ausgeschlossen.** Die kanonische Form wird auf den Bytes gebildet, die ankamen,
und erst danach wird gelesen: was nicht gelesen wird, kann nicht verlorengehen,
und was nicht erfunden wird, kann nicht hinzukommen. Für die TypeScript-Seite
bleibt die Regel wie sie ist (`looseObject`, kein `.default()`) — dort gibt es
diese Möglichkeit nicht.

**Geprüft ist der Kern, nicht das Telefon.** `go test -race` deckt den
Demultiplexer, die Pfadwahl (dieselben Konstanten und dieselbe Messreihe wie auf
dem Desktop), den Resolver, die Vereinigung samt Diff, die Kollisionsprüfung, die
Anmeldung gegen einen Server, der die Signatur so prüft wie der echte, und zwei
echte Sockets ab, die über Loopback einen direkten Pfad finden.

Darüber stehen zwei E2E-Skripte, beide mit dem gewöhnlichen Bun-Client als
Gegenstelle — also zugleich Tests über die Implementierungsgrenze:

- **`test/e2e/mobile-core.sh`**: der Kern an einem echten TUN, mit zwei
  Control-Servern. Ein Interface trägt beide Waves, es gibt kein `wave1`, ein
  öffentlicher UDP-Port für beide, ein Peer in jeder Wave ist erreichbar, der
  Resolver antwortet ohne Socket für *beide* Zonen und schweigt für alles
  andere, seine Adresse ist geroutet und keinem zugewiesen, und ein Neustart
  kommt mit denselben Adressen und demselben Port zurück, ohne dass jemand
  etwas neu freigeben muss.
- **`test/e2e/mobile-nat.sh`** (und `--symmetric`): derselbe Kern hinter einem
  NAT. Ohne Flag punchen die beiden Implementierungen einen direkten Pfad
  gegeneinander; mit `--symmetric` kann Punching prinzipiell nicht gelingen und
  der Verkehr läuft über das Relay, was am Zähler des Relays nachgesehen wird.
  Damit ist das Abnahmekriterium von M10 — „zwei Waves, direkter Pfad und
  Relay-Fallback" — vollständig abgedeckt.

**Vier Fehler sind dort aufgefallen und keiner an einem Unit-Test:** der Bind,
der nur einmal funktionierte; der Neustart, der den UDP-Port wechselte; die
fehlende Quelladresse; und eine nil-Map, die jede Wave mit Relay zum Absturz
brachte — Letztere erst, als es zum ersten Mal ein Relay gab.

Nur den Weg *durch die Plattform* deckt auch das nicht ab. Beide Apps bauen
(iOS mit Xcode aus `mobile/ios/project.yml`, Android mit dem Gradle-Wrapper)
und starten im Simulator bzw. Emulator — der Tunnel selbst läuft dort nicht,
`NEPacketTunnelProvider` gibt es im Simulator gar nicht. Der erste Lauf auf
echter Hardware ist der über TestFlight und den internen Test in Google Play.

**Die Store-Identität steht und ändert sich nie mehr:** Bundle-Id und
`applicationId` `org.wavemesh.app`, Extension `org.wavemesh.app.tunnel`,
App-Gruppe `group.org.wavemesh.app`, Team `L6R92A4Y7C` (Moellenbeck-Digital
UG). Für iOS stehen sie zusätzlich in `Shared/Identifiers.swift`. Beide Apps
zeigen vor der ersten Verbindung einmal, was mit Daten geschieht (App-Review
5.4, Play-Richtlinie zu `VpnService`); ändert sich die Aussage, bekommt der
Schlüssel `disclosureAccepted.v1` eine neue Nummer.

## Invarianten, die leicht kaputtgehen

- **Eine Live-Ansicht nur auf einem Terminal.** `wave up` und `wave status`
  bleiben offen und zeichnen im Sekundentakt neu — ein Pfad, eine RTT und ein
  Handshake-Alter sagen erst etwas, wenn man sie sich bewegen sieht. Am Rohr
  darf das nie passieren: die E2E-Skripte lesen `wave status` in `$(...)` und
  in `| grep -q`, und eine Ansicht, die auf Ctrl-C wartet, hängt sie auf.
  `shouldWatch()` in `render.ts` entscheidet das an einer Stelle, `--once`
  erzwingt den einen Stand auch auf dem Terminal. Zwei Dinge hängen daran:
  - **Die Fußzeile sagt, was Ctrl-C wirklich tut.** Getrennt wird nur dort, wo
    der Tunnel in diesem Prozess läuft (`runHere`); hält ihn der Daemon, hört
    bloß die Anzeige auf. Deshalb nimmt `renderStatus()` den Hinweis als
    Argument, und ein einzeln gedruckter Stand bekommt gar keinen.
  - **`status` schaut auf seiner eigenen Verbindung zu, `up` braucht eine
    zweite.** Der Client reicht jede Nachricht an den Watcher *und* an die
    älteste offene Anfrage; wer nach dem `watch` noch etwas fragt, bekommt den
    nächsten geschobenen Status als Antwort darauf. `status` fragt danach
    nichts mehr, also genügt eine.
- **Nicht punchen, bevor die eigenen Kandidaten veröffentlicht sind.** Sonst
  trifft das erste Paket das fremde NAT als unaufgeforderter Fluss; Linux legt
  dafür einen Conntrack-Eintrag an, der genau das Tupel belegt, das die
  Gegenseite für ihre Portbeibehaltung braucht. Startsignal ist die eigene
  Netmap mit den eigenen Kandidaten — sie erreicht beide Seiten im selben
  Broadcast.
- **Ein laufender Tunnel ist kein Riegel gegen einen zweiten Versuch.**
  `upOne()` im Daemon sichert gegen `runtime.starting`, nicht bloß gegen
  `runtime.tunnel` — das wird erst gesetzt, wenn `bringUp()` zurückkommt, und
  dazwischen wartet die Anmeldung auf einen Menschen im Browser. In diesem
  Fenster kamen sonst zwei Aufrufe durch (etwa `wave login` neben dem `up()`,
  das der Dienst beim Start selbst auslöst), bauten zwei Tunnel, und der
  Verlierer überschrieb mit seinem „timed out waiting for approval" den
  Zustand des Gewinners: ein Wave, der als `failed` gemeldet wird, während sein
  Interface Verkehr trägt. Am 15.09.2026 genau so beobachtet.
- **Der Startversatz muss unter der RTT zum Peer bleiben.** Deshalb steht der
  Punch-Aufruf in `Tunnel.apply()` vor der WireGuard- und Routen-Arbeit.
- **Keine langsame Arbeit im Nachrichtenpfad der Control-WebSocket.** STUN dort
  zu tun hat schon einmal die Netmap eines Peers um 1,5 s verzögert.
- **Kein bestätigter Pfad heißt nicht, dass nichts fließt.** Ohne `best`
  sprüht `onWireguardPacket()` jedes Paket an alle bekannten Kandidaten — das
  trägt, es ist nur verschwenderisch und ungemessen. Die Anzeige nennt das
  deshalb `no fixed path` und nicht `connecting…`; Letzteres behauptet, der
  Tunnel sei unten, während ein Ping darüber in 16 ms antwortet. Unterschieden
  wird am WireGuard-Handshake (`pathKind()` in `@wave/ipc`): frisch heißt, es
  kommt etwas durch, alt heißt, wir wissen nichts.
- **Kandidaten verfallen, auf beiden Seiten.** Hinter einem NAT, das jedem
  Ziel einen neuen Port gibt (k3s-SNAT, Handy-Hotspot), meldet jede STUN-Runde
  eine Adresse, unter der uns nie wieder jemand erreicht. Die Liste wuchs nur:
  der Connector stand nach 47 Stunden bei 2670 Kandidaten, jeder Peer probte
  jeden davon viermal pro Sekunde auf je einem neuen Ziel-Port — jedes ein
  NAT-Eintrag auf dem Router *vor dem Prober*, und am 28.09.2026 lief genau so
  ein Heimrouter voll. Deshalb drei Schranken: eigene Adressen verfallen nach
  `REFLEXIVE_TTL_MS` (höchstens `MAX_REFLEXIVE`), `setPeers()` vergisst
  zurückgezogene Pfade, sofern sie nicht gerade antworten, und der Server
  hält je Art höchstens acht (`boundCandidates()`, beim Speichern *und* beim
  Bauen der Netzkarte — Letzteres für Zeilen und Clients von davor). Der
  Go-Kern tut dasselbe.
  **Und der Takt läuft ab dem letzten Ping, nicht ab dem letzten Pong**
  (`probeDue()`/`ProbeDue()`). Ab dem Pong gerechnet war ein Kandidat, der nie
  antwortet, bei *jedem* Tick fällig — viermal pro Sekunde, für immer, auch
  nach der Schnellphase. Am 30.09.2026 waren das 736 ICMP-Fehler in der Minute
  („socket error(s) ignored"). Die Schranken oben begrenzen, *wie viele*
  Kandidaten es gibt, erst diese, *wie oft* sie gefragt werden: nach den
  ersten fünf Sekunden so oft wie ein lebender Pfad, alle drei.
- **Auch das Relay braucht einen Herzschlag.** Die Steuerverbindung hatte
  einen, das Relay nicht: nach einer halben Stunde Ruhezustand hatte das Relay
  seine Seite längst geschlossen, der Client las seinen Socket weiter als
  offen, ein `close` kam nie, und der Connector — nur über das Relay
  erreichbar — stand auf `connecting…`, während der Status `relay connected`
  zeigte. Der Client schickt deshalb alle 15 s ein Frame an seinen *eigenen*
  Disco-Key; das Relay liefert es nur zurück, wenn es diesen Schlüssel noch zu
  genau diesem Socket routet, und genau das ist die Eigenschaft, auf die es
  ankommt. Kein Protokollwechsel, der Relay-Server kann es schon. Jedes
  eingehende Frame zählt als Lebenszeichen, das Echo selbst geht nie an
  `onPacket`. Der Go-Kern tut dasselbe, und dort zählt es mehr: auf dem
  Telefon ist Schlafen der Normalfall.
- **ICMP-Fehler werden vom *nächsten* `send()` konsumiert.** Ein toter Kandidat
  verschluckt sonst die Sonde eines guten — `sendVia()` wiederholt deshalb einmal.
- `Bun.udpSocket().send()` nimmt **keine Hostnamen**, nur IP-Adressen.
- Fremde Tunnel-Interfaces (die anderer Mesh-VPNs, `wg*`, unter macOS **alle**
  `utun*`) gehören nicht in die Kandidatenliste, sonst baut man Tunnel durch
  Tunnel. Unter macOS heißt auch das eigene Interface `utunN`. Welche Präfixe
  das sind, steht an genau zwei Stellen: `gatherLocalCandidates()` und
  `isTunnelInterface()` im Go-Kern.
- **Unter macOS benennt der Kernel das Interface.** `wave0` ist dort nur ein
  Label: wireguard-go bekommt `utun` und meldet über `WG_TUN_NAME_FILE`, welches
  `utunN` es wurde. Alles, was das Interface anfasst, muss diesen Namen
  benutzen — `resolveInterfaceName()` liefert ihn. Dort läuft wireguard-go
  außerdem im Vordergrund (`-f`), weil nur dann der Prozess, den wir gestartet
  haben, auch der ist, dem das Interface gehört; `wave down` findet ihn über
  `/var/run/wireguard/<utunN>.pid`.
- **Unter macOS ist die eigene Tunnel-Adresse lokal nicht erreichbar.** Ein
  `utun` ist Point-to-Point: Pakete an die eigene wave-Adresse gehen ins
  Interface hinaus statt an den lokalen Socket — schon `ping` auf die eigene
  Adresse läuft ins Leere. Der DNS-Resolver lauscht dort deshalb auf
  `127.0.0.1`; welche Adresse es ist, entscheidet `resolverAddress()` im
  Link-Backend, nicht die Engine.
- Der Kernel kürzt führende Nullen in IPv6-Adressen — Adressvergleiche laufen
  über `canonicalAddress()`.
- **Privilegien bündeln sich im Daemon.** `waved` läuft als root, die CLI redet
  über einen Unix-Socket mit ihm; Zugriff regeln die Dateirechte (root plus eine
  Gruppe), nicht ein Token. Fehlt die Gruppe, bleibt der Socket root-only statt
  auf etwas Großzügigeres zurückzufallen. Die CLI arbeitet ohne Daemon weiterhin
  selbst — das hält die E2E-Tests einfach und ist der Notnagel.
- **Niemals den System-Resolver übernehmen.** Nur die Zone des Waves und die
  delegierten Suffixe werden umgeleitet (`resolvectl domain`,
  `/etc/resolver/<domain>`); fehlt die Möglichkeit, verweigert der Client die
  DNS-Konfiguration, statt `/etc/resolv.conf` zu überschreiben.
- **Der Resolver beantwortet auch PTR, und die Rückwärtszonen werden zu ihm
  geleitet.** Sonst fragt der System-Resolver „wie heißt 10.77.0.2?" nach
  draußen, wo niemand zuständig ist und niemand das sagt — und alles, was vor
  der Ausgabe einen Namen nachschlägt, wartet. Gemessen am 16.09.2026:
  `ping <name>` hing 8 s ohne eine Zeile, `ping -n <name>` antwortete in 20 ms.
  Die Zonen leitet `reverseZonesFor()` aus den eigenen Adressen ab — je Wave
  ein `/16` und ein `/48` (D5), also für alle Knoten darin dieselben. Innerhalb
  davon ist eine unbekannte Adresse **NXDOMAIN**, nicht Schweigen; außerhalb
  gehört die Frage uns nicht und wird verworfen.
- **Die eigene Zone ist Search-Domain, die delegierten Suffixe sind es nicht.**
  Unter Linux steht die Wave-Zone deshalb *ohne* `~` in `resolvectl domain`, die
  delegierten mit — erst das lässt `ping laptop` auf
  `laptop.rl.wave.internal` laufen. Eine Search-Domain wird nur an
  unqualifizierte Namen angehängt, ein fremdes Suffix dort würde aber die
  Auflösung nackter Namen außerhalb des Waves verändern. macOS kann das nicht:
  `/etc/resolver` leitet nur Namen um, die das Suffix schon tragen;
  Search-Domains stehen dort in der Konfiguration des Netzwerkdienstes und
  gehören dem Nutzer. `configureDns()` liefert deshalb `{ routed, searched }`
  statt eines Ja/Nein, und der Client sagt die Lücke ausdrücklich an.
- **Eine Relay-Sitzung gehört ihrem Socket, nicht ihrem Schlüssel.** `clients`
  ist nach Disco-Key indiziert, und `close()` löschte danach — beim
  Neuverbinden mit demselben Schlüssel räumte der zufallende **alte** Socket
  also die gerade registrierte **neue** Sitzung weg. Sichtbar wurde nichts:
  der Knoten blieb verbunden, das Relay verwarf nur jedes Frame an ihn, was
  sich wie ein stummer Peer liest. Genau der WLAN→LTE-Fall, den D10 den
  Normalfall nennt. Jede Verbindung trägt deshalb eine `id`, und gelöscht wird
  nur, wenn der eingetragene Eintrag dieser ist.
- **Der `xml2js`-Override in der Wurzel-`package.json` ist kein Überbleibsel.**
  `dbus-next` verlangt `^0.4.17` und wird seit Jahren nicht gepflegt; in
  `0.4.23` steckt GHSA-776f-qx25-q3cc (Prototype Pollution), und das Tray
  parst damit die Introspection-XML *fremder* Prozesse auf dem Session-Bus.
  `0.6.2` unterscheidet sich davon in genau einer Sache: `parser.js` schreibt
  mit `Object.defineProperty` statt mit `obj[key] = …`, womit `__proto__` als
  Elementname seine Magie verliert. `builder.js` ist Byte für Byte dasselbe,
  und auf echter Introspection-XML sind Parser- und Builder-Ergebnis beider
  Fassungen identisch (nachgemessen am 23.09.2026). Weil JSON keinen Kommentar
  trägt, steht die Begründung hier — wer den Eintrag wegräumt, holt die Lücke
  zurück. Ein `bun test` merkt davon nichts: die Tray-Tests prüfen reine
  Layout-Funktionen und fassen `dbus-next` nie an.
- **Zwei Go-Toolchains gab es einmal zu viel.** Die stdlib des Compilers
  landet in dem `wireguard-go`, das die Release-Archive tragen und das
  Connector-Image ausführt — beides als root beziehungsweise mit `NET_ADMIN`.
  Der Release-Job stand bis zum 23.09.2026 auf Go 1.23, das mit 1.25 aus der
  Unterstützung gefallen war und 45 offene stdlib-Advisories hatte; das
  Connector-Dockerfile auf 1.25 mit 26. Beide folgen jetzt
  `mobile/core/go.mod` wie `verify` und `e2e`. Reproduzierbar macht den Bau
  `-trimpath` und die gepinnte Pseudoversion des Moduls, **nicht** die Nummer
  des Compilers — eine alte Toolchain kauft also nichts und kostet eine
  wachsende Liste.

## Tests

- Unit-Tests gegen **PGlite** (eingebettetes Postgres, dieselben Migrationen),
  deshalb kein Container nötig.
- **`bun test` deckt den Anmeldeweg nicht ab.** Wer `login`, `up` oder den
  Daemon anfasst, muss die E2E-Skripte fahren — sie brauchen kein root und
  laufen in ein paar Minuten. Am 16.09.2026 stand die CI vier Läufe lang rot,
  weil `wave up` nicht mehr beitritt und die Skripte noch darauf bauten; die
  Unit-Tests waren die ganze Zeit grün.
- **Der Go-Kern hat eigene Tests und läuft nicht mit `bun test`.**
  `./mobile/build.sh check` ist die eine Stelle: gofmt, `go vet`, `go test` und
  die Binder-Erzeugung. Letztere ist der Typcheck für die Sprachgrenze — ein
  Parameter, den gomobile nicht tragen kann, fällt dort auf statt später in
  Xcode. Wer an `canonicalJson`, WaveSig, Disco oder dem DNS-Codec etwas ändert,
  fährt es, denn die Go-Tests prüfen genau diese Bytes gegen die
  TypeScript-Seite.
- **Gefahren werden sie auf der Maschine, nicht von einem Roboter.** Seit dem
  22.09.2026 gibt es keinen Workflow mehr, der auf einen Push oder einen Pull
  Request reagiert; die E2E-Skripte laufen im Job `e2e` des Release-Workflows
  und damit erst an einem Tag. Der Job hält Images und Binaries auf
  (`needs: [version, verify, e2e]`), ein Release kann also nicht an ihm vorbei
  — aber er meldet den Bruch eben erst dort, wo eine Version schon vergeben
  ist. Vor dem Commit selbst fahren ist seitdem kein guter Vorsatz mehr,
  sondern die einzige Stelle, an der es vorher auffällt.
- Die NAT-Topologie der E2E-Tests braucht zwei Dinge, ohne die sie falsche
  Ergebnisse liefert: die NAT-Router müssen unaufgeforderten Eingang
  **verwerfen** (ein verworfenes Paket bekommt keinen Conntrack-Eintrag), und
  die Leitungen brauchen **Latenz** — eine Topologie ohne ist unrealistisch
  härter als das echte Internet.

**Plattformen.** Die Steuerverbindung zwischen Daemon und CLI/Tray nutzt
`node:net` statt einer Bun-spezifischen API — dieselbe Aufrufform liefert unter
Windows eine Named Pipe und sonst einen Unix-Socket. Socket-Rechte und die
Gruppenauflösung gibt es nur auf POSIX; unter Windows regelt die ACL der Pipe
den Zugang. Das Tray liegt hinter `TrayBackend`: Linux spricht D-Bus (reines
JavaScript, weil das Tray dort ein Protokoll ist), macOS und Windows bieten nur
C-APIs und gehen deshalb beide über `bun:ffi`. Fehlt ein Backend, sagt das Tray
das und weist darauf hin, dass der Tunnel davon unberührt ist.

**Das Windows-Tray** (`backend-win32.ts`, Bindung in `win32.ts`, Bytes in
`win32-layout.ts`). Vier Fallen, die dort im Code stehen:

- **Das Fenster darf *kein* Message-only-Window sein.** `Shell_NotifyIcon` hat
  keinen Callback, es schickt eine Nachricht — es braucht also ein Fenster, auch
  wenn nie etwas darin gezeichnet wird. Der naheliegende Griff wäre
  `HWND_MESSAGE`; ein solches Fenster kann aber nie in den Vordergrund, und ein
  Popup-Menü eines Fensters, das nicht im Vordergrund ist, schließt beim Klick
  daneben nicht. Also ein gewöhnliches Toplevel, das einfach nie gezeigt wird.
- **`TrackPopupMenu` braucht zwei Krücken.** Ohne `SetForegroundWindow` davor
  bleibt das Menü beim Klick daneben stehen, ohne das `PostMessage` danach
  schließt es beim *ersten* solchen Klick nicht. Beides sind dokumentierte
  Eigenheiten ohne Alternative. Das Menü läuft dabei in einer eigenen Schleife,
  der Socket ist so lange unbedient — dieselbe Pause wie bei AppKit, und
  ebenso harmlos, weil der Daemon den Tunnel hält.
- **`CreateIconIndirect` kopiert seine beiden Bitmaps.** Wer sie danach nicht
  löscht, verliert bei jedem Farbwechsel zwei GDI-Objekte, und ein Prozess
  bekommt nur zehntausend davon. Das alte `HICON` wird erst *nach* dem
  `NIM_MODIFY` freigegeben, weil die Shell bis dahin noch das alte zeigt.
- **Das Icon ist ARGB, Windows will BGRA.** `iconPixmap()` zeichnet in der
  Reihenfolge, die StatusNotifierItem verlangt; `bgraFromPixmap()` dreht sie,
  und das ist die einzige Stelle, an der das passiert. Dazu eine 1-Bit-Maske
  aus denselben Alphawerten: ob ein 32-Bit-Farbbitmap sein Alpha ins Icon
  rettet, hängt an der Windows-Version, die Maske nicht — mit beiden ist das
  Icon schlimmstenfalls ein hartkantiger Kreis und nie ein Quadrat. Deren
  Zeilen sind auf zwei Byte aufgefüllt; falsch gerechnet zieht sich die Maske
  diagonal übers Icon.

Und `TPM_RETURNCMD` meldet die gewählte Id oder **0 für „abgebrochen"** — das
geht nur auf, weil kein Menüeintrag die Id 0 trägt (`Ids` in `view.ts` beginnt
bei 1). Ein Test hält das fest, damit es beim nächsten Eintrag nicht kippt.

**Das Fenster hinter dem Icon.** Ein Klick aufs Icon öffnet es und tut sonst
nichts; verbunden und getrennt wird auf den Schaltern darin, wo sichtbar ist,
welcher Wave gemeint ist. Ein dbusmenu kann das nicht darstellen — es kennt
Beschriftungen und Trenner, keine Zeilen mit eigenen Bedienelementen —, also ist
es ein echtes Fenster und damit ein Toolkit je Plattform: GTK4 über `bun:ffi`
unter Linux (`window-gtk.ts`), Cocoa über dieselbe Objective-C-Bindung unter
macOS (`window-macos.ts`), GDI über dieselbe Win32-Bindung unter Windows
(`window-win32.ts`). Das Icon und sein Menü funktionieren in jedem Fall weiter;
eine Plattform ohne Fenster bekommt weiterhin `NoWindowBackend`, weil ein
Fenster, das leer aufgeht, schlechter ist als eines, das sich erklärt.

**Die Dienste einer Maschine klappen auf Klick darunter auf**, und ein Klick auf
einen Dienst öffnet ihn im Browser. Fünf Dinge gelten dabei auf allen drei
Plattformen:

- **Der offene Zustand gehört dem Fenster, nicht der `WindowView`.** Die Liste
  wird bei jedem Status-Push neu gebaut, im Sekundentakt — eine Karte, die sich
  so oft von selbst zuklappt, wäre unbedienbar. Verschwindet eine Maschine,
  fliegt ihr Schlüssel aus der Menge, sonst wächst die über Wochen mit.
- **Aufklappbar ist nur, was etwas zu zeigen hat.** Ein Knopf, der sich drücken
  lässt und dann nichts tut, ist kaputt; Maschinen ohne Dienste bleiben, was
  sie waren. Wo sie welche haben, steht statt des Namens die Zahl
  (`10.64.0.5 · 2 services`) und daneben ein Dreieck.
- **Geklickt wird die ganze Zeile, bis zur Kopier-Spalte.** Das Dreieck allein
  ist sechzehn Punkte breit, während Name und Adresse daneben das sind, was wie
  der Knopf aussieht — ein Ziel, das man verfehlt, und gemeldet wird das nicht
  als „das Dreieck ist zu klein", sondern als „die Karte reagiert nicht". GTK
  bekommt es geschenkt, weil ein Button dort ein Kind nimmt und der Text darin
  sitzt, und die Windows-Karte rechnet ihre Trefferflächen ohnehin selbst.
  Cocoa kennt kein Kind im Knopf, also liegt dort ein **transparenter**
  NSButton über Text und Dreieck: er zeichnet nichts, verfolgt aber die Maus
  und schickt seine Action — und nimmt die Zeilen-Tooltip mit hinauf, weil er
  ihn sonst verdeckte. Er endet am Dreieck; das eine auf dieser Zeile, was
  etwas anderes bedeutet, ist der Kopierknopf. Am 26.09.2026 unter macOS so
  gemeldet, wo die Zeile bis dahin tot war.
- **Geöffnet wird nicht im Fenster.** Es ruft `onOpen` und `index.ts` nimmt
  dafür dasselbe `openCommand()`, das schon den Anmeldelink öffnet — drei
  Fenster mit eigenem `Bun.spawn` wären drei Stellen, an denen die
  Plattformweiche falsch sein kann.
- **Neu gezeichnet wird erst im nächsten Durchlauf der Schleife**, nicht im
  Klick-Handler — außer unter Windows. Unter GTK schließt der Neuaufbau genau
  die `JSCallback`, in der man gerade steht, und das ist ein Absturz; unter
  Cocoa ist AppKit noch dabei, die Action an einen Knopf zu schicken, den der
  Neuaufbau aus der Hierarchie nimmt. Beide pumpen ihre Schleife aus einem
  Timer, `setTimeout(…, 0)` ist also ein Handler, der zurückgekehrt ist. Die
  Windows-Karte ist ein Gemälde ohne lebende Bedienelemente und wird sofort neu
  vermessen.

Weil die Zeilen seitdem nicht mehr alle gleich hoch sind, rechnet
`windowLayout()` unter Windows die Liste von oben durch, statt
`index * ROW_HEIGHT` zu nehmen — dieselbe Umstellung brauchte `resize()` unter
macOS, wo die Höhe ohnehin gerechnet und nie gemessen wird.

**Unter macOS wird die Trefferfläche gemessen, nicht behauptet.** Eine reine
Layout-Funktion wie die der Windows-Karte gibt es dort nicht — die Geometrie
gehört Auto Layout —, also baut `window-macos.test.ts` die Karte und liest die
Rahmen zurück: KVC antwortet mit einem `NSValue`, und dessen `description`
druckt das Rechteck. Ein `NSRect` selbst kommt nach wie vor nicht über die
FFI-Grenze; genau deshalb war diese Zeile vorher ungeprüft.

**Das Windows-Fenster malt sich selbst.** Die anderen beiden bauen die Karte
aus Widgets und färben sie per Stylesheet oder Layer; die Common Controls
tragen dagegen die Farben und Formen des Systems mit sich — eine hellgraue
Checkbox auf dunkler Karte ist nicht dieselbe Gestaltung. Deshalb steht in
`window-win32-layout.ts` eine **reine Funktion**, die aus der `WindowView` und
dem Anzeigemaßstab eine Liste von Rechtecken und Trefferflächen macht, und
`window-win32.ts` setzt nur noch GDI-Aufrufe darauf ab — dieselbe Teilung wie
zwischen `win32-layout.ts` und `win32.ts`, und der einzige Weg, ein Layout ohne
Windows-Maschine zu prüfen. Die Maße und die Palette sind die des
GTK-Stylesheets; wer eine Konstante ändert, ändert die Karte nur auf einer
Plattform.

Sechs Dinge stehen dort im Code, und jedes hat einen Grund:

- **Eine eigene Nachrichtenschleife gibt es nicht.** Das Icon pumpt den Thread
  schon in Scheiben, und `PeekMessage` nimmt alles, was für ihn ansteht, dieses
  Fenster eingeschlossen — dieselbe Abmachung, die das macOS-Fenster mit dem
  Menüleisten-Item hat.
- **Gezeichnet wird in ein Speicher-Bitmap und einmal geblittet.** Die Karte
  wird bei jedem Status-Push ganz neu gemalt; Form für Form direkt ins Fenster
  flackert das sichtbar. Und `WM_ERASEBKGND` wird beansprucht, sonst wischt
  Windows vorher noch einmal.
- **Die runden Ecken gehören dem Fenster, nicht der Zeichnung.** Eine runde
  Karte in einem eckigen Fenster lässt vier deckende Ecken stehen; erst
  `SetWindowRgn` schneidet sie weg. Die Region gehört danach Windows — sie
  hier zu löschen wäre ein Double Free.
- **Jedes GDI-Objekt wird gelöscht, kein Stock-Objekt jemals.** Ein Pinsel je
  Form ist billig, zehntausend sind das Handle-Limit, und die Karte wird im
  Sekundentakt neu gemalt. `GetStockObject` liefert dagegen die des Systems.
- **Ein Klick aufs Icon eines offenen Fensters kommt zweimal an.** Er
  deaktiviert das Fenster — das ist unter Windows, anders als unter Hyprland,
  ein verlässliches Signal und genau das, was den Klick daneben ersetzt —, und
  *danach* meldet das Icon seinen eigenen Klick, der es wieder aufmachen würde.
  Deshalb die Sperre von 300 ms in `toggle()`.
- **Der Pfad steht auf der Zeile, nicht in einem Tooltip.** Die anderen beiden
  verstecken ihn in einem; hier ist alles selbst gemalt, und ein Tooltip wäre
  ein zweites Fenster mit eigener Nachrichtenzustellung. Also rechtsbündig auf
  der ersten Zeile, beide Hälften mit Ellipse, weil sich ohne Textmessung keine
  bessere Aufteilung als eine feste finden lässt.

**Das macOS-Fenster ist gelaufen, aber nie angesehen.** Am 15.09.2026 auf einem
Mac geöffnet und vermessen: Fensterrahmen, Stilmaske, Layout und die Aktionen
von Schalter und Kopierknopf stimmen (Auto Layout meldet nichts Mehrdeutiges,
der Kopierknopf landet auf dem echten Pasteboard). Ein Blick darauf fehlt
weiterhin — `screencapture` braucht die Bildschirmaufnahme-Berechtigung, die das
Terminal hier nicht hat. Farben, Schriftgrößen und Abstände gelten deshalb als
gerechnet, nicht als gesehen.

Zwei Dinge sind dort anders als unter Linux, weil die Plattform sie anders löst:

- **Ein NSRect kommt auch nicht heraus.** Deshalb ist die Höhe der Karte
  *gerechnet*: jede Zeile bekommt eine feste Höhe per Constraint, und
  `resize()` addiert dieselben Konstanten. Wer eine Konstante ändert, ändert
  beides. (Zum Nachmessen von außen geht es doch: KVC verpackt `frame` in ein
  `NSValue`, und `getValue:size:` schreibt es in einen eigenen Puffer — gut für
  ein Prüfskript, zu umständlich für den Normalbetrieb.)
- **Den Klick daneben bemerkt das Fenster selbst, und `hidesOnDeactivate` tut
  es nicht.** Es ist der dokumentierte Weg, und in einem Prozess, dessen
  Ereignisschleife von Hand gepumpt wird, passiert es einfach nicht: am
  24.09.2026 gemessen, wurde die App inaktiv —
  `NSApplicationDidResignActiveNotification` kam an, `[NSApp isActive]` kippte —
  und das Fenster blieb auf dem Schirm, in der Liste des Window-Servers, mit
  `isVisible` weiter 1. Damit stand die Karte noch, wenn der nächste Klick aufs
  Icon kam, `toggle()` las das als „ist offen, also zu" und das Öffnen kostete
  **zwei Klicks** — genau so gemeldet und mit dem alten Stand nachgestellt.
  Deshalb fragt `dismissWhenUnfocused()` im Sekundenbruchteil-Takt, ob die Karte
  noch Key ist, und räumt sie sonst selbst weg. Gefragt wird nach der Karte,
  nicht nach der App: ein Menü, ein anderes Fenster und eine andere App nehmen
  ihr alle den Fokus, und nur das erste davon lässt den Prozess aktiv. Erst
  *nachdem* sie den Fokus einmal hatte, zählt sein Verlust —
  `activateIgnoringOtherApps:` wirkt asynchron, und davor beurteilt hieße, eine
  gerade geöffnete Karte sofort wieder zuzumachen.
- **Und danach braucht es dieselbe Sperre wie unter Windows.** Der Klick aufs
  Icon nimmt der Karte den Fokus, das räumt sie weg, und derselbe Klick meldet
  sich danach als Klick aufs Icon — der sie wieder aufmachte. `clickOnIcon()`
  ignoriert deshalb 300 ms nach einem selbst veranlassten Wegräumen, und
  `close()` setzt den Zeitpunkt zurück: wer die Karte selbst zumacht, darf sie
  sofort wieder aufmachen. Escape gibt es weiterhin, als transparenter Knopf
  mit dem Tastenkürzel — ein Key-Equivalent braucht ein Bedienelement, an dem
  es hängt.
- **Das Menü hängt *nicht* am Status-Item.** Ein angehängtes Menü klappt AppKit
  bei jedem Klick selbst auf und meldet keinen davon — das Fenster wäre nie
  erreichbar. Stattdessen hält `MacosTray` das Menü selbst, der Button bekommt
  Ziel und Aktion, und `sendActionOn:` muss beide Maustasten anfordern, weil
  sonst nur die linke gemeldet wird. Rechts- und Control-Klick klappen das Menü
  über `popUpContextMenu:withEvent:forView:` auf, links geht ans Fenster —
  dieselbe Teilung, die unter Linux `ContextMenu` und `Activate` machen. Weil
  das Item das Menü nicht mehr hält, muss der Austausch in `update()` das alte
  freigeben, sonst bleibt bei jedem Status-Push eines liegen.

Drei Fallen, die GTK dabei stellt — zwei davon dieselben wie bei Cocoa:

- **Die Ereignisschleife muss von Hand gepumpt werden.** `gtk_main` würde nie
  zurückkehren und der Daemon-Socket bliebe unbedient; stattdessen
  `g_main_context_iteration(NULL, FALSE)` in kleinen Scheiben, begrenzt, damit
  ein Ereignissturm uns nicht festhält.
- **Jede `JSCallback` muss so lange leben wie ihr Widget.** Wird sie eingesammelt,
  springt der nächste Klick in freigegebenen Speicher. Deshalb gibt `connect()`
  sie zurück, und jede Zeile führt ihre Callbacks mit, bis sie entfernt wird.
- **Das Overlay ist eine Layer-Surface, kein Fenster.** Ein gewöhnliches
  Toplevel kachelt Hyprland in die Sitzung wie einen Editor. `gtk4-layer-shell`
  macht daraus eine Ebene über allem, oben rechts verankert — dafür muss die
  Bibliothek **vor** GTK geladen werden, sonst ist die Wayland-Verbindung schon
  aufgebaut und sie kann die Surface nicht mehr beanspruchen. Deshalb steht ihr
  `dlopen` in `gtk.ts` über dem von GTK, und das ist kein Zufall, den man
  umsortieren darf. Das Protokoll gibt es nur auf wlroots-Compositors (Hyprland,
  Sway); GNOME, KDE und X11 bekommen ein normales Fenster, und `overlayMode()`
  sagt, was es geworden ist.
- **Ein Klick schaltet um, er öffnet nicht nur.** Eine Layer-Surface hat keine
  Titelleiste, mit der man sie wieder loswürde.
- **Die Surface ist bildschirmfüllend und transparent**, gezeichnet wird nur die
  Karte oben rechts. Das ist kein Übermut, sondern die einzige Möglichkeit,
  einen Klick *daneben* zu bemerken: was außerhalb einer Layer-Surface passiert,
  bekommt sie nie zu sehen. `gtk_widget_pick()` sagt, worauf der Druck fiel —
  Karte oder Nachbarschaft.
- **Auf Fokusverlust ist kein Verlass.** Der naheliegende Weg wäre
  `notify::is-active`, aber Hyprland nimmt einer ON_DEMAND-Layer-Surface den
  Tastaturfokus nicht weg: gemessen am 15.09.2026, weder beim
  `hyprctl dispatch focuswindow` noch beim Auftauchen eines neuen Fensters wurde
  das Overlay inaktiv. Der Versuch ist gemacht und gescheitert; er muss nicht
  wiederholt werden.
- **Escape ist der zweite Ausgang**, und nicht nur der Bequemlichkeit wegen:
  liefert ein Compositor den Klick einmal nicht, ist er der Weg heraus.
- **Die Höhe der Karte kommt vom Inhalt**, sonst steht unter der letzten
  Maschine eine leere Fläche. Die Liste scrollt ab 300 px, damit die Karte nicht
  über den Schirm wächst.

**Kein `NSRect` über die FFI-Grenze.** Seine vier Doubles gehen auf arm64 in
Registern und auf x86-64 über den Stack — es gibt keine `objc_msgSend`-Signatur,
die auf beiden stimmt. Deshalb entsteht das Fenster über
`+[NSWindow windowWithContentViewController:]` (ein Objekt) und wird mit
`setContentSize:` bemessen: eine `NSSize` sind zwei Doubles und landen unter
beiden Konventionen in denselben zwei Registern. Das Layout macht `NSStackView`,
damit nie eine Position gesetzt werden muss. `msgSize()` in `objc.ts` ist die
einzige Stelle, an der eine Struktur übergeben wird, und der Kommentar dort sagt
warum.

Zwei weitere Fallen, die dort im Code stehen: `removeArrangedSubview:` nimmt
eine View nur aus dem Layout, nicht aus der Hierarchie — ohne
`removeFromSuperview` zeichnen die alten Zeilen über den neuen. Und eine
Accessory-App ist nicht im Vordergrund, also braucht das Fenster
`activateIgnoringOtherApps:`, sonst erscheint es hinter allem anderen.

**macOS-Tray:** Cocoa bietet kein Protokoll, nur C-APIs — deshalb `bun:ffi` auf
die Objective-C-Laufzeit (`apps/tray/src/objc.ts`). Zwei Fallen: `objc_msgSend`
ist variadisch und muss je Argumentform einzeln geöffnet werden, und
`[NSApp run]` darf **nicht** aufgerufen werden — es kehrte nie zurück und der
Daemon-Socket würde nicht mehr bedient. Stattdessen wird die Ereignisschleife in
kleinen Scheiben von Hand gepumpt.

**Das Icon ist eine Geometrie, keine Datei.** Das Zeichen — drei Knoten auf
einer Scheibe, die Grundlinie des Dreiecks eine Welle — steht einmal in
`apps/tray/src/icon.ts`. Der Tray rastert es dort zur Laufzeit, in genau der
Größe, die die Plattform verlangt (22 und 44 px für StatusNotifierItem,
`SM_CXSMICON` unter Windows, 36 px für die 18 Punkte der macOS-Menüleiste);
`bun run icon` schreibt aus denselben Zahlen `icon.svg` und `favicon.ico` des
Frontends, und `apps/tray/test/icon.test.ts` schlägt fehl, wenn die
eingecheckten Dateien nicht mehr dazu passen. Zwei Dinge daran:

- **Klein wird es kräftiger gezeichnet.** Bis 32 px sind Striche und Knoten
  dicker und die Welle flacher (`detailFor()`); in den Proportionen, die bei
  128 px stimmen, zerfällt die Welle bei 16 px in Krümel.
- **Der Zustand ist die Farbe des ganzen Zeichens**, kein Punkt daran — ein
  Punkt, der in 16 px passt, ist zu klein zum Lesen. Unter macOS deshalb auch
  kein Template-Bild: das färbte das System schwarz oder weiß. Dort geht das
  Icon als PNG an `-[NSImage initWithData:]` (`png.ts`), weil ein
  `NSBitmapImageRep` aus Rohpixeln einen Initialisierer mit elf Argumenten über
  die FFI-Grenze bräuchte. **Auf einem Mac gelaufen ist das noch nicht.**

Das Tray-Binary wird **ohne `--minify` und ohne `--sourcemap`** gebaut: mit
einem von beiden startet es, registriert nichts und hängt still. dbus-next
verlässt sich auf Laufzeit-Namen und Modulidentität, die der transformierte
Build zerstört.

**Die Pfadwahl wehrt sich an drei Stellen gegen Rauschen** — `choosePath()` und
`smoothRtt()` in `packages/magicsock/src/magicsock.ts`, beide rein und deshalb
ohne Netz prüfbar:

- **Das Relay bekommt einen Aufschlag von 15 ms**, damit es nur gewinnt, wenn es
  *deutlich* besser ist. Ein Relay ist bei gleicher Latenz nicht gleichwertig:
  es verbraucht fremde Bandbreite und setzt einen Dritten in den Pfad.
- **Die RTT ist ein gleitender Mittelwert, keine Einzelmessung** (`RTT_ALPHA`,
  ein Viertel Gewicht pro Probe). Am 17.09.2026 zwischen zwei eigenen Knoten
  gemessen: derselbe direkte Pfad meldete innerhalb einer Minute **14 ms und
  110 ms** — WLAN, nicht Störung. Auf der letzten Messung zu entscheiden hieß,
  die Latenz des Relays ständig zu kreuzen; der Pfad wechselte bei fast jeder
  Probe. Vier Proben Einschwingzeit liegen weit innerhalb von
  `PATH_TIMEOUT_MS`, ein wirklich schlecht gewordener Pfad fällt also weiterhin
  rechtzeitig auf.
- **Der amtierende Pfad hat eine Schwelle von 10 ms** (`SWITCH_MARGIN_MS`).
  Glätten allein reicht nicht: zwei Mittelwerte, die eine Millisekunde
  auseinanderliegen, tauschten sonst weiter die Plätze, und jeder Wechsel
  ordnet um, was gerade unterwegs ist. Die Schwelle gilt **nur für einen
  lebenden** Pfad — von einem toten fällt der Verkehr unverzögert herunter.

- **Halb so schnell gewinnt immer** (`SWITCH_RATIO`). Eine absolute Schwelle
  ist im LAN größer als alles, was sie schützen soll: nach einem kurzen
  Aussetzer lag der Verkehr am 28.09.2026 auf dem Umweg über die öffentliche
  Adresse des Routers (13 ms) statt im LAN (5 ms), und acht Millisekunden sind
  keine zehn — zurück kam er nie, solange der Umweg lebte, und jedes Paket
  ging durch das NAT des Routers. Beide Bedingungen gelten, die erste, die
  erreicht ist, entscheidet.

Zu merken ist daran, dass ein Aufschlag gegen Rauschen nur hilft, solange er
größer als das Rauschen ist. 15 ms waren gegen Ausschläge von 100 ms nichts.

Ein Hinweis zur Flakiness: Die socket-basierten Tests (magicsock, relay, dns)
warten mit 2–5-Sekunden-Fristen auf echte Netzwerkereignisse. Unter Last — etwa
wenn parallel ein E2E-Test läuft — sind vereinzelt Ausfälle zu beobachten, die
sich isoliert nicht reproduzieren lassen. Bei einem roten Lauf dort zuerst
nachsehen, bevor ein echter Defekt vermutet wird.

## Deployment

Die Serverseite und die Clusterseite laufen beide in einem k3s-Cluster
(drei Knoten), und zwar aus genau den Kustomize-Bäumen, die
im Repo stehen — es gibt keinen zweiten Weg und keinen Quellbaum auf einem Host:

| Namespace | Baum | Darin |
|---|---|---|
| `wave-mesh` | `deployment/server/overlays/prod` | Control, Web, Relay, Postgres |
| `wave` | `deployment/cluster/overlays/example` | Connector, Operator, interner Ingress |

```bash
export KUBECONFIG=~/.kube/<cluster>.yaml
kubectl diff  -k deployment/server/overlays/prod      # immer zuerst
kubectl apply -k deployment/server/overlays/prod      # der Wave selbst
kubectl apply -k deployment/cluster/overlays/example  # der Cluster als Teilnehmer darin

kubectl exec -n wave-mesh deploy/wave-control -c control -- wave-admin members <wave>
```

Was daran festliegt:

- **Ein Rollout ist ein Tag-Wechsel, kein Bau.** Die Overlays pinnen jede
  Version einzeln (`images:` → `newTag`), nie `latest` oder `develop`: ein
  Rollout soll eine Entscheidung sein und nicht die Nebenwirkung eines
  Neustarts. Gebaut wird ausschließlich im Release-Workflow (siehe „Images und
  Releases"), aktualisiert wird durch Heben des Tags und `apply`. Wer den Tag
  hebt, sieht vorher mit `kubectl diff` nach, ob wirklich nur die Image-Zeilen
  wandern — die Generatoren hängen ihren Inhalts-Hash an den Namen, eine
  unbeabsichtigte ConfigMap-Änderung fällt dort also auf.
- **Die Migration ist ein initContainer von `wave-control`**, kein eigener Job.
  Sie läuft damit bei jedem Rollout und ist ohne neue Migration ein No-op — den
  halb deployten Stapel „neuer Server, alte Datenbank" kann es so nicht geben.
  Ob eine dazugekommen ist, sagt vorher
  `git diff --stat <letzter-tag>..HEAD -- apps/control/drizzle/`.
- **Ein Healthcheck, der die Datenbank nicht anfasst, sagt nichts.** `/healthz`
  antwortet 200, ohne sie zu berühren, und `/api/me` antwortet ohne Sitzung mit
  401, bevor eine Abfrage läuft — beides sah schon einmal gesund aus, während
  jede Registrierung mit 500 scheiterte. Geprüft wird deshalb mit etwas, das
  wirklich durchläuft: `wave login <url>` bis zum Anmeldelink, oder ein
  signiertes `POST /v1/machine/register`, das mit `status: pending` antwortet —
  diese Zeile steht dann in Postgres.
- **Die Geheimnisse liegen neben den Overlays, nicht im Repo.** `secret.env` und
  `dockerconfig.json` stehen in `deployment/.gitignore`; daraus baut der
  `secretGenerator` `wave-secrets` und `ghcr`. Ginge `WAVE_SIGNING_KEY_1`
  verloren, müsste sich jedes Gerät neu anmelden; ginge `WAVE_DNS_SECRET`
  verloren, wären die hinterlegten DNS-Tokens nicht mehr zu öffnen und müssten
  neu gesetzt werden.
- **`WAVE_BASE_URL` trägt `https://`, und daran hängt mehr als der Link.**
  `loadConfig()` leitet daraus `secureCookies` ab — ein Wechsel auf `http://`
  machte die Sitzungscookies still unsicher. Derselbe Name steht im Ingress;
  die beiden müssen übereinstimmen, weil daraus die Anmeldelinks und die
  OAuth-Redirect-URIs entstehen.
- **`WAVE_ACME_DIRECTORY` steht hier bewusst auf dem echten Verzeichnis.** Ohne
  die Zeile wäre es Let's Encrypts Staging. Damit gilt das Rate Limit der
  Domain: ein Fehlversuch kostet eine Woche.
- **Konten entstehen nur auf der Shell.** Es gibt keine Registrierungsseite; die
  Anmeldeseite trägt Argon2id und die Login-Drossel, der Dev-Login ist unter
  `WAVE_ENV=production` ohnehin aus. Angelegt wird mit
  `kubectl exec … -- wave-admin set-password`.
- **Zwei unabhängige Server brauchen getrennte Adresscontainer.** Sonst bekäme
  ein Gerät in beiden Waves dieselben Adressen und verweigerte den zweiten
  (D5) — dafür gibt es `WAVE_IPV4_CONTAINER`.

Alles, was nur für diesen Cluster gilt, steht als Kommentar in den Overlays
selbst und wird hier absichtlich nicht wiederholt: warum STUN über `hostPort`
auf einen festgenagelten Knoten geht statt über einen Service (Hetzners
Load Balancer trägt kein UDP), warum die ClusterIP des internen Ingress fest
vergeben ist (der Connector braucht sie als Zahl für seine nftables-Regel) und
warum das Zustands-Volume auf `local-path` liegt. Wer dort etwas ändert, ändert
es an der Stelle, an der auch die Begründung steht.

## Images und Releases

**Apple-Signierung:** Der Release-Job läuft auf `macos-latest`, baut weiterhin
alle sechs Clients und signiert/notarisiert beide macOS-Archive vor den finalen
Prüfsummen und dem Ed25519-Manifest. `scripts/sign-macos.py` prüft beide Binaries,
Team, Zeitstempel, Hardened Runtime und Notarisierungstickets. Zugangsdaten kommen
aus dem eigenen 1Password-Vault **wave-mesh CI**; der temporäre Schlüsselbund wird
auch bei Fehlern entfernt. Details, geteilte Apple-Zugangsdaten und die noch
erforderliche Abnahme stehen in [`docs/MACOS-SIGNING.md`](docs/MACOS-SIGNING.md).
Tests dafür: `python3 -m unittest discover -s scripts -p 'test_*.py'`.

Jedes Stück, das jemand betreiben muss, bekommt ein eigenes Image auf der
GitHub Container Registry:

| Dienst | Image | Dockerfile |
|---|---|---|
| Control | `ghcr.io/moellenbeck-digital/wave-mesh/control` | `apps/control/Dockerfile` |
| Relay | `ghcr.io/moellenbeck-digital/wave-mesh/relay` | `apps/relay/Dockerfile` |
| Web | `ghcr.io/moellenbeck-digital/wave-mesh/web` | `apps/web/Dockerfile` |
| Connector | `ghcr.io/moellenbeck-digital/wave-mesh/connector` | `apps/connector/Dockerfile` |

Der Build-Kontext ist **das Repo-Wurzelverzeichnis**, nicht das App-Verzeichnis
— alle vier hängen an den Workspace-Paketen und stehen nicht für sich. Das
Connector-Image trägt drei Kommandos (Daemon, Connector, Operator), weil sie
derselbe Teilnehmer sind; welches läuft, entscheidet der Container.

**Zum Ausprobieren baut die `docker-compose.yml` Control und Relay**, es gibt
keinen zweiten Weg mit eigenen Flags, der auseinanderlaufen könnte:

```bash
bun run images:build     # docker compose build control relay
bun run stack:up         # baut und startet Postgres, Migration, Control, Relay
bun run stack:down       # räumt auf, Volume inklusive
```

Der Stapel ist `wave-control:dev` und `wave-relay:dev`; `bun run db:up` startet
weiterhin nur Postgres. Drei Dinge daran sind Absicht:

- **Ein eigener `migrate`-Dienst läuft einmal durch**, bevor der Control-Server
  startet (`service_completed_successfully`) — dasselbe Image, anderes Kommando.
- **Der Teststapel tritt auf `WAVE_ENV=development` zurück.** Das Image steht
  auf `production` und verlangt dort einen Signaturschlüssel; ein fester
  Schlüssel im Repo wäre einer, den irgendwann jemand in ein echtes Deployment
  kopiert. Der Server erzeugt stattdessen einen flüchtigen und sagt es.
- **Die Adressen in `WAVE_RELAYS` zeigen auf den Host, nicht ins Compose-Netz.**
  `wave up` läuft nicht im Container, und STUN braucht ohnehin eine IP statt
  eines Namens.

Gebaut wird für `linux/amd64` und `linux/arm64`. Die Abhängigkeiten installiert
die erste Stufe auf der Architektur des Build-Hosts (`--platform=$BUILDPLATFORM`):
beide Dienste ziehen nur JavaScript, der Baum ist auf beiden Architekturen
derselbe, und arm64 muss nicht unter Emulation installieren. Kopiert wird
danach `/app` **als Ganzes** — Buns isolierter Linker legt jedes Paket unter
`node_modules/.bun` ab und zeigt aus jedem Workspace mit relativen Symlinks
dorthin; einzelne Verzeichnisse herauszupicken zerreißt das.

**Die Operator-CLI liegt als eigenes Binary im Control-Image.** `wave-admin`
steht dort auf dem PATH — `docker exec <container> wave-admin members <wave>`,
ohne `bun` und ohne den Workspace davor. Gebaut wird es in einer eigenen Stufe
des Dockerfiles mit `bun build --compile`, quer übersetzt vom Build-Host aus
demselben Grund, aus dem dort auch installiert wird: das Ziel-Runtime steckt im
Binary, ein arm64-Image muss also keinen Compiler unter Emulation fahren. Das
Ziel ist **musl**, weil das Laufzeit-Image Alpine ist; ein glibc-Binary
scheitert dort mit „not found", was nach einer fehlenden Datei aussieht und
eine fehlende libc ist. Die Quelle bleibt daneben liegen, `bun
apps/control/src/admin.ts` ist also weiterhin dasselbe Programm — und die
Usage nennt von selbst den Weg, über den sie gerade aufgerufen wurde.

Die Migrationen reisen im Control-Image mit, angewandt werden sie von außen:

```bash
docker run --rm --env-file .env.control ghcr.io/.../control bun apps/control/src/db/migrate.ts
docker run --rm --env-file .env.control ghcr.io/.../control wave-admin set-password …
```

**Ein Tag baut auch die Clients.** `scripts/build-clients.sh` übersetzt das
Binary für alle sechs Paare — Linux, macOS und Windows auf je amd64 und arm64 —
und hängt sie als `.tar.gz` beziehungsweise `.zip` mit `SHA256SUMS` ans
GitHub-Release. Drei Dinge daran sind Absicht:

- **Eine Build-Definition, alle Verwendungen.** Dasselbe Skript baut das
  Host-Binary (`--host`), alle sechs zum Prüfen, und im Release mit
  `--package` dazu die Archive. Ein zweiter Aufruf mit eigenen Flags wäre genau
  der, der irgendwann auseinanderläuft — deshalb delegiert auch
  `apps/client/package.json` dorthin.
- **Niemals `--minify` oder `--sourcemap`.** Steht schon beim Tray: mit einem
  von beiden startet das Binary, registriert nichts und hängt still. Das Skript
  sagt es an der Stelle noch einmal, weil dort die Versuchung sitzt.
- **Alle sechs werden auf *einem* Runner übersetzt.** Bun kompiliert die
  Ziel-Runtime mit hinein, also braucht es sechs Builds und nicht sechs
  Maschinen. Geprüft werden alle sechs erst im Release — ein Ziel, das nicht
  mehr übersetzt, fällt damit mitten in einem Tag auf, und der einzige Schutz
  davor ist ein `bun run build:clients` von Hand.

**Die Archive tragen alles, was der Tunnel braucht** — `wireguard-go`, unter
Windows dazu `wintun.dll`, und die Lizenz jedes beigelegten Teils. Damit ist
`wave install` ohne Vorbedingungen brauchbar: der Install kopiert beides neben
das Binary, denn der Daemon sieht weder PATH noch GOPATH (siehe Plattformen).
Vier Dinge daran sind Absicht:

- **wireguard-go wird gebaut, nicht heruntergeladen.** Reines Go ohne cgo,
  also übersetzt ein Runner alle sechs Ziele — dieselbe Begründung wie bei den
  Bun-Binaries. Die Jobs `release` und `e2e` holen sich dafür `setup-go`.
- **Beide Fassungen sind gepinnt**, nicht `@latest`: ein Release muss beim
  Neubau dieselben Bytes ergeben. Die Nummern stehen oben in
  `scripts/build-clients.sh`; zum Anheben sagen
  `go list -m -versions golang.zx2c4.com/wireguard` und wintun.net, was es gibt.
- **Das Wintun-Zip wird gegen seine SHA-256 geprüft, bevor es geöffnet wird.**
  Es ist die einzige Datei hier, die vorgebaut bezogen statt übersetzt wird.
  Wintun gibt es nur als signierte DLL — die Seite nennt das ausdrücklich „the
  only supported way of distributing Wintun".
- **Die Wintun-Lizenz erlaubt genau diesen Fall, und nur ihn.** Klausel 3(d)
  verbietet Weitergabe, *außer* zusammen mit Software, die Wintun allein über
  die dokumentierte API nutzt — das tut wireguard-go. Klausel 3(c) verbietet,
  den Lizenzhinweis zu entfernen, deshalb liegt `LICENSE.wintun` im Archiv.
  Wer die DLL aus dem Archiv löst und für sich weitergibt, verlässt die Lizenz.

Gepackt wird deshalb auch dort, wo nur geprüft wird: ein gewanderter Pin oder
ein Ziel, das nicht mehr übersetzt, zeigt sich erst beim Packen. Seit dem
22.09.2026 passiert das nur noch im Release — wer einen der Pins anhebt, fährt
`bun run build:clients -- --package` besser selbst, bevor er taggt.

**Der Versionsbau läuft ausschließlich über den `release-process`-Skill.**
`.github/workflows/release.yml` hat genau einen Auslöser — einen Tag `v*` —,
kein `workflow_dispatch` und keinen Branch-Trigger. Zwei Prüfungen davor, und
beide fallen nur zusammen mit dem Skill aus:

- **Die Tag-Form.** Erlaubt sind `vX.Y.Z`, `vX.Y.0-insiders.N` und
  `vX.Y.0-develop.N` — die drei Formen, die der Skill vergibt. Alles andere
  bricht den Lauf ab, statt ein Image daraus zu machen.
- **`version` in der Wurzel-`package.json` muss dem Tag entsprechen.** Der
  Skill schreibt die Version und taggt danach; wer von Hand taggt, hat den
  Commit nicht und fliegt hier raus. Die Wurzel ist die einzige Stelle, an der
  die Version steht — die Workspaces bleiben auf `0.0.0`.

Aus dem Tag entstehen neben der vollen Version mitlaufende Tags, damit eine
Installation einem Kanal folgen kann, ohne die Nummern zu kennen: ein Stable
schiebt `X.Y`, `X` und `latest`, ein Vorab-Release nur `insiders`
beziehungsweise `develop`. Nur ein Stable bewegt `latest`.

**Ein kaputtes Dockerfile fällt erst am Tag auf.** Bis zum 22.09.2026 baute
ein CI-Workflow alle vier Images bei jedem Pull Request ohne zu pushen und
fuhr den Stapel danach gegen `/healthz` hoch; mit `ci.yml` ist beides weg. Der
Ersatz ist `bun run images:build` beziehungsweise `bun run stack:up` von Hand —
und für Web und Connector, die im Entwicklungsstapel keinen Dienst haben, ein
`docker build -f apps/<name>/Dockerfile .` aus dem Wurzelverzeichnis.

Das Release selbst entsteht im Job `release`, als letztes und **nach** den
Images: ein Release, das es gibt, während seine Server-Images fehlen, ist eine
Version, von der jemand die Hälfte deployt. **Derselbe Job baut auch die sechs
Clients**, statt sie von einem eigenen entgegenzunehmen. Zwei Jobs können
Dateien nur als Artefakt übergeben, und genau dieses Artefakt war der größte
Posten im Speicher der Organisation: 210 MB je Lauf, sieben Tage lang. Am
22.09.2026 war das Kontingent damit voll und *jeder* Upload schlug fehl —
`v0.1.0-develop.20` hat deshalb Images und kein Release. Die Archive landen
ohnehin am Release, und Release-Assets kosten kein Kontingent. Der Preis ist,
dass die sechs Builds jetzt nach den Images laufen statt daneben. Aus demselben
Grund steht `DOCKER_BUILD_SUMMARY: false` am Image-Job: dessen Build-Record ist
auch nur ein Artefakt, das niemand liest. Nur dieser Job bekommt
`contents: write`, und nur ein Stable bekommt kein `--prerelease` — sonst
trüge ein Insiders-Build das „Latest"-Abzeichen der Repo-Seite.

Genau diese Images laufen im Betrieb (siehe Deployment): die Overlays pinnen
sie mit ihrem Tag und ziehen sie aus der Registry. Gebaut wird ausschließlich
hier, von einem Tag — nirgends sonst und aus keinem Quellbaum.

## Konventionen

- Dokumentation und Antworten auf Deutsch, Code und Commit-Messages auf Englisch.
- Kommentare erklären, **warum** etwas so ist — das Was steht im Code.
- Vor jedem Commit: `bun run check`, `bun run typecheck`, `bun test`.
