# wave-mesh – Arch-Paket

Binärpaket für Arch Linux und Omarchy. Lädt die fertigen Binaries aus dem
GitHub-Release herunter, keine Kompilierung nötig.

## Bauen und installieren

```bash
cd packaging/arch
makepkg -si
```

`-s` installiert fehlende Abhängigkeiten automatisch.
`-i` installiert das fertige Paket mit `pacman -U`.

### Prüfung

```bash
namcap PKGBUILD
namcap wave-mesh-*.pkg.tar.zst
```

Erwartet: nur Warnungen (W), keine Fehler (E).  
Die W-Meldungen zu RELRO, PIE und „unstripped" sind normal für vorkompilierte
Binaries. `iproute2` und `nftables` werden zur Laufzeit als Prozesse aufgerufen
(`ip`, `nft`), nicht per shared library – daher Warnungen.

## Dienst starten

```bash
sudo systemctl enable --now wave-mesh
```

Dann dem Wave beitreten:

```bash
wave login <control-server-url>
wave up
```

## Gruppe für Nicht-root-Benutzer

Der Daemon legt den Steuersocket für die Gruppe `wave` an (erzeugt beim
Paketinstall durch `sysusers.d`). Mitglieder dieser Gruppe können `wave up`,
`wave status` usw. ohne sudo ausführen:

```bash
sudo usermod -aG wave $USER
# Neuanmeldung erforderlich
```

## Platzierung für Omarchy

Das Vorbild ist `basecamp/omarchy` → `bin/omarchy-install-service-tailscale`.
Ein analoges Snippet für wave-mesh (z. B. `bin/omarchy-install-service-wave`):

```bash
#!/usr/bin/env bash
set -euo pipefail

# Paket installieren (falls nicht vorhanden)
if ! pacman -Qi wave-mesh &>/dev/null; then
  cd /pfad/zu/packaging/arch
  sudo -u "$USER" makepkg -si --noconfirm
fi

# Dienst einrichten und starten
sudo systemctl enable --now wave-mesh

# Benutzer zur wave-Gruppe hinzufügen
sudo usermod -aG wave "$USER"

# Control-Server beitreten
wave login "$WAVE_CONTROL_URL"
wave up
```

Variablen wie `WAVE_CONTROL_URL` können aus der Omarchy-Konfiguration kommen.

## Offene Punkte

- **arm64 / aarch64 im Container nicht getestet**: Das offizielle
  `archlinux`-Docker-Image gibt es nur für `amd64`. Der PKGBUILD enthält
  `source_aarch64` mit korrekter Prüfsumme; der Bau wurde jedoch nicht auf
  echter aarch64-Hardware oder einem passenden Emulationsimage verifiziert (N).

- **Selbstaktualisierung deaktiviert durch Pfad**: Die eingebaute
  Selbstaktualisierung erkennt `/usr/bin/` als paketverwaltet und deaktiviert
  sich automatisch (siehe `update.ts` → `PACKAGE_MANAGED`). Explizit
  konfigurierbar über `/etc/wave/wave.env` → `WAVE_AUTO_UPDATE=false`.

- **Nicht im AUR**: Dieses Paket ist nicht ins AUR hochgeladen und soll dort
  nicht erscheinen – es ist für lokale Nutzung und Omarchy gedacht.

- **systemd-analyze verify**: Im Docker-Container schlägt `systemd-analyze
  verify` mit „Invalid argument" fehl, weil systemd nicht als PID 1 läuft.
  Auf dem echten Rechner mit laufendem systemd ist das zu prüfen (siehe
  „Was Ichi noch testen muss").

## Was Ichi auf dem Omarchy-Rechner noch testen muss

| Schritt | Befehl |
|---|---|
| Unit korrekt laden | `systemd-analyze verify /usr/lib/systemd/system/wave-mesh.service` |
| Dienst starten | `sudo systemctl enable --now wave-mesh` |
| Dienst läuft | `systemctl status wave-mesh` |
| Gruppe aktiv (nach Neuanmeldung) | `groups` → sollte `wave` enthalten |
| Login ohne sudo | `wave login <url>` als normaler Benutzer |
| Tunnel hoch | `wave up` und `wave status` |
| Kernel-WireGuard | `lsmod \| grep wireguard` (optional, wave nutzt wireguard-go) |
