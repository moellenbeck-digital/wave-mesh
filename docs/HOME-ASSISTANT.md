# wave als Home-Assistant-App (Plan)

Stand: 25.11.2026. Nichts davon ist gebaut. Was hier über Home Assistant
steht, ist aus dem Quelltext gelesen (`home-assistant/supervisor` `main`,
`home-assistant/plugin-dns` `master`, `home-assistant/operating-system` `dev`,
`hassio-addons/app-tailscale` `main`), nicht auf einem Gerät gemessen.

**Ziel:** Home Assistant (HA OS oder Supervised) wird ein Gerät im Wave, und
Integrationen in Home Assistant erreichen Geräte und Dienste im Wave. Home
Assistant selbst ist aus dem Wave per HTTPS mit echtem Zertifikat erreichbar.

## Grundform

Eine App (früher „Add-on“) ist ein Image mit einer `config.yaml`. Drei Dinge
sind nicht verhandelbar:

```yaml
host_network: true          # sonst ist nur der Container im Wave, nicht Home Assistant Core
privileged: [NET_ADMIN]
devices: [/dev/net/tun]
arch: [amd64, aarch64]      # Bun gibt es nicht für armv7/i386
init: false
```

Ohne `host_network` hätte nur die App eine Route in den Wave, und genau dafür
installiert man sie nicht. HA OS bringt mit, was der Tunnel braucht
(`CONFIG_TUN=y`, `CONFIG_NF_TABLES=m` in `kernel/v6.18.y/haos.config`), auf
einem Gerät gesehen ist das nicht.

Gestartet wird `wave daemon` im Vordergrund, wie im Connector-Image
(`apps/connector/Dockerfile`). **Kein `wave install`**: es gibt dort kein
systemd, den Prozess hält der Supervisor.

- **Zustand nach `/data`** (`WAVE_STATE=/data/state.json`). Den sichert und
  erhält der Supervisor; die Zertifikate liegen damit unter `/data/certs`.
- **Selbstaktualisierung aus.** Die Einheit, die aktualisiert wird, ist das
  Image, und das tauscht der Supervisor. Ein Daemon, der im Container sein
  Binary ersetzt, verliert den Tausch beim nächsten Neustart. Ausdrücklich
  abschalten, nicht darauf bauen, dass `updateBlocker()` es zufällig verhindert.
- **Binary aus dem Release, aber auf die libc achten.** Am liebsten wie beim
  DSM-Paket die Bytes aus `wave-linux-<arch>.tar.gz` (kein zweiter Build). Die
  sind glibc, die üblichen HA-Basis-Images Alpine — „not found“ wäre dann eine
  fehlende libc. Also Debian-Basis von Home Assistant oder musl-Ziele in
  `build-clients.sh`.
- **Port 41641/udp kollidiert mit der Tailscale-App** (auch `host_network`).
  Der Port muss einstellbar sein oder der Konflikt klar gemeldet werden.
- **Sauber beenden.** Mit `host_network` liegen `wave0` und seine Routen im
  Netz des Hosts; der Daemon muss auf SIGTERM innerhalb des `timeout` des
  Supervisors aufräumen.

## Anmelden

1. **Stufe 1:** Optionen `control_url` und `auth_key` (Pre-Auth-Key), wie
   beim Connector. Braucht keine Oberfläche.
2. **Stufe 2:** eine Ingress-Seite. `dsm-ui.ts`/`dsm-ui-view.ts` können das
   meiste schon (Waves schalten, Anmeldung mit Freigabelink, Geräte und
   Dienste, DE/EN). An DSM hängen nur der Transport (CGI) und die Prüfung, wer
   darf (`authenticate.cgi` + `administrators`). Für Home Assistant: ein
   kleiner HTTP-Server, Anfragen nur von der Ingress-Adresse des Supervisors
   (`172.30.32.2`), `panel_admin: true`. Also Anfragebehandlung von Transport
   und Prüfung trennen und `wave ha-ui` als zweite Hülle — eine Oberfläche mit
   zwei Hosts, nicht zwei.

## DNS: keine Weiterleitung je Zone

Das ist die eigentliche Einschränkung.

- **Das DNS-Plugin (CoreDNS) kennt nur ein `forward .`.** Die Corefile kommt
  aus einer festen Vorlage (`plugin-dns`, `rootfs/usr/share/tempio/corefile`),
  gefüllt aus `coredns.json` mit `servers`, `locals`, `fallback`, `debug`. Kein
  `import`, keine zweite Zone.
- **Einstellbar sind nur `servers` und `fallback`** (`SCHEMA_OPTIONS` in
  `supervisor/api/dns.py`, `ha dns options`). `servers` ist eine Liste für alle
  Namen und wird der Reihe nach gefragt (`policy sequential`).
- **Die `hosts`-Datei gehört dem Supervisor.** Eine App bekommt dort nur ihren
  Slug (`<slug>`, `<slug>.local.hass.io`); eine API zum Eintragen gibt es
  nicht, ebenso keinen DNS-Schlüssel in der `config.yaml`.
- **`resolvectl` hilft nicht.** HA OS hat `systemd-resolved` mit
  `DNSStubListener=no`, und Container fragen, was in ihrer `resolv.conf` steht.
  In der App meldet `configureDns()` deshalb `routed: false`, und der Client
  sagt die Lücke an — erwartet und richtig.
- **Offen:** ob Core über das Plugin oder über den Resolver des Hosts auflöst.
  Core läuft mit `network_mode="host"`, bekommt aber `Dns=[172.30.32.3]`
  (`_create_container_config`); ob Docker das im Host-Modus anwendet, steht
  nicht im Code. Am Gerät: `docker exec homeassistant cat /etc/resolv.conf`.
  Am Ergebnis ändert es nichts: auf keinem der beiden Wege gibt es eine
  Weiterleitung je Zone.

### Wie es die Tailscale-App macht

`host_network`, `NET_ADMIN`, `/dev/net/tun`, Port 41641/udp — dieselbe Form.
Für DNS übernimmt sie **die ganze Auflösung**, aber als Schritt des Nutzers:
`ha dns options --servers dns://100.100.100.100`. Das trägt, weil MagicDNS ein
vollständiger Resolver ist und alles Fremde weiterreicht. Die Schleife (MagicDNS
fragt den Host, der Host das Plugin, das Plugin MagicDNS) schneidet ein
`dnsmasq` mit iptables-Regeln in der App ab. Nur volle Namen
(`gerät.tail1234.ts.net`), und nur IPv4: `ha dns options` lehnt IPv6-Server ab
(`app-tailscale` #789).

### Was daraus für wave folgt

- **Stufe 1:** kein DNS für Core. Integrationen tragen die Wave-Adresse ein; sie
  ist je Gerät fest. Die App zeigt die Adressen der Peers zum Kopieren.
  `DOCS.md` sagt das deutlich.
- **Stufe 2:** dasselbe Modell wie Tailscale, als ausdrückliche Ausnahme von
  „nie den System-Resolver übernehmen“ — der Nutzer stellt es selbst ein, es
  wird alles weitergereicht statt verworfen, und `ha dns reset` nimmt es
  zurück. Die App setzt `servers` nie selbst. Dafür braucht es:
  1. einen Rückfall im Resolver, „alles Übrige an diese Server“ — heute ist es
     `drop` (`resolve()` in `packages/dns/src/resolver.ts`); das Weiterleiten
     selbst gibt es schon für delegierte Routen;
  2. als Upstream die Server des Hosts aus dessen `/run/resolv.conf`
     (NetworkManager, `rc-manager=file`), **nie** `172.30.32.3` — so entsteht
     die Schleife gar nicht erst, die Tailscale mit `dnsmasq` abfängt;
  3. einen Resolver für alle Waves unter einer festen IPv4-Adresse, die das
     Plugin erreicht und das LAN nicht: `172.30.32.1:53` (Gateway des
     `hassio`-Netzes auf dem Host). Ob der Port dort frei ist, ist ungeprüft.

  Der Preis: jede Anfrage von Home Assistant geht durch den Daemon, und ist
  die App gestoppt, ist die Auflösung im Haus langsam, bis das Plugin den
  Server als tot führt (`max_fails 5`, `health_check 1m`).
- **Die saubere Lösung liegt bei Home Assistant:** Weiterleitung je Zone im
  Plugin (`{zone, server}` in `coredns.json`, gesetzt von einer App mit
  passender Rolle über die Supervisor-API). Wenige Zeilen in der Vorlage plus
  Schema und API; die Tailscale-App bräuchte dann weder die globale Umstellung
  noch `dnsmasq`. Vorher in den Issues des Supervisors nachsehen, ob es den
  Vorschlag schon gibt.

## HTTPS für Home Assistant

**Weg A — Zertifikat an den HTTP-Server von Home Assistant** (wie die
Let's-Encrypt-App): `map: [ssl:rw]`, `wave cert … --hook` kopiert nach
`/ssl/wave/`, `http: ssl_certificate/ssl_key` in der `configuration.yaml`.
Verworfen, aus zwei Gründen:

- Home Assistant liest das Zertifikat nur beim Start (so verstanden, nicht
  nachgemessen); jede Erneuerung hieße ein Neustart von Core über
  `POST http://supervisor/core/restart` — ungefragt, mitten in Automationen.
- Port 8123 spräche danach nur noch HTTPS, mit einem Zertifikat für einen
  Namen, der nur im Wave auflöst. Im LAN (`homeassistant.local`, IP,
  Companion-App im WLAN) gäbe es überall eine Zertifikatswarnung.

**Weg B — TLS endet in der App (gewählt).** Home Assistant bleibt im LAN auf
HTTP. Die App lauscht auf ihrer **Wave-Adresse** auf 443, wählt das Zertifikat
per SNI und reicht an `http://127.0.0.1:8123` durch — der Mechanismus von
`wave expose` (`ExposeListeners` in `apps/client/src/expose.ts`): nie an
`0.0.0.0`, Schlüssel und Kette bei jedem Handshake neu gelesen, also **kein
Neustart** bei einer Erneuerung, `Host` unverändert.

Was fehlt: `wave expose` nimmt nur Namen unter der Pier-Zone (`exposeLabel()`),
nicht den eigenen Gerätenamen. Also `wave expose` für den eigenen Namen öffnen
oder eine App-Option wie `https_proxy: true`.

Bekannt und in die Doku: Home Assistant sieht diese Verbindungen als lokal von
`127.0.0.1`; `ip_ban` greift für Zugriffe aus dem Wave nicht. Dasselbe gilt
für `wave expose ha http://localhost:8123` über den Pier.

## Wo es liegt

Ein eigenes kleines Repository (etwa `wave-mesh-ha`) mit `repository.yaml` und
`wave/` (`config.yaml`, `DOCS.md`, `translations/de.yaml` und `en.yaml`, Icon
und Logo aus `apps/tray/src/icon.ts`). Die App zieht über `image:` ein fertiges
Image `ghcr.io/moellenbeck-digital/wave-mesh/ha-app`, gebaut wie alle anderen
nur im Release-Workflow von einem Tag. Nicht ins Monorepo: Home Assistant klont
das ganze Repository, um eine App zu finden. Die Aufnahme in die
Community-Sammlung (`hassio-addons`) kommt erst, wenn die App läuft — die hat
eigene Anforderungen an Basis-Images, s6 und CI.

## Reihenfolge

1. **Stufe 1:** Image, `config.yaml`, Pre-Auth-Key, Auto-Update aus,
   einstellbarer Port, Weg B für HTTPS, DNS-Hinweis in `DOCS.md`.
2. **Stufe 2:** Ingress-Seite aus `dsm-ui`, Resolver mit Weiterleitung auf
   `172.30.32.1` als Opt-in.
3. **Upstream:** Weiterleitung je Zone im DNS-Plugin vorschlagen.

**Ungeprüft** ist alles davon auf einem echten Home Assistant: `host_network`
mit `wave0` im Netz des Hosts, nftables auf HA OS, der freie Port auf
`172.30.32.1` und woher Core seine Namen holt.
