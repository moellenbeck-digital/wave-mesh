# wave-mesh

Ein selbst hostbares Mesh-VPN auf WireGuard-Basis: Geräte finden sich über einen
Koordinationsserver, verbinden sich direkt per NAT-Hole-Punching und bekommen interne DNS-Namen mit gültigen
Let's-Encrypt-Zertifikaten.

**Status: frühe Entwicklung.** Der Architekturplan steht in
[`docs/PLAN.md`](docs/PLAN.md), erreicht sind M0 (Bootstrap), M1 (Login),
M2 (Node-Registrierung, Netmap, WireGuard-Konfiguration), M3 (NAT-Traversal
per Hole Punching), M4 (Relay-Fallback), M5 (Namensauflösung), M6
(Let's-Encrypt-Zertifikate auf Gerätenamen) und M11 (Dienste aus einem
Kubernetes-Cluster, im Cluster noch ungefahren).

## Aufbau

| Pfad | Inhalt |
|---|---|
| `apps/control` | Control-Server: OIDC-Login, Node-Registrierung, signierte Netmaps |
| `apps/relay` | STUN-Server und Relay für Verbindungen ohne direkten Pfad |
| `packages/magicsock` | UDP-Multiplexer vor WireGuard: Kandidaten, Probing, Pfadwahl |
| `packages/disco` | authentifizierte Discovery-Pakete (X25519 + XChaCha20-Poly1305) |
| `packages/dns` | DNS-Codec und Split-DNS-Resolver für die Namen des Waves |
| `apps/client` | `wave` CLI: Enrolment, WireGuard-Konfiguration, Routen |
| `apps/tray` | Tray-Icon (StatusNotifierItem über D-Bus), liest den Daemon |
| `apps/connector` | Cluster-Seite: leitet Dienstadressen an den internen Ingress-Controller |
| `apps/operator` | liest `Ingress`/`HTTPRoute` der Klasse `wave` und meldet die Namen |
| `test/e2e` | Integrationstests: Tunnel im LAN, Hole Punching durch zwei NATs, Relay-Fallback bei symmetrischem NAT |
| `packages/proto` | gemeinsame Zod-Schemas: Netmap, Control-Protokoll, Disco-Framing |
| `spike/m3-holepunch` | Wegwerf-Prototyp, der das NAT-Traversal-Risiko klärt |

## Entwicklung

```bash
bun install
bun test          # Tests
bun run check     # Lint + Format (Biome)
bun run typecheck # tsc --noEmit
bun run db:up     # Postgres in Docker
```

### Control-Server starten

```bash
cp apps/control/.env.example apps/control/.env
bun run db:up
cd apps/control && bun run db:migrate && bun run dev
```

Ein Konto anlegen und `http://localhost:8080` öffnen:

```bash
cd apps/control && bun src/admin.ts set-password du@example.com
```

Anmeldung mit E-Mail und Passwort (Argon2id, keine Registrierungsseite —
Konten legt der Betreiber an). Alternativ Google-OIDC über
`GOOGLE_CLIENT_ID`/`SECRET`. Der Entwicklungs-Login mit `WAVE_DEV_AUTH=1`
akzeptiert dagegen jede eingegebene Adresse und gehört nur an einen Port, der
nicht öffentlich steht — `WAVE_DEV_AUTH_FROM` beschränkt ihn auf genannte
Netze, und in Produktion ist er immer aus.

Tests brauchen kein Docker — sie laufen gegen ein eingebettetes Postgres
(PGlite) mit denselben Migrationen.

### Client bauen und einrichten

Fertige Binaries für Linux, macOS und Windows auf jeweils amd64 und arm64
hängen an jedem [Release](../../releases); selbst bauen geht so:

```bash
bun run build:client              # ergibt ./dist/wave, ein einzelnes Binary
sudo ./dist/wave install
```

`install` richtet die Maschine ein und kennt keinen Server: es kopiert das
Binary nach `/usr/local/bin`, legt die Gruppe `wave` an, trägt dich ein,
schreibt die Dienstdateien und startet Dienst und Tray-Icon. Beigetreten wird
danach mit `wave login <control-server-url>`, so oft du magst. Die
Alltagsbefehle brauchen kein `sudo` mehr:

```bash
wave up        # verbindet; beim ersten Mal kommt ein Link zum Anmelden
wave status    # bleibt offen und aktualisiert sich, bis Ctrl-C
wave down
```

`wave up` und `wave status` bleiben auf einem Terminal offen und zeichnen sich
im Sekundentakt neu — Pfad, Laufzeit und Handshake-Alter sagen erst etwas, wenn
man sie sich bewegen sieht. Ctrl-C beendet bei `wave status` nur die Anzeige,
die Tunnel laufen weiter. In eine Pipe oder ein `$(...)` schreibt `wave status`
stattdessen einen einzigen Stand und endet, damit kein Skript daran hängen
bleibt; `--once` erzwingt das auch auf dem Terminal.

Der Dienst aktualisiert sich selbst. Sein Control-Server bietet ihm neue
Releases an, er installiert sie nach einer zufälligen Wartezeit von bis zu vier
Stunden und geht von allein zurück, wenn die neue Fassung keinen Server
erreicht. Installiert wird nur, was mit dem Release-Schlüssel signiert ist, den
das Binary mitbringt:

```bash
wave version                     # welche Fassung, und ob eine neuere ansteht
wave update                      # die neuere jetzt statt später
wave update --channel insiders   # ein anderer Kanal, sofern der Server ihn anbietet
wave update --auto-update off    # nur noch anzeigen
```

### Zertifikate für Gerätenamen

Trägt ein Wave ein DNS-Suffix, das dir gehört, bekommen seine Geräte gültige
Let's-Encrypt-Zertifikate auf ihre Namen. Beantwortet wird die
dns-01-Challenge auf einem von zwei Wegen, einmal je Wave gewählt:

```bash
# auf dem Server, einmal je Wave
bun apps/control/src/admin.ts set-dns-provider meinwave manual      # ohne Zugangsdaten
bun apps/control/src/admin.ts set-dns-provider meinwave cloudflare  # fragt den Token ab
bun apps/control/src/admin.ts set-dns-provider meinwave hetzner
bun apps/control/src/admin.ts set-dns-provider meinwave ionos       # <prefix>.<secret>
bun apps/control/src/admin.ts set-dns-provider meinwave inwx        # Konto statt Token

# auf dem Gerät
wave cert --hook 'systemctl reload caddy'
wave certs
```

**`manual` funktioniert bei jedem Hoster.** Der Server nennt den TXT-Record,
du legst ihn in deiner Zone an, und sobald er dort steht — nachgesehen wird bei
den autoritativen Nameservern der Zone, nicht über einen Resolver — läuft die
Ausstellung weiter:

```
$ wave cert

This wave answers dns-01 by hand, so laptop.wave.example.com needs a record first:

  name   _acme-challenge.laptop.wave.example.com
  type   TXT
  value  0Zq8…

Waiting... Ctrl-C is safe: `wave cert` takes the same order up again.
```

Der Preis: **auch jede Erneuerung braucht dann einen Menschen.** Wer das nicht
will, hinterlegt Zugangsdaten für einen der vier Provider — dann läuft alles
Weitere unbeaufsichtigt.

Was die vier voneinander unterscheidet, ist die Art der Zugangsdaten:

| Provider | Zugang | Zu wissen |
|---|---|---|
| `cloudflare` | API-Token, auf eine Zone beschränkbar (Zone / DNS / Edit) | die engste Vollmacht der vier |
| `hetzner` | API-Token des DNS-Kontos | gilt für alle Zonen des Kontos |
| `ionos` | API-Key `<public prefix>.<secret>` | **Hosting** DNS, nicht IONOS Cloud DNS — die beiden haben getrennte APIs, und der Key des einen ergibt beim anderen 401 |
| `inwx` | Benutzername, Passwort und bei aktiver 2FA das TOTP-Shared-Secret | INWX kennt keinen auf eine Zone beschränkten Token: diese Zugangsdaten können alles, was das Konto kann. Ein Sub-Account nur für diese Domain ist der Weg, das einzugrenzen |

`set-dns-provider` fragt die Teile einzeln ab; aus einer Pipe nimmt INWX sie als
JSON (`{"user":…,"password":…,"totpSecret":…}`), weil ein Rohr nur einmal
gelesen wird. `"sandbox": true` spricht statt der Registry INWX' Testsystem an.

Für eine Maschine, die mehrere Dienste bedient, gibt es ein Wildcard-Zertifikat
— aber nur, wenn der Betreiber sie dafür freigibt:

```bash
bun apps/control/src/admin.ts allow-wildcard meinwave proxy   # auf dem Server
wave cert --wildcard                                          # auf dem Gerät
```

Es trägt `*.meinwave.example.com` und den Namen der Zone selbst. Die Freigabe
ist ausdrücklich, weil ein Wildcard keinem Gerät gehört, sondern allen: wer
seinen Schlüssel hat, kann jeder Name im Wave sein. Dafür landen die einzelnen
Gerätenamen nicht in den öffentlichen CT-Logs.

Der private Schlüssel entsteht auf dem Gerät und bleibt dort — zum Server geht
nur der Zertifikatsantrag, zurück kommt die Kette. Erneuert wird vom Dienst, in
dem Fenster, das die CA vorschlägt (ARI). Für einen Provider-Token braucht der
Server `WAVE_DNS_SECRET` (32 Bytes base64), womit der Token verschlüsselt
abgelegt wird; ohne den Wert verweigert `set-dns-provider` ihn — `manual`
braucht ihn nicht, da gibt es nichts zu speichern. Vorgabe ist das
Staging-Verzeichnis von Let's Encrypt — auf die echte Ausstellung schaltet
`WAVE_ACME_DIRECTORY` um. Ohne eigene Domain bleibt der Platzhalter unter
`.internal`, und dafür kann es öffentliche Zertifikate prinzipiell nicht geben.

Dasselbe Binary ist auch der Dienst und das Tray — `wave daemon` und
`wave tray` laufen im Vordergrund, und genau die ruft die erzeugte
Dienstdatei auf. `sudo wave uninstall` entfernt den Dienst wieder; Binary und
Schlüssel bleiben liegen.

Ohne Einrichtung erledigt die CLI die Arbeit selbst und muss als root laufen:

```bash
sudo ./dist/wave up --control http://localhost:8080
```

Der Tunnel lebt dann so lange wie der Prozess — der MagicSock besitzt den
öffentlichen UDP-Port. Für andere Plattformen:

```bash
cd apps/client && bun build --compile --external x11 --target=bun-darwin-arm64 src/cli.ts --outfile ../../dist/wave-macos
```

Zur Laufzeit braucht der Client `wireguard-go` im `PATH` oder über
`WAVE_WIREGUARD_GO`.

### Dienste aus einem Kubernetes-Cluster

Ein interner Dienst kann im Wave erreichbar sein und sonst nirgends. Dafür geht
je Cluster ein **Connector** in den Wave — ein ganz gewöhnliches Gerät —, und
jeder freigegebene Name bekommt eine eigene Adresse aus dem Wave:

```bash
bun apps/control/src/admin.ts auth-key meinwave connector --reusable   # auf dem Server

cd deployment/cluster/overlays/example   # im Cluster
cp secret.env.example secret.env         # den Schlüssel eintragen
kubectl apply -k .
```

Danach genügt ein gewöhnlicher Ingress:

```yaml
spec:
  ingressClassName: wave
  rules:
    - host: grafana.meinwave.example.com
```

Der Operator im Cluster liest ihn, der Control-Server vergibt Namen und Adresse,
und jedes Gerät im Wave löst `grafana.meinwave.example.com` auf und routet es
durch den Tunnel. Von außen führt kein Weg dorthin: der Connector hat keinen
eingehenden Port, und der interne Ingress-Controller nur eine ClusterIP.

**Im Cluster gefahren ist das noch nicht** — die Regeln und der Operator sind
gegen Fakes getestet, nicht gegen echtes Kubernetes.

## Lizenz

© 2026 Robin Lenz. Lizenziert unter der [Elastic License 2.0](LICENSE) (ELv2).
Benutzen, verändern und weitergeben ist erlaubt, auch im eigenen Unternehmen.
Nicht erlaubt ist, wave-mesh Dritten als gehosteten oder verwalteten Dienst
anzubieten.
