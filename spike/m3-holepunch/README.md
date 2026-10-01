# M3-Spike: NAT-Hole-Punching

**Wegwerf-Code.** Zweck ist eine einzige Frage, vor allem anderen:

> Können sich zwei Bun-Prozesse hinter verschiedenen NATs ohne Portfreigabe
> direkt per UDP erreichen — und wie zuverlässig?

Trägt das nicht, ist die Architektur aus `docs/PLAN.md` hinfällig, egal wie gut
Control-Server und Zertifikate sind. Deshalb steht dieser Spike vor M0.

## Was drin ist

- ein UDP-Socket pro Peer, der **gleichzeitig** für STUN und Peer-Traffic benutzt wird
  (nur so gehört die von STUN gemeldete Adresse auch zum Datenpfad)
- Kandidatensammlung: lokale Interfaces + reflexive Adressen von zwei STUN-Servern
- NAT-Klassifikation aus dem Vergleich beider STUN-Antworten
- Rendezvous-Server als Platzhalter für die Control-WebSocket: Kandidatenaustausch
  und das gleichzeitige `GO`
- beidseitiges Punching mit RTT-Messung, Pfadauswahl und Erkennung **gelernter**
  Adressen (Ping kommt von einem Port, den die Gegenseite nie annonciert hat)

## Was bewusst fehlt

WireGuard, authentifizierte Disco-Pakete (hier unsigniert — jeder kann Pings
fälschen), Relay-Fallback, IPv6, Portmapping (PMP/PCP/UPnP), MTU-Probing,
Reconnect. Das alles gehört in die echte M3/M4-Implementierung, nicht hierher.

## Ausführen

**1. Erst beide Maschinen einzeln prüfen:**

```bash
bun run peer.ts --natcheck
```

Die Ausgabezeile `NAT mapping:` entscheidet fast alles:

| Ausgabe | Bedeutung |
|---|---|
| `endpoint-independent (cone)` | beide STUN-Server sehen denselben externen Port → Punching sollte klappen |
| `address-dependent / symmetric` | pro Ziel ein neuer Port → direktes Punching scheitert, Relay nötig (M4) |
| `multiple external IPs` | load-balanced NAT/CGNAT, Punching unzuverlässig |

**2. Lokaler Funktionstest** (nur Plumbing, kein echter NAT-Test):

```bash
./run-local.sh --duration 8
```

**3. Der eigentliche Test über zwei echte NATs.** Rendezvous auf eine Maschine mit
öffentlicher IP (VPS), je ein Peer in zwei verschiedenen Netzen — z.B. Heimanschluss
und Mobilfunk-Tethering, das ist der interessante Fall, weil Mobilfunk fast immer
CGNAT ist:

```bash
# VPS
bun run rendezvous.ts                       # Port 8787/tcp freigeben

# Maschine A
bun run peer.ts --name a --rendezvous ws://<vps>:8787 --no-local

# Maschine B
bun run peer.ts --name b --rendezvous ws://<vps>:8787 --no-local
```

`--no-local` unterdrückt LAN-Kandidaten, damit nicht versehentlich ein direkter
Weg das Ergebnis schönt. Das Rendezvous-Log enthält am Ende beide Verdicts.

Exit-Code: `0` = direkter Pfad, `2` = keiner.

## Ausgabe lesen

- `time to first pong` — wie lange nach `GO` der erste Rückweg stand. Werte über
  ~2 s heißen, dass mehrere Punch-Runden nötig waren.
- `learned address` — die Gegenseite war über eine Adresse erreichbar, die sie nie
  annonciert hat. Das ist der Fall „eine Seite symmetrisch": funktioniert, weil wir
  auf die Quelladresse des eingehenden Pings zurückschießen. Diese Logik muss in
  die echte Implementierung übernommen werden.
- `sendErr` — unroutbare Kandidaten (typisch bei LAN-Adressen der Gegenseite),
  harmlos.

## Ergebnisse

| Datum | Setup | Ergebnis |
|---|---|---|
| 2026-09-13 | eine Maschine, Arch/arm64, Bun 1.4.2, beide Peers lokal | Plumbing ok. NAT: endpoint-independent. Der Pfad über die **reflexive** Adresse funktionierte ebenfalls (Router macht Hairpin/NAT-Loopback), 50/50 Pongs, RTT-Median 12,8 ms; über LAN 0,5 ms. |
| _offen_ | zwei verschiedene NATs, Rendezvous auf VPS | **das ist der entscheidende Lauf** |
| _offen_ | eine Seite Mobilfunk-CGNAT | erwartet: symmetrisch → Relay nötig |

## Erkenntnisse für die echte Implementierung

1. `Bun.udpSocket().send()` akzeptiert **keine Hostnamen**, nur IPs — DNS muss der
   Aufrufer auflösen. Betrifft auch die spätere Relay-Auswahl.
2. Kandidaten aus `os.networkInterfaces()` enthalten auch Adressen anderer VPNs
   (im Test das Interface eines anderen Mesh-VPNs). Die echte Implementierung muss das eigene `wave0` und
   fremde Tunnel-Interfaces aus der Kandidatenliste filtern, sonst baut man
   Tunnel durch Tunnel.
3. Der Vergleich zweier STUN-Antworten reicht, um vorherzusagen, ob Punching
   klappt — die Klassifikation gehört als `wave netcheck` ins Produkt.
4. Auf die Quelladresse eingehender Pings zurückzuschießen ist kein Sonderfall,
   sondern der Normalfall bei einseitig symmetrischem NAT.
