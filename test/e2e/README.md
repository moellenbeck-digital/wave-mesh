# End-to-End-Tests

## `two-nodes.sh` — M2

Fährt den vollständigen Weg ab: Control-Server starten, Browser-Login, zwei
Geräte registrieren und im Browser freigeben, WireGuard konfigurieren, und zum
Schluss in beide Richtungen über den Tunnel pingen.

```bash
./test/e2e/two-nodes.sh
```

Voraussetzungen: `bun`, `wireguard-go` (Pfad über `WAVE_WIREGUARD_GO`, sonst aus
`$PATH` oder `~/go/bin/wireguard`), `iproute2`, und aktivierte unprivilegierte
User-Namespaces.

**Kein root nötig.** Das Skript startet sich selbst in einem unprivilegierten
User-Namespace neu; darin sind wir uid 0 und dürfen Netzwerk-Namespaces, ein
veth-Paar und TUN-Geräte anlegen. Die beiden Nodes liegen in getrennten
Netns, verbunden durch ein veth-Paar — das steht für „zwei Rechner im selben
LAN". Nichts davon berührt das Host-Netzwerk.

Der Control-Server läuft dabei gegen ein eingebettetes Postgres (PGlite), ist
sonst aber die echte Anwendung mit denselben Routen und derselben Middleware.

Installation von wireguard-go, falls nicht vorhanden:

```bash
go install golang.zx2c4.com/wireguard@latest   # landet als ~/go/bin/wireguard
```

## `nat-traversal.sh` — M3

Der eigentliche Beweis für das NAT-Traversal: zwei Nodes hinter **getrennten
NATs**, ohne jede Portfreigabe, finden einen direkten Pfad zueinander und
tragen darüber WireGuard-Traffic.

```
  node A ---- natA ====== br0 (203.0.113.0/24) ====== natB ---- node B
  10.1.0.2   masquerade      control + 2× STUN       masquerade  10.2.0.2
             203.0.113.10    203.0.113.254           203.0.113.20
```

Geprüft wird nicht nur, dass der Ping ankommt, sondern auch **wie**: beide
Seiten müssen einen Pfad über die *öffentliche* Adresse der Gegenseite wählen
(`203.0.113.x`), und WireGuards Endpoint muss eine Loopback-Adresse sein — der
Beweis, dass der Verkehr durch den MagicSock läuft und nicht daran vorbei.

```bash
./test/e2e/nat-traversal.sh
```

Zusätzlich zu den Voraussetzungen oben: `nftables` und `tc` (iproute2).

### Zwei Details, ohne die der Test falsche Ergebnisse liefert

**Die NAT-Router verwerfen unaufgeforderte eingehende Pakete.** Das ist nicht
nur realistisch, sondern entscheidend: ein verworfenes Paket bekommt in Linux
keinen bestätigten Conntrack-Eintrag. Ohne diese Regel legt jedes verirrte
Punch-Paket einen Eintrag an, der genau das Adresstupel belegt, das der Node
dahinter für seine eigene ausgehende Portbeibehaltung braucht — er wird danach
auf einen anderen Port abgebildet als den, den STUN gemeldet hat, und beide
Seiten reden dauerhaft aneinander vorbei.

**Die Leitungen haben 25 ms Verzögerung.** Eine Topologie ohne Latenz ist
unrealistisch *härter* als das echte Internet: der Startversatz zwischen den
beiden Seiten muss kleiner sein als die Laufzeit zum Peer, sonst trifft das
erste Paket den fremden NAT, bevor die Gegenseite überhaupt gesendet hat.

## `relay-fallback.sh` — M4

Dieselbe Topologie wie der NAT-Test, mit einem Unterschied: die NAT-Router
vergeben pro Fluss einen zufälligen Quellport (`masquerade random`). Der Port,
den STUN meldet, ist damit nicht der Port, an den ein Peer senden müsste —
Hole Punching kann hier prinzipiell nicht funktionieren. Genau dafür gibt es
das Relay.

```bash
./test/e2e/relay-fallback.sh
```

Geprüft wird, dass die Nodes ihr NAT korrekt als `address-dependent`
klassifizieren, dass **kein** direkter Pfad gewählt wird, dass der Ping
trotzdem durchgeht — und zum Schluss am Zähler des Relays, dass der Verkehr
tatsächlich dort entlanggelaufen ist und nicht irgendwo anders.

Das Relay sieht dabei nur zwei öffentliche Schlüssel und einen undurchsichtigen
Payload. Authentifiziert wird mit einer Challenge, die an den Disco-Key des
Clients versiegelt ist: nur wer den passenden privaten Schlüssel hat, kann sie
lesen — mehr Vertrauen als Verfügbarkeit braucht das Relay nicht.

## Auf jedem Rechner: `docker/run.sh`

Die Tests brauchen Linux — Netzwerk-Namespaces, veth-Paare, nftables, TUN.
Auf einem Mac (oder überall mit Docker) laufen sie in einem Container, der
nur die Werkzeuge mitbringt; das Repo wird eingehängt, nicht kopiert.

```bash
test/e2e/docker/run.sh mobile-lifecycle.sh
test/e2e/docker/run.sh mobile-nat.sh --symmetric
```

Privilegiert, weil die Tests Namespaces und TUN-Geräte anlegen — nur im
Container. Die `node_modules` des Rechners bleiben unberührt: jedes Paket des
Workspaces bekommt im Container ein eigenes Volume für seine Linux-Installation.
Die Go-Module werden vorher geholt, denn gebaut wird in Namespaces ohne Netz.

## `same-server.sh` — zwei Waves an einem Server

Ein Control-Server, ein Konto, zwei Waves (zwei Projekte), und Gerät A in
beiden: die zweite Anmeldung mit `wave login <url> --new-wave`, die Freigabe
nennt den Wave. Geprüft wird, dass A beide Peers erreicht und beide Zonen
auflöst, dass die Peers der beiden Waves sich *nicht* erreichen, dass
`wave profiles` beide nach ihrer Zone nennt und dass `wave down`, `wave up`
und `wave logout` nur den genannten treffen — auch auf dem Server.

```bash
test/e2e/docker/run.sh same-server.sh
```

## `billing.sh` — ein gekaufter Wave

Die Abrechnungs-API, die wave-mesh.org für Stripe ruft, gegen echte Tunnel.
Ein Control-Server mit `WAVE_BILLING_TOKEN` und `WAVE_BILLING_RETENTION_DAYS=0`,
drei Namespaces an einer Brücke:

- `PUT /api/billing/subscriptions/sub_e2e` legt den Wave an (`created: true`,
  genau die Felder, die die Seite braucht), ein zweites Mal ist `created: false`.
- Der Owner-Link setzt das Passwort, meldet an und bestätigt die Adresse; ein
  zweites Mal ist er weg (410), und neu gibt es keinen.
- Zwei Geräte treten bei und pingen sich. `suspended` leert die Netzkarte,
  kein Ping mehr, beide bleiben angemeldet; ein drittes Gerät kommt weder über
  den Browser (403 „This wave is paused") noch mit einem Pre-Auth-Key hinein.
- `active` bringt den Ping ohne neue Freigabe zurück, und derselbe Schlüssel,
  den die Pause abgewiesen hat, meldet das dritte Gerät jetzt an — er wurde
  nicht verbraucht.
- Zwei Plätze: Eigentümer plus eine Einladung, die nächste wird abgewiesen
  (409 „No seat left"), dieselbe Adresse noch einmal kostet nichts, ein
  dritter Platz lässt die nächste zu.
- `ended` stoppt das Mesh und setzt `delete_after` (aus dem Audit-Log); der
  Sweep löscht den Wave, trennt die Geräte, und das Abo ist danach unbekannt.
- Falscher Token 401, ein Server ohne Token hat keine API (404), einer mit
  zu kurzem startet nicht.

```bash
test/e2e/docker/run.sh billing.sh
```

Sweep und Pre-Auth-Key gehen über zwei Test-Routen des E2E-Servers
(`POST /__e2e/billing/sweep`, `POST /__e2e/auth-key?wave=…`): das Postgres
lebt dort im Prozess, `wave-admin` kommt nicht heran, und auf den stündlichen
Sweep zu warten ist keine Option. Der Server, den ein Deployment fährt, hat
beide nicht.

## `mobile-services.sh` — Dienste eines Clusters auf dem Telefon

Der Telefon-Kern in zwei Waves, im zweiten ein Connector wie im Cluster: Dienste
signiert angemeldet wie vom Operator, das nftables-Regelwerk des Connectors
(DNAT auf ein reines IPv4-Ziel, IPv6 abgewiesen), dazu ein Gerät mit Port im
ersten Wave. Geprüft: Auflösung und Routen, eine Seite und 3 MB über IPv4,
40 Netzkarten-Wechsel ohne verlorene Anfrage, IPv6 sofort abgewiesen statt
hängend, Gerät per Name im anderen Wave, alles noch einmal nur über das Relay,
und mit einer Zugriffsregel, deren Filter auf dem Telefon nachweislich greift.

```bash
test/e2e/docker/run.sh mobile-services.sh
test/e2e/docker/run.sh mobile-services.sh --harness <datei>   # gegen einen älteren Kern
```

## `mobile-lifecycle.sh` — die Telefon-App, Schritt für Schritt

Was ein Mensch in der App tut, gegen zwei echte Control-Server, über genau die
Schnittstelle, die iOS und Android rufen: `wavemobile`, gesteuert von
`mobile/core/cmd/wave-phone` über eine Befehls-Pipe (`login`, `cancel`,
`pause`, `resume`, `logout`, `hostname`, `network`). Jeder Schritt ist etwas,
das schon einmal schiefging:

- Beitritt unter einem gewählten Namen; der Server kennt Plattform und Version
  aus dem `hello` (vorher: „Unbekannt, Version unbekannt").
- Eine Sitzung überlebt eine Netzkarte, die einen Peer hinzufügt — geprüft am
  Alter des letzten Handshakes (vorher: `replace_peers` bei jeder Netzkarte).
- Über eine Minute wird nichts neu veröffentlicht und nichts neu angewendet
  (vorher: Kandidaten jede Minute, und damit eine Netzkarte für den ganzen Wave).
- Pausieren und Fortsetzen ohne neue Freigabe.
- Ein Netzwechsel baut die Control-Verbindung binnen 5 s neu auf.
- Eine abgebrochene Anmeldung hinterlässt nichts.
- Ein zweiter Wave, in stabiler Reihenfolge.
- Wer einen pausierten Wave verlässt, meldet sich beim Server ab (vorher: ein
  Geister-Gerät).
- Entfernt der Server das Gerät, geht der Wave herunter und sagt es; eine neue
  Anmeldung bringt ihn zurück.
- Ein Umbenennen im Web erreicht das Telefon.
- Ein Neustart kommt ohne Freigabe zurück, und Stoppen hängt nicht (vorher:
  ein blockierender TUN-Deskriptor hielt die Leseschleife fest).
