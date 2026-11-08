import { type Locale, type Messages, messagesFor } from "@wave/i18n";
import type { DnsProviderKind } from "@/lib/control";

/**
 * The texts of the certificate page: which DNS provider answers dns-01 for a
 * wave. Product names stay as they are; what the control server says about a
 * refused credential arrives in the reader's language already.
 */

const en = {
  back: "← Overview",
  title: (wave: string) => `Certificates for ${wave}`,
  intro:
    "Devices get Let's Encrypt certificates for their names with {cert}. The control server answers the dns-01 challenge in the zone {suffix} — by itself through a provider, or by asking a person.",
  placeholder:
    "This wave still uses the placeholder domain {suffix}, and no certificate can exist for it. Move the wave onto a domain of your own first: “Change domain” on the overview.",
  currentLabel: "Current provider",
  since: (date: string) => `Set up ${date}`,
  none: "No provider is set, so devices cannot get certificates yet.",
  noSealing:
    "This server has no WAVE_DNS_SECRET and so cannot store credentials. Only the manual mode is possible; for a provider, ask whoever runs the server.",
  providerLabel: "Provider",
  providerName: (kind: DnsProviderKind) =>
    ({
      manual: "Manual — any hoster",
      cloudflare: "Cloudflare",
      hetzner: "Hetzner DNS",
      ionos: "IONOS (Hosting DNS)",
      inwx: "INWX",
    })[kind],
  providerHint: (kind: DnsProviderKind) =>
    ({
      manual:
        "No credentials. {cert} names the TXT record to create and waits until it is in the zone. The price: every renewal needs a person again.",
      cloudflare: "An API token limited to this zone (Zone · DNS · Edit) — the narrowest grant of the four.",
      hetzner: "An API token of the DNS console. It applies to every zone of the account.",
      ionos:
        "The API key of IONOS Hosting DNS, written as prefix.secret. Not IONOS Cloud DNS: its keys answer 401 here.",
      inwx: "INWX has no token limited to one zone; these credentials can do whatever the account can. A sub-account just for this domain keeps that small.",
    })[kind],
  tokenLabel: (kind: DnsProviderKind): string => (kind === "ionos" ? "API key (prefix.secret)" : "API token"),
  inwxUser: "User name",
  inwxPassword: "Password",
  inwxTotp: "TOTP shared secret (only with two-factor login)",
  stored:
    "Tested by writing a TXT record and removing it again, then stored encrypted. It is never shown again; entering new credentials replaces it.",
  save: "Test and save",
  saving: "Testing the credentials…",
  saved: "Saved. Devices can now ask for certificates with wave cert.",
  savedManual: "Saved. wave cert on a device now names the record to create.",
  edit: "Edit",
  cancel: "Cancel",
  remove: "Remove",
  confirmRemove:
    "Remove the provider? Certificates already issued stay valid, but devices can neither get new ones nor renew until a provider is set again.",
  refused: "The control server refused.",
} satisfies Messages;

const de: typeof en = {
  back: "← Übersicht",
  title: (wave) => `Zertifikate für ${wave}`,
  intro:
    "Geräte holen sich mit {cert} Let's-Encrypt-Zertifikate auf ihre Namen. Die dns-01-Challenge beantwortet der Control-Server in der Zone {suffix} — selbst über einen Provider oder, indem er einen Menschen fragt.",
  placeholder:
    "Dieser Wave nutzt noch die Platzhalter-Domain {suffix}, und für die kann es kein Zertifikat geben. Zieh ihn zuerst auf eine eigene Domain um: „Domain ändern“ in der Übersicht.",
  currentLabel: "Aktueller Provider",
  since: (date) => `Eingerichtet ${date}`,
  none: "Es ist kein Provider eingerichtet, Geräte bekommen deshalb noch keine Zertifikate.",
  noSealing:
    "Auf diesem Server fehlt WAVE_DNS_SECRET, er kann deshalb keine Zugangsdaten speichern. Möglich ist nur der manuelle Modus; für einen Provider frag den Betreiber des Servers.",
  providerLabel: "Provider",
  providerName: (kind) =>
    ({
      manual: "Manuell — jeder Hoster",
      cloudflare: "Cloudflare",
      hetzner: "Hetzner DNS",
      ionos: "IONOS (Hosting DNS)",
      inwx: "INWX",
    })[kind],
  providerHint: (kind) =>
    ({
      manual:
        "Keine Zugangsdaten. {cert} nennt den anzulegenden TXT-Record und wartet, bis er in der Zone steht. Der Preis: Auch jede Erneuerung braucht dann wieder einen Menschen.",
      cloudflare:
        "Ein API-Token, beschränkt auf diese Zone (Zone · DNS · Edit) — die engste Vollmacht der vier.",
      hetzner: "Ein API-Token der DNS-Konsole. Er gilt für alle Zonen des Kontos.",
      ionos:
        "Der API-Key von IONOS Hosting DNS, geschrieben als prefix.secret. Nicht IONOS Cloud DNS: dessen Keys ergeben hier 401.",
      inwx: "INWX kennt keinen auf eine Zone beschränkten Token; diese Zugangsdaten können alles, was das Konto kann. Ein Sub-Account nur für diese Domain hält das klein.",
    })[kind],
  tokenLabel: (kind) => (kind === "ionos" ? "API-Key (prefix.secret)" : "API-Token"),
  inwxUser: "Benutzername",
  inwxPassword: "Passwort",
  inwxTotp: "TOTP-Shared-Secret (nur bei Zwei-Faktor-Anmeldung)",
  stored:
    "Geprüft, indem ein TXT-Record geschrieben und wieder entfernt wird, dann verschlüsselt gespeichert. Angezeigt wird es nie wieder; neue Zugangsdaten ersetzen die alten.",
  save: "Prüfen und speichern",
  saving: "Zugangsdaten werden geprüft …",
  saved: "Gespeichert. Geräte können jetzt mit wave cert Zertifikate anfordern.",
  savedManual: "Gespeichert. wave cert nennt auf einem Gerät jetzt den anzulegenden Record.",
  edit: "Bearbeiten",
  cancel: "Abbrechen",
  remove: "Entfernen",
  confirmRemove:
    "Provider entfernen? Ausgestellte Zertifikate bleiben gültig, aber Geräte bekommen weder neue noch Erneuerungen, bis wieder einer eingerichtet ist.",
  refused: "Der Control-Server hat abgelehnt.",
};

export type DnsMessages = typeof en;

export const dnsMessages = (locale: Locale): DnsMessages => messagesFor({ en, de }, locale);
