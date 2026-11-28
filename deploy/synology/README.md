# wave-connector auf einer Synology (Container Manager)

Der Connector stellt Dienste aus dem Heimnetz in einen Wave, ohne Cluster und
ohne wave-operator. Gedacht für DSM 7 mit Kernel 4.4 ohne nftables (z. B.
DS920+): gefiltert und weitergeleitet wird dort mit iptables.

```
Gerät im Wave ──Tunnel──▶ wave0 ┌ Netzraum „net“ ─────────────┐
                                │ daemon     Tunnel, Policy   │
                                │ connector  DNAT auf Caddy   │──▶ caddy ──▶ Dienste im LAN
                                └─────────────────────────────┘    (Host-Name)
```

Alle Regeln liegen im Netzraum der Container. Netz und Firewall des NAS bleiben
unverändert.

**Stand:** Die Regeln sind in einem Linux-Container mit ausschließlich
iptables-legacy gefahren (`test/e2e/iptables.sh`). Auf einem echten NAS ist
dieser Aufbau **noch nicht geprüft**.

## Voraussetzungen auf dem NAS

Container laden keine Kernelmodule. Einmal per SSH (oder als Aufgabe im
Aufgabenplaner, Benutzer root) prüfen:

```sh
ls -l /dev/net/tun || sudo modprobe tun
lsmod | grep -E 'tun|ip_tables|iptable_|ip6table_|nf_nat|nf_conntrack|xt_|ipt_'
```

| Modul | Wofür | Fehlt es |
|---|---|---|
| `tun` | Tunnel | kein Tunnel |
| `iptable_nat`, `nf_nat`, `xt_nat`, `ipt_MASQUERADE` | Weiterleitung | Connector meldet den Fehler und leitet nichts weiter |
| `iptable_filter` | nur Dienstports durchlassen | wie oben |
| `xt_conntrack` | Policy: Antworten erlauben | „policy NOT enforced“ |
| `iptable_mangle` | Policy vor dem DNAT | die Policy liegt dann in der `filter`-Tabelle |
| `xt_TCPMSS` | MSS begrenzen | Hinweis im Log, sonst läuft es |
| `ip6_tables`, `ip6table_filter` | IPv6 filtern | Hinweis im Connector; unter einer Policy „policy NOT enforced: IPv6 …“ |

Ein fehlendes Modul lädt `sudo insmod /lib/modules/<name>.ko`. Damit es einen
Neustart übersteht, gehört der Befehl in eine Aufgabe „beim Hochfahren“.

## 1. Image bauen

Auf einem Rechner mit Docker, **nicht** auf dem NAS (Bun kann dort nicht bauen),
im Wurzelverzeichnis des Repositorys:

```sh
docker buildx build --platform linux/amd64 -f deploy/synology/Dockerfile \
  -t wave-synology:local --load .
docker save wave-synology:local | gzip > wave-synology.tar.gz
```

Im Container Manager unter **Image → Aktion → Importieren** die Datei laden.

## 2. Auf dem Server

```sh
bun apps/control/src/admin.ts auth-key <wave> synology
```

Mit einer Policy braucht der Zugriff auf die Dienste eine Regel, etwa
`{"src": ["group:family"], "dst": ["svc:ha", "svc:paperless"]}`.

## 3. Projekt anlegen

1. Mit der File Station einen Ordner anlegen, z. B. `docker/wave`.
2. `docker-compose.yml`, `Caddyfile` und `.env.example` hineinlegen,
   `.env.example` als `.env` kopieren und ausfüllen.
3. Container Manager → **Projekt → Erstellen**, den Ordner wählen, die
   vorhandene `docker-compose.yml` verwenden und starten.

`login` tritt dem Wave bei und beendet sich danach; ein beendeter Container mit
Code 0 ist dort richtig. Der Schlüssel steht nur in `.env`.

## 4. Prüfen

Im Protokoll des Containers `connector` stehen nacheinander:

```
forwarding with iptables (iptables-legacy)
services: ha 100.x.y.z, paperless …, openclaw …
forwarding wave0 to 172.31.250.10, own addresses …
```

Im Protokoll des `daemon` darf unter einer Policy **nicht**
`policy NOT enforced here` stehen; der Grund steht in derselben Zeile.

Von einem Gerät im Wave: `curl -I http://ha.<WAVE_DOMAIN>`.

Die Regeln selbst:

```sh
sudo docker exec wave-synology-connector-1 iptables-legacy-save
```

## Dienste hinter Caddy

- **Home Assistant** lehnt Anfragen eines unbekannten Proxys ab. In
  `configuration.yaml` unter `http:` `use_x_forwarded_for: true` setzen und die
  LAN-Adresse des NAS in `trusted_proxies` eintragen.
- **Paperless** braucht `PAPERLESS_URL=http://paperless.<WAVE_DOMAIN>`.
- **OpenClaw**: Der Name muss als erlaubte Herkunft eingetragen sein; die
  Oberfläche kann HTTPS verlangen (siehe `Caddyfile`).

Ein weiterer Dienst: in `WAVE_SERVICES` ergänzen, im `Caddyfile` eine Seite und
im Compose-File die Variable dazu, Projekt neu starten. Ein Name, der aus
`WAVE_SERVICES` verschwindet, verschwindet aus dem Wave. Nur eine *leere* Liste
wird nie gemeldet; den letzten Dienst entfernt `admin.ts remove-service`.

## Grenzen

- Meldet das Projekt „Pool overlaps“, ist `172.31.250.0/24` schon vergeben:
  `WAVE_SUBNET_PREFIX` in `.env` setzen.
- Nur TCP auf den Ports 80 und 443 (`WAVE_BACKEND_PORTS` ändert die Liste).
- Die Dienste sehen die Adresse von Caddy beziehungsweise des NAS, nicht die des
  Geräts im Wave.
- Hinter dem Docker-NAT kommt ein direkter Pfad nicht immer zustande; dann läuft
  der Verkehr über das Relay.
- Das Image aktualisiert sich nicht selbst: neu bauen und importieren.
- Beim Anhalten nimmt der Connector seine Regeln wieder heraus.
