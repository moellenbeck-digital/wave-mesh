# wave auf dem Telefon (D10 / M10)

Ein gemeinsamer Kern in Go, die Oberfläche nativ. Warum überhaupt Go und nicht
der vorhandene Client, steht in [`docs/PLAN.md`](../docs/PLAN.md) unter D10: auf
iOS und Android gibt es kein `Bun.spawn`, kein `ip`, kein `resolvectl`, kein
`Bun.udpSocket` — und die iOS-Tunnel-Extension ist bei rund 50 MB gedeckelt, was
eine JS-Runtime darin ausschließt. Portabel ist allein der Vertrag.

```
mobile/
  core/      Go-Kern: alles, was entscheidet. Läuft unter `go test`.
  fixtures/  erzeugt die Vergleichsdaten aus der TypeScript-Seite
  ios/       NEPacketTunnelProvider und SwiftUI
  android/   VpnService und Compose
  build.sh   bindet den Kern (`ios`, `android`), oder prüft ihn (`check`)
```

## Befehle

```bash
./mobile/build.sh check      # gofmt, go vet, go test -race und gobind — braucht kein Telefon
./test/e2e/mobile-core.sh             # der Kern an einem echten TUN, zwei Waves, ein Interface
./test/e2e/mobile-nat.sh              # derselbe Kern durch zwei NATs: direkter Pfad
./test/e2e/mobile-nat.sh --symmetric  # ... und über das Relay, wo Punching nicht geht
./mobile/build.sh ios        # Wavemobile.xcframework (nur auf macOS, braucht Xcode)
./mobile/build.sh android    # wavemobile.aar (braucht ANDROID_HOME mit NDK)
./mobile/build.sh clean

cd mobile/fixtures && bun run generate   # Vergleichsdaten neu erzeugen
```

Weder `.xcframework` noch `.aar` liegen im Repo: je rund 30 MB übersetztes Go,
beide aus dem Quellbaum daneben reproduzierbar. Gepinnt ist die Eingabe —
`core/go.mod` hält wireguard-go, die Krypto-Bibliothek *und* gomobile selbst,
Letzteres als Tool-Abhängigkeit. Eine zweite Nummer im Shell-Skript wäre eine
zweite Stelle zum Vergessen.

## Der Zuschnitt

**Ein Tunnel, N WireGuard-Devices.** Beide Plattformen erlauben genau einen
Tunnel je App. Also liegt unten ein Gerät und darüber je Wave ein virtuelles
`tun.Device`, dazwischen ein Demultiplexer, der ausgehende Pakete nach
Zielpräfix sortiert (`wavetun`). Die Routing-Tabelle dafür ist genau die, deren
Disjunktheit schon `waveoverlap` garantiert — es kommt keine Bedingung hinzu.

**Ein Socket, N Waves.** `wavemagic` besitzt den einen öffentlichen UDP-Port;
jede Wave bekommt daraus eine `conn.Bind`-Sicht, die nur ihre Pakete liefert.
Der Loopback-Socket je Peer entfällt damit: er existiert auf dem Desktop nur,
weil Bun wireguard-go keine `conn.Bind` anbieten kann. Als Bibliothek nimmt es
die echte entgegen, und ein Pfadwechsel fasst die WireGuard-Konfiguration
weiterhin nie an — der Endpoint *ist* der Peer (`wave://<nodeKey>`), keine
Adresse.

**Ein Resolver ohne eigenen Socket.** Die Anfrage kommt als Paket auf dem
Tunnel an. Der Demultiplexer erkennt die Adresse, `wavedns` beantwortet sie aus
einer Suffix→Wave-Tabelle, und die Antwort wird als IP-Paket zurückgeschrieben —
samt Prüfsummen, die über IPv6 nicht optional sind. Bedingung dafür: die
Resolver-Adresse ist **geroutet und keinem zugewiesen**. Eine Adresse, die das
Interface hält, beantwortet der Kernel lokal, wo nichts lauscht. Deshalb
reserviert jeder Wave eine — die 53. seines Blocks, die der Allokator nie
vergibt und die in `dns.resolverAddress` steht.

**N Control-Verbindungen, unverändert.** Die einzige Schicht, die D10 so lässt,
wie sie war: drei Waves heißen drei Maschinenschlüssel, drei gepinnte
Signaturschlüssel, drei Sockets. Sie wissen nichts voneinander.

Was daran festliegt:

- **Schlüssel dürfen sich so wenig überschneiden wie Adressen.** Disco-Pakete
  tragen den Absenderschlüssel im Klartext, und auf einem gemeinsamen Socket
  schlägt die Zuordnung über alle Waves hinweg nach. Ein bösartiger
  Control-Server könnte sonst einen Peer mit dem Disco-Key eines fremden Waves
  ankündigen. `waveoverlap` lehnt den zweiten Wave deshalb ab und nennt beide —
  genau wie bei Adressen.
- **Erst die Vereinigung, dann anwenden.** `setTunnelNetworkSettings` ist atomar
  und kennt kein Teilversagen, also *muss* die Kollisionsprüfung vorher
  stattfinden. Und weil erneutes Anwenden den Tunnel kurz unterbricht, geht eine
  Netmap, die nichts geändert hat, gar nicht erst an die Plattform
  (`wavesettings.Settings.Equal`).
- **Der Netzwechsel ist der Normalfall.** WLAN→LTE löst sofort Rebind, Neu-
  sammeln und `publishEndpoints` aus. Auf dem Desktop wartet der Rebind, bis
  Peers unerreichbar sind; hier wäre das der Unterschied zwischen einer Pause,
  die niemand bemerkt, und zehn Sekunden ohne alles.
- **Android bekommt bei jedem `establish()` einen neuen Deskriptor** und
  schließt den alten. Der Kern muss ihn also austauschen können
  (`Core.ReplaceTunnel`); iOS behält seinen Packet Flow und ruft das nie.
- **Android setzt DNS geräteweit.** `VpnService.Builder.addDnsServer()` kennt
  kein `matchDomains` wie iOS. Die Invariante „nie den System-Resolver
  übernehmen" ist dort nicht haltbar, und aus dem sonst optionalen Weiterreichen
  an die vorherigen Upstreams wird eine Pflicht — sonst bräche jeder Name auf
  dem Telefon, der nicht in einem Wave liegt.
- **Zwei Waves auf einem Interface brauchen eine Quelladressen-Regel.** Mit
  lauter `/32` nimmt der Kernel die erste Adresse des Interfaces; ein Paket in
  die zweite Wave geht dann mit der Quelladresse der ersten hinaus und wird von
  der Gegenseite verworfen. Deshalb bekommen die eigenen Adressen den Präfix,
  der ihre Wave abdeckt (`wavesettings/prefix.go`, abgeleitet aus der Netmap),
  und jede Route trägt zusätzlich ihre Quelladresse — das Erste ist alles, was
  iOS und Android können, das Zweite nutzt Linux.
- **Ein Neustart wechselt den UDP-Port nicht.** Er ist das, wohin die Peers
  senden gelernt haben, und auf einem frischen Port senden sie 15 Sekunden
  weiter an den alten. `DefaultListenPort` ist deshalb dieselbe 41641 wie auf
  dem Desktop; nur der Rebind nach einem Netzwechsel zieht absichtlich um.
- **Beide Plattformen müssen unsere Sockets aus ihrem eigenen Tunnel halten.**
  Unter Android ist das `VpnService.protect`; ohne das liefe der verschlüsselte
  Verkehr in den Tunnel, den er trägt — ein Fehlerbild, das wie ein Peer
  aussieht, der nie antwortet. Der Kern reicht jeden Socket durch
  `Callbacks.ProtectSocket`.

## Der Vertrag wird gegen die TypeScript-Seite geprüft

„Beide Implementierungen sind sich einig" ist eine Aussage über Bytes und kann
von keiner Seite allein gemacht werden. `mobile/fixtures` erzeugt deshalb mit
dem Code, der produktiv läuft, eine Datei mit kanonischem JSON, einer signierten
Netmap, versiegelten Disco-Paketen, einer STUN-Antwort aus unserem eigenen
Server und DNS-Antworten — und die Go-Tests lesen sie. Eine kanonische Kodierung,
die sich in einem Zeichen unterscheidet, ist eine Signatur, die nicht verifiziert,
und auf dem Telefon liest sich das als „netmap signature does not verify": wie
ein Angriff, obwohl es ein Tippfehler ist.

In der Fixture steckt absichtlich ein Feld, das kein Schema kennt. Der Go-Kern
verifiziert die *Bytes*, die ankamen, und liest sie erst danach — was nicht
gelesen wird, kann auch nicht verlorengehen. Das ist dieselbe Regel wie auf der
anderen Seite (`looseObject`, keine `.default()`), nur an einer Stelle, an der
sie sich nicht brechen lässt.

## Was der Kern an einem echten TUN beweist

Zwei Skripte fahren genau diesen Kern auf Linux, mit `mobile/core/cmd/wave-harness`
als Bindeglied: es liefert die zwei Dinge, die sonst die Plattform liefert —
einen Deskriptor und etwas, das die berechneten Settings anwendet (hier über
`ip`). Die Gegenstelle ist jeweils der gewöhnliche Bun-Client, also sind es
zugleich Tests über die Implementierungsgrenze hinweg.

**`mobile-core.sh`** — zwei Control-Server, zwei Waves: ein Interface trägt
beide und es gibt kein `wave1`, ein öffentlicher UDP-Port für beide, ein Peer in
jeder Wave erreichbar, der Resolver antwortet ohne Socket für beide Zonen und
schweigt für alles andere, seine Adresse ist geroutet und keinem zugewiesen, und
ein Neustart kommt mit denselben Adressen und demselben Port zurück, ohne dass
jemand etwas neu freigeben muss.

**`mobile-nat.sh`** — derselbe Kern hinter einem NAT, mit zwei Relays und zwei
STUN-Servern aus der Netmap. Ohne Flag punchen die beiden Implementierungen
einen direkten Pfad gegeneinander; mit `--symmetric` vergeben die NAT-Router pro
Fluss einen zufälligen Port, Punching kann prinzipiell nicht gelingen, und der
Verkehr läuft über das Relay — nachgesehen an dessen Zähler, nicht nur am Log.
Damit ist das Abnahmekriterium von M10 vollständig: zwei Waves, direkter Pfad,
Relay-Fallback.

**Vier Fehler sind dabei aufgefallen, keiner an einem Unit-Test:**

1. **Die `conn.Bind` funktionierte genau einmal.** wireguard-go schließt und
   öffnet sie im Normalbetrieb bei jedem `Up()`; ein Bind, das `Close` für
   endgültig nahm, antwortete danach für immer „bind is closed" — ein Tunnel,
   der nie hochkommt.
2. **Der Neustart wechselte den UDP-Port**, und die Peers sendeten 15 Sekunden
   weiter an den alten. Ein Tunnel, der beidseitig oben aussieht und nichts
   trägt.
3. **Die Quelladresse.** Mit zwei Waves auf einem Interface ging ein Paket in
   die zweite Wave mit der Quelladresse der ersten hinaus und wurde verworfen —
   das Gerät erreichte die erste Wave und die zweite nicht, bei bestätigten
   Pfaden zu beiden.
4. **Eine nil-Map ließ jede Wave mit Relay abstürzen.** Aufgefallen erst, als es
   zum ersten Mal ein Relay gab: auf einem flachen Testsegment braucht niemand
   eins.

Alle vier stehen jetzt als Test da, drei davon zusätzlich als Unit-Test.

## Sprachen

Englisch ist die Grundsprache, Deutsch die Übersetzung; welche gilt, entscheidet
die Systemsprache des Telefons. Einen Schalter in der App gibt es nicht. Beide
Plattformen nehmen dafür ihren eigenen Mechanismus, und der deutsche Text folgt
der Weboberfläche: „du", „der Wave", „Diesen Wave verlassen".

- **iOS: ein String Catalog**, `ios/Wave/Localizable.xcstrings`. Schlüssel ist
  der englische Text selbst. `Text("…")`, `Button("…")` und `Section("…")`
  schlagen Literale von allein nach; was als gewöhnlicher `String` entsteht
  (etwa der Pfad eines Peers), geht ausdrücklich durch `String(localized:)`.
  Eine Interpolation wird dabei zu einem Formatschlüssel — `"\(via) ·
  \(rtt) ms"` mit `String` und `Int` heißt im Katalog `%@ · %lld ms`. Das ist
  der eine Schlüssel, den Xcode beim ersten Öffnen bestätigen sollte: stimmt er
  nicht genau, steht still der englische Text da. Der Katalog gehört in
  **beide** Targets — die Fehlermeldungen der Extension schlagen in deren
  eigenem Bundle nach, nicht in dem der App.
- **Android: Ressourcen**, `res/values/strings.xml` und
  `res/values-de/strings.xml`, gelesen über `stringResource()` in Compose und
  `getString()` im Dienst (Benachrichtigung und ihr Kanal). Der App-Name
  `wave-mesh` ist `translatable="false"` — ein Name, kein Wort.

Was der Kern sagt — Fehlermeldungen aus `login` und `logout`, Log-Zeilen —
bleibt Englisch: er läuft unter `go test` ohne Plattform und kennt keine
Sprache.

## Bauen und hochladen

```bash
./mobile/build.sh ios && cd mobile/ios && xcodegen generate   # dann Wave.xcodeproj in Xcode öffnen
./mobile/build.sh android && cd mobile/android && ./gradlew :app:assembleDebug
./gradlew :app:bundleRelease                                  # das .aab für Google Play
```

Das Xcode-Projekt steht als Text in `ios/project.yml` (XcodeGen); das
`.xcodeproj`, beide `Info.plist` und die Entitlements schreibt `xcodegen
generate`, keines davon liegt im Repo. Lokal signiert Xcode automatisch mit dem
Team `L6R92A4Y7C`. Für den Store signiert `ios/upload.sh`: ein eigener,
temporärer Schlüsselbund mit dem Distribution-Zertifikat, die beiden
App-Store-Profile, Archiv, Export und Upload zu App Store Connect über den
API-Schlüssel — alles aus Umgebungsvariablen, nichts bleibt liegen. Dasselbe
Skript läuft lokal und in CI.

Fest und nie mehr änderbar, sobald die App im Store ist:

| | iOS | Android |
|---|---|---|
| App | `org.wavemesh.app` | `org.wavemesh.app` |
| Tunnel | Extension `org.wavemesh.app.tunnel` | `WaveVpnService` im selben Paket |
| Gemeinsam | App-Gruppe `group.org.wavemesh.app` | — |
| Mindestens | iOS 17, iPhone und iPad | Android 10 (API 29), Ziel API 36 |

Beide Apps zeigen vor der ersten Verbindung einmal, was mit Daten geschieht —
App Review verlangt das von VPN-Apps (Richtlinie 5.4), Google Play ähnlich für
`VpnService`. Erst danach legt iOS die VPN-Konfiguration an bzw. fragt Android
nach der Erlaubnis. Der Text sagt nur, was stimmt: kein Server von uns im Weg,
keine Analyse, keine Werbung. Ändert er sich, bekommt `disclosureAccepted.v1`
eine neue Nummer, damit er erneut erscheint.

## Tests und Diagnose

```bash
cd mobile/core && go test ./wavesettings ./waveengine   # die Form von Einstellungen und Status, als Datei
cd mobile/ios && xcodegen generate && \
  xcodebuild -scheme WaveTunnelTests -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
```

```bash
cd mobile/ios && xcodebuild -scheme Wave -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
test/e2e/docker/run.sh mobile-lifecycle.sh       # die App-Abläufe durch den echten Kern, auf Linux
```

Die App testet sich in zwei Hälften. **Über dem Tunnel** — was sie zeigt, fragt
und tut — mit UI-Tests im Simulator (`WaveUITests`, auf Deutsch, also mit den
Übersetzungen): Hinweis beim ersten Start, Beitritt, Gerätename, falsche
Adresse, Abbruch, Pausieren, Verlassen mit Rückfrage, vom Server entfernt,
anderes VPN, getrennter Tunnel, Dienste, Weboberfläche, Protokoll, „Automatisch
verbinden“. Den Tunnel gibt es im Simulator nicht; an seiner Stelle steht
`FakeTunnel`, das dieselben Nachrichten mit dem JSON des Kerns beantwortet — nur
in Debug-Builds und nur mit `-UITestFakeTunnel`, im Release ist es nicht
enthalten. **Den Tunnel selbst** testet `mobile-lifecycle.sh` auf Linux durch
den echten Kern, über dieselbe Schnittstelle (`wavemobile`).

`core/wavesettings/testdata/settings.json` und `core/waveengine/testdata/status.json`
sind der Vertrag zwischen dem Kern und den Apps: Go prüft, dass es genau diese
Form schreibt, die iOS-Tests lesen genau diese Dateien (neu erzeugen mit
`-update`). Auf dem Telefon selbst gibt es unter **Protokoll** alles, was
Tunnel und App getan haben — Start, Anmeldung, die angewendeten Adressen,
Routen und DNS-Domains, jeden Fehler. Es bleibt auf dem Gerät, bis man es teilt.

## Was offen ist, und was ungeprüft

- **Kein Lauf auf echter Hardware.** Beide Apps bauen und starten (Simulator,
  Emulator), der Tunnel selbst aber nicht: `NEPacketTunnelProvider` gibt es im
  iOS-Simulator nicht, und im Emulator fehlt ein Control-Server. Der erste
  echte Lauf ist der über TestFlight bzw. den internen Test in Google Play.
- **Wie viel Speicher die Extension mit mehreren Waves braucht**, ist nicht
  gemessen. iOS beendet sie bei etwa 50 MB ohne sichtbaren Absturz; wireguard-go
  verkleinert seine Puffer für iOS, aber für *ein* Device, und hier ist es eines
  je Wave. Der Kern setzt unter iOS eine weiche Grenze für den Go-Heap
  (`wavemobile/memory.go`) und schreibt alle fünf Minuten ins Protokoll, was er
  hält — die Zahlen von einem echten Telefon mit zwei Waves stehen noch aus.
- **Der Gerätename auf iOS** ist seit iOS 16 nur noch das Modell („iPhone“);
  die App lässt deshalb einen eigenen Namen eingeben. Er gilt für den nächsten
  Beitritt — ein Wave, in dem das Gerät schon ist, behält seinen Namen, weil der
  Control-Server ihn nur beim Enrolment übernimmt.
- **Android signiert noch nicht für Google Play.** `bundleRelease` erzeugt das
  `.aab` unsigniert; Upload-Schlüssel und Signierung kommen mit der App in der
  Play Console.

Das ist derselbe Stand wie beim Windows-Tray und bei den Cluster-Manifesten:
benannt, nicht verschwiegen.
