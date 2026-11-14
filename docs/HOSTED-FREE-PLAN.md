# Gehosteter Gratis-Tarif pro Kundenkonto

Status: Historischer Produktplan vom 13.11.2026, inzwischen teilweise umgesetzt.
Die folgenden Bestandsbeschreibungen und offenen Entscheidungen geben den
damaligen Planungsstand wieder. Den aktuellen Stand beschreiben
[`GRATIS-TARIF.md`](GRATIS-TARIF.md),
[`ACCOUNT-SUBSCRIPTIONS.md`](ACCOUNT-SUBSCRIPTIONS.md) und
[`DEVICE-IDENTITY.md`](DEVICE-IDENTITY.md).

## Ziel und Geltungsbereich

Ein Kundenkonto kann mehrere getrennte Waves auf unserem gehosteten Control-Server
betreiben. Das kostenlose Kontingent gilt **einmal pro Kundenkonto über alle
seine Waves**, nicht je Wave und nicht für alle Kunden eines Servers zusammen.
Selbst betriebene Control-Server bleiben ohne Nutzer- und Gerätelimit kostenlos.

| Größe | Gratisgrenze | Zählregel |
| --- | ---: | --- |
| Personen | 3 | Unterschiedliche Mitglieder einschließlich Eigentümer, über alle Waves des Kundenkontos. Eine Person in mehreren Waves zählt einmal. Offene Einladungen reservieren einen Platz für ihre E-Mail-Adresse. |
| Geräte | 100 | Unterschiedliche registrierte Geräte über alle Waves des Kundenkontos. Ein Gerät in mehreren Waves zählt einmal; ob es gerade verbunden ist, spielt keine Rolle. |

„Gleichzeitig“ bezieht sich auf bestehende Mitgliedschaften und registrierte
Geräte, **nicht** auf offene Browser-Sitzungen oder gerade aktive Tunnel.
Das Entfernen der letzten Mitgliedschaft beziehungsweise Registrierung gibt
den Platz wieder frei. Bereits verbundene Geräte werden beim Erreichen einer
Grenze nicht getrennt; nur zusätzliche Einladungen und Registrierungen werden
abgelehnt.

Ein gemeinsames Kundenkonto ist eine neue Produkteinheit. Heute hängen
Abonnement und Platzgrenze an einem einzelnen Wave (`wave_billing`,
`apps/control/src/billing/seats.ts`); ohne Abrechnungszeile sind Waves
unbegrenzt. Die gehostete Gratis-Anmeldung existiert noch nicht. Die
Preisseite nennt derzeit nur unbegrenztes Selbsthosting und bezahltes Hosting.

## Produktanforderungen

1. Ein bestätigter Eigentümer kann ohne Zahlung ein Kundenkonto und darin
   Waves anlegen. Die Bestätigung der E-Mail erfolgt vor der Belegung eines
   Adressblocks. Ein bestehendes bestätigtes Konto wird wiederverwendet;
   eine zweite Anmeldung mit derselben Adresse darf keinen neuen Gratis-Topf
   erzeugen. Als Missbrauchsgrenze gilt zunächst ein Gratis-Kundenkonto je
   bestätigtem Eigentümer; Anmeldeversuche werden begrenzt.
2. Die Kontoübersicht zeigt Tarif, `belegt / erlaubt` für Personen und Geräte
   und die Waves des Kontos. Einladungen zeigen ausdrücklich, dass sie einen
   Platz reservieren. Bei voller Quote erhält der Aufrufer eine lokalisierte,
   handlungsfähige Fehlermeldung; der bestehende Zugang bleibt bestehen.
3. Alle Wege zur Mitgliedschaft und Geräteregistrierung verwenden dieselbe
   zentrale Quotenprüfung: Browser, Einladung, Administrator, Gerätefreigabe
   und Pre-Auth-Key. Gleichzeitige Anfragen können die Grenze nicht
   überschreiten. Connectoren sind Geräte und zählen mit.
4. Das bestehende Bezahl-Abo wird dem Kundenkonto zugeordnet. Ein Upgrade
   behält Waves, Mitglieder, Geräte, Schlüssel und Adressen. Ein Wechsel
   zurück auf Gratis wird erst angeboten, wenn beide Grenzen eingehalten
   werden; andernfalls nennt die Oberfläche die zu entfernenden Überhänge.
   Kündigung und Datenaufbewahrung müssen dafür mit dem heutigen
   30-Tage-Löschablauf abgestimmt werden.
5. Die Preisseite unterscheidet klar zwischen unbegrenztem Selbsthosting,
   dem gehosteten Gratis-Tarif und bezahltem Hosting. DE und EN nennen die
   kontoübergreifende Zählregel und den Stand des Angebots gleichlautend.

## Technische Umsetzung in Reihenfolge

1. **Kundenkonto und Migration:** Neue, dauerhafte Konto-ID mit Eigentümer,
   Tarif und Wave-Zuordnung. Bestehende selbst betriebene Waves bleiben
   außerhalb dieses Modells; bestehende bezahlte Waves und ihre
   Stripe-Zuordnung werden ohne Schlüssel- oder Adresswechsel übernommen.
   `wave_billing` bleibt Quelle des Abo-Zustands, die wirksame Berechtigung
   wird an einer Stelle aus Konto-Tarif und Abo abgeleitet. Keine erfundenen
   Stripe-Abos für Gratis-Konten.
2. **Identitäten und Zähler:** Personen werden nach kanonischer, bestätigter
   Konto-Identität gezählt; Einladungen reservieren nach normalisierter
   E-Mail-Adresse. Für Geräte ist eine stabile Identität über mehrere Waves
   nötig. Prüfen, ob der heutige `machine_key` dafür auch bei
   Schlüsselwechsel taugt; andernfalls eine dauerhafte Geräte-ID einführen.
   Ein mehrfach registriertes Gerät wird nur beim letzten Entfernen frei.
3. **Durchsetzung:** `ensureSeatFor()` auf das Kundenkonto erweitern und die
   Gerätequote zentral in `createNode()` prüfen. `createNode()` sperrt die
   Wave-Zeile bereits; für kontoübergreifende Zähler braucht es eine
   einheitliche Kontosperre und dokumentierte Sperrreihenfolge. Limits und
   Belegung über die Control-API an das Web-Frontend liefern, ohne die
   Datenbank direkt aus dem Frontend zu lesen.
4. **Gratis-Onboarding und Tarifwechsel:** Bestätigungslink, Konto- und
   Wave-Erstellung, klare Fehlermeldung bei erschöpfter Kapazität. Stripe
   ordnet ein späteres Abo dem bestehenden Konto zu, statt einen zweiten
   Wave anzulegen. Webhooks bleiben wiederholbar und gegen vertauschte
   Reihenfolge geschützt.
5. **Kapazität vor öffentlichem Start:** Der Server reserviert derzeit ein
   `/16` je Wave und hat damit höchstens 64 Wave-Blöcke. Für eine offene
   Gratis-Anmeldung neue, kleinere Präfixe mit Überschneidungsprüfung
   einführen oder Kunden auf mehrere Control-Server verteilen. Bestehende
   `/16` bleiben unverändert. Ein begrenzter Test kann vorher mit der
   vorhandenen Kapazität laufen; eine öffentliche Anmeldung nicht.
6. **Oberfläche, Betrieb, Recht:** Preise, Kontoübersicht, Anmeldung,
   Hilfe und Fehlermeldungen in DE/EN; AGB und Datenschutzhinweise für den
   gehosteten Gratis-Tarif prüfen. Quotenereignisse, aktive Geräte,
   Relay-Volumen und belegte Adressblöcke beobachten, ohne Nutzdaten zu
   erfassen. Rollback für Schema, Tarif und Checkout dokumentieren.

## Abnahme

- Drei unterschiedliche Personen und 100 unterschiedliche Geräte können
  über mehrere Waves verteilt sein; jeweils eine weitere Person oder ein
  weiteres Gerät wird auf jedem Zugangsweg mit demselben Limit abgewiesen.
- Dieselbe Person und dasselbe Gerät in zwei Waves belegen jeweils nur einen
  Platz. Offene Einladungen reservieren; Widerruf und Entfernen geben frei.
- Zwei parallele Einladungen oder Geräteregistrierungen können den letzten
  freien Platz nicht doppelt vergeben.
- Upgrade und zulässiger Downgrade erhalten Wave-IDs, Geräte, Schlüssel,
  Adressen und laufende Verbindungen. Bestehende Bezahl-Abos bleiben korrekt.
- Selbst betriebene Waves behalten ihre bisherigen unbegrenzten Regeln.
- End-to-End-Tests prüfen die Grenzen über echte Geräteanmeldung und
  Einladungen; Website, E-Mail und API zeigen dieselben Zahlen und Begriffe.

## Vor Veröffentlichung zu entscheiden

- Zahlt ein Kunde im Bezahl-Tarif für alle Mitglieder oder nur für die Plätze
  ab dem vierten? Vorschlag: alle Mitglieder, wie im bestehenden Abo.
- Wie viele Waves darf ein Gratis-Konto anlegen? Der Nutzen mehrerer Waves
  soll erhalten bleiben; die Zahl muss zur gewählten Adress- und
  Missbrauchsgrenze passen.
- Welche dauerhafte Geräte-ID übersteht eine Schlüsselrotation, ohne ein
  Gerät doppelt zu zählen oder fremde Geräte zusammenzufassen?
