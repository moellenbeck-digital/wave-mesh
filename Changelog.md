# Changelog wave-mesh

Selbst hostbares Mesh-VPN auf WireGuard-Basis.

---

## 🔮 In Entwicklung (Ausblick auf nächstes Release)

*Seit v0.7.0-develop.3 ist nichts hinzugekommen.*

---

## 🔬 Development v0.7.0-develop.3 (05.10.2026)

### Neue Funktionen

- **Aus einem Cluster in den Wave.** Pods in einem Cluster mit Connector
  erreichen Dienste und Geräte des Waves über deren Namen, etwa
  `https://plausible.wave.example.com` — auch Dienste, die ein anderer Cluster
  in den Wave stellt. TLS bleibt dabei Ende zu Ende; nur HTTP und HTTPS.
  Eingeschaltet wird es je Cluster mit der Komponente `components/egress` und
  einem CoreDNS-Eintrag, der als Vorlage beiliegt.

---

## 🔬 Development v0.7.0-develop.2 (04.10.2026)

*Derselbe Inhalt wie develop.1. Dessen Build ist an einem Fehler im Testskript
gescheitert und hat keine Images und kein Release hervorgebracht.*

---

## 🔬 Development v0.7.0-develop.1 (04.10.2026)

### Neue Funktionen

- **Zwei-Faktor-Anmeldung mit einer Authenticator-App** für die Anmeldung mit
  E-Mail und Passwort. Eingerichtet wird auf der neuen Seite „Dein Konto“
  (die eigene Adresse oben rechts): QR-Code scannen, ersten Code bestätigen,
  zehn Wiederherstellungscodes sichern. Danach fragt die Anmeldung nach dem
  Passwort noch nach dem Code aus der App.
- **Für das verlorene Telefon:** ein Wiederherstellungscode meldet einmal an,
  und der Betreiber kann den zweiten Faktor mit
  `wave-admin disable-2fa <email>` abschalten.

> Wer sich über Google oder Pocket ID anmeldet, nutzt deren zweiten Faktor;
> dort gibt es hier nichts einzurichten.

---

## ✅ Stable v0.6.0 (03.10.2026)

### Neue Funktionen (gegenüber v0.5.0)

- **Anmeldung über Pocket ID** und jeden anderen OpenID-Connect-Provider
  (Authelia, Authentik, Keycloak …). Der Betreiber trägt Issuer, Client-ID und
  einen Namen ein; auf der Anmelde- und der Einladungsseite steht dann etwa
  „Weiter mit Pocket ID". Mit Pocket ID meldet sich niemand mehr mit einem
  Passwort an, nur noch mit einem Passkey.

> Einladungen annehmen kann nur, wessen Adresse der Provider als bestätigt
> meldet — in Pocket ID ist das die Einstellung „Emails Verified". An den
> Clients hat sich nichts geändert; Geräte auf dem Kanal stable bekommen v0.6.0
> trotzdem angeboten, mit demselben Code wie v0.5.0.

---

## ✅ Stable v0.5.0 (02.10.2026)

*Enthält alles aus v0.5.0-develop.1.*

### Neue Funktionen (gegenüber v0.4.0)

- **Deutsch und Englisch überall.** Weboberfläche, die Seiten des
  Control-Servers, `wave`, das Tray-Icon, `wave-admin` und die Apps gibt es in
  beiden Sprachen; ist die eigene keine davon, gilt Englisch. *(seit develop.1)*
- **Umschalter DE | EN in der Kopfzeile** der Weboberfläche, auch vor der
  Anmeldung. Ohne Wahl gilt die Sprache des Browsers. *(seit develop.1)*
- **`wave` und das Tray-Icon folgen der Systemsprache**, `WAVE_LANG=en` oder
  `WAVE_LANG=de` legt sie fest. Meldungen des Dienstes erscheinen in der
  Sprache dessen, der sie liest. *(seit develop.1)*
- Das Tray-Menü sagt jetzt, warum sich ein Gerät nicht selbst aktualisiert.
  *(seit develop.1)*

### Verbesserungen (gegenüber v0.4.0)

- Ist eine Gerätefreigabe abgelaufen oder ein Wave noch leer, nennt die Seite
  den richtigen Befehl: `wave login <control-server-url>` statt `wave up`.
  *(seit develop.1)*

> Geräte auf dem Kanal stable bekommen diese Version von selbst angeboten. Die
> Protokolle des Dienstes und des Servers bleiben englisch.

---

## 🔬 Development v0.5.0-develop.1 (02.10.2026)

### Neue Funktionen

- **Deutsch und Englisch überall.** Weboberfläche, die Seiten des
  Control-Servers, `wave`, das Tray-Icon, `wave-admin` und die Apps gibt es in
  beiden Sprachen; ist die eigene keine davon, gilt Englisch.
- **Umschalter DE | EN in der Kopfzeile** der Weboberfläche, auch vor der
  Anmeldung. Ohne Wahl gilt die Sprache des Browsers.
- **`wave` und das Tray-Icon folgen der Systemsprache**, `WAVE_LANG=en` oder
  `WAVE_LANG=de` legt sie fest. Meldungen des Dienstes erscheinen in der
  Sprache dessen, der sie liest.
- Das Tray-Menü sagt jetzt, warum sich ein Gerät nicht selbst aktualisiert.

### Verbesserungen

- Ist eine Gerätefreigabe abgelaufen oder ein Wave noch leer, nennt die Seite
  den richtigen Befehl: `wave login <control-server-url>` statt `wave up`.

> Protokolle des Dienstes und des Servers bleiben englisch, damit man sie
> durchsuchen und vergleichen kann.

---

## ✅ Stable v0.4.0 (02.10.2026)

*Enthält alles aus v0.4.0-develop.1 und v0.4.0-develop.2.*

### Neue Funktionen (gegenüber v0.3.0)

- **Zugriffsregeln als Graph.** Auf der Zugriffsseite eines Waves stehen
  Mitglieder, Gruppen, Rollen, Tags, Dienste und „alle“ als Karten; eine Regel
  ist ein Pfeil, den man von einer Karte zur anderen zieht, und die Ports
  hängen an der Kante. Der erste Pfeil schaltet die Policy ein — ab dann gilt
  nur noch, was ein Pfeil erlaubt. *(seit develop.1)*
- **Gruppen und Tags direkt auf der Seite.** Gruppen werden angelegt und mit
  Mitgliedern gefüllt, Tags angelegt und Geräten gegeben. Die Seite zeigt
  dabei sofort, welche Geräte eine Karte trifft und wer danach wen erreicht —
  noch bevor gespeichert ist. Gespeichert wird alles auf einmal, mit
  „Rückgängig“ und „Verwerfen“ davor. *(seit develop.1)*
- Die Policy lässt sich weiterhin als JSON bearbeiten, aufklappbar unter dem
  Graphen. *(seit develop.1)*

### Verbesserungen (gegenüber v0.3.0)

- **Die Leiste zum Bearbeiten steht rechts neben dem Graphen**, die
  Zugriffsseite ist dafür so breit wie die Kopfzeile. *(seit develop.2)*
- Die Übersicht beginnt direkt mit den Wave-Karten. *(seit develop.1)*

> An den Clients hat sich nichts geändert. Geräte auf dem Kanal stable
> bekommen v0.4.0 trotzdem angeboten und installieren sie — mit demselben
> Code wie v0.3.0.

---

## 🔬 Development v0.4.0-develop.2 (01.10.2026)

### Verbesserungen

- **Die Leiste zum Bearbeiten steht rechts neben dem Graphen**, nicht mehr
  darunter: wer eine Karte oder einen Pfeil antippt, sieht sofort, was sich
  dort einstellen lässt. Die Zugriffsseite ist dafür so breit wie die
  Kopfzeile; auf schmaleren Bildschirmen rutscht die Leiste weiter unter den
  Graphen.

---

## 🔬 Development v0.4.0-develop.1 (01.10.2026)

### Neue Funktionen

- **Zugriffsregeln als Graph.** Auf der Zugriffsseite eines Waves stehen
  Mitglieder, Gruppen, Rollen, Tags, Dienste und „alle“ als Karten; eine Regel
  ist ein Pfeil, den man von einer Karte zur anderen zieht, und die Ports
  hängen an der Kante. Der erste Pfeil schaltet die Policy ein — ab dann gilt
  nur noch, was ein Pfeil erlaubt.
- **Gruppen und Tags direkt auf der Seite.** Gruppen werden angelegt und mit
  Mitgliedern gefüllt, Tags angelegt und Geräten gegeben. Die Seite zeigt
  dabei sofort, welche Geräte eine Karte trifft und wer danach wen erreicht —
  noch bevor gespeichert ist. Gespeichert wird alles auf einmal, mit
  „Rückgängig“ und „Verwerfen“ davor.
- Die Policy lässt sich weiterhin als JSON bearbeiten, aufklappbar unter dem
  Graphen.

### Verbesserungen

- Die Übersicht beginnt direkt mit den Wave-Karten, ohne Einleitung darüber.

---

## ✅ Stable v0.3.0 (01.10.2026)

*Enthält alles aus v0.3.0-develop.1.*

### Neue Funktionen (gegenüber v0.2.0)

- **Der Update-Dialog trägt das wave-Zeichen** statt eines Systemsymbols —
  unter macOS im Dialog, unter Windows im Fenster und in seiner Titelleiste,
  unter Linux in der Benachrichtigung. Unter Windows ist der Dialog ein eigenes
  kleines Fenster mit „Install now" und „Later" statt einer Ja/Nein-Abfrage.
  *(seit develop.1)*

> Geräte mit v0.2.0 bekommen diese Version von selbst angeboten — und sehen
> dabei den Update-Dialog zum ersten Mal, noch in seiner alten Form.

---

## 🔬 Development v0.3.0-develop.1 (01.10.2026)

### Neue Funktionen

- **Der Update-Dialog trägt das wave-Zeichen** statt eines Systemsymbols —
  unter macOS im Dialog, unter Windows im Fenster und in seiner Titelleiste,
  unter Linux in der Benachrichtigung. Unter Windows ist der Dialog dafür ein
  eigenes kleines Fenster mit „Install now" und „Later" statt einer
  Ja/Nein-Abfrage.

---

## ✅ Stable v0.2.0 (01.10.2026)

*Clients halten sich ab dieser Version selbst aktuell. Enthält alles aus
v0.2.0-develop.1 bis v0.2.0-develop.4.*

### Neue Funktionen (gegenüber v0.1.0)

- **Clients aktualisieren sich selbst.** Der Control-Server bietet neue
  Releases an, der Dienst installiert sie nach einer zufälligen Wartezeit von
  bis zu vier Stunden und kehrt von allein zur alten Version zurück, wenn die
  neue keinen Server erreicht. Installiert wird nur, was mit dem
  Release-Schlüssel signiert ist, und nie eine ältere Version. *(seit develop.1)*
- **Neue Befehle:** `wave version` zeigt die installierte Fassung und ob eine
  neuere ansteht, `wave update` installiert sie sofort, `--channel` und
  `--auto-update on|off` stellen Kanal und Automatik ein. *(seit develop.1)*
- **Update-Dialog:** Eine neue Version meldet sich einmal mit einem Dialog,
  der mit einem Klick installiert; Tooltip und Menü des Tray-Icons nennen sie
  ebenfalls. *(seit develop.1 und develop.4)*
- **Client-Versionen in der Weboberfläche:** Die Geräteliste zeigt, welche
  Version und welcher Update-Kanal auf jedem Gerät läuft, live aktualisiert.
  *(seit develop.2)*

### Für Betreiber

- `WAVE_UPDATE_CHANNELS` legt fest, welche Kanäle ein Server anbietet
  (`stable`, `insiders`, `develop`; der erste ist die Vorgabe, ungesetzt
  `stable`). Ohne `WAVE_GITHUB_TOKEN` — Fine-grained, nur dieses Repository,
  „Contents: read" — wird nichts angeboten.
- `wave-admin devices` zeigt Version und Kanal jedes Geräts.
- Eine Datenbankmigration läuft beim Rollout von selbst mit.

> Clients von v0.1.0 und älter können sich noch nicht selbst aktualisieren:
> auf jedem Gerät einmal von Hand `sudo ./wave install` mit dieser Version,
> danach geht es von allein.

---

## 🔬 Development v0.2.0-develop.4 (01.10.2026)

*Ein neues Update meldet sich jetzt mit einem Dialog.*

### ✨ Update-Dialog mit „Install now"

Steht eine neue Version bereit, erscheint einmal ein Dialog, der beide
Versionen nennt, sagt, wann sich das Gerät sonst selbst aktualisiert, und mit
einem Klick sofort installiert. Unter Linux ist das eine Desktop-Benachrichtigung
mit dem Knopf „Install now" — wo der Benachrichtigungsdienst keine Knöpfe kennt,
genügt ein Klick auf die Meldung —, unter macOS ein Dialog mit „Later" und
„Install now", unter Windows eine Meldung mit Ja und Nein.

Nach „Later" kommt der Dialog für diese Version nicht wieder; der Eintrag
„Install update now" im Menü des Tray-Icons bleibt.

> Zu sehen ist der Dialog ab dem ersten Update *nach* dieser Version: er muss
> im Tray stecken, das das Angebot bekommt.

---

## 🔬 Development v0.2.0-develop.3 (01.10.2026)

*Keine neuen Funktionen: ein Release, an dem sich die Selbst-Updates erproben
lassen. Ein Gerät mit v0.2.0-develop.1 oder .2 auf dem Kanal `develop` sollte
sich von selbst auf diese Version heben.*

---

## 🔬 Development v0.2.0-develop.2 (01.10.2026)

*Die Weboberfläche zeigt, welche Version auf jedem Gerät läuft.*

### ✨ Client-Version in der Geräteliste

In der Geräteliste steht jetzt unter dem Betriebssystem, welche Version des
Clients ein Gerät fährt und welchem Update-Kanal es folgt — etwa
`v0.2.0-develop.1 · develop`. So ist auf einen Blick zu sehen, wer zurückhängt.
Die Anzeige folgt live: meldet sich ein Gerät nach einem Update mit der neuen
Version, ändert sie sich ohne Neuladen. Geräte mit Clients von vor den
Selbst-Updates melden ihre Version nicht und stehen dort als „Version
unbekannt".

---

## 🔬 Development v0.2.0-develop.1 (01.10.2026)

*Installierte Clients halten sich ab jetzt selbst aktuell.*

### ✨ Clients aktualisieren sich selbst

Bisher blieb ein installiertes Gerät auf seiner Version stehen, bis jemand ein
neues Archiv holte und `wave install` noch einmal ausführte. Jetzt bietet der
Control-Server seinen Geräten neue Releases an, und der Dienst installiert sie
nach einer zufälligen Wartezeit von bis zu vier Stunden selbst. Erreicht die
neue Fassung danach binnen fünf Minuten keinen Server, kehrt das Gerät von
allein zur alten zurück und nimmt diese Version nie wieder.

Installiert wird nur, was mit dem Release-Schlüssel signiert ist, den das
Programm mitbringt — der Control-Server reicht Releases nur weiter und kann
nichts unterschieben. Ältere Versionen werden nie installiert.

```bash
wave version                     # welche Fassung, und ob eine neuere ansteht
wave update                      # die neuere jetzt statt später
wave update --channel insiders   # ein anderer Kanal, sofern der Server ihn anbietet
wave update --auto-update off    # nur noch anzeigen
```

Das Tray-Icon nennt ein anstehendes Update im Tooltip, im Menü (mit „Install
update now") und im Fenster.

### Für Betreiber

- **Welche Kanäle ein Server anbietet**, legt `WAVE_UPDATE_CHANNELS` fest:
  `stable`, `insiders`, `develop`, mehrere mit Komma, der erste ist die
  Vorgabe. Ungesetzt ist es `stable`. Ein Gerät kann sich einen anderen aus der
  Liste wünschen, keinen darüber hinaus.
- **Ohne `WAVE_GITHUB_TOKEN` wird nichts angeboten.** Nötig ist ein
  Fine-grained Token nur für dieses Repository mit „Contents: read"; er bleibt
  auf dem Server.
- **`wave-admin devices` zeigt jetzt die Version jedes Geräts** und seinen
  Kanal. Geräte mit älteren Clients stehen dort als „version unknown".
- Eine neue Datenbankmigration läuft beim Rollout von selbst mit.

> Der erste Client mit dieser Funktion muss noch einmal von Hand installiert
> werden; ab dann geht es von allein.

---

## ✅ Stable v0.1.0 (01.10.2026)

*Die erste stabile Version: sie enthält alles aus v0.1.0-insiders.1 bis
v0.1.0-insiders.9 und dazu die Änderung unten.*

### 📦 Neues Zuhause: moellenbeck-digital

wave-mesh liegt jetzt im Repository `moellenbeck-digital/wave-mesh`. Die Images
kommen ab dieser Version aus `ghcr.io/moellenbeck-digital/wave-mesh/*`; wer sie
bisher unter `ghcr.io/pinguin45orga/wave-mesh/*` bezogen hat, stellt die
Adresse um. An bestehenden Anmeldungen, Geräten und Adressen ändert sich
nichts.

### Das Wichtigste aus den Vorschau-Versionen

- **Zugriffsregeln:** Eine Policy legt fest, wer wen erreicht — nach Personen,
  Gruppen, Rollen, Diensten oder Tags, mit Ports und Richtung. Ohne Policy
  erreicht weiterhin jedes Gerät jedes andere. *(seit insiders.5)*
- **Verlauf:** Jede Änderung an einem Wave wird mit Zeit und Person
  festgehalten. *(seit insiders.5)*
- **Neuer Name und eigenes Icon:** Aus wave-net wurde wave-mesh, mit eigenem
  Zeichen im Tray und im Browser-Tab. *(seit insiders.7 und insiders.9)*
- **Neue Lizenz:** Elastic License 2.0 statt MIT. *(seit insiders.9)*
- **Schonender fürs Netz:** Keine wachsenden Adresslisten mehr, die Heimrouter
  volllaufen ließen, und deutlich weniger Anfragen an Adressen, die nie
  antworten. *(seit insiders.1 und insiders.6)*
- **Robuster nach Ruhezustand und WLAN-Aussetzern:** Die Relay-Verbindung baut
  sich selbst neu auf, und der Verkehr kehrt auf den direkten Weg zurück.
  *(seit insiders.2)*

---

## 🧪 Insiders v0.1.0-insiders.9 (01.10.2026)

*Neu gegenüber v0.1.0-insiders.8.*

### ✨ Ein eigenes Icon

wave-mesh hat ein Zeichen: drei verbundene Knoten auf einer Scheibe, die
Grundlinie eine Welle. Es steht im Tray unter Linux, Windows und macOS und als
Symbol im Browser-Tab der Oberfläche. Der Tray zeigt den Zustand wie bisher an
der Farbe — Petrol verbunden, Gelb verbindend, Grau getrennt. Unter macOS
ersetzt es den farbigen Punkt in der Menüleiste; dort ist es neu und noch
nicht auf echter Hardware erprobt.

### 📄 Neue Lizenz: Elastic License 2.0

wave-mesh steht ab dieser Version unter der Elastic License 2.0 statt MIT.
Benutzen, verändern und weitergeben bleibt erlaubt, auch im eigenen
Unternehmen; nicht erlaubt ist, wave-mesh Dritten als gehosteten oder
verwalteten Dienst anzubieten. Frühere Versionen bleiben unter MIT.

---

## 🧪 Insiders v0.1.0-insiders.8 (30.09.2026)

*Neu gegenüber v0.1.0-insiders.7.*

### 🐛 Logo im Seitenkopf

Der Seitenkopf der Oberfläche zeigte noch „wavenet“; jetzt steht dort
„wavemesh“.

---

## 🧪 Insiders v0.1.0-insiders.7 (30.09.2026)

*Neu gegenüber v0.1.0-insiders.6.*

### ✨ Neuer Name: wave-mesh

Das Projekt heißt jetzt **wave-mesh** statt wave-net — in der Oberfläche, in
der Beschreibung des Dienstes auf dem Gerät und im Repository. Die Images
liegen ab dieser Version unter `ghcr.io/pinguin45orga/wave-mesh/*`. An
bestehenden Anmeldungen, Geräten und Adressen ändert sich nichts.

---

## 🧪 Insiders v0.1.0-insiders.6 (30.09.2026)

*Neu gegenüber v0.1.0-insiders.5.*

### 🐛 Weniger Fehlversuche ins Leere

Ein Gerät probiert jede Adresse, unter der ein anderes vielleicht erreichbar
ist — auch solche, die von hier aus gar nicht erreichbar sind, etwa das
Heimnetz eines anderen Standorts. Eine Adresse, die nie antwortete, bekam
bisher viermal pro Sekunde eine Anfrage, und zwar dauerhaft. Das kostete
Verbindungseinträge im eigenen Router und füllte das Log mit Hunderten von
Meldungen wie „socket error(s) ignored“ pro Minute. Nach den ersten fünf
Sekunden wird eine solche Adresse jetzt nur noch alle drei Sekunden gefragt,
so oft wie eine funktionierende. Verbindungen kommen genauso schnell zustande
wie vorher, auch auf den Telefonen.

---

## 🧪 Insiders v0.1.0-insiders.5 (29.09.2026)

*Neu gegenüber v0.1.0-insiders.2. Die Tags v0.1.0-insiders.3 und .4 wurden nie
veröffentlicht: der Test der Zugriffsregeln fand zuerst einen Fehler in sich
selbst und dann einen echten — unter Ubuntu 24.04 hätten Linux-Geräte die Ports
nicht durchgesetzt. Beides ist hier behoben.*

### ✨ Zugriffsregeln: wer wen erreicht

Bisher erreichte in einem Wave jedes Gerät jedes andere, auf allen Ports. Das
bleibt so, solange niemand etwas anderes festlegt. Jetzt lässt sich für einen
Wave eine Policy setzen, und dann ist nur noch erlaubt, was eine Regel nennt:
etwa „meine Geräte erreichen das NAS, aber nur für Dateifreigaben“, oder „der
Kubernetes-Connector erreicht niemanden von sich aus“.

- Regeln nennen Personen, Gruppen, Rollen, Dienste oder **Tags**. Ein Tag
  kennzeichnet eine Maschine — `tag:nas`, `tag:server` — und ein getaggtes
  Gerät zählt nicht mehr als Gerät seines Besitzers.
- Ein Gerät, das eine Regel nicht erlaubt, ist für die anderen gar nicht erst
  da. Das gilt sofort für jedes Gerät, auch für eines mit älterer Version.
- Die erlaubten **Ports und die Richtung** setzt jedes Gerät selbst durch:
  unter Linux und im Kern der Telefon-Apps geprüft, unter macOS und Windows
  neu und dort noch nicht auf echter Hardware erprobt. Welches Gerät die Ports
  hält, zeigt die neue Zugriffsseite.
- Verwaltet wird auf der neuen Seite **Zugriff** in der Wave-Karte, für
  Eigentümer und Admins, oder mit `wave-admin`.

### ✨ Verlauf

Jede Änderung an einem Wave — Regeln, Tags, Mitglieder, Einladungen, Geräte,
Domain — wird mit Zeit und Person festgehalten und ist auf der Zugriffsseite
zu sehen.

---

## 🧪 Insiders v0.1.0-insiders.2 (28.09.2026)

*Neu gegenüber v0.1.0-insiders.1.*

### 🐛 Nach dem Ruhezustand wieder erreichbar

Wachte ein Laptop aus dem Ruhezustand auf, blieb seine Verbindung zum Relay
still tot: die Anzeige sagte „relay connected“, aber Geräte, die nur über das
Relay erreichbar sind — etwa ein Connector in einem Kubernetes-Cluster —
standen auf „connecting…“, bis wave neu gestartet wurde. Jetzt prüft wave die
Relay-Verbindung alle 15 Sekunden und baut sie neu auf, sobald sie nicht mehr
antwortet. Das gilt ebenso für den Kern der Telefon-Apps, wo Schlafen der
Normalfall ist.

### 🐛 Der Verkehr findet ins lokale Netz zurück

Nach einem kurzen Aussetzer im WLAN konnte der Verkehr zwischen zwei Geräten im
selben Netz auf dem Umweg über den Router hängen bleiben, obwohl der direkte
Weg längst wieder da und mehr als doppelt so schnell war. Jetzt wechselt wave
zurück, sobald der direkte Weg deutlich schneller ist.

---

## 🧪 Insiders v0.1.0-insiders.1 (28.09.2026)

*Die erste Vorschau-Version: sie enthält alles aus den Development-Builds bis
v0.1.0-develop.28 und dazu die beiden Änderungen unten.*

### 🐛 wave legt keinen Router mehr lahm

Ein Gerät hinter einem NAT, das jeder Verbindung einen neuen Port gibt — ein
Kubernetes-Knoten, ein Handy-Hotspot —, meldete jede Minute eine neue eigene
Adresse und vergaß nie eine alte. Nach zwei Tagen waren es beim Connector gut
2600, und jedes andere Gerät im Wave versuchte sie alle mehrmals pro Sekunde.
Jeder dieser Versuche belegt auf dem Router davor einen Eintrag, und ein
Heimrouter ist damit irgendwann voll: das Internet wird für alle im Haus
langsam oder bricht ab.

Jetzt verfallen solche Adressen nach wenigen Minuten, Geräte vergessen
Adressen, die ein anderes Gerät nicht mehr meldet, und der Server gibt je
Gerät nur noch eine kleine Zahl weiter — auch für Geräte, die noch eine ältere
Version fahren. Das gilt ebenso für den Kern der Telefon-Apps.

### 🐛 Die ganze Zeile klappt die Dienste auf

Im Tray-Fenster unter macOS reagierte nur das kleine Dreieck auf einen Klick,
nicht der Name und die Adresse daneben. Jetzt klappt die ganze Zeile auf.

---

## 🔬 Development v0.1.0-develop.28 (26.09.2026)

*Die Dienste eines Clusters stehen jetzt überall dort, wo auch die Geräte
stehen — und ein Klick öffnet sie.*

### ✨ Dienste auf Klick, unter ihrem Gerät

Ein Connector bringt so viele Namen mit, wie der Cluster Ingresse hat. In der
Weboberfläche standen sie bisher alle ausgeschrieben unter ihrem Gerät und
schoben die Geräteliste aus dem Blick; auf dem Gerät selbst — im Tray-Fenster
und in `wave status` — gab es sie überhaupt nicht zu sehen.

Jetzt klappt ein Klick auf ein Gerät seine Dienste darunter auf, ein zweiter
klappt sie wieder zu, und ein Klick auf einen Dienst öffnet ihn im Browser.
Das gilt für die Weboberfläche und für das Tray-Fenster auf allen drei
Plattformen; welche Geräte offen sind, überlebt dabei die laufende
Aktualisierung. Geräte ohne Dienste bleiben, was sie waren.

`wave status` schreibt sie stattdessen eingerückt unter ihre Maschine — im
Terminal gibt es nichts anzuklicken. Es ist auch die einzige Ansicht, die die
Dienste des eigenen Geräts zeigt: wer den Client selbst als Connector fährt,
sah sie bislang nirgends.

### 🔗 Ein Link, überall derselbe

Ob ein Dienst `http` oder `https` spricht, weiß nur der Cluster; unter welcher
Domain er hängt, nur der Wave. Beides weiß der Server — und er schreibt die
Adresse jetzt einmal aus und schickt genau diese an alle: an den Browser, an
jedes Gerät, an die Shell. Vorher setzte sie sich jede Ansicht selbst zusammen,
und vier Schreibweisen derselben Adresse sind vier Gelegenheiten,
auseinanderzulaufen. Ein Dienst, der nur Klartext spricht, wird damit nirgends
mehr als `https`-Link angeboten — ein Link, der ins Leere geführt hätte.

---

## 🔬 Development v0.1.0-develop.27 (26.09.2026)

*Die Geräteliste in der Oberfläche aktualisiert sich von selbst.*

### ✨ Geräte, Status und Dienste ohne Neuladen

Bisher zeigte die Übersicht den Stand vom Moment des Aufrufs: ein Gerät, das
sich gerade verband, eines, das dazukam oder entfernt wurde, ein Cluster, der
andere Dienste meldete — nichts davon erreichte eine Seite, die schon offen
war. Man hat neu geladen und nachgesehen.

Die Karte hängt jetzt an einer laufenden Verbindung zum Control-Server und
zeichnet neu, sobald sich etwas ändert: der Punkt neben einem Gerät, die Zahl
in „3 von 5 Geräten verbunden", die Liste selbst und die Dienste darunter.

Zu sehen bekommt man dabei nur die Waves, in denen man ist — wer aus einem Wave
entfernt wird, sieht dessen Geräte auch in einem offenen Tab nicht weiter.
Reißt die Verbindung ab, sagt die Seite es und verbindet sich von selbst
wieder; bis dahin steht dort der Stand vom Laden, statt still zu veralten.

---

## 🔬 Development v0.1.0-develop.26 (24.09.2026)

*Das Tray-Fenster unter macOS geht wieder beim ersten Klick auf.*

### 🐛 Die Karte unter macOS brauchte zwei Klicks

Wer das Fenster über das Icon öffnete, danach woanders hin klickte und dann
wieder aufs Icon, sah nichts passieren — erst der zweite Klick brachte die
Karte zurück.

Dahinter steckte eine Karte, die sich nicht weggeräumt hat. Sie sollte
verschwinden, sobald man sich etwas anderem zuwendet, blieb aber stehen; der
nächste Klick aufs Icon tat deshalb genau das, was ein Klick auf eine offene
Karte tut — er hat sie geschlossen. Sie räumt sich jetzt selbst weg, sobald
sie den Fokus verliert, und der Klick, der das ausgelöst hat, macht sie nicht
im selben Atemzug wieder auf.

---

## 🔬 Development v0.1.0-develop.25 (23.09.2026)

*Ein fremdes Gerät kommt nicht mehr durch einen angeklickten Link in den Wave,
und ein Telefon, das das Netz wechselt, bleibt über das Relay erreichbar.*

### 🔒 Ein Gerät freizugeben ist ein Knopfdruck, nicht das Öffnen eines Links

Bisher genügte es, den Anmeldelink zu öffnen — damit war das Gerät im Wave.
Das reicht nicht: einen solchen Link bekommt jeder, der `wave login` gegen den
Server laufen lässt, und dafür braucht es weder Konto noch Einladung. Danach
genügte es, ein angemeldetes Mitglied auf den Link zu locken, und ein fremdes
Gerät saß im Wave — nachgestellt, mit Adresse, in jeder Netzkarte und auf
jedem Interface.

Die Seite zeigt jetzt nur noch; aufgenommen wird das Gerät erst mit dem
Absenden des Formulars. Der eine eingesparte Klick war genau der, der den
Schritt getragen hat. Gefragt wird dabei immer, auch wenn es nur einen Wave
gibt.

### 🐛 Ein Telefon, das das Netz wechselt, bleibt über das Relay erreichbar

Verband sich ein Gerät neu — WLAN auf Mobilfunk, der Normalfall auf dem
Telefon —, räumte die alte, zufallende Verbindung die gerade angelegte neue
wieder weg. Zu sehen war davon nichts: das Gerät galt weiter als verbunden,
nur kam über das Relay nichts mehr bei ihm an.

### 🛠 Weniger Angriffsfläche in den Images

Ein Abhängigkeits-Audit hat vier Lücken aufgedeckt und alle sind zu:
Release-Bau und Connector-Image stehen auf derselben, unterstützten
Go-Fassung wie der Rest des Repos; das Connector-Image schleppt keinen
Compiler-Baum mehr mit, den nie jemand ausführt; und die Datenbankschicht ist
auf eine Fassung ohne bekannte Schwachstelle gehoben.

---

## 🔬 Development v0.1.0-develop.24 (23.09.2026)

*Einen Wave zu administrieren braucht im Container keinen Pfad in den
Workspace mehr.*

### 🛠 Die Operator-CLI liegt als Binary im Control-Image

`wave-admin` steht im Image auf dem PATH. Wer einen Wave administriert, tippt
also `docker exec <container> wave-admin members <wave>` statt den Pfad in den
Workspace — und kann das Binary aus dem Image herauskopieren und anderswo
benutzen, weil alles darin steckt.

Aus dem Repo heraus ändert sich nichts: `bun apps/control/src/admin.ts` ist
weiterhin dasselbe Programm, und die Hilfe nennt von selbst den Weg, über den
sie gerade aufgerufen wurde, statt auf ein Verzeichnis zu zeigen, das nicht da
ist.

---

## 🔬 Development v0.1.0-develop.23 (23.09.2026)

*wave läuft jetzt auch auf dem Telefon — jedenfalls überall dort, wo es sich
ohne Telefon nachweisen lässt —, und wer seine Domain bei IONOS oder INWX hat,
bekommt seine Zertifikate ab jetzt ohne Handarbeit.*

> **v0.1.0-develop.22 gibt es gar nicht.** Der Tag existiert, aber der Lauf kam
> nicht bis zu den Images: die End-to-End-Tests scheiterten daran, dass der
> Go-Kern in einem Netz-Namespace gebaut wird, in dem es kein Netz gibt — und
> die dort eingestellte Go-Version war eine ältere, als der Kern verlangt, also
> wollte Go sich erst eine nachladen. Derselbe Inhalt trägt jetzt die `.23`.

### 📱 Mobile: ein Go-Kern für iOS und Android (D10 / M10)

Vom bisherigen Client läuft auf einem Telefon nichts: kein `Bun.spawn` für
wireguard-go, kein `ip` oder `resolvectl`, und die iOS-Tunnel-Extension ist bei
rund 50 MB gedeckelt. Portabel ist allein der Vertrag. Neu ist deshalb ein
gemeinsamer Kern in Go unter `mobile/core`, dazu die beiden Plattform-Hosts —
`NEPacketTunnelProvider` in Swift, `VpnService` in Kotlin —, die absichtlich
dünn bleiben: sie tun nur, was ausschließlich die Plattform kann.

- **Ein Tunnel, mehrere Waves.** Beide Plattformen erlauben genau einen Tunnel
  je App. Also liegt unten ein Gerät und darüber je Wave ein eigenes
  WireGuard-Device, dazwischen ein Demultiplexer, der nach Zielpräfix sortiert.
  Ein Telefon kann damit in zwei Waves gleichzeitig sein, mit getrennten
  Schlüsseln — derselbe öffentliche Schlüssel in jeder Netmap würde sonst zwei
  Waves mit einem gemeinsamen Mitglied erlauben, das Gerät wiederzuerkennen.
- **Ein UDP-Port für alles.** Der Loopback-Socket je Peer entfällt: als
  Bibliothek nimmt wireguard-go eine `conn.Bind` entgegen, und jede Wave
  bekommt davon eine Sicht, die nur ihre Pakete liefert. Ein Pfadwechsel fasst
  die WireGuard-Konfiguration weiterhin nie an — dort steht jetzt der Peer statt
  einer Adresse.
- **Ein Resolver mit Suffix-Tabelle, ohne eigenen Socket.** Die Anfrage kommt
  als Paket auf dem Tunnel an und die Antwort geht genauso zurück, samt
  Prüfsummen. PTR inklusive, damit `ping <name>` nicht acht Sekunden auf eine
  Rückwärtsauflösung wartet, die niemand beantwortet.
- **Der Netzwechsel ist der Normalfall.** WLAN → LTE löst sofort einen Rebind
  und neue Kandidaten aus, statt darauf zu warten, dass Peers unerreichbar
  werden. Das ist der Unterschied zwischen einer Pause, die niemand bemerkt,
  und zehn Sekunden ohne alles.
- **Zwei Waves dürfen sich weder Adressen noch Schlüssel teilen.** Auf einem
  gemeinsamen Socket entscheidet der Absenderschlüssel im Klartext, welcher Peer
  ein Disco-Paket geschickt hat — ein bösartiger Control-Server könnte sich
  sonst in das Nachschlagen einer fremden Wave hängen. Die zweite Wave wird
  abgelehnt, und beide werden genannt.

**Der Kern läuft an einem echten TUN.** Zwei E2E-Skripte setzen genau den Code,
der auf ein Telefon geht, auf ein echtes Tunnelinterface — die Gegenstelle ist
jeweils der gewöhnliche Client, also wird zugleich über die
Implementierungsgrenze geprüft. `mobile-core.sh`: ein Interface trägt zwei
Waves, ein UDP-Port für beide, ein Peer in jeder erreichbar, der Resolver
antwortet ohne Socket für beide Zonen, ein Neustart kommt mit denselben
Adressen und demselben Port zurück. `mobile-nat.sh`: derselbe Kern hinter einem
NAT puncht einen direkten Pfad, und hinter zwei symmetrischen NATs, wo Punching
nicht gelingen kann, läuft der Verkehr über das Relay. Damit ist abgedeckt, was
M10 verlangt — zwei Waves gleichzeitig, direkter Pfad und Relay-Fallback.

Vier Fehler sind dabei aufgefallen, keiner an einem Unit-Test: ein Tunnel, der
genau einmal hochkam und danach „bind is closed" meldete; ein Neustart, nach dem
die Peers 15 Sekunden ins Leere sendeten; ein Gerät mit zwei Waves, das die
erste erreichte und die zweite nicht, bei bestätigten Pfaden zu beiden; und ein
Absturz, sobald zum ersten Mal ein Relay im Spiel war.

### 🔎 Jeder Wave reserviert eine Adresse für seinen Resolver

Die 53. seines Blocks. Der Allokator vergibt sie nie an ein Gerät, und die
Netmap schickt sie mit. Nötig ist das für Clients, deren Resolver keinen
eigenen Socket hat: erreicht wird er nur, wenn seine Adresse in den Tunnel
*geroutet* und niemandem *zugewiesen* ist — eine Adresse, die das Interface
hält, beantwortet der Kernel lokal, wo nichts lauscht.

Das Feld ist dabei optional geworden statt vorbelegt: ein Wave, der vor der
Reservierung nummeriert wurde, kann die Adresse längst an einen Knoten vergeben
haben, und dann bleibt sie weg, statt das DNS aller Geräte auf ein Gerät zu
zeigen. Nebenbei ist damit eine Regelverletzung raus, die eine einwandfreie
Netmap irgendwann als gefälscht hätte melden können: unterhalb von `Netmap` darf
nichts einen Default haben.

**Auf einem Telefon gelaufen ist nichts davon.** Es gibt hier weder einen Mac
noch ein Android-Gerät; für iOS fehlt zusätzlich das Xcode-Projekt und ein
bezahlter Developer-Account, und der iOS-Simulator kann Network Extensions
ohnehin nicht ausführen. Derselbe Stand wie beim Windows-Tray: benannt, nicht
verschwiegen.

### 🔑 Zwei weitere DNS-Provider: IONOS und INWX

`set-dns-provider` kennt jetzt vier statt zwei. Wer seine Domain bei IONOS oder
INWX hat, bekommt damit unbeaufsichtigte Erneuerungen, statt für jede einen
TXT-Record von Hand anzulegen.

Die beiden Neuen sind nicht dieselbe Sorte Zugangsdaten wie die beiden Alten,
und das ist beim Einrichten zu wissen:

- **IONOS** meint hier *Hosting* DNS — die gewöhnliche Domain bei ionos.de —
  und nicht IONOS Cloud DNS. Getrennte Produkte mit getrennten APIs; der Key
  des einen ergibt beim anderen 401. Der Zugang ist ein API-Key der Form
  `<public prefix>.<secret>`.
- **INWX** hat keinen Token, der sich auf eine Zone einschränken ließe: es
  meldet sich mit Benutzername und Passwort an, bei aktiver Zwei-Faktor-Auth
  zusätzlich mit einem TOTP-Code, für den das Shared Secret hinterlegt wird.
  Diese Zugangsdaten können alles, was das Konto kann — ein Sub-Account nur für
  diese Domain ist die einzige Art, das einzugrenzen, und `set-dns-provider`
  sagt das beim Abfragen. Abgelegt wird die Angabe als JSON in derselben
  versiegelten Spalte wie ein Token.

`WAVE_DNS_SECRET` gilt unverändert für beide: ohne den Wert wird nichts
gespeichert. Und `set-dns-provider` probiert die Zugangsdaten weiterhin sofort
gegen die echte Zone — was nicht schreiben kann, wird nicht behalten.

Geprüft ist das gegen nachgebaute APIs, nicht gegen die echten: die Sitzung von
INWX samt Ablauf und zweitem Faktor, die Anführungszeichen, in denen IONOS
seine TXT-Werte zurückgibt, und für beide der Fall, auf den es ankommt — ein
Wildcard-Auftrag und sein Apex schreiben denselben Recordnamen mit
verschiedenen Werten, und keiner darf den anderen wegräumen.

---

## 🔬 Development v0.1.0-develop.21 (22.09.2026)

*Das Tray-Icon ist unter Windows nach dem Install sofort da, und der Link zu
einem Dienst führt endlich dorthin, wo er hinführen soll.*

> **v0.1.0-develop.20 gibt es nicht zum Herunterladen.** Der Tag existiert, und
> control und relay liegen unter dieser Nummer auf der Registry, aber der Lauf
> kam nicht bis zum Release: der Speicher der Organisation war voll, und damit
> schlug das Hochladen der Client-Archive fehl. Was dort hineingehört hätte,
> steht hier. Wer `develop` fährt, holt sich `.21` — dort stimmen alle vier
> Images wieder überein.

### Neue Funktionen

- **Unter Windows steht das Tray-Icon direkt nach `wave install` da.** Bisher
  wurde dort nur ein Anmelde-Task registriert — das Icon kam also erst beim
  nächsten Ab- und Anmelden, oder man startete `wave tray` von Hand, und der
  Schlusshinweis musste genau das zugeben. Jetzt startet es sofort, so wie es
  launchd und systemd auf den anderen beiden ohnehin tun. Es bleibt ein
  *optionaler* Schritt: ein Eingabeaufforderungs-Fenster als Administrator
  eines anderen Kontos kann keine fremde Sitzung bespielen, und ein Icon, das
  nicht startet, ist kein Tunnel, der gescheitert ist.
- **Das Icon verschwindet nicht mehr nach drei Tagen.** Der Aufgabenplaner
  beendet eine Aufgabe ohne ausdrückliche Zeitangabe nach drei Tagen, und auf
  einem Laptop ließ er sie im Akkubetrieb meist gar nicht erst starten — beides
  Voreinstellungen, die sich nur über eine Definitionsdatei abschalten lassen,
  und beides Fehlerbilder, die man morgens ohne Anhaltspunkt vorfindet. Ein
  Absturz führt jetzt außerdem zu einem Neustart statt zum Ende.
- **Der Link zu einem Dienst spricht das Protokoll seines Ingress.** Die
  Oberfläche baute jede Dienstadresse als `https`, und bei einem Cluster, der
  einen davon im Klartext ausliefert, ging der Link ins Leere. Ob TLS beendet
  wird, weiß nur der Cluster — es hängt am Ingress beziehungsweise am Listener
  des Gateways —, und er sagt es jetzt: Oberfläche und `admin.ts services`
  bauen den Link daraus. Wird ein Name über beide Wege bedient, gewinnt
  `https`.

### Wichtig zu wissen

- **Eine Version entsteht erst, wenn der Tunnel im Test wirklich hochkommt.**
  Die End-to-End-Tests — zwei Knoten im Tunnel, ein Gerät in zwei Waves, Hole
  Punching durch zwei NATs, Rückfall aufs Relay — laufen jetzt im
  Release-Lauf und halten Images und Binaries auf. Vorher liefen sie neben dem
  Release auf Pull Requests, konnten also rot sein, während eine Version
  herausging. Der Preis dafür steht in derselben Zeile: auf einen Push oder
  Pull Request reagiert nichts mehr, Prüfungen vor dem Commit sind damit
  Handarbeit.

---

## 🔮 Development v0.1.0-develop.19 (21.09.2026)

*Ein Gerät bekam die Adresse eines Dienstes -- und unter Windows kam daraufhin
gar kein Tunnel mehr hoch.*

### Fehlerbehebungen

- **Ein neues Gerät konnte die Adresse eines Dienstes bekommen.** Geräte und
  Dienste teilen sich in einem Wave eine Nummerierung, aber nur die Dienste
  wurden mit Blick auf beide Seiten vergeben. Ein Gerät, das nach einem Dienst
  dazukam, landete deshalb womöglich auf dessen Adresse -- und das fiel nicht
  dort auf, sondern auf ebendiesem Gerät, als etwas, das nach Netz aussieht:
  Der Tunnel kam nicht hoch, weil die Route für diese Adresse mit der eigenen
  Adresse kollidierte. Neue Geräte bekommen jetzt Adresse und Namen, die noch
  niemand hält; ein Gerät kann sich damit auch nicht mehr so nennen wie ein
  Dienst.
- **Unter Windows scheiterte der Start an einer Route, die schon da war.**
  Windows legt zu jeder Adresse eines Adapters selbst eine Route an. Der Client
  zählte die nicht mit, legte sie ein zweites Mal an, und die Absage darauf
  brach den ganzen Start ab. Angelegt wird jetzt nur, was fehlt.
- **Ein gescheiterter Start räumt hinter sich auf.** Vorher blieben Interface,
  Port, Adressen und Routen liegen; der nächste Versuch scheiterte dann an den
  Resten des vorigen statt an dem, was wirklich schiefging -- unter Windows
  dauerhaft, weil eine liegengebliebene Route dort jeden weiteren Versuch
  abweist.

---

## 🔬 Development v0.1.0-develop.18 (21.09.2026)

*Windows holt beim Tray auf.*

### Neue Funktionen

- **Das Tray-Fenster gibt es jetzt auch unter Windows.** Ein Linksklick aufs
  Icon öffnet dieselbe Karte, die Linux und macOS schon zeigen: oben der
  Gerätename, darunter jeder Wave mit einem eigenen Schalter zum Verbinden und
  Trennen, darunter die Maschinen mit Adresse, Namen und dem Weg, über den sie
  gerade erreicht werden — samt Knopf, der den Namen in die Zwischenablage
  legt. Vorher fiel der Linksklick dort ins Leere und alles hing am Menü der
  rechten Maustaste; das gibt es unverändert weiter. Das Fenster verschwindet,
  sobald man sich etwas anderem zuwendet, und auf Escape.

  Ungeprüft auf echter Hardware — hier steht keine Windows-Maschine. Geprüft
  ist, wo jedes Element landet und was ein Klick darauf auslöst.

---

## 🔬 Development v0.1.0-develop.17 (21.09.2026)

### Fehlerbehebungen

- **Die Ereignisliste des Clients ist wieder brauchbar.** Sie bestand zuletzt
  fast nur aus `socket error (ignored): unknown` — einer Meldung ohne Inhalt,
  die im Sekundentakt kam und die acht Zeilen verdrängte, für die die Liste da
  ist. Ursache sind ICMP-Ablehnungen von Adressen, die ein Peer angeboten hat
  und die von hier aus nicht erreichbar sind; das ist normal. Sie werden jetzt
  gezählt, und höchstens einmal pro Minute steht dort, wie viele es waren.

---

## 🔬 Development v0.1.0-develop.16 (21.09.2026)

*Zwei kleine Dinge in der Oberfläche, die vorher fehlten.*

### Neue Funktionen

- **Ein Dienst ist jetzt anklickbar.** Unter dem Connector steht seine Adresse
  als vollständige URL und führt direkt dorthin — erreichbar für jeden im Wave
  und für sonst niemanden, denn außerhalb löst der Name nicht einmal auf.
- **Der Name eines Waves lässt sich ändern**, von Eigentümer und
  Administratoren, in der Wave-Karte über der Domain. Das ist der billige
  Schritt: kein Gerät kennt den Namen, es muss also auch keines etwas
  übernehmen. Anders als beim Wechsel der Domain, bei dem jedes Gerät eine neue
  Netzkarte braucht.

---

## 🔬 Development v0.1.0-develop.15 (21.09.2026)

*Die Dienste eines Clusters sind jetzt auch zu sehen — und der Weg dorthin
funktioniert im echten Cluster.*

### Neue Funktionen

- **Die Oberfläche zeigt die Dienste eines Connectors.** Unter dem Gerät
  stehen die Namen, die es beantwortet, mit ihrer Adresse im Wave; am
  Gerätenamen sagt ein Abzeichen, wie viele es sind. Vorher sah ein Connector
  aus wie eine Maschine, die beigetreten ist und seitdem nichts tut — die
  Dienste waren in der Netzkarte, in den Routen und im Resolver, nur nirgends
  zu sehen.

### Fehlerbehebungen

- **Der interne Ingress-Controller antwortete auf alles mit 404.** Ihm fehlte
  ein Leserecht, ohne das er seine Konfiguration nie veröffentlicht — und das
  stand nirgends im Log, sondern nur als wiederholter Rechte-Fehler zu einer
  Ressource, die mit Ingresses nichts zu tun hat.

---

## 🔬 Development v0.1.0-develop.14 (21.09.2026)

*Das erste Mal, dass ein Cluster wirklich einen Dienst in einen Wave gestellt
hat — und die Fehler, die dabei sichtbar wurden.*

### Fehlerbehebungen

- **Ein Dienst aus dem Cluster war nicht erreichbar.** Name und Adresse kamen
  an, jedes Gerät hatte die Route, und trotzdem antwortete nichts: Der
  Connector hielt die Adressen seiner Dienste für seine eigenen und leitete sie
  deshalb nicht weiter — das Paket blieb bei ihm liegen. Aufgefallen ist das
  erst im echten Cluster, weil es den Fehler ohne Dienste gar nicht gibt.

### Neue Funktionen

- **Die Clusterseite bringt ihren eigenen Ingress-Controller mit** (Traefik,
  Klasse `wave`, nur ClusterIP), und davor eine Regel, die nur den Connector
  durchlässt. Erst das macht „nur aus dem Wave erreichbar" wahr: wave kann
  einen Dienst erreichbar machen, unerreichbar machen muss der Cluster. Wer
  schon einen internen Controller hat, nimmt diesen heraus.
- **Der Connector behält seine Anmeldung.** Er läuft als StatefulSet mit einem
  Volume, heißt dauerhaft `wave-connector-0` und hinterlässt nicht mehr bei
  jedem Rollout ein weiteres Gerät in der Wave, um das sich jemand kümmern
  muss.

---

## 🔬 Development v0.1.0-develop.13 (21.09.2026)

*Das Kustomize-Setup ist einmal auf einem echten Cluster gelaufen — und das
hat es verändert.*

### Neue Funktionen

- **Die Datenbank gehört zum Setup.** `deployment/server` bringt Postgres mit,
  statt es als Zusatz anzubieten: ein Wave braucht eine Datenbank, und eine
  optionale hieß, dass jedes Overlay daran denken muss. Was ein einzelner Pod
  mit einem Volume nicht kann — Backup, Failover, Point-in-Time-Restore —,
  steht dort, wo er definiert ist; der Patch, der ihn für einen verwalteten
  Dienst wieder herausnimmt, liegt im Prod-Overlay bereit.
- **Zugang zu den privaten Images.** Jeder Pod nennt ein Image-Pull-Secret, und
  jedes Overlay erzeugt es aus einer `dockerconfig.json` neben seiner
  `kustomization.yaml` — bisher konnte nur ziehen, wer die Images öffentlich
  hatte.
- **STUN ohne Load Balancer.** Wo die Plattform kein UDP über ihren Load
  Balancer trägt — bei Hetzner etwa —, geht STUN im Prod-Overlay direkt über
  einen `hostPort` auf den Knoten. Das ist sogar der bessere Weg: ohne
  kube-proxy im Pfad kann nichts die reflexive Adresse verfälschen. Der Preis
  steht daneben: der Pod ist damit an den Knoten gebunden, dessen Adresse die
  Geräte kennen.

### Fehlerbehebungen

- **Der Relay startete in Kubernetes gar nicht.** Ein Service namens
  `wave-relay` lässt Kubernetes die alte Docker-Link-Variable
  `WAVE_RELAY_PORT=tcp://…` setzen — und genau daraus liest der Relay seinen
  Port. Er endete mit „options.port … Received NaN", bevor er lauschte. Diese
  Variablen sind jetzt in allen Pods abgeschaltet; gefunden wird hier alles
  über DNS.
- **Das dokumentierte `kubectl exec` zum Anlegen eines Kontos brauchte `-it`.**
  `admin.ts set-password` fragt das Passwort auf stdin ab; ohne Terminal bekam
  es eine leere Pipe und schob es auf die Passwortlänge.

---

## 🔬 Development v0.1.0-develop.12 (21.09.2026)

*Ein Wave stellt jetzt Zertifikate auf seine Gerätenamen aus, nimmt die Dienste
eines Kubernetes-Clusters auf — und lässt sich selbst auf Kubernetes betreiben.*

### Neue Funktionen

- **Gültige Let's-Encrypt-Zertifikate auf Gerätenamen.** `wave cert` holt für
  ein Gerät ein Zertifikat auf seinen Namen im Wave; der Dienst erneuert es von
  da an unbeaufsichtigt, in dem Fenster, das die CA vorschlägt (ARI), sonst bei
  zwei Dritteln der Laufzeit. `--hook 'systemctl reload caddy'` sagt, was danach
  neu geladen werden soll, `wave certs` zeigt, was das Gerät hält.
- **Der Control-Server schreibt in die Zone des Waves.** Ein auf die Zone
  beschränkter API-Token — Cloudflare oder Hetzner — wird einmal je Wave
  hinterlegt (`admin.ts set-dns-provider`) und beim Hinterlegen sofort
  ausprobiert; genau dieser Schreibtest ist zugleich die Domain-Verifikation.
  Gespeichert wird der Token nur verschlüsselt (`WAVE_DNS_SECRET`).
- **Oder von Hand, bei jedem Hoster** (`set-dns-provider <wave> manual`).
  `wave cert` druckt dann den TXT-Record, den es braucht, und wartet darauf;
  sobald er in der Zone steht, läuft die Ausstellung weiter. Nachgesehen wird
  bei den autoritativen Nameservern der Zone, damit ein Resolver, der die
  Abwesenheit des Records gecacht hat, nicht eine Stunde lang blockiert.
  Ctrl-C ist dabei ungefährlich: derselbe Auftrag wird beim nächsten
  `wave cert` weitergeführt.
- **Ein Kubernetes-Cluster kann Dienste in den Wave stellen** (D11). Ein
  `Ingress` mit `ingressClassName: wave` bekommt einen Namen und eine eigene
  Adresse im Wave; erreichbar ist er dann genau über den Wave und sonst
  nirgends. Dafür gibt es `apps/connector` (hält den Tunnel, leitet weiter) und
  `apps/operator` (liest die Ingresses) samt Manifesten in
  `deployment/cluster/`. Im Cluster gefahren wurde das noch nicht.
- **Kustomize-Setup für den ganzen Stapel** (`deployment/`): Control-Server,
  Frontend und Relay in `deployment/server`, Connector und Operator in
  `deployment/cluster` — zwei Bäume, weil sie in verschiedenen Clustern laufen.
  Dazu veröffentlicht ein Release jetzt auch die Images `web` und `connector`,
  nicht mehr nur `control` und `relay`.
- **Pre-Auth-Keys** (`admin.ts auth-key <wave>`, `wave login --auth-key`):
  Enrolment ohne Browser, für Maschinen, an denen niemand sitzt. Einmalig,
  ablaufend und widerrufbar, auf Wunsch wiederverwendbar.
- **Ein Wave lässt sich löschen** — vom Eigentümer, und nur mit getipptem
  Namen. Jeder andere Schnitt ist umkehrbar, dieser nicht: jedes Gerät verliert
  seine Anmeldung, die Adressen fallen zurück und die Domain wird wieder frei.
  Auf der Shell heißt es `admin.ts delete-wave <wave>` und nennt vorher, wie
  viele Geräte und Mitglieder daran hängen.

### Wichtig zu wissen

- **Ein Dienst ist eine Adresse, kein Knoten.** Er hat keine Schlüssel und ist
  kein WireGuard-Peer: seine Adresse steht in den `allowedIps` des Connectors,
  und damit routet ihn jedes Gerät, ohne etwas Neues zu lernen.
- **Der private Schlüssel entsteht auf dem Gerät und bleibt dort.** Zum Server
  geht nur der Zertifikatsantrag, zurück kommt die öffentliche Kette — und kein
  Gerät bekommt je ein DNS-Token, denn wer `_acme-challenge` schreiben darf,
  darf die ganze Zone schreiben.
- **Ausgestellt wird auf den eigenen Gerätenamen.** Ein Wave unter dem
  Platzhalter `.internal` bekommt prinzipiell keines — dafür muss erst eine
  eigene Domain eingetragen sein.
- **Ein Wildcard braucht die Freigabe des Betreibers**
  (`admin.ts allow-wildcard <wave> <gerät>`), dann holt ihn
  `wave cert --wildcard` samt dem Namen der Zone selbst. Der Grund für die
  Freigabe: `*.wave.example.com` gehört keinem Gerät, sondern allen — wer den
  Schlüssel hält, kann jeder Name im Wave sein. Gedacht ist er für *eine*
  Maschine mit mehreren Diensten; auf mehrere verteilt wäre er das Gegenteil
  von dem, wofür der Rest gebaut ist. Zurücknehmen geht mit `deny-wildcard`.
- **Von Hand heißt auch: Erneuerung von Hand.** Der Dienst meldet dann, welcher
  Record fehlt, und versucht es später wieder — unbeaufsichtigt erneuert nur,
  wer einen Provider-Token hinterlegt hat.
- **Vorgabe ist das Staging-Verzeichnis von Let's Encrypt.** Auf die echte
  Ausstellung schaltet `WAVE_ACME_DIRECTORY` um; deren Rate Limits verbrennt ein
  Fehlversuch für eine Woche.
- **Jeder ausgestellte Name landet dauerhaft in den öffentlichen CT-Logs.**
  Deshalb wird nur auf Zuruf ausgestellt und nicht für jedes Gerät automatisch.

---

## 🔬 Development v0.1.0-develop.6 (17.09.2026)

*Die Domain eines Waves gehört jetzt seinem Eigentümer — sie wird beim Anlegen
angegeben statt vergeben.*

### Neue Funktionen

- **Beim Anlegen eines Waves wird nach Name und Domain gefragt.** Der erste
  Login legt kein Netz mehr ungefragt an: er führt auf ein Formular, und erst
  das Absenden erzeugt den Wave. Vorbelegt ist `<name>.wave.internal` — wer
  keine eigene Domain hat, behält das einfach und ändert nichts an seinem
  Vorgehen.
- **Eine eigene Domain benennt die Geräte.** Trägt man dort `wave.example.com`
  ein, heißt der Laptop `laptop.wave.example.com`. Das ist der Schritt, ohne
  den es später kein öffentliches HTTPS-Zertifikat auf einen Gerätenamen geben
  kann: für die Platzhalter-Domain `*.wave.internal` ist das grundsätzlich
  nicht möglich, weil sie niemandem gehört. Die Zertifikate selbst gibt es
  weiterhin nicht — nur die Voraussetzung dafür.
- **Die Domain lässt sich später wechseln**, in der Wave-Karte der Oberfläche
  für Eigentümer und Administratoren, auf der Shell des Servers mit
  `admin.ts set-domain <wave> <domain>`. Verbundene Geräte übernehmen die neuen
  Namen mit der nächsten Netzkarte. Zu wissen ist dabei: der Wechsel benennt
  **jedes** Gerät im Wave um.
- **`wave status` bleibt offen und zeichnet mit.** Pfad, Laufzeit und das Alter
  des letzten Handshakes aktualisieren sich im Sekundentakt, bis Strg-C — diese
  Werte sagen erst etwas, wenn man sie sich bewegen sieht. Für Skripte und die
  einzelne Momentaufnahme gibt es weiterhin `wave status --once`, und am Rohr
  verhält sich das Kommando unverändert.

### Fehlerbehebungen

- **Es entsteht kein Wave mehr, den niemand bestellt hat.** Weil die Anmeldung
  selbst keinen anlegt, kann auch keiner nebenbei entstehen — etwa wenn man
  sich anmeldet, bevor man eine Einladung in ein fremdes Netz öffnet. Vorher
  entschied die Reihenfolge zweier Klicks, ob man hinterher einen Wave zu viel
  hatte.
- **Eine schon belegte Domain wird benannt, nicht mit einem Serverfehler
  quittiert.** Zwei Waves können nicht dieselbe Zone beantworten; der Versuch
  scheiterte bisher unverständlich, jetzt sagt die Seite, was los ist.
- **Das erste Gerät eines frischen Kontos läuft nicht mehr ins Leere.**
  `wave login` führt durch Anmeldung, Wave-Formular und Gerätefreigabe
  hindurch; vorher endete die Freigabe mit einer Fehlermeldung, weil es noch
  kein Netz gab, in das das Gerät gehört hätte.

---

## 🔬 Development v0.1.0-develop.5 (17.09.2026)

### Neue Funktionen

- **Ein einzelnes Gerät lässt sich entfernen**, ohne das Mitglied mit
  hinauszuwerfen — für die Maschine, die verloren, verkauft oder irgendwo
  stehen geblieben ist, also gerade die, auf der `wave logout` niemand mehr
  ausführen kann. In der Geräteliste steht dafür ein Knopf, sichtbar für
  Eigentümer und Admins; auf der Shell des Servers gibt es
  `admin.ts devices <wave>` und `admin.ts remove-device <wave> <name|id>`. Das
  entfernte Gerät wird dabei getrennt, nicht bloß vergessen.

### Fehlerbehebungen

- **Die Verbindung zu einem Peer wechselt nicht mehr ständig zwischen direkt
  und Relay.** Über WLAN schwankt die gemessene Laufzeit desselben Pfades
  leicht zwischen 14 und 110 ms; entschieden wurde bisher auf der letzten
  Messung, und damit wechselte der Pfad bei fast jeder Sondierung. Jetzt zählt
  ein gleitender Mittelwert, und der Pfad, der den Verkehr schon trägt, gibt
  ihn nur an einen deutlich besseren ab. Von einem Pfad, der nicht mehr
  antwortet, fällt der Verkehr weiterhin sofort herunter.

---

## 🔬 Development v0.1.0-develop.4 (17.09.2026)

*Behebt, dass `wave login` den Freigabe-Link nicht mehr anzeigte.*

### Fehlerbehebungen

- **`wave login` zeigt den Freigabe-Link wieder an.** Lief ein Dienst, gab das
  Kommando gar nichts aus und wartete bis zu 15 Minuten stumm — ausgerechnet
  auf das Öffnen des Links, den es hätte anzeigen sollen. Unter Windows fiel
  das ab v0.1.0-develop.3 auf, weil es dort erstmals einen laufenden Dienst
  gibt; unter Linux und macOS betraf es jeden, der den Dienst installiert hatte.
- **`wave up` sagt jetzt, wenn es etwas ablehnt.** Wurde ein Wave nicht
  eindeutig benannt oder war die Adresse keine, entschied der Dienst das für
  sich und die Ausgabe schwieg dazu.

---

## 🔬 Development v0.1.0-develop.3 (17.09.2026)

*Macht den Windows-Client einrichtbar — bisher ließ er sich überhaupt nicht in
Betrieb nehmen — und legt jedem Archiv bei, was der Tunnel braucht.*

### Nichts mehr nachinstallieren

- **wireguard-go liegt jetzt in jedem Archiv bei**, für Linux, macOS und
  Windows in der jeweils passenden Architektur; unter Windows zusätzlich
  `wintun.dll`. `wave install` legt beides neben das Binary — der Dienst läuft
  als root beziehungsweise LocalSystem und findet nichts, was nur im PATH des
  Benutzers steht. Das `go install golang.zx2c4.com/wireguard@latest` aus der
  Einrichtung entfällt damit.
- **Fehlt eine der beiden Dateien, sagt `wave install` es und endet mit einem
  Fehler**, statt eine Einrichtung zu melden, aus der kein Tunnel werden kann.

### Windows

- **Der Client lässt sich einrichten und trägt einen Tunnel.** Bisher scheiterte
  `wave login` mit „Diese Sicherheitskennung kann nicht als Besitzer des Objekts
  zugeordnet werden", und `wave install` legte einen Dienst an, der nie startete.
  Beides hatte dieselbe Ursache: der Tunnel muss als LocalSystem laufen, und ein
  Prompt „als Administrator" genügt dafür nicht.
- **Eingerichtet wird jetzt eine geplante Aufgabe statt eines Dienstes.** Sie
  läuft als LocalSystem beim Systemstart und kommt nach einem Absturz von selbst
  wieder. Nachsehen lässt sie sich mit `schtasks /query /tn "wave daemon"`, nicht
  in `services.msc`. Beim Beenden werden die Waves erst ordentlich abgebaut,
  damit keine DNS-Regeln in der Registry zurückbleiben.
- **`wave install` sagt jetzt, wenn etwas schiefgegangen ist.** Zuvor meldete es
  „installed and running" und endete erfolgreich, auch wenn jeder einzelne
  Schritt gescheitert war — und die Fehlermeldungen der Windows-Werkzeuge kamen
  als nackte Zahlen heraus.

### Was weiterhin fehlt

Die Liste aus v0.1.0-develop.1 gilt unverändert, bis auf den ersten Punkt:
wireguard-go und `wintun.dll` liegen jetzt bei. **Der Windows-Client ist
weiterhin nie auf echter Hardware gelaufen** — auch das hier Beschriebene ist
geprüft, soweit sich das ohne Windows-Maschine prüfen lässt.

---

## 🔬 Development v0.1.0-develop.1 (17.09.2026)

*Die erste Version überhaupt. Sie ist zum Ausprobieren gedacht, nicht für den
Dauerbetrieb — siehe „Was noch fehlt" am Ende dieses Abschnitts.*

### Das Netz

- **Geräte finden sich selbst und verbinden sich direkt.** Jedes Gerät meldet
  sich bei einem Control-Server an und bekommt eine signierte Netzkarte; den
  Tunnel bauen die Geräte danach untereinander auf, ohne dass Verkehr über den
  Server läuft.
- **Auch hinter NAT, ohne Portfreigabe.** Zwei Geräte hinter getrennten Routern
  stanzen sich gegenseitig einen Weg; keine Konfiguration am Router nötig.
- **Relay als Rückfallebene.** Wo ein direkter Weg unmöglich ist — etwa hinter
  symmetrischem NAT — läuft die Verbindung über ein Relay, verschlüsselt wie
  jede andere. Taucht später doch ein direkter Weg auf, wird ohne Abriss
  umgeschaltet.
- **Namen statt Adressen.** `ping laptop` findet das Gerät im eigenen Wave.
  Rückwärtsauflösung inklusive, damit nichts mehr auf Namensabfragen wartet,
  die niemand beantwortet. Nur die Namen des Waves werden umgeleitet, die
  übrige Namensauflösung des Rechners bleibt unangetastet.

### Anmelden und verwalten

- **Anmeldung im Browser**, per Passwort oder über einen OIDC-Anbieter.
- **Mehrere Menschen in einem Wave.** Rollen (Eigentümer, Admin, Mitglied),
  Einladungen per einmaligem Link, und das Entfernen eines Mitglieds nimmt
  dessen Geräte mit.
- **Weboberfläche** für Geräte, Waves, Mitglieder und Einladungen.
- **Ein Gerät kann in mehreren Waves gleichzeitig sein** — etwa einem privaten
  und einem beruflichen, auf verschiedenen Servern, mit getrennten Schlüsseln.

### Auf dem eigenen Rechner

- **Ein einziges Binary** für alles: `wave up`, `wave status`, `wave login`,
  `wave profiles`, dazu Dienst und Tray-Icon. `wave install` richtet die
  Maschine ein, beigetreten wird danach mit `wave login <server-url>`.
- **Tray-Icon** unter Linux und macOS, mit einem Fenster, in dem sich jeder
  Wave einzeln schalten lässt.
- **Windows** ist neu dazugekommen: Tunnel, Adressen, Routen, Split-DNS,
  Windows-Dienst und Tray-Icon.
- **Fertige Binaries** hängen an diesem Release — Linux, macOS und Windows,
  jeweils für amd64 und arm64, mit Prüfsummen.
- **Server als Container-Images** für Control und Relay, für amd64 und arm64.

### Was noch fehlt

- **wireguard-go wird nicht mitgeliefert** und muss vorhanden sein
  (`go install golang.zx2c4.com/wireguard@latest` oder das Paket der
  Distribution). Unter Windows zusätzlich `wintun.dll`.
- **Der Windows-Client ist nie auf echter Hardware gelaufen.** Er ist gebaut
  und geprüft, soweit sich das ohne Windows-Maschine prüfen lässt — mehr nicht.
  Unter Windows fehlt außerdem das Fenster hinter dem Tray-Icon; dort trägt das
  Menü alles.
- **Keine Zugriffsregeln.** Alle Geräte aller Mitglieder eines Waves sehen sich
  gegenseitig.
- **Keine Zertifikate und keine automatische Domain-Einrichtung.** Namen
  funktionieren im Wave, öffentliche Zertifikate dafür gibt es noch nicht.
- **Keine Clients für iOS und Android.** Wie sie gebaut würden, ist entschieden
  und dokumentiert, gebaut sind sie nicht.

---

## Release-Prozess

Features durchlaufen die Phasen sequentiell, bevor sie alle Nutzer erreichen:

```
🔬 Development  →  🧪 Insiders  →  ✅ Stable
   (Vorabbau)      (Early Adopter)   (Alle Nutzer)
```

| Phase | Zielgruppe | Beschreibung |
|-------|------------|--------------|
| 🔬 **Development** | Entwickler | Vorabbau zum Ausprobieren. Kann kaputt sein. |
| 🧪 **Insiders** | Early Adopter | Vorschau-Version zum Testen vor dem Stable-Release. |
| ✅ **Stable** | Alle Nutzer | Produktionsreife Version. |

**Hinweis:** Jeder Abschnitt listet nur die Änderungen, die **neu** in dieser
Phase sind.
