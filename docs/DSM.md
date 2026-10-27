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

- **Rechte.** Der Daemon braucht root: TUN-Gerät laden, Routen, Firewall, das
  Zertifikatsverzeichnis. DSM 7 zwingt Pakete in einen eigenen Paketbenutzer
  (`"run-as": "package"`); `"run-as": "root"` steht zwar in der
  `privilege`-Spezifikation, aber DSM 7 startet Pakete, die nicht von Synology
  signiert sind, nicht als root (Hinweis im WireGuard-SPK von runfalk). Tailscale
  geht den anderen Weg — Paketbenutzer, `setcap` auf `tailscaled` und ein
  Boot-Skript als root für `/dev/net/tun` —, das reicht hier nicht: Dateirechte
  auf dem Binary geben weder `insmod` noch Schreibzugriff auf
  `/usr/syno/etc/certificate`.
- **Was trägt:** `conf/privilege` mit `run-as: root`, und `start-stop-status
  start` ruft das vorhandene `wave install --binary <Paketpfad>` auf. Das
  schreibt die systemd-Unit, legt die Gruppe `wave` an (`synogroup`) und startet
  neu — die bestehende Install-Logik, keine Parallelwelt. systemd trägt den
  Daemon danach auch durch Neustarts.
- **Was der Nutzer einmalig selbst tut:** das Paket ohne „Nach der Installation
  ausführen“ installieren und per SSH `sudo
  /var/packages/wave/scripts/start-stop-status start` ausführen; die Konten, die
  `wave` bedienen dürfen, in die DSM-Gruppe `wave` eintragen.
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
| `conf/privilege` | `run-as: root` |
| `conf/resource` | legt `wave` per `usr-local-linker` in den PATH |
| `scripts/start-stop-status`, `scripts/preuninst` | Lebenszyklus, siehe unten |
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

**Lebenszyklus.**

- `start` → `wave install --binary <Paketpfad>`. `--binary` hält das Binary dort,
  wo das Paket es hingelegt hat; ohne die Option kopierte `install` es bei jedem
  Start nach `/usr/local/bin/wave` — über das, was der Selbstupdater dort
  inzwischen abgelegt hat.
- `stop` → `systemctl stop wave` und `disable`: gestoppt bleibt gestoppt, auch
  nach dem Neustart.
- `status` → `systemctl is-active wave`.
- `preuninst` → `wave uninstall`: sonst bliebe eine Unit, deren Binary fehlt. Die
  Anmeldung unter `/var/lib/wave` bleibt, wie bei `wave uninstall`.

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

1. SPK installieren, ohne zu starten; `sudo …/start-stop-status start`;
   `systemctl status wave`; `wave status`.
2. Neustart: kommt der Daemon von allein hoch, ist `/dev/net/tun` da?
3. Stoppen im Paketzentrum, Neustart: bleibt er aus?
4. `wave cert --dsm`, dann das Zertifikat in der Oberfläche einem Dienst
   zuordnen, erneut `wave cert`: einmal in der Liste, Weboberfläche liefert das
   neue Zertifikat.
5. Paket deinstallieren: Unit weg, `/var/lib/wave` noch da.

## Quellen

- Synology Developer Guide: INFO (Pflicht- und optionale Felder), Plattform-/
  Arch-Tabelle, `scripts`, `privilege`.
- Tailscale: `release/dist/synology/pkgs.go` (Paketaufbau, `arch`-Familien) und
  `cmd/tailscale/cli/configure-synology.go` (TUN und `setcap` als root).
- runfalk/synology-wireguard: README (root-Start ab DSM 7), `conf/resource`.
- JessThrysoee/synology-letsencrypt: Aufbau von `_archive`, INFO, Dienstlisten
  und Reload-Schritte auf DSM 6 und 7. Synology dokumentiert diese Ablage nicht.
