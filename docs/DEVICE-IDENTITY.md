# Geräteidentität und das Gerätekontingent

Stand: Ticket #116 (Gratis-Kontingent pro Kundenkonto).

## Was ein Gerät ist

**Ein Gerät ist ein `machine_key`** (Ed25519-Schlüssel, `nodes.machine_key`). Er ist die
dauerhafte Identität: er signiert jede Anfrage an den Control-Server
(`packages/crypto/src/httpsig.ts`), und er ändert sich nicht, solange das Gerät in der Wave
bleibt. Die kurzlebigen Schlüssel sind andere: `node_key` (WireGuard) und `disco_key`
werden bei jeder erneuten Registrierung (`POST /v1/machine/register` eines bekannten
Geräts) ersetzt und laufen nach 180 Tagen ab (`key_expires_at`). Sie sind **nicht** die
Identität.

**Der `machine_key` wird nirgends rotiert.** Weder der Server (kein Pfad schreibt die
Spalte nach dem Anlegen) noch der Client (`apps/client/src/state.ts`, `ensureProfile`
erzeugt ihn einmal je Profil). Es gibt also keine Rotationsregel, die doppelt zählen oder
Platz freigeben könnte. Ein neuer `machine_key` ist ein neues Gerät: wer sein Profil löscht
und neu anmeldet, belegt einen weiteren Platz, bis der alte Knoten entfernt ist.

Heute erzeugt der Client **je Profil** einen eigenen `machine_key`. Ein physisches Gerät
mit zwei Profilen (auch am selben Server) hat also zwei `machine_key` und zählt zweimal.
Dass derselbe Schlüssel in mehreren Waves steht, ist serverseitig möglich (siehe unten),
wird aber erst durch einen Client entstehen, der den Schlüssel profilübergreifend teilt,
oder durch eine Anmeldung mit demselben Schlüssel und einem Pre-Auth-Key einer zweiten Wave.

## Ein Gerät, mehrere Waves

`nodes` ist je Wave eindeutig: `(wave_id, machine_key)` (Migration `0023`, vorher war
`machine_key` global eindeutig). Je Wave hat das Gerät einen eigenen Knoten mit eigener
Adresse und eigenem Namen; die Identität bleibt dieselbe.

Weil der Schlüssel allein dann nicht mehr sagt, welchen Knoten eine Anfrage meint, gilt eine
feste Auswahlregel (`routes/machine-auth.ts`, `nodeByMachineKey`):

1. Die Anfrage nennt die Wave im Header `X-Wave-Id`: der Knoten dieses Schlüssels in dieser
   Wave. Der Header liegt nicht unter der Signatur und braucht es nicht: die Signatur beweist
   den Schlüssel, der Header wählt nur unter den Knoten, die dieser Schlüssel schon hat. Eine
   fremde Wave findet nichts (404), nie den Knoten eines anderen Geräts.
2. Ohne Header: der einzige Knoten des Geräts. Hat das Gerät mehrere und nennt keine Wave,
   antwortet der Server mit **409** (`control-ws`: Close-Code **4409**) statt zu raten.
3. `register`: Ziel ist die Wave aus dem Header, sonst die des Pre-Auth-Keys. Steht das Gerät
   dort schon, werden nur seine Schlüssel erneuert (der Key wird nicht verbraucht).

Der Client sendet den Header noch nicht; solange jedes Profil einen eigenen `machine_key`
hat, ist er auch nicht nötig. Er wird gebraucht, sobald ein Gerät mit demselben Schlüssel
in einer zweiten Wave steht.

## Das Gerätekontingent (`billing/device-limit.ts`)

Ein **gehostetes Gratis-Konto** darf höchstens **100 verschiedene Geräte** über alle seine
Waves registrieren (Konstante `DEFAULT_FREE_DEVICE_LIMIT`, einstellbar mit
`WAVE_FREE_DEVICE_LIMIT`). Der Online-Status spielt keine Rolle.

- **Gratis-Status** (Annahme): die Wave hat ein `account_id`, und **keine** Wave des Kontos
  hat eine `wave_billing`-Zeile (auch nicht `suspended` oder `ended`: das Konto hat bezahlt
  oder bezahlt noch). Waves ohne `account_id` (selbst betrieben) sind unbegrenzt.
- **Gerät** = `count(distinct machine_key)` über die Knoten aller Waves des Kontos. Ein Gerät,
  das schon im Konto ist, darf in eine weitere Wave, ohne einen Platz zu belegen.
- **Zentral:** `createNode()` (`routes/machine.ts`) ruft `ensureDeviceSlot()` unter der
  Sperre auf Wave- und Kontozeile. Beide Wege, die Knoten anlegen, laufen dort durch:
  Pre-Auth-Key (`/v1/machine/register`, auch Connector) und Browser-Freigabe
  (`approveRequest`). Andere Wege legen keine Knoten an: Kontoverknüpfung und
  `moveTo` ändern nur `nodes.user_id`; Admin und `waves/*` entfernen nur.
- **Fehlerklasse** `DeviceLimitError` (Muster `SeatLimitError`). Abweisung:
  Maschinen-API `403 {"error": …, "code": "device_limit", "limit": 100}`; Browser-Freigabe eine
  Seite in der Sprache des Benutzers (`packages/i18n`, `routes/messages.ts`), die Anfrage
  bleibt offen und kann nach einem freien Platz mit demselben Link abgeschlossen werden.
- **Pre-Auth-Key:** das Limit wird vor dem Verbrauch des Keys geprüft; scheitert die
  Anlage erst unter der Sperre (Wettlauf um den letzten Platz), gibt `releaseAuthKey()` die
  Nutzung zurück.
- **Platz frei:** es gibt keinen Zähler. Gezählt werden die vorhandenen Knoten; löscht man den
  letzten Knoten eines `machine_key` im Konto (Gerät entfernen, Abmelden, Wave löschen mit
  Cascade), ist der Platz frei.
- **Bestand bleibt:** ein Konto, das schon mehr Geräte hat (z. B. weil
  `wave-admin migrate-accounts` Waves nachträglich zuordnet), verliert keines; es kommt nur
  keines Neues dazu.

## Rückfall

Das alte Control-Image läuft gegen das neue Schema weiter, solange kein Gerät in zwei Waves
steht: es sucht per `machine_key … limit 1`. Danach wäre seine Auswahl nicht eindeutig.
Rückfall also nur vor der ersten Anmeldung eines Schlüssels in einer zweiten Wave; die
Migration hat keinen `down`-Schritt.
