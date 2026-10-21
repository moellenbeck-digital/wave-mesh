# Zu wave-mesh beitragen

Fehler und Funktionswünsche kannst du als [Issue](../../issues) melden. Beschreibe
das beobachtete Verhalten, die erwartete Wirkung, Plattform und Version (`wave
version`) sowie Schritte zum Nachstellen. Entferne Schlüssel, Tokens, private
Adressen und personenbezogene Daten aus Logs. Sicherheitslücken gehören nicht
in ein Issue; siehe [SECURITY.md](SECURITY.md).

## Änderungen vorbereiten

1. Lies [README.md](README.md) und bei Architekturänderungen
   [docs/PLAN.md](docs/PLAN.md). Für Oberflächen gilt [DESIGN.md](DESIGN.md).
2. Installiere [Bun](https://bun.sh/), führe `bun install` aus und erstelle für
   deine Änderung einen Branch.
3. Prüfe vor einem Pull Request `bun run check`, `bun run typecheck` und
   `bun test`. Für Änderungen am Web zusätzlich `cd apps/web && bun run
   typecheck`, am Telefonkern `./mobile/build.sh check`.
4. Beschreibe im Pull Request die Änderung, ihren Grund, die durchgeführten
   Prüfungen und bekannte Einschränkungen. Ergänze Tests für verändertes
   Verhalten. Bei Login, Tunnel oder Daemon sind die passenden Skripte unter
   `test/e2e/` wichtig; ihre Voraussetzungen stehen in
   [test/e2e/README.md](test/e2e/README.md).

Beiträge zu diesem Repository werden unter der [Elastic License 2.0](LICENSE)
angenommen. Sie ist keine OSI-konforme Open-Source-Lizenz; insbesondere ist ein
gehosteter oder verwalteter Dienst für Dritte damit nicht erlaubt.
