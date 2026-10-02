import type { Locale, Messages } from "@wave/i18n";

/**
 * What `wave-admin` says, in the language of the machine it runs on.
 *
 * Command names, flags, selectors and the JSON shapes stay as they are in both
 * languages: they are what gets typed back. Dates stay ISO for the same
 * reason -- an operator pastes them into a query or a ticket.
 */
const en = {
  usageTitle: "usage:",
  usageNotes: `<wave> is a wave name, a wave id or the address of its owner.
set-acl reads a policy from a file, or from a pipe with -; without one every device reaches
every other. acl prints the policy and who reaches whom under it.
set-dns-provider reads the credential from the terminal or from a pipe. cloudflare, hetzner and
ionos take one token; inwx takes an account and asks for its parts, or reads
{"user":"…","password":"…","totpSecret":"…"} from a pipe.`,

  // --- credentials ----------------------------------------------------------
  ionosPrompt: (suffix: string) => `IONOS API key, <public prefix>.<secret> (${suffix}): `,
  tokenPrompt: (kind: string, suffix: string) => `API token for ${kind} (${suffix}): `,
  inwxIntro: (suffix: string) => `INWX signs in with an account rather than a token (${suffix}).`,
  inwxScope: [
    "Worth knowing: it has nothing that can be scoped to one zone, so this credential can",
    "do everything the account can. A sub-account for this domain alone is the way to narrow it.",
  ].join("\n"),
  inwxUser: "  INWX username: ",
  inwxPassword: "  INWX password (not echoed): ",
  inwxTotp: "  TOTP shared secret, empty if the account has no 2FA: ",

  // --- finding things -------------------------------------------------------
  noWaveMatches: (selector: string) => `no wave matches ${selector}`,
  severalWaves: (selector: string, list: string) =>
    `${selector} matches several waves -- name one of them:\n${list}`,
  ambiguousEntry: (name: string, id: string, owner: string | null) =>
    `  ${name} (${id}), owner ${owner ?? "unknown"}`,
  noDevice: (host: string, wave: string) => `no device called ${host} in ${wave}`,
  noAccount: (email: string) => `no account for ${email}`,

  // --- DNS and certificates -------------------------------------------------
  providerMustBe: (kinds: string) => `provider must be one of ${kinds}`,
  placeholderSuffix: (wave: string, suffix: string) =>
    `${wave} still uses the placeholder ${suffix}; set-domain first`,
  manualMode: (wave: string) => `${wave} answers dns-01 by hand; no credential is stored.`,
  manualRecord: "`wave cert` on a device prints the record to create and waits for it.",
  manualRenewals: "Renewals then need a person too -- a provider is the only way around that.",
  noDnsSecret: "WAVE_DNS_SECRET is not set; without it a token would have to be stored in the clear",
  noCredential: "no credential given",
  credentialCannotWrite: (suffix: string, reason: string) =>
    `the credential could not write ${suffix}: ${reason}`,
  writesThrough: (wave: string, suffix: string, kind: string) => `${wave} writes ${suffix} through ${kind}.`,
  devicesCanAskCerts: "Devices can now ask for certificates with `wave cert`.",
  providerSet: (wave: string, suffix: string, provider: string, at: string) =>
    `${wave} (${suffix}): ${provider}, set ${at}`,
  noProvider: (wave: string, suffix: string) => `${wave} (${suffix}): no DNS credential, so no certificates`,
  providerRemoved: (wave: string) =>
    `${wave} has no DNS credential any more; issued certificates keep working until they expire.`,
  hadNoProvider: (wave: string) => `${wave} had no DNS credential`,
  certUntil: (at: string) => `until ${at}`,
  noCertificates: "  no certificates",
  wildcardDenied: (host: string, suffix: string) => `${host} may no longer ask for *.${suffix}.`,
  wildcardAllowed: (host: string, suffix: string) => `${host} may now ask for *.${suffix} and ${suffix}.`,
  wildcardWarning: [
    "Whoever holds that certificate's key can serve every name in the wave,",
    "so it belongs on a machine you would trust with all of them.",
  ].join("\n"),

  // --- services and keys ----------------------------------------------------
  via: (host: string) => `via ${host}`,
  noServices: "  no services",
  serviceRemoved: (name: string, wave: string) =>
    `${name} is gone from ${wave}; a running operator would declare it again.`,
  noService: (name: string, wave: string) => `no service called ${name} in ${wave}`,
  noOwnerToEnrolFor: (wave: string) => `${wave} has no owner account to enrol devices for`,
  keyEnrols: (wave: string, until: string) => `This key enrols devices into ${wave} until ${until}.`,
  keyShownOnce: "It is shown once; it cannot be read back, only replaced.",
  keyState: (state: "revoked" | "expired" | "used" | "usable"): string =>
    ({ revoked: "revoked", expired: "expired", used: "used", usable: "usable" })[state],
  keyKind: (reusable: boolean): string => (reusable ? "reusable" : "single use"),
  keyDevices: (n: number) => `${n} device(s)`,
  noKeys: "  no pre-auth keys",
  keyRevoked: (id: string) => `${id} cannot enrol anything any more; devices that used it keep their place.`,
  noUsableKey: (id: string, wave: string) => `no usable key ${id} in ${wave}`,

  // --- audit and policy -----------------------------------------------------
  newestFirst: (wave: string, suffix: string) => `${wave} (${suffix}), newest first`,
  nothingRecorded: "  nothing recorded yet",
  noPolicy: (wave: string) => `${wave} has no policy: every device reaches every other.`,
  policyVersion: (version: number, at: string) => `\nversion ${version}, set ${at}. Under it:`,
  everyDeviceEnforces: "\nEvery device enforces its ports.",
  netmapOnly: "\nThese devices are limited by the netmap only, not in their ports:",
  notJson: (reason: string) => `not JSON: ${reason}`,
  note: (warning: string) => `  note: ${warning}`,
  refused: (errors: string) => `refused:\n${errors}`,
  policySet: (wave: string, version: number) => `${wave}: policy version ${version}. Under it:`,
  withinThirtySeconds: "Connected devices get the new netmap within thirty seconds.",
  policyRemoved: (wave: string) => `${wave} has no policy any more: every device reaches every other.`,
  hadNoPolicy: (wave: string) => `${wave} had no policy`,
  badTags: (bad: string) => `not a tag: ${bad} (tags look like tag:nas)`,
  untagged: (host: string) => `${host} has no tags: it counts as its owner's again.`,
  judgedByTags: "The policy now judges it by these tags alone, no longer as its owner's device.",

  // --- the wave itself ------------------------------------------------------
  suffixTaken: (domain: string) => `another wave already answers for ${domain}`,
  namesNow: (wave: string, domain: string) => `${wave}: names are now <host>.${domain}`,
  nextNetmap: "Connected nodes pick this up with their next netmap.",
  deleteSummary: (wave: string, suffix: string, devices: number, members: number) =>
    `${wave} (${suffix}) has ${devices} device(s) and ${members} member(s).`,
  deleteWarning: "Deleting it cannot be undone: every device loses its enrolment.",
  typeToConfirm: (wave: string) => `Type ${wave} to confirm: `,
  notDeleted: "Not deleted.",
  deleted: (wave: string, devices: number) =>
    `${wave} is gone, with ${devices} device(s). Connected ones drop on their next request.`,

  // --- people and devices ---------------------------------------------------
  deviceCount: (n: number) => `${n} ${n === 1 ? "device" : "devices"}`,
  invitedLine: (email: string, role: string, until: string) =>
    `  invited ${email} as ${role}, until ${until}`,
  neverSeen: "never seen",
  versionUnknown: "  version unknown",
  noDevices: "  no devices",
  deviceRemoved: (host: string, wave: string) =>
    `${host} is out of ${wave}; it has to be let in again with wave login.`,
  peerGone: "Nodes still running lose the peer with their next netmap.",
  peersGone: "Nodes still running lose the peers with their next netmap.",
  noAccountHint: (email: string) =>
    `no account for ${email}. Create one with set-password, or use invite to let them in themselves.`,
  memberAdded: (email: string, role: string, wave: string) => `${email} is now ${role} of ${wave}.`,
  memberExisted: (email: string, wave: string, role: string) =>
    `${email} was already in ${wave}; role is ${role}.`,
  notInWave: (email: string, wave: string) => `${email} is not in ${wave}`,
  ownsWave: (email: string, wave: string) =>
    `${email} owns ${wave}; hand ownership over before removing them.`,
  notAllowed: "not allowed",
  memberRemoved: (email: string, wave: string, devices: number) =>
    `${email} is out of ${wave}; ${devices} device(s) removed with them.`,
  notAnEmail: (email: string) => `not an email address: ${email}`,
  noOwnerToInviteFor: (wave: string) => `${wave} has no owner account to invite on behalf of`,
  sendLink: (email: string, until: string) => `Send ${email} this link. It works once, until ${until}:`,
  inviteRevoked: (email: string) => `The invitation for ${email} no longer works.`,
  noInvite: (email: string, wave: string) => `no open invitation for ${email} in ${wave}`,

  // --- set-password ---------------------------------------------------------
  passwordFor: (email: string) => `Password for ${email}: `,
  repeat: "Repeat: ",
  passwordTooShort: "Password must be at least 12 characters.",
  passwordsDiffer: "Passwords do not match.",
  waveDeferred: "no wave: an invitation is waiting for this address",
  waveNote: (id: string, created: boolean) => `wave ${id}${created ? " created" : ""}`,
  accountSaved: (created: boolean, email: string, userId: string, note: string) =>
    `${created ? "Created" : "Updated"} ${email} (${userId}); ${note}.`,
} satisfies Messages;

const de: typeof en = {
  usageTitle: "Aufruf:",
  usageNotes: `<wave> ist ein Wave-Name, eine Wave-Id oder die Adresse seines Eigentümers.
set-acl liest eine Policy aus einer Datei oder mit - aus einer Pipe; ohne Policy erreicht jedes
Gerät jedes andere. acl druckt die Policy und wer danach wen erreicht.
set-dns-provider liest die Zugangsdaten vom Terminal oder aus einer Pipe. cloudflare, hetzner und
ionos nehmen einen Token; inwx nimmt ein Konto und fragt nach seinen Teilen, oder liest
{"user":"…","password":"…","totpSecret":"…"} aus einer Pipe.`,

  ionosPrompt: (suffix) => `IONOS-API-Schlüssel, <öffentliches Präfix>.<Geheimnis> (${suffix}): `,
  tokenPrompt: (kind, suffix) => `API-Token für ${kind} (${suffix}): `,
  inwxIntro: (suffix) => `INWX meldet sich mit einem Konto an, nicht mit einem Token (${suffix}).`,
  inwxScope: [
    "Gut zu wissen: Dort lässt sich nichts auf eine Zone beschränken, diese Zugangsdaten können",
    "also alles, was das Konto kann. Ein Sub-Account nur für diese Domain grenzt das ein.",
  ].join("\n"),
  inwxUser: "  INWX-Benutzername: ",
  inwxPassword: "  INWX-Passwort (wird nicht angezeigt): ",
  inwxTotp: "  TOTP-Geheimnis, leer, wenn das Konto keine 2FA hat: ",

  noWaveMatches: (selector) => `kein Wave passt zu ${selector}`,
  severalWaves: (selector, list) => `${selector} passt zu mehreren Waves -- nenne einen davon:\n${list}`,
  ambiguousEntry: (name, id, owner) => `  ${name} (${id}), Eigentümer ${owner ?? "unbekannt"}`,
  noDevice: (host, wave) => `kein Gerät namens ${host} in ${wave}`,
  noAccount: (email) => `kein Konto für ${email}`,

  providerMustBe: (kinds) => `der Provider muss einer von ${kinds} sein`,
  placeholderSuffix: (wave, suffix) => `${wave} nutzt noch den Platzhalter ${suffix}; zuerst set-domain`,
  manualMode: (wave) => `${wave} beantwortet dns-01 von Hand; es werden keine Zugangsdaten gespeichert.`,
  manualRecord: "`wave cert` auf einem Gerät nennt den anzulegenden Record und wartet darauf.",
  manualRenewals: "Erneuerungen brauchen dann ebenfalls einen Menschen -- nur ein Provider erspart das.",
  noDnsSecret: "WAVE_DNS_SECRET ist nicht gesetzt; ohne es müsste ein Token im Klartext gespeichert werden",
  noCredential: "keine Zugangsdaten angegeben",
  credentialCannotWrite: (suffix, reason) =>
    `mit diesen Zugangsdaten lässt sich ${suffix} nicht schreiben: ${reason}`,
  writesThrough: (wave, suffix, kind) => `${wave} schreibt ${suffix} über ${kind}.`,
  devicesCanAskCerts: "Geräte können jetzt mit `wave cert` Zertifikate anfordern.",
  providerSet: (wave, suffix, provider, at) => `${wave} (${suffix}): ${provider}, gesetzt ${at}`,
  noProvider: (wave, suffix) => `${wave} (${suffix}): keine DNS-Zugangsdaten, also keine Zertifikate`,
  providerRemoved: (wave) =>
    `${wave} hat keine DNS-Zugangsdaten mehr; ausgestellte Zertifikate gelten weiter, bis sie ablaufen.`,
  hadNoProvider: (wave) => `${wave} hatte keine DNS-Zugangsdaten`,
  certUntil: (at) => `bis ${at}`,
  noCertificates: "  keine Zertifikate",
  wildcardDenied: (host, suffix) => `${host} darf *.${suffix} nicht mehr anfordern.`,
  wildcardAllowed: (host, suffix) => `${host} darf jetzt *.${suffix} und ${suffix} anfordern.`,
  wildcardWarning: [
    "Wer den Schlüssel dieses Zertifikats hat, kann jeder Name im Wave sein,",
    "es gehört also auf eine Maschine, der du alle davon anvertrauen würdest.",
  ].join("\n"),

  via: (host) => `über ${host}`,
  noServices: "  keine Dienste",
  serviceRemoved: (name, wave) =>
    `${name} ist aus ${wave} entfernt; ein laufender Operator würde ihn wieder melden.`,
  noService: (name, wave) => `kein Dienst namens ${name} in ${wave}`,
  noOwnerToEnrolFor: (wave) => `${wave} hat kein Eigentümerkonto, für das Geräte angemeldet werden könnten`,
  keyEnrols: (wave, until) => `Dieser Schlüssel meldet bis ${until} Geräte in ${wave} an.`,
  keyShownOnce: "Er wird einmal angezeigt; er lässt sich nicht wieder auslesen, nur ersetzen.",
  keyState: (state) =>
    ({ revoked: "widerrufen", expired: "abgelaufen", used: "verbraucht", usable: "gültig" })[state],
  keyKind: (reusable) => (reusable ? "mehrfach" : "einmalig"),
  keyDevices: (n) => `${n} Gerät(e)`,
  noKeys: "  keine Pre-Auth-Keys",
  keyRevoked: (id) => `${id} meldet nichts mehr an; Geräte, die ihn benutzt haben, behalten ihren Platz.`,
  noUsableKey: (id, wave) => `kein gültiger Schlüssel ${id} in ${wave}`,

  newestFirst: (wave, suffix) => `${wave} (${suffix}), neueste zuerst`,
  nothingRecorded: "  noch nichts aufgezeichnet",
  noPolicy: (wave) => `${wave} hat keine Policy: jedes Gerät erreicht jedes andere.`,
  policyVersion: (version, at) => `\nVersion ${version}, gesetzt ${at}. Danach:`,
  everyDeviceEnforces: "\nJedes Gerät setzt seine Ports durch.",
  netmapOnly: "\nDiese Geräte begrenzt nur die Netzkarte, nicht ihre Ports:",
  notJson: (reason) => `kein JSON: ${reason}`,
  note: (warning) => `  Hinweis: ${warning}`,
  refused: (errors) => `abgelehnt:\n${errors}`,
  policySet: (wave, version) => `${wave}: Policy-Version ${version}. Danach:`,
  withinThirtySeconds: "Verbundene Geräte bekommen die neue Netzkarte innerhalb von dreißig Sekunden.",
  policyRemoved: (wave) => `${wave} hat keine Policy mehr: jedes Gerät erreicht jedes andere.`,
  hadNoPolicy: (wave) => `${wave} hatte keine Policy`,
  badTags: (bad) => `kein Tag: ${bad} (Tags sehen aus wie tag:nas)`,
  untagged: (host) => `${host} hat keine Tags: es zählt wieder als Gerät seines Besitzers.`,
  judgedByTags: "Die Policy beurteilt es jetzt nur nach diesen Tags, nicht mehr als Gerät seines Besitzers.",

  suffixTaken: (domain) => `ein anderer Wave antwortet schon für ${domain}`,
  namesNow: (wave, domain) => `${wave}: die Namen lauten jetzt <host>.${domain}`,
  nextNetmap: "Verbundene Knoten übernehmen das mit ihrer nächsten Netzkarte.",
  deleteSummary: (wave, suffix, devices, members) =>
    `${wave} (${suffix}) hat ${devices} Gerät(e) und ${members} Mitglied(er).`,
  deleteWarning: "Das Löschen lässt sich nicht rückgängig machen: jedes Gerät verliert seine Anmeldung.",
  typeToConfirm: (wave) => `Tippe ${wave} zur Bestätigung: `,
  notDeleted: "Nicht gelöscht.",
  deleted: (wave, devices) =>
    `${wave} ist gelöscht, mit ${devices} Gerät(en). Verbundene fallen bei ihrer nächsten Anfrage heraus.`,

  deviceCount: (n) => `${n} ${n === 1 ? "Gerät" : "Geräte"}`,
  invitedLine: (email, role, until) => `  eingeladen: ${email} als ${role}, bis ${until}`,
  neverSeen: "nie gesehen",
  versionUnknown: "  Version unbekannt",
  noDevices: "  keine Geräte",
  deviceRemoved: (host, wave) =>
    `${host} ist aus ${wave} entfernt; es muss mit wave login neu hereingelassen werden.`,
  peerGone: "Laufende Knoten verlieren den Peer mit ihrer nächsten Netzkarte.",
  peersGone: "Laufende Knoten verlieren die Peers mit ihrer nächsten Netzkarte.",
  noAccountHint: (email) =>
    `kein Konto für ${email}. Leg eines mit set-password an, oder lass die Person mit invite selbst herein.`,
  memberAdded: (email, role, wave) => `${email} ist jetzt ${role} in ${wave}.`,
  memberExisted: (email, wave, role) => `${email} war schon in ${wave}; Rolle ist ${role}.`,
  notInWave: (email, wave) => `${email} ist nicht in ${wave}`,
  ownsWave: (email, wave) =>
    `${email} ist Eigentümer von ${wave}; übergib die Eigentümerschaft vor dem Entfernen.`,
  notAllowed: "nicht erlaubt",
  memberRemoved: (email, wave, devices) =>
    `${email} ist aus ${wave} entfernt; ${devices} Gerät(e) gingen mit.`,
  notAnEmail: (email) => `keine E-Mail-Adresse: ${email}`,
  noOwnerToInviteFor: (wave) => `${wave} hat kein Eigentümerkonto, in dessen Namen eingeladen werden könnte`,
  sendLink: (email, until) => `Schick ${email} diesen Link. Er funktioniert einmal, bis ${until}:`,
  inviteRevoked: (email) => `Die Einladung für ${email} funktioniert nicht mehr.`,
  noInvite: (email, wave) => `keine offene Einladung für ${email} in ${wave}`,

  passwordFor: (email) => `Passwort für ${email}: `,
  repeat: "Wiederholen: ",
  passwordTooShort: "Das Passwort muss mindestens 12 Zeichen haben.",
  passwordsDiffer: "Die Passwörter stimmen nicht überein.",
  waveDeferred: "kein Wave: für diese Adresse wartet eine Einladung",
  waveNote: (id, created) => `Wave ${id}${created ? " angelegt" : ""}`,
  accountSaved: (created, email, userId, note) =>
    `${email} (${userId}) ${created ? "angelegt" : "aktualisiert"}; ${note}.`,
};

export type AdminMessages = typeof en;

export const adminMessages = (locale: Locale): AdminMessages => (locale === "de" ? de : en);
