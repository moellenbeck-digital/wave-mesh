# Oberflächentests (Playwright)

Laufen gegen das Dev-System (`https://control.test.wave-mesh.net`), nicht gegen einen lokalen Stack.
Aufruf durch das Dev-Team: `e2e-test ausfuehren <nr>` im Worktree. Es setzt `APP_URL`, `APP_USER`,
`APP_PASSWORD` (Konto des Wave-Eigentümers) und `APP_TICKET`.

## Konvention

- Eine Datei je Ticket: `tests/t<nr>-<thema>.e2e.ts`. Endung `.e2e.ts`, damit `bun test` sie nicht aufgreift.
- Jeder Fall trägt die Marke als Tag: `test("…", { tag: "@t<nr>" }, …)`; `e2e-test ausfuehren <nr>` führt nur diese aus.
- Ein Kriterium des Tickets = ein Fall mit eigenem `expect`. Nicht Prüfbares steht im Dateikopf.
- Das Dev-System ist geteilt: Testdaten selbst anlegen (eindeutiger Name mit Lauf-Kennung) und am Ende
  wieder entfernen, nie fremde Daten anfassen.
- Selektoren sprachunabhängig (`name`, `action`, Rolle), Beschriftungen nur in `en-US` (die Config setzt es).
- Hilfen für Konten, Einladungen und Wave-Aufbau: `tests/helpers.ts`.
- Konten lassen sich in der Oberfläche nicht löschen. Zweitkonten haben deshalb feste Adressen
  (`t<nr>-…@example.test`) mit abgeleitetem Passwort und werden bei jedem Lauf wiederverwendet.

## Lokal

```bash
bun install --frozen-lockfile
APP_URL=… APP_USER=… APP_PASSWORD=… APP_TICKET=35 bunx playwright test -c playwright.testsystem.config.ts
```

Berichte und Artefakte landen in `testsystem-bericht/t<nr>/` und `testsystem-artefakte/t<nr>/` (nicht im Git).
