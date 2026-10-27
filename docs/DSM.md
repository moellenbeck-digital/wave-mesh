# wave auf Synology DSM 7

Das Installationspaket (SPK) und die Zertifikatsablage für DSM. Gebaut wird mit
`bun scripts/build-spk.ts [dist]` nach `scripts/build-clients.sh --package`;
im Release übernimmt das `release.yml`.

**Nicht auf echter Hardware geprüft.** Alles unten ist aus Synologys
Entwicklerdoku, aus dem Quelltext von Tailscale und aus Community-Paketen
abgeleitet (Quellen am Ende), und die Tests laufen gegen einen nachgebauten
DSM-Zertifikatspeicher. Vor dem ersten Release gehört ein Lauf auf einem NAS
dazu — siehe „Abnahme“.

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
  Zertifikatspeicher (Tailscale reicht `setcap` für das TUN-Gerät; wave braucht
  darüber hinaus Firewall, Routen und den Zertifikatspeicher). Also läuft der Daemon nicht aus dem Paket,
  sondern unter systemd, und **einmalig richtet ihn jemand mit `sudo` ein** —
  derselbe Handschritt, den Tailscale (`tailscale configure-host`, root, einmal)
  und runfalks WireGuard-Paket (`sudo …/scripts/start`) für DSM 7 verlangen.
  DSM selbst bietet für fremde Pakete keinen Weg, das zu vermeiden; die
  Alternative, den Schritt als Aufgabenplaner-Aufgabe („Benutzerdefiniertes
  Skript“, läuft als root) einzutragen, ist derselbe Handschritt in der
  Oberfläche statt im Terminal und wird nicht vom Paket angelegt.
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
  Gruppe `wave` ein (die `setup` angelegt hat; das Konto, das `sudo` aufgerufen
  hat, ist schon Mitglied) und meldet sie neu an: Die Gruppe darf den Socket
  des Daemons benutzen, ohne sie sagt `wave status` „Permission denied“. Mit
  der Gruppe `wave-pkg` hat das nichts zu tun — die gehört DSM und dem Paket.
- **Nicht auf echter Hardware geprüft:** dass DSM 7 das Paket mit
  `run-as: package` über „Manuelle Installation“ ohne die Root-Meldung
  annimmt, folgt aus Synologys Regel und den Paketen oben, ist aber an keinem
  NAS ausprobiert. Ebenso die Namen `wave-pkg` für Benutzer und Gruppe (frei
  gewählt, damit sie nicht mit der Gruppe `wave` kollidieren, die `wave
  install` anlegt) und das Verhalten des Paketzentrums bei `status`. Siehe
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
| `scripts/start-stop-status`, `scripts/preuninst` | Lebenszyklus als Paketbenutzer, siehe unten |
| `scripts/setup` | der Schritt als root, von Hand: `sudo /var/packages/wave/scripts/setup` |
| `package.tgz` | `wave`, `wireguard-go`, `LICENSE`, `LICENSE.wireguard-go` |

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

- `scripts/setup` (von Hand, als root) → `wave install --binary <Paketpfad>`.
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

## Quellen

- Synology Developer Guide: INFO (Pflicht- und optionale Felder), Plattform-/
  Arch-Tabelle, `scripts`, `privilege`.
- Tailscale: `release/dist/synology/pkgs.go` (Paketaufbau, `arch`-Familien),
  `release/dist/synology/files/privilege-dsm7` (`run-as: package`, Benutzer und
  Gruppe) und `cmd/tailscale/cli/configure-synology.go` (TUN und `setcap` als
  root, einmal von Hand).
- SynoCommunity/spksrc: `mk/spksrc.service.mk` (für DSM ≥ 7 immer
  `"run-as": "package"`).
- runfalk/synology-wireguard: README (ab DSM 7 gibt Synology Paketen ohne Signatur
  kein root; Start von Hand mit `sudo`; verweist auf Synologys Hinweis zu
  Drittanbieter-Paketen), `conf/resource`.
- JessThrysoee/synology-letsencrypt: Aufbau von `_archive`, INFO, Dienstlisten
  und Reload-Schritte auf DSM 6 und 7. Synology dokumentiert diese Ablage nicht.
