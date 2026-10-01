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

## Was offen ist, und was ungeprüft

**Die Telefone selbst sind ungeprüft.** Was ein Telefon bräuchte:

- Kein Lauf auf echter Hardware, auf keiner der beiden Plattformen. Es gibt hier
  weder einen Mac noch ein Android-Gerät, und `gomobile bind` braucht für iOS
  Xcode und für Android das NDK — `./build.sh check` prüft deshalb, was ohne
  beides geht, und die Binder-Erzeugung ist die äußerste Grenze davon.
- **Für iOS fehlt das Xcode-Projekt.** Die Swift-Dateien stehen hier, das
  `.xcodeproj` nicht: es ist eine XML-Datei voller UUIDs, die niemand von Hand
  pflegt und die ohne Xcode nicht erzeugt werden kann. Nötig sind zwei Targets
  (App und Packet-Tunnel-Extension), das Entitlement
  `com.apple.developer.networking.networkextension` mit `packet-tunnel-provider`,
  eine App-Gruppe `group.org.wave` für beide, und die Bundle-Id der Extension
  muss `org.wave.app.tunnel` sein — so heißt sie in `WaveApp.swift`.
- **Das Entitlement gibt es nur mit bezahltem Developer-Account**, auch für das
  eigene Gerät. Ohne ihn lässt sich das hier nicht einmal starten.
- Das Android-Projekt baut, sobald `mobile/build.sh android` die `.aar` gelegt
  hat; ohne sie fehlt Gradle eine Abhängigkeit, und das ist Absicht — die
  Alternative wäre eine Gradle-Task, die Go und das NDK aufruft und dann in
  einer Sprache scheitert, die nach Kotlin aussieht.

Das ist derselbe Stand wie beim Windows-Tray und bei den Cluster-Manifesten:
benannt, nicht verschwiegen.
