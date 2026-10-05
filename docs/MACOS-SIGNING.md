# Apple-Signierung der macOS-Releases

Die Umsetzung übernimmt die temporäre Schlüsselbundverwaltung aus BloomMD.
wave-mesh liefert weiterhin `wave-darwin-{amd64,arm64}.tar.gz`: `wave`,
`wireguard-go` und die beiden Lizenzdateien. Das Format des Auto-Updaters bleibt
unverändert. Ein `.pkg`, DMG oder App-Bundle wird hier nicht erzeugt.

## Zugangsdaten

1Password-Konto: `moellenbeck-digital.1password.eu`, Vault **wave-mesh CI**.
Der Service-Account **wave-mesh GitHub Actions Signing** erhält ausschließlich
`read_items` für diesen Vault. Sein Token liegt im GitHub-Repository-Secret
`OP_SERVICE_ACCOUNT_TOKEN` sowie im Vault-Eintrag **GitHub Actions Service Account**.

- **macOS Developer ID**: `macos_developer_id_p12_base64`,
  `macos_developer_id_p12_password`, `electrobun_developer_id`, `apple_team_id`.
  Der historische Feldname `electrobun_developer_id` wird im Workflow auf
  `MACOS_DEVELOPER_ID` abgebildet; wave-mesh benötigt kein Electrobun.
- **Apple Notarization**: `apple_api_key_id`, `apple_api_issuer_id`,
  `apple_api_private_key_p8_base64`.

Zertifikat und Notarisierungs-Key werden vorerst mit BloomMD geteilt, aber im
eigenen Vault gespeichert. Rotation oder Widerruf betrifft deshalb beide Projekte;
beide Kopien müssen aktualisiert werden. Der CI-Service-Account ist unabhängig.
Private Schlüssel und Passwörter gehören nicht ins Repository oder in Logs.
Das tägliche 1Password-Kontingent gilt gemeinsam für alle Service-Accounts.

## Release-Ablauf

Der bestehende tagbasierte Release-Job läuft jetzt auf `macos-latest`. Er baut
weiterhin alle sechs Clients im selben Job, ohne große Zwischenartefakte an
andere Jobs zu übertragen. Linux-Verifikation, E2E und Images bleiben unverändert.

1. Alle Clients bauen und paketieren.
2. Sieben Felder über die gepinnte 1Password-Action laden, ohne sie global als
   Umgebungsvariablen zu exportieren.
3. Zertifikat in einen temporären Schlüsselbund importieren. Der `.p8`-Key liegt
   nur im geschützten temporären Verzeichnis. Identität und Team müssen passen.
4. In beiden macOS-Archiven `wave` und `wireguard-go` mit Developer ID Application,
   Zeitstempel und Hardened Runtime signieren. Nur `wave` erhält `allow-jit` für
   Bun; Debugger-Entitlements sind nicht erlaubt.
5. Je Architektur ein temporäres ZIP bei `notarytool` einreichen. Nur `Accepted`
   lässt den Ablauf fortfahren. Timeout nach 30 Minuten; keine automatische
   erneute Einreichung bei Fehlern.
6. Die signierten Dateien wieder als `.tar.gz` packen und erneut entpacken.
   Bytegleichheit, Signatur, Team, Runtime und Entitlements sowie die verfügbaren
   Notarisierungstickets per `codesign --check-notarization` prüfen.
7. Alle sechs SHA-256-Prüfsummen neu schreiben. Erst danach das bisherige
   Ed25519-Release-Manifest erstellen. Die Apple-Signierung ersetzt diese
   Vertrauenskette des Auto-Updaters nicht.
8. `macos-signing-evidence.json` mit Version, Commit, Team, Submission-IDs und
   Hashes zusammen mit den Release-Dateien veröffentlichen.

Ein `always()`-Schritt stellt die vorherige Schlüsselbund-Suchliste wieder her
und entfernt den temporären Schlüsselbund sowie die privaten Dateien, auch bei
einem fehlgeschlagenen Build. Ohne gültige Secrets oder erfolgreiche Prüfungen
wird kein GitHub-Release veröffentlicht.

## Grenzen und Abnahme

Am 05.10.2026 wurde der Ablauf lokal mit echten Apple-Zugangsdaten erfolgreich
geprüft, Version `0.7.0-develop.2`, Basis-Commit `4b4cf67` mit uncommitteten
Signierungsänderungen:

| Architektur | Apple Submission-ID | Ergebnis |
| --- | --- | --- |
| Intel | `a0678b0c-6176-4b88-9607-f2a281549d79` | Accepted |
| Apple Silicon | `a9060d45-0ca3-4f9d-80a7-64044cfba4e4` | Accepted |

Beide Archive wurden nach dem Packen entpackt und auf Signatur, Entitlements und
online verfügbare Notarisierungstickets geprüft. `wave version` und
`wireguard-go --version` starteten für beide Architekturen auf dem lokalen
Apple-Silicon-Mac (Intel unter Rosetta). Alle sechs Archiv-Prüfsummen stimmen.
Der temporäre Schlüsselbund und die privaten Dateien wurden entfernt.
Der eigene wave-mesh-Service-Account konnte beide Apple-Einträge lesen; der
allgemeine Token aus `~/.secrets` hat dagegen keinen Zugriff auf diesen Vault.
Die vollständigen Hashes stehen im lokalen `dist/macos-signing-evidence.json`.
Dieser Test hat keinen Release veröffentlicht; CI-Lauf und unabhängige
Download-/Installations-/Auto-Update-Abnahme bleiben offen.

Beim ersten Test wurden Apples `._`-Metadatendateien im Archiv erkannt.
Der Build unterdrückt sie jetzt mit `COPYFILE_DISABLE=1`; die strikte Prüfung
der vier erlaubten Archivdateien bleibt bestehen.

Apple unterstützt kein Stapling an einzelnen Binaries oder ZIP-Archiven.
Gatekeeper muss das Ticket daher online abrufen können. Ein stapelbares
Installationsmedium wäre ein separater Packaging-Schritt.

Die Implementierung allein ist kein Nachweis eines signierten Releases. Vor der
ersten Freigabe müssen ein echter Signierungs-/Notarisierungslauf und ein Download
auf einem unabhängigen Mac getestet werden: Start ohne Gatekeeper-Ausnahme,
`wave version`, Installation, Tray/Daemon und Auto-Update. Für Intel und Apple
Silicon sind die jeweiligen Artefakte zu prüfen. Kein Release-Tag wird allein
durch die Einrichtung dieses Workflows erzeugt.

Lokale Prüfungen ohne Apple-Secrets:

```sh
python3 -m unittest discover -s scripts -p 'test_*.py'
bash -n scripts/build-clients.sh
```

Referenzen:
- [Apple: Notarisierungsablauf](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)
- [Bun: Signierung kompilierter Executables](https://bun.com/docs/bundler/executables)
