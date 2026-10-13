# App Store: Eintrag und Einreichung

Alles, was im App Store über die iOS-App steht, liegt hier und wird per Skript
nach App Store Connect geschrieben, nicht von Hand geklickt.

| Datei | Wofür |
|---|---|
| `listing.json` | Version, Kategorien, Texte (en-US primär, de-DE), Angaben für App Review |
| `screenshots.sh` | Screenshots für 6,9″-iPhone und 13″-iPad, je Sprache (`WaveUITests/StoreScreenshots.swift`, FakeTunnel mit `-UITestDemo`) |
| `push-listing.mjs` | schreibt `listing.json` nach App Store Connect |
| `upload-screenshots.mjs` | ersetzt die Screenshots der vorbereiteten Version |
| `asc.mjs` | der API-Zugang beider Skripte |

Die Screenshots liegen nicht im Repo (`screenshots/` ist ignoriert); sie
entstehen jedes Mal neu aus dem Stand des Codes.

## Ablauf

```bash
mobile/ios/store/screenshots.sh                       # braucht Xcode und Wavemobile.xcframework
export ASC_KEY_ID=… ASC_ISSUER_ID=… ASC_KEY_P8_BASE64=…   # Schlüssel mit Rolle „App Manager“
REVIEW_DEMO_PASSWORD=… node mobile/ios/store/push-listing.mjs
node mobile/ios/store/upload-screenshots.mjs
```

Der Schlüssel in „wave-mesh CI/Apple Notarization“ reicht dafür nicht: er darf
Builds hochladen, aber keine Metadaten ändern (403).

Einmalig im Browser, weil die API sie nicht anbietet: **App-Datenschutz**
(Antworten unten), **Preis** (kostenlos), **Verfügbarkeit** (alle Länder außer
Frankreich, siehe unten) und **Altersfreigabe** (überall „Nein“/„Keine“ → 4+).

Danach in App Store Connect den Build der Version wählen (gleiche
`MARKETING_VERSION` wie `listing.json`), Exportfrage „Standard-Verschlüsselung“
ist mit `ITSAppUsesNonExemptEncryption=false` schon beantwortet, und einreichen.
**Eingereicht wird nur mit Max' ausdrücklichem OK.**

## Für App Review

Apple prüft VPN-Apps genau (Richtlinie 5.4): Anbieter ist eine Organisation
(Moellenbeck-Digital UG), die App nutzt `NEPacketTunnelProvider`, es gibt eine
Datenschutzerklärung, und der Prüfer muss sich wirklich verbinden können.

Dafür gibt es am Control-Server `wave.moellenbeck-digital.io` das Konto
`app-review@wave-mesh.org` mit einem eigenen, sonst leeren Wave – getrennt vom
Wave des Teams. Angelegt mit `wave-admin set-password app-review@wave-mesh.org`
im Pod `wave-control` (Namespace `ops-mesh`); das Passwort steht in 1Password
und geht über `REVIEW_DEMO_PASSWORD` nach App Store Connect. Nach der Prüfung
kann der Wave bleiben: Apple prüft jedes Update wieder.

## App-Datenschutz (Antworten im Browser)

Die App selbst sammelt nichts für uns (keine Analyse, keine Werbung, kein
Tracking). Sie schickt dem Control-Server, den der Nutzer eingibt, Gerätename,
Betriebssystem, öffentliche Schlüssel und Netzwerkadressen. Betreibt der Kunde
den Server selbst, ist das keine Erhebung durch uns. Weil wir mit „Betrieb
durch uns“ aber auch selbst Server betreiben, geben wir es an:

- **Kontaktinformationen → E-Mail-Adresse**: mit der Identität verknüpft, Zweck
  „App-Funktionalität“, kein Tracking (Anmeldung am Control-Server)
- **Kennungen → Geräte-ID**: verknüpft, „App-Funktionalität“, kein Tracking
  (die öffentlichen Schlüssel und die Knoten-ID des Geräts)
- sonst nichts; Diagnosedaten nicht, denn das Protokoll verlässt das Gerät nur,
  wenn der Nutzer es selbst teilt

## Frankreich

Für Apps mit Verschlüsselung verlangt Apple beim Vertrieb in Frankreich eine
Erklärung bei der ANSSI. Bis die vorliegt, ist Frankreich in der
Verfügbarkeit abgewählt.
