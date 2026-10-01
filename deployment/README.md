# deployment

Kustomize-Bäume für wave-mesh: die Serverseite eines Waves (Control-Server,
Frontend, Relay) und die Clusterseite (Connector und Operator, D11).

Es sind **zwei Wurzelbäume und nicht einer**, weil sie an verschiedenen Orten
laufen: der Control-Server steht dort, wo der Wave gehostet wird, der Connector
in *dem* Cluster, dessen Dienste im Wave erreichbar sein sollen. Ein einziges
`kubectl apply -k`, das beides installiert, wäre für beide Seiten falsch.

```
deployment/
  server/                 # Control + Web + Relay + Postgres
    base/                 # nicht deploybar: ohne Geheimnisse, ohne Image-Tag
    overlays/dev/         # lokaler Cluster, port-forward statt Ingress
    overlays/prod/        # eigene Namen, Ingress, gepinnte Images
  cluster/                # Connector + Operator
    base/
    overlays/example/
```

Die Basis läuft absichtlich nicht für sich: sie hat kein Secret und keinen Tag
am Image. Genommen wird immer ein Overlay — und ein eigenes zu kopieren ist der
vorgesehene Weg, `dev` und `prod` sind Beispiele.

## Zugang zur Registry

`wave-mesh` ist ein privates Repository, also sind auch seine Images privat: ohne
Zugangsdaten zieht das Kubelet anonym und bekommt 401. Jedes Overlay erzeugt
sich deshalb ein `dockerconfigjson`-Secret namens `ghcr`, und jeder Pod, der ein
Image von dort zieht, verweist darauf. Die Datei dazu entsteht aus einem
**klassischen** GitHub-Token mit `read:packages` — ein fein granulares reicht
für die Container-Registry nicht:

```bash
printf '{"auths":{"ghcr.io":{"auth":"%s"}}}' \
  "$(printf '<github-benutzer>:<token>' | base64 -w0)" > dockerconfig.json
```

Sie gehört neben die `kustomization.yaml` des Overlays und steht wie `secret.env`
in der `.gitignore`. Ein Overlay ohne sie baut nicht — das ist dieselbe laute
Absicht wie bei den übrigen Geheimnissen.

## Serverseite

```bash
cd deployment/server/overlays/dev
cp secret.env.example secret.env        # ausfüllen; secret.env ist ignoriert
# dockerconfig.json anlegen, siehe oben
kubectl apply -k .
kubectl -n wave-mesh port-forward svc/wave-control 8080:8080
```

Ein Konto entsteht nur auf der Shell — eine Registrierungsseite gibt es
absichtlich nicht:

```bash
kubectl -n wave-mesh exec -it deploy/wave-control -- \
  bun apps/control/src/admin.ts set-password you@example.com
```

`-it` ist nötig, nicht Geschmackssache: das Kommando fragt das Passwort auf
stdin ab. Mit Terminal fragt es zweimal und zeigt nichts an, ohne liest es die
Pipe — `kubectl exec` ohne `-i` reicht ihm eine leere, und es bricht mit
„Password must be at least 12 characters" ab. Für ein Skript deshalb:

```bash
read -rs -p 'Passwort: ' pw && echo
printf '%s' "$pw" | kubectl -n wave-mesh exec -i deploy/wave-control -- \
  bun apps/control/src/admin.ts set-password you@example.com
unset pw
```

Danach `wave login http://localhost:8080`. Das ist zugleich die einzige ehrliche
Prüfung des Stapels: `/healthz` fasst die Datenbank nicht an und antwortet auch
dann mit 200, wenn hinter dem Server nichts mehr steht.

**Die Datenbank steht in der Basis**, und sie kann nur, was ein einzelner Pod
mit einem Volume kann: kein Backup, kein Failover, kein Point-in-Time-Restore.
Verliert er sein Volume, müsste sich jedes Gerät neu anmelden. Wer einen
verwalteten Dienst hat, trägt dessen Adresse in `DATABASE_URL` ein und patcht
den Pod im Overlay heraus — der Block dafür steht auskommentiert in
`overlays/prod/kustomization.yaml`.

Für `prod` sind drei Dinge anzupassen, und sie hängen zusammen: die Namen in
`ingress.yaml`, `WAVE_BASE_URL` (daraus entstehen Anmeldelinks, OAuth-Redirects
und `secureCookies`) und die STUN-Adresse in `WAVE_RELAYS`. Letztere ist die
öffentliche Adresse des LoadBalancers von `wave-relay-stun` und muss eine **IP**
sein — `Bun.udpSocket().send()` nimmt keine Namen. Sie steht erst fest, wenn der
Service eine bekommen hat:

```bash
kubectl -n wave-mesh get svc wave-relay-stun
```

## Clusterseite

```bash
# auf der Shell des Control-Servers
bun apps/control/src/admin.ts auth-key <wave> connector --reusable

# im Cluster
cd deployment/cluster/overlays/example
cp secret.env.example secret.env        # den Schlüssel eintragen
# dockerconfig.json anlegen, siehe „Zugang zur Registry"
kubectl apply -k .
```

Das bringt vier Dinge mit: den Connector-Pod (Daemon, Connector, Operator), die
RBAC dafür, **einen internen Traefik der Klasse `wave`** und die NetworkPolicy
davor.

Was danach passiert: Der Operator sieht jeden `Ingress` der Klasse `wave` (oder
eine `HTTPRoute` an einem `Gateway` derselben), meldet die ganze Menge der Namen
an den Control-Server, der vergibt Adressen aus dem `/16` des Waves, und der
Connector leitet alles, was auf `wave0` für keine seiner eigenen Adressen
ankommt, an diesen Traefik weiter. Ein Dienst wird damit so exponiert:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: grafana
spec:
  ingressClassName: wave      # dieselbe Klasse, die der Operator liest
  rules:
    - host: grafana.vpn.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service: { name: grafana, port: { number: 3000 } }
```

**Derselbe Klassenname trägt beide Seiten**: Traefik bedient die Ingresses der
Klasse `wave`, der Operator (`WAVE_INGRESS_CLASS`) meldet genau deren Hosts.
Ein Name, eine Entscheidung — ein Ingress der Klasse `nginx` bleibt in beiden
Welten unberührt.

**Warum ein eigener Controller, und warum ein interner:** wave macht einen
Dienst erreichbar; *un*erreichbar machen kann es ihn nicht. Zeigte der Connector
auf den öffentlichen Controller des Clusters, wäre der Wave-Name nur ein zweiter
Weg auf etwas, das ohnehin offen steht. Deshalb hat dieser hier eine ClusterIP
und sonst nichts — kein LoadBalancer, kein NodePort, kein hostNetwork — und
davor eine NetworkPolicy, die nur den Connector-Pod durchlässt. Die ist so viel
wert wie ihre Durchsetzung: k3s bringt den Netpol-Controller von kube-router
mit, mit `--disable-network-policy` wäre sie Dekoration.

**Die ClusterIP steht fest** (`10.43.0.80` im Beispiel-Overlay, an zwei Stellen:
im Patch auf den Service und in `WAVE_BACKEND_IPV4`). Der Connector braucht sie
als Zahl, denn daraus wird eine nftables-Regel — eine vergebene Adresse stünde
erst nach dem ersten Apply fest. Sie muss im Service-CIDR des Clusters liegen
(k3s `10.43.0.0/16`, kubeadm meist `10.96.0.0/12`) und frei sein; ist sie es
nicht, scheitert der Apply sichtbar am Service.

Wer im Cluster schon einen internen Controller hat, nimmt `ingress.yaml` im
Overlay wieder heraus und zeigt mit `WAVE_BACKEND_IPV4` auf dessen ClusterIP.

**Der Connector ist ein StatefulSet**, und beides daran hängt an seiner
Anmeldung: sie liegt auf einem PVC, überlebt also jedes Rollout, und der Knoten
heißt `wave-connector-0` statt einer neuen Zufallsendung nach jedem Neustart.
Vorher stand der Zustand in einem `emptyDir`, und jedes Rollout hinterließ ein
weiteres Gerät in der Wave, das niemand mehr abholt.

`--reusable` am Schlüssel bleibt trotzdem sinnvoll: geht das Volume verloren —
ein `local-path`-Volume klebt am Knoten —, meldet sich der Connector damit neu
an, ohne dass jemand einen Schlüssel nachreichen muss. Ein Gerät, das schon im
Wave ist, verbraucht dabei keinen Zug.

Die Speicherklasse setzt das Overlay. In der Basis steht keine, damit die
Vorgabe des Clusters greift — was voraussetzt, dass es genau eine gibt; sind
zwei als Vorgabe markiert, entscheidet der API-Server, und dann gehört die
Klasse ausdrücklich ins Overlay.

```bash
kubectl -n wave logs sts/wave-connector -c operator   # was der Operator sieht
kubectl -n wave logs sts/wave-connector -c connector  # die nftables-Regel
kubectl -n wave logs sts/wave-connector -c daemon     # der Tunnel
```

## Was in den Manifesten steckt

Vier Entscheidungen, die man beim Umbauen kennen sollte; die Begründung steht
jeweils als Kommentar daneben:

- **Control und Relay laufen mit genau einer Replika**, und das ist keine
  Sparsamkeit. Beide halten ihre offenen Verbindungen in einer Map im Prozess —
  der `NetmapHub` die Control-Sockets der Geräte, das Relay seine Sitzungen. Ein
  zweiter Pod bekäme die Hälfte der Geräte und erführe nie, dass die andere
  Hälfte eine neue Netmap braucht. Mehr Relays gibt es stattdessen als weitere
  Einträge in `WAVE_RELAYS`.
- **Der STUN-Service braucht `externalTrafficPolicy: Local`.** Mit der Vorgabe
  `Cluster` macht kube-proxy SNAT, und ein STUN-Server, der die Adresse eines
  Cluster-Knotens als reflexive Adresse zurückmeldet, schickt jedes Hole
  Punching gegen einen Endpunkt, den es nicht gibt.
- **Die Migrationen laufen als initContainer**, nicht als Job: ein Job ist
  unveränderlich, `kubectl apply` auf einen geänderten scheitert, und einer mit
  wechselndem Namen sammelt sich an. Vor dem einen Pod ist derselbe Ort in der
  Reihenfolge wie `service_completed_successfully` in der Compose-Datei.
- **Nur der Control-Server steht im Ingress.** Das Frontend spricht
  ausschließlich sein eigener Server an, und `/v1/control` ist ein WebSocket, den
  er nicht per `fetch` weiterreichen könnte — er gehört ihm selbst.

## Ungeprüft

Die Bäume bauen (`kubectl kustomize`), gefahren wurde noch keiner: hier gibt es
keinen Cluster. Das ist derselbe Stand wie beim Connector selbst und beim
Windows-Tray — benannt, nicht verschwiegen.

Ein Ding hängt daran: **die Tags in den `images:`-Einträgen gibt es erst ab dem
nächsten Release.** Alle vier Images baut der Release-Workflow seit dieser
Änderung, veröffentlicht sind bisher aber nur `control` und `relay` — bis ein
Tag durchgelaufen ist, zeigen `web` und `connector` auf etwas, das noch nicht
in der Registry steht.
