# wave auf Synology DSM 7

Das Installationspaket (SPK) und die Zertifikatsablage für DSM. Gebaut wird mit
`bun scripts/build-spk.ts [dist]` nach `scripts/build-clients.sh --package`;
im Release übernimmt das `release.yml`.

## Inbetriebnahme ohne SSH

1. Das SPK für die Architektur des NAS im **Paketzentrum → Manuelle
   Installation** installieren und das Paket starten. Die DS920+ nimmt
   `x86_64`; andere Modelle müssen passend zu ihrer CPU gewählt werden.
2. Einmal unter **Systemsteuerung → Aufgabenplaner → Erstellen → Geplante
   Aufgabe → Benutzerdefiniertes Skript** eine Aufgabe mit Benutzer **root**
   anlegen. Unter *Aufgabeneinstellungen* als Skript
   `/var/packages/wave/scripts/setup` eintragen. Die Aufgabe speichern,
   markieren, **Ausführen** und danach löschen. Vor dem Lauf lässt sich unter
   *Einstellungen* das Speichern der Ausgabe einschalten; das Ergebnis steht
   dann unter **Aktion → Ergebnis anzeigen**. Der Dienst startet danach bei
   NAS-Neustarts über systemd, ohne wiederkehrende Aufgabe.
   Nach einem SPK-Upgrade denselben Befehl erneut ausführen, damit der laufende
   Daemon das neue Binary nutzt. Die Wave-Anmeldung bleibt dabei erhalten.
3. **wave** im DSM-Hauptmenü öffnen. Unter **Einem Wave beitreten** die ganze
   `https://`-Adresse des Control-Servers eingeben und **Anmelden** drücken.
   Den angezeigten Freigabelink im Browser öffnen, dort anmelden und die
   DiskStation freigeben.
   Läuft der Control-Server nur im LAN, ist die Adresse die vom NAS aus
   erreichbare Hostadresse, zum Beispiel `http://<LAN-IP>:8080` bei der
   Compose-Entwicklungsumgebung. `localhost` bezeichnet hier die DiskStation,
   nicht den anderen Server. Ein Hostname muss auf der DiskStation auflösbar
   sein; ein bloßer Rechnername aus einer anderen Maschine genügt nicht.
4. Nach der Freigabe zeigt die Seite den Wave, seine Verbindung und die
   anderen Geräte mit ihren Diensten. **Verbinden** und **Trennen** wirken je
   Wave. **Von diesem Gerät entfernen** löscht nach einer Rückfrage die lokalen
   Schlüssel und lässt nur diese DiskStation den Wave verlassen; der Wave auf
   dem Control-Server bleibt bestehen. Die Seite fragt den Status selbst neu
   ab; ein Neuladen ist nicht nötig.

Die Seite liegt auf derselben Herkunft wie DSM unter
`/webman/3rdparty/wave/index.cgi/`. Das einmalige Setup und die Anmeldung an
einem echten Control-Server sind verschiedene Schritte: Ein laufender Dienst
allein kann noch keine Geräte zeigen.

**Auf echter Hardware geprüft.** Das SPK 0.15.1 wurde auf einer
DS920+ mit DSM 7.4.1 über `synopkg install` installiert und über
`synopkg start` gestartet. Das einmalige
`scripts/setup` richtete `wave.service` ein; der Dienst war anschließend
`active` und `enabled`, und der DSM-Paketbenutzer konnte den Steuersocket
lesen. Die DSM-Seite antwortete unter `/webman/3rdparty/wave/index.cgi/` mit
HTTP 200, auch auf Deutsch. `modprobe tun` erzeugte `/dev/net/tun`. Die Seite
war anschließend in einer angemeldeten DSM-Sitzung sichtbar. Ein fehlgeschlagener
Anmeldeversuch zeigte den TLS-Zertifikatsfehler der falschen Serveradresse;
dieses nicht autorisierte Profil wurde wieder entfernt. Später meldete sich
die DiskStation am Control-Server an und baute einen Tunnel auf. Beim Nachtest
am 11.11.2026 war das lokale Profil im Ops-Wave (`10.160.0.104`); das alte
Profil im Wave `martin` war entfernt. Ein HTTPS-GET auf einen Dienst über
dessen Wave-Adresse antwortete mit HTTP 200; der Peer zeigte unmittelbar
danach einen WireGuard-Handshake über das Relay. Ein NAS-Neustart und die
Zertifikatsablage sind noch offen — siehe „Abnahme“.
DSM bietet diesem Client derzeit keine Schnittstelle für die Weiterleitung
einzelner DNS-Zonen an den Wave-Resolver; `wave status` meldet deshalb, dass
Wave-interne Namen auf dem NAS nicht automatisch aufgelöst werden.

**CGI-POST auf echter Hardware:** DSM ließ stdin nach den in `CONTENT_LENGTH`
gemeldeten Bytes offen. `Bun.stdin.text()` wartete daher auf EOF und hielt
„Melde an…“ ohne Antwort fest. Die CGI liest nun genau diese Bytes mit
`readSync`; ein Test mit absichtlich offen gehaltenem stdin antwortete auf
der DS920+ in unter einer Sekunde. Die Korrektur lief erst als Test-Binary
und ist seit dem lokalen Test-SPK vom 11.11.2026 auch im Paket enthalten.

**Upgrade-Probe vom 11.11.2026:** DSM 7.4.1 verweigerte das Upgrade des
installierten Pakets 0.15.1 vor dem Dateiaustausch mit Fehler 261
(`package does not have preupgrade / postupgrade script`). Beide Hooks sind nun
im SPK enthalten; sie laufen als Paketbenutzer und ändern den root-Daemon
nicht selbst. Das lokale Test-SPK `0.16.1-develop.2` wurde danach erfolgreich
als Upgrade installiert. `scripts/setup` lief erneut als root ohne Fehler;
Paket, root-Daemon und CGI-Seite meldeten sich einsatzbereit (HTTP 200). Der
Daemon blieb mit dem Control-Server verbunden. Ein Konto ohne root sah bei
`synopkg status wave` Fehler 263, derselbe Befehl mit `sudo` meldete
`running` und Status 0.

**Hardwareprobe vom 08.11.2026:** Auf einer DS920+ mit DSM 7.4.1 wurde ein
getrenntes, unprivilegiertes Prüf-SPK installiert. DSM hat dessen Datei
`conf/systemd/pkg-waveprobe.service` als root nach
`/usr/local/lib/systemd/system` kopiert. Beim Start des Pakets konnte dessen
`start-stop-status` als Paketbenutzer die Unit aber nicht mit
`synosystemctl start` starten (Paketstart: Fehler 272; die genaue Ursache
dieses Fehlers wurde noch nicht isoliert). Die Unit blieb
`inactive`. Das Prüf-SPK wurde wieder entfernt; DSM entfernte auch die Unit.
**Das bloße Beilegen einer System-Unit beseitigte den manuellen Root-Schritt
in dieser Probe nicht.** Der spätere Test des eigentlichen wave-SPK mit
laufendem Tunnel steht oben.

**Capability-Probe auf derselben DS920+:** Ein zweites Prüf-SPK mit
`run-as: package` und einem statischen Go-Programm ließ sich ohne
`tool.capabilities` installieren. Unter dem Paketbenutzer hatte es
`CapPrm=CapEff=CapAmb=0`; `/dev/net/tun` fehlte. Sobald die
`conf/privilege` unter `tool` einen `capabilities`-Eintrag enthielt,
verweigerte DSM die Installation schon bei `prepare_install` mit Fehler 319.
Das geschah mit `cap_net_admin,cap_net_raw`, mit `cap_net_raw` allein und
mit `cap_chown` allein. Das Paketlog sagte jeweils wörtlich
`Failed to pass privilege check, tool capabilities should not exist`.
Der Capability-Weg ist damit für ein auf dieser DSM-Version manuell
installiertes Drittanbieter-SPK nicht verfügbar; ein Tunneltest mit diesen
Rechten fand nicht statt. Auch dieses Prüf-SPK wurde entfernt.

## Vorabklärung: was DSM 7 verlangt

- **Rechte.** DSM 7 lässt Pakete, die nicht von Synology signiert sind, nicht
  als root laufen. Ein Paket mit `"run-as": "root"` in `conf/privilege` bricht
  bei „Manuelle Installation“ mit „… kann nicht installiert werden, da es mit
  Root-Rechten ausgeführt wird“ ab (so geschehen mit dem ersten Paket, Ticket
  #53 — der frühere Stand dieses Abschnitts hielt `run-as: root` für tragfähig;
  das war nie auf einem NAS geprüft und ist falsch). Der Weg für fremde
  Pakete ist ein Paketbenutzer: `"run-as": "package"`. Tailscale
  (`privilege-dsm7`) und die Pakete der SynoCommunity (`spksrc.service.mk`
  schreibt für DSM ≥ 7 `{"defaults": {"run-as": "package"}}`) machen es so.
- **Root bekommt der Daemon auf anderem Weg.** Er braucht root für das
  TUN-Gerät, Routen, Firewall und `/usr/syno/etc/certificate`; Dateirechte oder
  `setcap` auf dem Binary geben weder `insmod` noch Schreibzugriff auf den
  Zertifikatspeicher. Ein manuell installiertes SPK mit `tool.capabilities`
  wurde auf DSM 7.4.1 sogar schon vor der Installation abgewiesen (siehe
  Capability-Probe). Also läuft der Daemon nicht aus dem Paket,
  sondern unter systemd, und **einmalig richtet ihn jemand mit `sudo` ein** —
  so wie Tailscale (`tailscale configure-host`, root) und runfalks
  WireGuard-Paket (`sudo …/scripts/start`) für DSM 7 einen Handschritt
  verlangen.
  DSM selbst bietet für fremde Pakete keinen Weg, das zu vermeiden. Wer kein
  SSH einschalten will, trägt denselben Schritt im Aufgabenplaner ein — siehe
  „Ohne SSH: der Aufgabenplaner“. Das Paket legt diese Aufgabe nicht selbst an.
- **Was trägt:** `conf/privilege` mit `run-as: package` (Benutzer und Gruppe
  `wave-pkg`), und `scripts/setup` — nicht von DSM gerufen, sondern von Hand —
  ruft das vorhandene `wave install --binary <Paketpfad>` auf. Das schreibt die
  systemd-Unit, legt die Gruppe `wave` an (`synogroup`) und startet neu — die
  bestehende Install-Logik, keine Parallelwelt. systemd trägt den Daemon danach
  auch durch Neustarts. Der Paketbenutzer führt nichts davon aus.
- **Der Handschritt (einmalig):** das Paket in „Manuelle Installation“
  installieren, dann per SSH (Systemsteuerung → Terminal & SNMP → SSH
  aktivieren; als Administrator anmelden)

  ```sh
  sudo /var/packages/wave/scripts/setup
  ```

  Danach läuft der Daemon als Dienst `wave`. Die Konten, die `wave` bedienen
  dürfen, trägt man in **Systemsteuerung → Benutzer & Gruppe → Gruppe** in die
  Gruppe `wave` ein (die `setup` angelegt hat) und meldet sie neu an: Die Gruppe darf den Socket
  des Daemons benutzen, ohne sie sagt `wave status` „Permission denied“. Mit
  der Gruppe `wave-pkg` hat das nichts zu tun — die gehört DSM und dem Paket.
- **Ohne SSH: der Aufgabenplaner.** Derselbe Schritt geht auch über die
  Oberfläche, denn eine Aufgabe des Aufgabenplaners darf als root laufen:

  1. **Systemsteuerung → Aufgabenplaner → Erstellen → Geplante Aufgabe →
     Benutzerdefiniertes Skript.**
  2. *Allgemein:* ein Name, etwa `wave einrichten`; Benutzer **root**.
  3. *Zeitplan:* „Am folgenden Datum ausführen“, „Nicht wiederholen“. Gebraucht
     wird nur der eine Lauf von Hand, der Zeitplan ist bloß Pflicht im Formular.
  4. *Aufgabeneinstellungen → Benutzerdefiniertes Skript:*

     ```sh
     /var/packages/wave/scripts/setup
     ```

     Ohne `sudo`: die Aufgabe läuft schon als root.
  5. Die Aufgabe markieren, **Ausführen**, danach löschen.

  Zwei Dinge sind dabei zu beachten:

  - **Niemand ist automatisch in der Gruppe `wave`.** `setup` richtet auf dem
    NAS keinen Benutzer-Tray ein und ordnet auch keinen SSH-Benutzer zu. Die
    Gruppe entsteht trotzdem; die Konten trägt man unter **Benutzer & Gruppe
    → Gruppe** ein.
  - **Die Ausgabe sieht man nicht von selbst.** Der Aufgabenplaner zeigt sie
    nur, wenn unter **Einstellungen** das Speichern der Ausgabeergebnisse
    eingeschaltet ist — also *vor* dem Ausführen einschalten; danach steht sie
    unter **Aktion → Ergebnis anzeigen**. Das Paketzentrum taugt als Kontrolle
    nicht: `status` meldet absichtlich auch ohne eingerichteten Dienst „läuft“
    (siehe „Lebenszyklus“).

  Anders als bei Tailscale gehört die Aufgabe **nicht** auf „Hochfahren“.
  Tailscale braucht das, weil `configure-host` nur `/dev/net/tun` und die
  Capabilities von `tailscaled` setzt und DSM beides beim Neustart
  zurücknimmt. Nach der Erstinstallation trägt systemd den Daemon durch jeden
  Neustart, und das TUN-Modul lädt der Daemon selbst (siehe
  „TUN“). Bei jedem Hochfahren ausgeführt, schriebe die Aufgabe die Unit neu
  und startete den Daemon ein zweites Mal. Schaden täte das nicht (`install`
  ist wiederholbar), nützen auch nicht. Nach einem SPK-Upgrade wird `setup`
  einmal erneut ausgeführt, damit der laufende Dienst das neue Binary nutzt.

  Zum Entfernen genauso, mit `/var/packages/wave/scripts/setup uninstall` als
  Skript, **bevor** das Paket deinstalliert wird.
- **Noch offen:** Die Installation über den Dialog „Manuelle Installation“
  im Paketzentrum wurde nicht geprüft; die Hardwaretests nutzten `synopkg`.
  Der Paketbenutzer und die Paketgruppe `wave-pkg` funktionierten auf der
  DS920+. Der Status im Paketzentrum selbst wurde nicht geprüft; `synopkg
  status wave` meldete nach dem Upgrade mit root-Rechten `running`. Siehe
  „Abnahme“.
- **TUN.** DSM lädt das Modul nach einem Neustart nicht. Das ist schon gelöst:
  `ensureTunDevice` (`apps/client/src/engine.ts`) versucht bei jedem Start des
  Daemons `modprobe tun` und danach `insmod /lib/modules/tun.ko`. Da der Daemon
  per systemd startet, geschieht das nach jedem Neustart, ohne Aufgabenplaner.
- **Zielplattformen.** SPK-`arch` `x86_64` (alle Intel/AMD-Plattformen von
  apollolake bis v1000) und `armv8` (rtd1296, armada37xx, rtd1619, rtd1619b).
  Die Binaries sind die der Archive `wave-linux-amd64` und `wave-linux-arm64`.
  Mindestens DSM `7.0-40000`.

## Das Paket

`wave-<version>-dsm7-<arch>.spk` ist ein unkomprimiertes tar:

| Datei | Inhalt |
|---|---|
| `INFO` | Paket `wave`, `arch`, `os_min_ver`, `checksum` (MD5 von `package.tgz`), `extractsize` |
| `PACKAGE_ICON.PNG`, `PACKAGE_ICON_256.PNG` | die Marke des Trays, zur Bauzeit gezeichnet (72 und 256 px) |
| `conf/privilege` | `run-as: package` (nie root), Benutzer und Gruppe `wave-pkg` |
| `conf/resource` | legt `wave` per `usr-local-linker` in den PATH |
| `scripts/start-stop-status`, `scripts/preupgrade`, `scripts/postupgrade`, `scripts/preuninst` | Lebenszyklus als Paketbenutzer, siehe unten |
| `scripts/setup` | der Schritt als root, von Hand: `sudo /var/packages/wave/scripts/setup` |
| `package.tgz` | `wave`, `wireguard-go`, `LICENSE`, `LICENSE.wireguard-go`, dazu `ui/` (siehe „Die Seite in DSM“) |
| INFO `dsmuidir`, `dsmappname` | `ui` und `SYNO.SDS.wave` — der Eintrag im Hauptmenü |

Die Dateien liegen unter `packaging/dsm/`; `scripts/build-spk.ts` setzt sie
zusammen. Es schreibt das tar selbst: Der Release-Job läuft auf macOS, und bsdtar
und GNU tar sagen „gehört root“ verschieden. Ein auf dem NAS entpacktes Paket
behält den Eigentümer aus dem Archiv, also steht dort überall root, und das
Datum ist 1970 — dieselbe Eingabe gibt dieselbe Datei.

**Version.** DSM will `<Version>-<Build>` aus Zahlen. Der Build trägt den Kanal,
damit die Reihenfolge die von semver ist: `0.12.0-develop.1` → `0.12.0-1001`,
`0.12.0-insiders.2` → `0.12.0-2002`, `0.12.0` → `0.12.0-3000`. Die
Dateinamen tragen die echte Version.

**Lebenszyklus.** DSM ruft `start-stop-status` und `preuninst` als
Paketbenutzer; der darf weder `systemctl` noch `wave install` ausführen. Der
Daemon ist deshalb nicht Sache des Pakets, sondern von systemd und root:

- `scripts/setup` (von Hand, als root) → `wave install --binary <Paketpfad>
  --socket-user wave-pkg`.
  `--binary` hält das Binary dort, wo das Paket es hingelegt hat; ohne die
  Option kopierte `install` es nach `/usr/local/bin/wave` — weg vom Paket und
  über das, was der Selbstupdater dort abgelegt hat. Vorher gehört das
  Paketverzeichnis root: Der Daemon läuft als root daraus.
- `start` → ändert nichts und endet mit 0; ist der Daemon noch nicht eingerichtet,
  steht der Befehl für `setup` in der Ausgabe. Das Paket „startet“ also auch vor
  dem Handschritt fehlerfrei und wirkt nicht abgestürzt.
- `stop` → ändert nichts und endet mit 0. Den Daemon hält man mit
  `sudo systemctl stop wave` an (und mit `sudo systemctl disable wave`, damit er
  nach dem Neustart aus bleibt). Das Paketzentrum kann das nicht.
- `status` → 0 und „wave is running“, wenn `systemctl is-active wave` sagt, dass
  er läuft; 3 („nicht läuft“), wenn die Unit eingerichtet ist, aber nicht läuft;
  **0**, wenn der Dienst noch nicht eingerichtet ist — dann wartet das Paket
  nur auf den Handschritt, und das Paketzentrum soll das nicht als Ausfall
  zeigen. Die Ausgabe sagt, welcher Zustand es ist.
- `preuninst` → kann den Dienst nicht selbst entfernen. Ist die Unit noch da,
  steht in der Ausgabe `sudo /var/packages/wave/scripts/setup uninstall` (das
  ruft `wave uninstall`); **vor** dem Entfernen des Pakets auszuführen, sonst
  bliebe eine Unit, deren Binary fehlt und die ständig neu startet. Läuft das
  Skript doch als root, ruft es `wave uninstall` selbst. Schlägt nie fehl: Es
  läuft auch bei jedem Upgrade. Die Anmeldung unter `/var/lib/wave` bleibt, wie
  bei `wave uninstall`.

Die Zustände zu Start, Stopp und Status im Paketzentrum sagen damit nichts
über den Tunnel; maßgeblich sind `systemctl status wave` und `wave status`.

Die Selbstaktualisierung läuft unverändert: Der Updater tauscht die Dateien im
Verzeichnis des laufenden Binarys. Im Paketzentrum bleibt die Paketversion
stehen. `manifest.json` kennt die SPKs nicht, absichtlich: es listet die
Archive, aus denen sich ein Gerät aktualisiert.

## Die Seite in DSM

Im Hauptmenü von DSM steht **wave**, wie bei Tailscale. Die Seite zeigt die
Waves dieser DiskStation mit Verbinden und Trennen, meldet die NAS bei einem
weiteren Wave an (Adresse des Control-Servers eintragen, dann den
Freigabelink im Browser öffnen) und listet die Geräte samt ihren Diensten.
Ohne SSH geht danach alles außer dem einmaligen Setup.

So hängt sie zusammen (`packaging/dsm/ui/`, `apps/client/src/dsm-ui.ts`):

- **DSM bindet `ui/` unter `/webman/3rdparty/wave/` ein** (INFO `dsmuidir`)
  und zeigt den Eintrag aus `ui/config`, dessen Schlüssel der `dsmappname` ist
  (`SYNO.SDS.wave`; `build-spk.ts` bricht ab, wenn die beiden auseinanderlaufen).
  `allUsers: false`: der Eintrag erscheint nur Administratoren.
- **`ui/index.cgi` ruft `wave dsm-ui`** — das Binary des Pakets als CGI, ein
  Prozess je Anfrage, ohne eigenen Zustand. Die Seite fragt alle drei Sekunden,
  solange der Tab sichtbar ist; ein verborgener fragt nichts.
- **Wer darf, sagt DSM.** Ohne DSMs Token (`X-SYNO-TOKEN`, die Seite holt ihn
  wie Tailscale von `/webman/login.cgi`) wird nichts beantwortet; mit ihm nennt
  DSMs `authenticate.cgi` das angemeldete Konto, und das muss in der Gruppe
  `administrators` stehen (`/etc/group`). Eine Anmeldung hängt die NAS an ein
  fremdes Netz, und der Daemon läuft als root — das entscheidet nicht jedes
  Konto, das DSM öffnen kann.
- **Ändern nur per POST mit JSON und vom eigenen Ursprung** (`Sec-Fetch-Site`).
  Die Seite trägt eine CSP mit Nonce und lädt nichts von anderswo; was ein
  Control-Server schreibt (Namen, Links), wird maskiert, und verlinkt wird nur
  `http(s)`.
- **Der Daemon-Socket gehört zusätzlich `wave-pkg`.** DSM führt das CGI als
  Paketbenutzer aus; der steht in keiner Gruppe, die man verlässlich pflegen
  könnte — `synogroup` verwaltet DSMs Konten, nicht die Systembenutzer der
  Pakete. Deshalb übergibt `setup` `--socket-user wave-pkg`, die Unit setzt
  `WAVE_SOCKET_USER`, und der Daemon gibt dem Socket diesen Eigentümer bei
  Gruppe `wave` und 0660. Der Preis: Als Eigentümer könnte `wave-pkg` die Rechte
  des Sockets ändern — wer das Paketkonto übernimmt, steuert den Daemon aber
  ohnehin schon. **Wer vor dieser Version eingerichtet hat, führt `setup`
  einmal neu aus**; die Seite sagt das, wenn sie abgewiesen wird.
- **Die Anmeldung wartet nicht auf die Freigabe.** Ein CGI kann keine Minuten
  offen halten. Es übergibt die Adresse dem Daemon, wartet höchstens zehn
  Sekunden, bis der Freigabelink (oder ein Grund, etwa ein unerreichbarer
  Server) im Status steht, und schließt dann. Der Daemon führt die Anmeldung
  ohne Zuhörer weiter; die nächste Abfrage der Seite zeigt, wie weit sie ist.
- **Sprache** wie im Web: `Accept-Language`, sonst Englisch.

## Zertifikate

`wave cert` legt auf einem DSM zusätzlich in DSMs eigenen Zertifikatspeicher ab,
ohne Import in der Oberfläche. Erkannt wird DSM an `/etc.defaults/VERSION`
(`os_name="DSM"`); `--no-dsm` schaltet es ab, `--dsm` erzwingt es. Die Wahl
steht im Zertifikatseintrag, damit die Erneuerung dasselbe tut. Auf jedem
anderen System ändert sich nichts: `certs/<name>/` und `--hook` wie bisher.

DSM legt ein Zertifikat so ab, und so macht es `apps/client/src/dsm.ts`:

- `/usr/syno/etc/certificate/_archive/<id>/` mit `cert.pem`, `chain.pem`,
  `fullchain.pem` und `privkey.pem` (die ID: sechs Zeichen). Der Schlüssel ist
  0600, jede Datei wird neben dem Ziel geschrieben und umbenannt.
- `_archive/INFO`: JSON, je ID `{ "desc": …, "services": […] }`. Ein neuer Eintrag
  heißt `wave: <name>` und hat keine Dienste. Ein bestehender wird **nicht neu
  geschrieben**: seine Dienstliste gehört DSM.
- Jeder Dienst auf der Liste (`subscriber`/`service`, z. B. `system/default`,
  `smbftpd/ftpd`) hat ein eigenes Verzeichnis unter `/usr/local/etc/certificate`
  oder `/usr/syno/etc/certificate`. Dort landen bei jeder Erneuerung dieselben
  vier Dateien; danach läuft das Skript des Subscribers unter
  `…/certificate.d/<subscriber>` und das TLS-Profil unter
  `/usr/libexec/security-profile/tls-profile/` (für die Weboberfläche `dsm.sh`).
  Fehlt beides bei `system`, lädt `synosystemctl reload nginx` nginx neu.
- `_archive/DEFAULT` und die Dienstlisten fremder Zertifikate bleiben unberührt.

**Keine doppelten Einträge:** Die ID steht im Zertifikatseintrag (`dsmId`); fehlt
sie, etwa nach einer neuen Anmeldung, findet die Beschreibung den Eintrag. Eine
ID, die DSM nicht mehr kennt, wird nicht geglaubt.

**Einmalig bleibt die Zuordnung.** Ein neuer Eintrag taucht in
*Systemsteuerung → Sicherheit → Zertifikat* auf und wird dort in
*Einstellungen* einem Dienst zugeordnet — Importieren, Kopieren und das
Erneuern danach entfallen. `wave cert` ordnet nichts selbst zu, denn damit würde
es das Zertifikat der DSM-Weboberfläche austauschen, ohne dass jemand es verlangt
hat.

**Scheitert die Übernahme** (Speicher nicht beschreibbar, INFO kaputt), steht
eine Zeile im Log des Daemons, wie beim Hook. Das Zertifikat unter
`certs/<name>/` ist gültig, die Erneuerung gilt nicht als gescheitert, und ein
kaputtes INFO wird nie überschrieben.

## Abnahme auf einem NAS (offen)

1. SPK über „Manuelle Installation“ installieren: **keine** Meldung über
   Root-Rechte; das Paket steht danach im Paketzentrum und lässt sich an- und
   ausschalten, ohne als abgestürzt zu erscheinen (auch ohne Handschritt).
2. `sudo /var/packages/wave/scripts/setup`; `systemctl status wave`; `wave status`
   (als Mitglied der Gruppe `wave`); `getent group wave`; stimmen Benutzer und
   Gruppe `wave-pkg` (`id wave-pkg`)?
3. Neustart: kommt der Daemon von allein hoch, ist `/dev/net/tun` da?
4. `sudo systemctl stop wave` und `disable`, Neustart: bleibt er aus?
5. `wave cert --dsm`, dann das Zertifikat in der Oberfläche einem Dienst
   zuordnen, erneut `wave cert`: einmal in der Liste, Weboberfläche liefert das
   neue Zertifikat.
6. `sudo …/scripts/setup uninstall`, dann Paket deinstallieren: Unit weg,
   `/var/lib/wave` noch da.
7. Die Seite: wave im Hauptmenü (nur für Administratoren), die Waves und
   Geräte stehen da, Trennen und Verbinden wirken, eine Anmeldung zeigt den
   Freigabelink, und nach der Freigabe erscheinen die Geräte ohne Neuladen.
   Ein Konto ohne Administratorrechte bekommt den Eintrag nicht und, über die
   URL, nur die Meldung. Läuft das CGI wirklich als `wave-pkg` (`ps` während
   einer Anfrage), und reicht der Socket-Eigentümer dafür? Braucht DSM nach
   der Installation einen nginx-Neustart, bis der Eintrag erscheint (Tailscale
   setzt dafür `startstop_restart_services="nginx"`)?
8. Dasselbe ohne SSH: Paket neu installieren, `setup` als Aufgabe im
   Aufgabenplaner (Benutzer root) ausführen. Läuft danach der Dienst, gibt es
   die Gruppe `wave` (ohne Mitglieder), und stimmen die Bezeichnungen der
   Oberfläche in dieser Anleitung?

## Quellen

- Synology Developer Guide: INFO (Pflicht- und optionale Felder), Plattform-/
  Arch-Tabelle, `scripts`, `privilege`.
- Tailscale: `release/dist/synology/pkgs.go` (Paketaufbau, `arch`-Familien,
  `dsmuidir`/`dsmappname`), `release/dist/synology/files/config` und
  `index.cgi` (der Eintrag im Hauptmenü), `client/web/synology.go` (Token,
  `authenticate.cgi`, `administrators`) und `client/web/src/hooks/auth.ts`
  (der Token von `/webman/login.cgi`), außerdem
  `release/dist/synology/files/privilege-dsm7` (`run-as: package`, Benutzer und
  Gruppe) und `cmd/tailscale/cli/configure-synology.go` (`mknod`/`chmod` für
  `/dev/net/tun` und `setcap` auf `tailscaled`, als root). Tailscales Anleitung
  (tailscale.com/kb/1131/synology) lässt das als Aufgabe beim Hochfahren
  laufen und nach jedem Paket-Update erneut.
- SynoCommunity/spksrc: `mk/spksrc.service.mk` (für DSM ≥ 7 immer
  `"run-as": "package"`).
- runfalk/synology-wireguard: README (ab DSM 7 gibt Synology Paketen ohne Signatur
  kein root; Start von Hand mit `sudo`; verweist auf Synologys Hinweis zu
  Drittanbieter-Paketen), `conf/resource`.
- JessThrysoee/synology-letsencrypt: Aufbau von `_archive`, INFO, Dienstlisten
  und Reload-Schritte auf DSM 6 und 7. Synology dokumentiert diese Ablage nicht.
