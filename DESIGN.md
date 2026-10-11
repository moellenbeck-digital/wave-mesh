# Design wave-mesh

Wie wave-mesh aussieht und warum. Die Werte hier sind abgeschrieben — die
Quelle der Wahrheit bleibt der Code:

| Was | Wo |
|---|---|
| Tokens, Typo-Skala, `wc-*`-Komponenten der Weboberfläche | `apps/web/src/app/globals.css` |
| Das Zeichen und seine Zustandsfarben | `apps/tray/src/icon.ts` |
| Die Palette des Tray-Fensters | `apps/tray/src/window-win32-layout.ts` (`PALETTE`), `window-gtk.ts`, `window-macos.ts` |
| `icon.svg` und `favicon.ico` des Frontends | erzeugt mit `bun run icon` aus `icon.ts` |

Wer hier einen Wert ändert, ändert ihn dort — und umgekehrt.

---

## Grundsatz

**wave-mesh gehört zur Familie von [wavecenter.org](https://wavecenter.org/de).**
Palette, Schriften und die `wc-*`-Komponenten sind von dort übernommen, damit
die Oberfläche als Teil derselben Familie gelesen wird. Eigen ist genau eine
Sache: **der Akzent ist Petrol statt Gold.**

Daraus folgen die Regeln, die alles Weitere bestimmen:

- **Ein Akzent, ein Signal.** Petrol steht für „aktiv, verbunden, Aktion“.
  Es gibt kein Erfolgs-Grün daneben — auch eine Erfolgsmeldung ist Petrol.
- **Rot nur für Fehler** und für Zustände, die jemand beheben muss
  („nicht freigegeben“).
- **Ruhig statt bunt.** Text ist Navy oder Slate, Flächen sind Papier und Weiß,
  Trennlinien sind Navy mit wenigen Prozent Deckkraft.
- **Kein Token ohne Nutzer.** Was in `globals.css` steht, wird von einer Seite
  getragen. Was keine Seite braucht, kommt nicht hinein.

---

## Marke

### Wortmarke

`wave` in Navy, direkt daran `mesh` in Petrol, beides in Space Grotesk,
`text-xl`, `tracking-tight`. In der Weboberfläche folgt daneben in Slate der
Name der Anwendung („Control“). Im Fließtext heißt das Produkt **wave-mesh**,
klein und mit Bindestrich.

### Das Zeichen

Drei Knoten auf einer Scheibe, verbunden zu einem Dreieck, dessen Grundlinie
eine Welle ist — Mesh und Welle in einer Figur.

- **Es ist Geometrie, keine Datei.** Es steht einmal in
  `apps/tray/src/icon.ts` (64-Einheiten-Raster) und wird zur Laufzeit in genau
  der Größe gerastert, die die Plattform verlangt. `bun run icon` schreibt
  daraus `icon.svg` und `favicon.ico`; `apps/tray/test/icon.test.ts` schlägt
  fehl, wenn die eingecheckten Dateien nicht mehr dazu passen.
- **Klein wird es kräftiger gezeichnet.** Bis 32 px sind Striche und Knoten
  dicker und die Welle flacher. Wer das Zeichen anderswo verwendet, nimmt die
  erzeugten Dateien und zeichnet es nicht nach.
- **Der Zustand ist die Farbe des ganzen Zeichens**, nie ein Punkt daran:
  ein Punkt, der in 16 px passt, ist nicht lesbar. Unter macOS deshalb auch
  kein Template-Bild, das das System schwarz oder weiß färben würde.

| Zustand | Farbe | |
|---|---|---|
| Verbunden | `#0f7f7f` | eine Spur heller als Petrol, sonst versinkt es auf dunklen Leisten |
| Verbindet | `#d99a14` | Bernstein — die einzige Stelle, an der Gelb vorkommt |
| Getrennt | `#7c8b9a` | Slate |
| Marke (Favicon) | `#0f6e6e` | Petrol |

---

## Farben

### Weboberfläche (hell)

| Token | Wert | Verwendung |
|---|---|---|
| `paper` | `#fffdf8` | Seitenhintergrund, Header (85 % deckend, mit Blur) |
| `ink` | `#1a1a1a` | Grundtextfarbe, technische Werte (IP-Adressen) |
| `navy` | `#0f2744` | Überschriften, Namen, Beschriftungen, Sekundär-Buttons |
| `slate` | `#7c8b9a` | Nebentext, Metadaten, Abschnittstitel, Offline-Zustand |
| `accent` | `#0f6e6e` | Petrol: Primär-Buttons, Links zu Diensten, Online-Punkt, Fokus |
| `accent-strong` | `#0b5757` | Hover des Primär-Buttons, Text der Erfolgsmeldung |
| `line` | `#0f274414` | Navy 8 %: jede Trennlinie und jeder Kartenrand |
| — | `#ffffff` | Karten und Eingabefelder |
| — | `#dc2626` | Fehler (Meldung, Badge, Hinweistext) |

**Abstufungen per Deckkraft statt neuer Farben.** Hintergründe und Ränder
entstehen aus Navy, Petrol oder Rot mit Alpha:

| Deckkraft | Navy `#0f2744` | Petrol `#0f6e6e` | Rot `#dc2626` |
|---|---|---|---|
| 4 % (`0a`) | Hover von Zeilen (`bg-navy/4`), Hinweisflächen | — | — |
| 6 % (`0f`) | Kartenschatten, neutraler Badge, Abschnittslinie | Hintergrund Erfolgsmeldung | Hintergrund Fehler, Fehler-Badge |
| 8 % (`14`) | `line` | Akzent-Badge | — |
| 10 % (`1a`) | Header-Unterkante | — | — |
| 12 % (`1f`) | Rand Eingabefeld | Ring um den Online-Punkt | — |
| 15 % (`26`) | Rand Sekundär-Button | Rand Erfolgsmeldung | Rand Fehlermeldung |
| 30 % | — | Unterstreichung von Dienst-Links | — |

### Tray-Fenster (dunkel)

Das Fenster hinter dem Tray-Icon ist dunkel, auf allen drei Plattformen gleich.
Den Akzent bringt es selbst mit, statt den des Desktops zu übernehmen — der
Schalter soll zu wave-mesh gehören.

| Name | Wert | Verwendung |
|---|---|---|
| `card` | `#14161f` | Fläche der Karte (Radius 12 px) |
| `border` | `#262b3b` | Kartenrand, Trennlinien |
| `text` | `#d7dbe8` | Text |
| `muted` | `#7f88a3` | Untertitel, Abschnittstitel, Details, Pfeile |
| `active` | `#232838` | Ausgewählte Zeile |
| — | `#1c2030` | Hover von Zeilen und Diensten (GTK) |
| — | `#2b3145` | Hover des Kopierknopfs (GTK) |
| `offline` | `#5c6480` | Geräte ohne Verbindung |
| `accent` | `#0f6e6e` | Schalter an (Hover `#12857f`) |
| `track` | `#3a4055` | Schalter aus |
| `knob` | `#e8ecf7` | Knopf des Schalters |
| `service` | `#7ecfcf` | Dienste — das einzige auf der Karte, das etwas anderswo öffnet |

### Mobile Apps

Die iOS-App verwendet die Systemvorgaben von SwiftUI mit genau einer
Abweichung: der Akzent ist Petrol — `#0f6e6e` auf hellem, `#0f7f7f` auf dunklem
Grund, aus demselben Grund wie beim Zeichen in dunklen Leisten (`AccentColor`
im Asset-Katalog). **Die Android-App sieht aus wie die iOS-App**, nicht wie
Material: gruppierte Liste auf `#F2F2F7` (dunkel Schwarz), Abschnitte weiß
(dunkel `#1C1C1E`) mit großem Radius, Kopf- und Fußzeilen in Grau, Aktionen als
Text in Petrol, Zerstörendes in Rot, großer Titel und die Pille oben rechts.
Die Farben sind die Systemfarben von iOS und stehen einmal in
`mobile/android/…/Theme.kt`; Material bleibt nur darunter (Textfelder,
Dialoge) und bekommt dieselben Werte. Das App-Icon ist das Zeichen weiß auf Petrol (die Plattform gibt
die Form vor, der Kreis entfällt), erzeugt aus `markSvg()`, nie nachgezeichnet.

---

## Typografie

| Rolle | Schrift |
|---|---|
| Display (Wortmarke, große Überschriften) | **Space Grotesk** 500/600/700 |
| Fließtext und UI | **Inter** |
| Code, IP-Adressen, Schlüssel | `ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace` |

Beide Webfonts liefert `next/font` selbst aus — zur Laufzeit geht keine Anfrage
an Google.

**Skala** (Utilities aus `globals.css`):

| Klasse | Größe | Gewicht | Zeilenhöhe |
|---|---|---|---|
| `text-display-md` | `clamp(1.5rem, 3vw, 2.5rem)` | 700 | 1.2 |
| `text-display-sm` | `clamp(1.25rem, 2vw, 1.75rem)` | 700 | 1.25 |
| `text-headline` | 1.375rem | 600 | 1.3 |
| `text-body-lg` | 1.0625rem | — | 1.7 |
| `text-body` | 0.9375rem | — | 1.7 |
| `text-body-sm` | 0.875rem | — | 1.6 |
| `text-caption` | 0.8125rem | — | 1.5 |
| `text-label` | 0.6875rem | 700 | 1.4, Sperrung 0.05em |

Die Display-Stufen und die Headline sind leicht enger gesetzt (−0.01em).
Abschnittstitel (`wc-section-title`) stehen in Versalien, 0.75rem, Slate,
gesperrt — im Tray-Fenster entsprechend `muted`, 0.75rem, Sperrung 0.14em.

---

## Komponenten

Alles Wiederkehrende ist eine `wc-*`-Utility in `globals.css`. Neue Seiten
setzen sich daraus zusammen, statt Stile nachzubauen.

| Klasse | Aussehen |
|---|---|
| `wc-card` | Weiß, Rand `line`, Schatten `0 1px 3px` Navy 6 % |
| `wc-section-title` | Versalien in Slate, darunter eine Linie Navy 6 % |
| `wc-badge` | Pille (`rounded-full`), 0.75rem, Farbe per Inline-Stil (siehe unten) |
| `wc-btn` + `wc-btn-primary` | Petrol, weißer Text, Radius 0.5rem, Hover `accent-strong` |
| `wc-btn` + `wc-btn-secondary` | Transparent, Navy-Text, Rand Navy 15 %, Hover Navy 3 % |
| `wc-input` | Weiß, Rand Navy 12 %, Radius 0.5rem, Fokus: Rand Petrol |
| `wc-label` | Navy, 0.875rem, 500 |
| `wc-alert-success` | Petrol 6 % Fläche, Text `accent-strong` — bewusst kein Grün |
| `wc-alert-error` | Rot 6 % Fläche, Rand Rot 15 %, Text `#dc2626` |

**Badges** gibt es in drei Tönen, immer heller Hintergrund mit kräftigem Text:

| Ton | Hintergrund | Text | Beispiel |
|---|---|---|---|
| Neutral | Navy 6 % | Slate | „flüchtig“ |
| Akzent | Petrol 8 % | Petrol | „2 Dienste“ |
| Fehler | Rot 6 % | Rot | „nicht freigegeben“ |

**Online-Zustand** in Listen: ein Punkt von 8 px — online Petrol mit einem
3-px-Ring Petrol 12 %, offline Slate mit 50 % Deckkraft.

---

## Layout

- **Header:** fest oben, 64 px hoch, Papier zu 85 % mit `backdrop-blur`, eine
  Haarlinie Navy 10 % darunter. Inhalt bis `max-w-7xl`.
- **Inhalt:** zentriert, `max-w-5xl`, `px-6 py-12`. Formulare und schmale
  Dialoge `max-w-md` bis `max-w-lg`.
- **Radien:** 0.5rem (`rounded-lg`) für Buttons, Felder und Hinweisflächen;
  Pillen für Badges; 12 px für die Tray-Karte, 8 px für ihre Zeilen.
- **Listen:** Zeilen getrennt durch `divide-line`, Zeilen-Hover Navy 4 %.
  Auf schmalen Bildschirmen stapeln sich die Spalten (`grid-cols-1`), ab `md`
  stehen sie nebeneinander.
- **Leere Zustände:** zentriert, ein Satz in Slate, darunter die nächste
  Handlung auf einer Fläche Navy 4 %.

---

## Bewegung

- Übergänge sind kurz: 0.2s für Buttons und Felder, 0.5s für Karten.
- Zwei Einblendungen: `animate-fade-in` (0.4s) und `animate-slide-up`
  (0.5s, 16 px von unten).
- `prefers-reduced-motion` schaltet alle Animationen und Übergänge praktisch ab.

---

## Sprache und Ton

- Die Oberfläche spricht **Deutsch und Englisch**, Englisch ist der Rückfall.
  Im Browser entscheidet der Umschalter DE | EN in der Kopfzeile (Cookie
  `wave_lang`), sonst die Sprache des Browsers; `<html lang>` folgt. CLI und
  Tray nehmen die Systemsprache, `WAVE_LANG` setzt sie fest.
- Im Deutschen wird **geduzt**, und es heißt **der Wave** („in deinem Wave“,
  „einem Wave beitreten“) — auch in CLI, Tray und den Apps.
- Kurz und konkret: sagen, was ist und was man tun kann — „In diesem Wave ist
  noch kein Gerät angemeldet.“, nicht „Keine Daten vorhanden.“
- Fachbegriffe, die man im Terminal wiederfindet (`wave-admin`, Tags wie
  `tag:nas`), stehen in Monospace.

---

## Zugänglichkeit

- Petrol auf Papier erreicht etwa 6 : 1, Navy auf Papier deutlich mehr — beides
  genügt WCAG AA für jeden Text.
- **Slate auf Papier erreicht nur etwa 3.5 : 1.** Das reicht für großen Text,
  nicht für kleinen. Slate trägt deshalb nur Nebensächliches (Metadaten,
  Beschriftungen); was jemand lesen *muss*, steht in Navy oder Ink.
- Im Tray-Fenster erreicht `muted` auf `card` etwa 5 : 1. `offline` liegt mit
  rund 3 : 1 bewusst darunter — es soll zurücktreten.
- Zustand nie nur über Farbe: der Online-Punkt ist `aria-hidden`, der Zustand
  steht zusätzlich als Text da.
