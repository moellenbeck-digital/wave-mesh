# Gratis-Tarif und Selfhosting

*English: [`FREE-PLAN.md`](FREE-PLAN.md). Ticket #119; die Technik dazu steht in
[`ACCOUNT-SUBSCRIPTIONS.md`](ACCOUNT-SUBSCRIPTIONS.md) und im Abschnitt „Gratis-Konto und Tarifwechsel“
der [`CLAUDE.md`](../CLAUDE.md).*

Wer auf einem **gehosteten** Server (wave-mesh.org) ein Konto anlegt, startet mit dem Gratis-Tarif. Ein
**selbst betriebener** Server (Selfhosting) hat keinen Tarif und keine Grenzen.

## Was Gratis heißt

Die Grenzen gelten **für das ganze Konto, über alle seine Waves zusammen**, nicht je Wave:

| Was | Gratis | Bezahlt (Konto-Abo) |
|---|---|---|
| Waves | 3 | keine Grenze |
| Personen | 3 | die gebuchten Plätze |
| Geräte | 100 | keine Grenze |

Die Begriffe sind überall dieselben: in der Kontoübersicht, in den Fehlermeldungen, in der API
(`/api/me`) und hier.

## Wie gezählt wird

- **Waves:** alle Waves des Kontos.
- **Personen:** Mitglieder plus **offene Einladungen**. Eine offene Einladung **reserviert einen Platz**,
  bis sie angenommen, zurückgezogen wird oder abläuft. Wer in mehreren Waves des Kontos Mitglied ist,
  zählt **einmal**. Eine Einladung an eine Adresse, die schon Mitglied oder anderswo im Konto
  eingeladen ist, kostet keinen weiteren Platz; eine neue Einladung an dieselbe Adresse im selben Wave
  ersetzt die alte.
- **Geräte:** jedes Gerät einmal (nach seinem Maschinenschlüssel), egal in wie vielen Waves des Kontos
  es steht.

Ein Beispiel: Anna ist Eigentümerin von zwei Waves (Platz 1), Ben ist in beiden Mitglied (Platz 2), und
eine Einladung an Chris ist offen (Platz 3). Das Konto hält **3 von 3 Personen**; die vierte Einladung wird
abgewiesen, bis eine zurückgezogen oder eine Person entfernt ist.

## Wo du die Belegung siehst

- **Kontoübersicht** (`/account#plan`): Tarif, Waves, Personen und Geräte, jeweils als *belegt von erlaubt*,
  dazu die Zählregeln. Liegt das Konto über einer Grenze (nach einer Kündigung), steht darunter der
  **Überhang**: welche Zahl wie weit darüber liegt und, je Wave, welche Personen und Geräte dort sind.
- **Beim Einladen** (Mitgliederliste eines Waves und die Seite nach dem Einladen): die aktuelle Belegung
  der Personen mit der Erklärung, dass sie über alle Waves des Kontos gilt, dass offene Einladungen einen
  Platz reservieren und dass Mehrfachmitgliedschaft einmal zählt. Der Hinweis erscheint nur auf
  gehosteten Servern mit Tarif, nie beim Selfhosting.

## Wenn eine Grenze erreicht ist

Jede Abweisung nennt die Zahlen als *belegt / erlaubt* und mindestens einen nächsten Schritt. Sie
betrifft nur **Neues**; was da ist, bleibt und funktioniert weiter.

| Grenze | Wo es auffällt | Nächster Schritt |
|---|---|---|
| Waves | Wave anlegen | einen Wave löschen, den du nicht mehr brauchst, oder ein Abo abschließen (`/account#plan`) |
| Personen | Einladen, Person per `wave-admin` aufnehmen | eine Einladung zurückziehen oder eine Person entfernen, oder ein Abo abschließen |
| Geräte | Gerät registrieren (`wave up`, Schlüssel, Browser-Freigabe) | ein Gerät entfernen (Weboberfläche oder `wave logout <wave>` am Gerät), oder ein Abo abschließen |

Auf der Kommandozeile (`wave up`, `wave login`), in der DSM-Oberfläche und in der Weboberfläche
erscheint dieselbe Meldung, auf Deutsch oder Englisch. Programme lesen sie aus den JSON-Fehlern
(`device_limit`, `people-limit`, `wave-limit`, jeweils mit `limit` und `used`, siehe
[`ACCOUNT-SUBSCRIPTIONS.md`](ACCOUNT-SUBSCRIPTIONS.md)).

## Upgrade und Downgrade

- **Upgrade:** Ein Konto-Abo gilt für das ganze Konto, sofort. Waves und Geräte sind dann nicht mehr
  begrenzt, die Personen richten sich nach den gebuchten Plätzen. An Waves, Schlüsseln, Adressen und
  Verbindungen ändert sich nichts.
- **Downgrade:** Bevor eine Kündigung zugelassen wird, prüft die Seite, ob das Konto als Gratis-Konto so
  bleiben dürfte (`downgrade-check`, immer gegen die **Gratis**-Grenzen). Passt es nicht, ist der
  **Überhang** die Antwort darauf, um wie viel nicht.
- **Nach der Kündigung** ist das Konto wieder Gratis. **Nichts wird gelöscht oder gestoppt:** Waves, Personen,
  Einladungen und Geräte bleiben stehen und laufen weiter; die Grenzen sagen nur zu Neuem nein, bis das
  Konto wieder innerhalb liegt. Was „zu viel“ ist, entscheidet der Eigentümer, nicht das System.

## Selfhosting ist unbegrenzt

Ein selbst betriebener Control-Server (ohne `WAVE_BILLING_TOKEN`) kennt keinen Tarif:

- `/api/me` enthält kein `plan` (und keine `limits`, `usage`, `overhang`);
- kein Wave, keine Einladung und kein Gerät wird wegen einer Gratis-Grenze abgewiesen;
- die Oberfläche zeigt keine Quotenhinweise: keinen Block „Tarif und Nutzung“, keinen Personen-Hinweis
  beim Einladen.

Was dort begrenzt, sind nur Hardware und Adressraum. Betrieb: [`deployment/README.md`](../deployment/README.md).

## Für Betreiber gehosteter Server

| Einstellung | Standard | Bedeutung |
|---|---|---|
| `WAVE_FREE_MAX_WAVES` | 3 | Waves je Gratis-Konto (mindestens 1) |
| `WAVE_FREE_DEVICE_LIMIT` | 100 | Geräte je Gratis-Konto (mindestens 1) |
| Personen | 3, fest | **kein** Env; die Konstante `FREE_PEOPLE_LIMIT` in `billing/plan.ts` |

Mehr dazu, auch zu `WAVE_FREE_IPV4_PREFIX_LENGTH` und `WAVE_FREE_BLOCKED_EMAIL_DOMAINS`:
[`ACCOUNT-SUBSCRIPTIONS.md`](ACCOUNT-SUBSCRIPTIONS.md).
