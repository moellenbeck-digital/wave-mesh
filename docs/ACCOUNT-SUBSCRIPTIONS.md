# Konto-Abos: Aufrufe für wave-mesh.org

Ticket #117. Ein **Konto-Abo** gilt für ein ganzes gehostetes Kundenkonto (`customer_accounts`) und
damit für alle seine Waves, im Unterschied zum Wave-Abo (`PUT /api/billing/subscriptions/:id`), das
genau einen Wave bucht. Wer mit einem Gratis-Konto startet (bis zu 3 Waves, 3 Personen, 100 Geräte),
upgradet mit einem Konto-Abo und fällt mit dessen Kündigung zurück in Gratis — ohne dass sich an
Waves, Schlüsseln, Adressen oder Verbindungen etwas ändert.

Die Seite ruft den Endpunkt in einem Folgeticket auf; dieses Dokument beschreibt den Vertrag. Es gibt
keinen weiteren Schreibweg (kein `wave-admin`, keine Oberfläche).

## Aufruf

```bash
curl -X PUT "$CONTROL/api/billing/account-subscriptions/$SUBSCRIPTION_ID" \
  -H "Authorization: Bearer $WAVE_BILLING_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "email": "anna@acme.example", "seats": 10, "state": "active", "asOf": 1789000000000 }'
```

Derselbe Bearer-Token wie bei den Wave-Abos (`WAVE_BILLING_TOKEN`); ohne Token gibt es den Pfad nicht
(404), mit falschem 401.

| Feld | Bedeutung |
|---|---|
| `:subscriptionId` | die Stripe-Abo-ID, dauerhaft; je ID eine Zeile |
| `email` | Adresse des Zahlenden; nur beim **ersten** Aufruf einer ID nötig, danach ignoriert |
| `seats` | ganze Zahl 1…100000: Personen im ganzen Konto (Mitglieder plus offene Einladungen) |
| `state` | `active`, `suspended`, `ended` — der Zustand, den das Abo haben soll |
| `asOf` | optional, ms: wann die Seite den Zustand bei Stripe gelesen hat |

Gesagt wird der **Zustand, nicht die Änderung**: dasselbe zweimal ist einmal, ein verspätetes Ereignis
ist nicht schlimmer als ein wiederholtes. Ein älterer `asOf` als der zuletzt angewandte wird nicht
angewandt und mit dem aktuellen Stand beantwortet (200).

## Wann ein Abo entsteht

Eine unbekannte ID entsteht nur mit `email` **und** `state: "active"`. Die Adresse muss einem
**bestätigten** Benutzer gehören (`emailVerified`): ein Konto-Abo kauft mehr Platz in einem Konto, das
schon jemandem gehört, deshalb gibt es hier keinen Platzhalter. Hat der Benutzer noch kein
Kundenkonto, entsteht es leer mit dem Abo. Bei mehreren Konten eines Benutzers gilt das älteste.

## Antworten

| Status | Body | Bedeutung für die Seite |
|---|---|---|
| 200 | `{ subscriptionId, accountId, created, state, seats, deleteAfter, waves, people }` | angewandt (auch wiederholt oder veraltet). `deleteAfter` nur in `ended` (ISO-Zeit), `waves` und `people` sind der Stand des Kontos jetzt |
| 400 | `{ "error": "invalid request" \| "not JSON" \| "not an email address…" }` | Aufruf falsch, nicht wiederholen |
| 401 | `{ "error": "unauthorized" }` | Token falsch |
| 404 | `{ "error": "unknown-subscription" }` | nie gesehen und nicht genug gesagt (keine Adresse oder nicht `active`) |
| 404 | `{ "error": "unknown-account" }` | **keine bestätigte Adresse dieses Namens**: es gibt kein Konto, das das Abo bekommen könnte. Es wurde nichts angelegt. Die Seite wiederholt nicht blind; der Käufer muss sich mit dieser Adresse bestätigt anmelden |
| 409 | `{ "error": "ended" }` | für immer beendet; ein späteres `active`/`suspended` ist ein veralteter Lesestand |
| 409 | `{ "error": "account-has-subscription" }` | das Konto hat schon ein anderes nicht beendetes Konto-Abo |
| 409 | `{ "error": "wave-subscription" }` | die ID ist schon die eines Wave-Abos |
| 500 | `{ "error": "could not apply the subscription" }` | unser Fehler, wiederholen |

Jede andere 404 (kein Token, falsche Adresse) ist Konfiguration, nicht „unbekannt“.

## Was daran festliegt

- **Beendet bleibt beendet.** `delete_after` (jetzt plus `WAVE_BILLING_RETENTION_DAYS`) wird einmal
  gesetzt und nicht hinausgeschoben. Es löscht **nichts**: ein beendetes Konto-Abo lässt das Konto in
  Gratis zurückfallen, Waves, Geräte, Mitglieder und Einladungen bleiben stehen. Gratis-Grenzen sagen
  danach nur zu Neuem nein, auch wenn das Konto sie überschreitet.
- **`suspended` ist nicht beendet:** das Konto bleibt bezahlt. Eine Pause von Netzkarten gibt es für
  Konto-Abos nicht (nur das Wave-Abo pausiert einen Wave).
- **Ein nicht beendetes Konto-Abo je Konto** (partieller Unique-Index). Zwei gleichzeitige
  Zustellungen derselben ID ergeben eine Zeile und zwei Mal 200 (`created: true` genau einmal).
- **Wie `seats` zählt:** mit Konto-Abo gilt konto-weit `seats` plus die Summe der `wave_billing.seats`
  des Kontos, gezählt als verschiedene Personen. Ein Wave mit eigener `wave_billing`-Zeile prüft
  weiter je Wave.
- **Geräte:** ein Konto mit nicht beendetem Konto-Abo hat keine Gerätegrenze.
- **Keine Netzkarte:** ein Konto-Abo startet oder stoppt kein Mesh; an Geräte wird nichts gesendet.
- **Log:** `billing: account <id> subscription <sub> is <state>, <n> seats` bei jeder Änderung.

## Downgrade-Prüfung

Bevor die Seite eine Kündigung zulässt, fragt sie, ob das Konto als Gratis-Konto so bleiben dürfte. Die
Prüfung ändert nichts und löscht nichts; die Entscheidung bleibt bei der Seite.

```bash
curl "$CONTROL/api/billing/accounts/$ACCOUNT_ID/downgrade-check" \
  -H "Authorization: Bearer $WAVE_BILLING_TOKEN"
```

`$ACCOUNT_ID` ist die `accountId` aus der Antwort des Konto-Abos (`ca_…`).

```json
{
  "allowed": false,
  "limits": { "waves": 3, "people": 3, "devices": 100 },
  "usage": { "waves": 4, "people": 5, "devices": 12 },
  "overhang": { "waves": 1, "people": 2, "devices": 0 }
}
```

- `allowed` ist wahr bei höchstens `limits.waves` Waves, `limits.people` Personen und `limits.devices`
  Geräten (Standard 3 / 3 / 100; die Grenzen sind die der Gratis-Konten dieses Servers,
  `WAVE_FREE_MAX_WAVES`, `WAVE_FREE_DEVICE_LIMIT`).
- `usage.people` sind verschiedene Benutzer plus offene Einladungen an noch nicht beteiligte Adressen,
  `usage.devices` verschiedene Geräte (Maschinenschlüssel) über alle Waves des Kontos.
- `overhang` ist, um wie viel `usage` über `limits` liegt, je Zahl (0, wenn sie passt).
- Gemessen wird immer gegen die **Gratis**-Grenzen, auch bei einem Konto mit Abo: die Frage ist „würde es
  passen“.

| Status | Body | Bedeutung |
|---|---|---|
| 200 | wie oben | gilt für jedes Konto, auch ein leeres |
| 401 | `{ "error": "unauthorized" }` | Token fehlt oder ist falsch |
| 404 | `{ "error": "unknown-account" }` | die ID ist kein Kundenkonto |
| 404 | (leer) | kein `WAVE_BILLING_TOKEN` auf dem Server: Konfiguration, nicht „unbekannt“ |

## Was der Eigentümer sieht

`/api/me` trägt in `account` zusätzlich zu `identities` und `linkable` (nur auf einem gehosteten Server,
mit `WAVE_BILLING_TOKEN`):

```json
{
  "accountId": "ca_…",
  "plan": "free",
  "limits": { "waves": 3, "people": 3, "devices": 100 },
  "usage": { "waves": 2, "people": 1, "devices": 5 },
  "overhang": {
    "waves": 0, "people": 0, "devices": 0,
    "perWave": [
      { "waveId": "w_…", "waveName": "alpha",
        "people": [{ "email": "anna@acme.example", "kind": "member" },
                   { "email": "wait@acme.example", "kind": "invitation" }],
        "devices": [{ "name": "laptop" }] }
    ]
  }
}
```

`plan` ist `free` oder `paid`. Bei einem bezahlten Konto sind `limits.waves` und `limits.devices` `null`
(keine Grenze) und `limits.people` ist die Platzzahl. `accountId` ist `null`, solange der Benutzer noch
kein Konto hat (sein erster Wave legt es an); Plan `free`, Nutzung 0. `overhang.perWave` ist nur gefüllt,
wenn etwas über einer Grenze liegt, und nennt dann für **jeden** Wave des Kontos die Personen (Adresse,
Mitglied oder Einladung) und die Geräte (Name). Welche davon „zu viel“ sind, entscheidet das System nicht:
Es **löscht und stoppt nichts**, die Grenzen sagen nur zu Neuem nein. In der Oberfläche steht das auf
`/account` (Abschnitt „Tarif und Nutzung“, `#plan`).
