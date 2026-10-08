import { type Locale, type Messages, messagesFor } from "@wave/i18n";

/**
 * The texts of every page but the access page (see `./acl.ts`).
 *
 * Sentences with markup in them keep `{name}` holes and go through `rich()`;
 * everything with a number or a name that is plain text is a function, so the
 * German side can put it where German wants it.
 */

type Role = "owner" | "admin" | "member";

const en = {
  // ---- frame ----
  metaDescription: "Management for a self-hosted mesh VPN built on WireGuard.",
  signOut: "Sign out",
  language: "Language",
  footerTagline: "wave-mesh — a self-hosted mesh VPN built on WireGuard.",
  footerSigned: "Netmaps are delivered signed.",
  toOverview: "Back to overview",

  notFoundTitle: "Page not found",
  notFoundText: "This address does not belong to any page of this console.",

  errorTitle: "The control server is not answering",
  errorText:
    "The console could not load its data. The tunnel itself is unaffected: devices that are already connected stay connected.",
  errorRetry: "Try again",

  // ---- shared words ----
  never: "never",
  osUnknown: "Unknown",
  roleName: (role: Role) => ({ owner: "Owner", admin: "Administrator", member: "Member" })[role],
  /** The role inside a sentence: "as {role}". */
  asRole: (role: "admin" | "member"): string => (role === "admin" ? "an administrator" : "a member"),
  devices: (n: number) => (n === 1 ? "1 device" : `${n} devices`),
  people: (n: number) => (n === 1 ? "1 person" : `${n} people`),
  providerDev: "Developer login",
  continueWith: (provider: string) => `Continue with ${provider}`,
  or: "or",
  signIn: "Sign in",
  email: "Email",
  password: "Password",
  name: "Name",
  domain: "Domain",
  apply: "Apply",
  remove: "Remove",

  // ---- dashboard ----
  dashboardTitle: "Your network",
  joined: "You are now in {wave}.",
  noWaveTitle: "No wave yet",
  inviteWaiting:
    "An invitation to {wave}{by} is waiting for you. Open the link you were sent — it is valid until {until}.",
  invitedBy: (name: string) => ` from ${name}`,
  noWaveText:
    "No network has been set up for this account yet. A wave is not created on its own — you choose the domain the device names live under when you create it.",
  createWave: "Create wave",

  // ---- login ----
  loginLead: "Your account is where you manage the devices in your wave.",
  loginInvalid: "Email or password is incorrect.",
  loginThrottled: "Too many attempts. Please try again later.",

  // ---- device approval ----
  chooseOne: (host: string) => `Add ${host}?`,
  chooseMany: (host: string) => `Which wave should ${host} join?`,
  chooseOneText: "It gets an address in the wave and is then visible to every device in it.",
  chooseManyText: "A device belongs to exactly one wave. To be in a second, it signs in there once more.",
  addDevice: "Add device",

  connectedHost: (host: string) => `${host} is connected`,
  connectedDevice: "Device is connected",
  connectedWave: "It now belongs to {wave}{ip}.",
  connectedIp: " and listens on {ip}",
  connectedNoWave: "The device has been added to your wave.",
  connectedClose: "You can close this window — the device connects on its own now.",

  expiredTitle: "Request expired",
  expiredText:
    "The link was only valid for a short while, so that an intercepted link cannot let a stranger's device into the network.",
  expiredRetry: "Start the sign-in on the device again:",
  expiredRetryApp: "In the wave-mesh app on a phone or tablet: tap Log in again.",

  // ---- invitations ----
  goneTitle: "This invitation is no longer valid",
  goneText:
    "It has been used, withdrawn or has expired. An invitation works once, and only for the address it was sent to.",
  goneAsk:
    "Ask someone in the wave for a new one — invitations are created by the owner and the administrators.",

  joinWrongAddress: "This invitation belongs to a different address than the one you are signed in with.",
  joinUnverified:
    "The sign-in provider does not confirm your address. An unconfirmed address cannot accept an invitation.",
  joinGone: "This invitation has been used, withdrawn or has expired.",
  joinTitle: (wave: string) => `Invitation to ${wave}`,
  joinLead: "For {email}, as {role}{by}. Valid until {until}.",
  joinBy: (name: string) => `, from ${name}`,
  signedInAs: "You are signed in as {who}.",
  join: "Join",
  signOutToAccept: (email: string) => `Sign out and sign back in as ${email} to accept the invitation.`,
  hasAccount:
    "There is already an account for this address. Sign in with it — the invitation is accepted along the way.",
  passwordFor: (email: string) => `Password for ${email}`,
  minChars: "At least 12 characters.",
  createAndJoin: "Create account and join",

  invitedTitle: (email: string) => `${email} is invited`,
  invitedCreated: "Invitation created",
  invitedAs: "As {role} in {wave}. ",
  invitedShare: "Pass this link on — no email is sent. It works once, and only for the invited address.",
  invitedNoLink: "The link is missing from the address. Create the invitation again.",
  invitedPending: "Until someone joins, the invitation stays in the people list and can be withdrawn there.",

  // ---- creating a wave ----
  newLead: "A wave is your network: every device in it gets a fixed address and a name under your domain.",
  newInviteWaiting:
    "An invitation to {wave}{by} is waiting for you. Open the link you were sent — you do not need a wave of your own for it.",
  nameHint: "Lowercase letters, digits and hyphens.",
  domainHint:
    "Devices will then be called {pattern}. Keep the suggestion if you have no domain of your own — you can change it later, but that renames every device in the wave.",

  // ---- wave card ----
  rename: "Rename",
  renameHint:
    "Lowercase letters, digits and hyphens; umlauts and spaces are replaced. The devices notice nothing — their names hang off the domain, not the wave's name.",
  changeDomain: "Change domain",
  domainChangeHint:
    "Every device is then called {pattern}. Connected devices pick that up with the next netmap; a certificate is only possible for a domain you own.",
  accessLink: "Access: who reaches whom →",
  devicesTitle: "Devices",
  addPhone: "Add a phone",
  addPhoneCode: "QR code that opens the wave-mesh app with this server",
  addPhoneHint:
    "Scan it with the iPhone camera: the wave-mesh app opens with this server filled in. Approve the device here afterwards, as always.",
  addPhoneManual: "Or type this address into the app:",
  peopleTitle: "People",
  deleteWave: "Delete wave",
  leaveWave: "Leave wave",
  leaveWaveHint:
    "You leave this wave, and your devices in it leave with you. Coming back takes a new invitation.",
  leaveWaveConfirm: "Leave this wave",
  renameDevice: "Rename",
  newDeviceName: "New name",
  renameDeviceHint:
    "Lower case letters, digits and hyphens; anything else becomes a hyphen. A name already taken gets a number. Every device in the wave learns the new name.",
  deleteConfirm: "Type {name} to confirm",
  deleteForGood: "Delete for good",
  deleteHint:
    "Takes {devices} and {people} with it. Every device loses its sign-in and has to be approved again, and {suffix} is free again afterwards. This cannot be undone.",
  connectedCount: (online: number, total: number) =>
    `${online} of ${total} ${total === 1 ? "device" : "devices"} connected`,

  // ---- people ----
  memberSince: (date: string) => `member since ${date}`,
  invitedNotJoined: "invited, not joined yet",
  until: (date: string) => `until ${date}`,
  withdraw: "Withdraw",
  inviteSomeone: "Invite someone",
  role: "Role",
  invite: "Invite",
  inviteHint:
    "The invitation is handed out as a link — no email is sent. Whoever is removed loses their devices in this wave.",

  // ---- devices ----
  ephemeral: "ephemeral",
  notApproved: "not approved",
  services: (n: number) => (n === 1 ? "1 service" : `${n} services`),
  updateChannel: (channel: string) => `Update channel: ${channel}`,
  versionUnknown: "Version unknown",
  online: "connected",
  noDevices: "No device has signed in to this wave yet.",
  removeDeviceHint:
    "A removed device loses access at once — the others drop it from their netmap, and it has to be approved again with {command}.",
  feedOffline:
    "No live connection — the devices are shown as they were when the page loaded. The next attempt is under way.",
} satisfies Messages;

const de: typeof en = {
  metaDescription: "Verwaltung für ein selbst gehostetes Mesh-VPN auf WireGuard-Basis.",
  signOut: "Abmelden",
  language: "Sprache",
  footerTagline: "wave-mesh — selbst gehostetes Mesh-VPN auf WireGuard-Basis.",
  footerSigned: "Netzkarten werden signiert ausgeliefert.",
  toOverview: "Zur Übersicht",

  notFoundTitle: "Seite nicht gefunden",
  notFoundText: "Diese Adresse gehört zu keiner Seite dieser Verwaltung.",

  errorTitle: "Der Control-Server antwortet nicht",
  errorText:
    "Die Oberfläche konnte ihre Daten nicht laden. Der Tunnel selbst ist davon unberührt: Geräte, die bereits verbunden sind, bleiben es.",
  errorRetry: "Erneut versuchen",

  never: "noch nie",
  osUnknown: "Unbekannt",
  roleName: (role) => ({ owner: "Eigentümer", admin: "Administrator", member: "Mitglied" })[role],
  asRole: (role) => (role === "admin" ? "Administrator" : "Mitglied"),
  devices: (n) => (n === 1 ? "1 Gerät" : `${n} Geräte`),
  people: (n) => (n === 1 ? "1 Person" : `${n} Personen`),
  providerDev: "Entwickler-Login",
  continueWith: (provider) => `Weiter mit ${provider}`,
  or: "oder",
  signIn: "Anmelden",
  email: "E-Mail",
  password: "Passwort",
  name: "Name",
  domain: "Domain",
  apply: "Übernehmen",
  remove: "Entfernen",

  dashboardTitle: "Dein Netz",
  joined: "Du bist jetzt in {wave}.",
  noWaveTitle: "Noch kein Wave",
  inviteWaiting:
    "Es wartet eine Einladung in {wave}{by}. Öffne den Link, den du bekommen hast — er gilt bis {until}.",
  invitedBy: (name) => ` von ${name}`,
  noWaveText:
    "Für dieses Konto ist noch kein Netz eingerichtet. Ein Wave entsteht nicht von selbst — die Domain, unter der die Gerätenamen hängen, wählst du beim Anlegen.",
  createWave: "Wave anlegen",

  loginLead: "Mit deinem Konto verwaltest du die Geräte in deinem Wave.",
  loginInvalid: "E-Mail oder Passwort stimmt nicht.",
  loginThrottled: "Zu viele Versuche. Bitte später erneut probieren.",

  chooseOne: (host) => `${host} aufnehmen?`,
  chooseMany: (host) => `In welchen Wave soll ${host}?`,
  chooseOneText: "Es bekommt eine Adresse im Wave und ist danach für jedes Gerät darin sichtbar.",
  chooseManyText:
    "Ein Gerät gehört zu genau einem Wave. Für einen zweiten meldet es sich dort noch einmal an.",
  addDevice: "Gerät hinzufügen",

  connectedHost: (host) => `${host} ist verbunden`,
  connectedDevice: "Gerät ist verbunden",
  connectedWave: "Es gehört jetzt zu {wave}{ip}.",
  connectedIp: " und hört auf {ip}",
  connectedNoWave: "Das Gerät wurde deinem Wave hinzugefügt.",
  connectedClose: "Dieses Fenster kann zu — das Gerät verbindet sich jetzt von selbst.",

  expiredTitle: "Anfrage abgelaufen",
  expiredText: "Der Link war nur kurz gültig, damit ein abgefangener Link kein fremdes Gerät ins Netz lässt.",
  expiredRetry: "Starte die Anmeldung auf dem Gerät noch einmal:",
  expiredRetryApp: "In der wave-mesh-App auf Telefon oder Tablet: noch einmal auf Anmelden tippen.",

  goneTitle: "Diese Einladung gilt nicht mehr",
  goneText:
    "Sie wurde schon benutzt, zurückgezogen oder ist abgelaufen. Eine Einladung gilt einmal und nur für die Adresse, an die sie ging.",
  goneAsk:
    "Bitte jemanden aus dem Wave um eine neue — Einladungen erstellen der Eigentümer und die Administratoren.",

  joinWrongAddress: "Diese Einladung gehört zu einer anderen Adresse als der, mit der du angemeldet bist.",
  joinUnverified:
    "Der Anmeldedienst bestätigt deine Adresse nicht. Eine unbestätigte Adresse kann keine Einladung annehmen.",
  joinGone: "Diese Einladung wurde schon benutzt, zurückgezogen oder ist abgelaufen.",
  joinTitle: (wave) => `Einladung in ${wave}`,
  joinLead: "Für {email}, als {role}{by}. Gültig bis {until}.",
  joinBy: (name) => `, von ${name}`,
  signedInAs: "Du bist als {who} angemeldet.",
  join: "Beitreten",
  signOutToAccept: (email) => `Melde dich ab und mit ${email} wieder an, um die Einladung anzunehmen.`,
  hasAccount:
    "Für diese Adresse gibt es schon ein Konto. Melde dich damit an — die Einladung wird dabei angenommen.",
  passwordFor: (email) => `Passwort für ${email}`,
  minChars: "Mindestens 12 Zeichen.",
  createAndJoin: "Konto anlegen und beitreten",

  invitedTitle: (email) => `${email} ist eingeladen`,
  invitedCreated: "Einladung erstellt",
  invitedAs: "Als {role} in {wave}. ",
  invitedShare:
    "Schicke diesen Link weiter — es wird keine E-Mail verschickt. Er gilt einmal und nur für die eingeladene Adresse.",
  invitedNoLink: "Der Link fehlt in der Adresse. Lege die Einladung noch einmal an.",
  invitedPending:
    "Solange niemand beigetreten ist, steht die Einladung in der Personenliste und kann dort zurückgezogen werden.",

  newLead:
    "Ein Wave ist dein Netz: jedes Gerät darin bekommt eine feste Adresse und einen Namen unter deiner Domain.",
  newInviteWaiting:
    "Es wartet eine Einladung in {wave}{by}. Öffne den Link, den du bekommen hast — ein eigener Wave ist dafür nicht nötig.",
  nameHint: "Kleinbuchstaben, Ziffern und Bindestriche.",
  domainHint:
    "Geräte heißen dann {pattern}. Behalte den Vorschlag, wenn du keine eigene Domain hast — ändern kannst du ihn später, das benennt allerdings jedes Gerät im Wave um.",

  rename: "Namen ändern",
  renameHint:
    "Kleinbuchstaben, Ziffern und Bindestriche; Umlaute und Leerzeichen werden ersetzt. Die Geräte merken davon nichts — ihre Namen hängen an der Domain, nicht am Wave-Namen.",
  changeDomain: "Domain ändern",
  domainChangeHint:
    "Danach heißt jedes Gerät {pattern}. Verbundene Geräte übernehmen das mit der nächsten Netzkarte; ein Zertifikat gibt es nur für eine Domain, die dir gehört.",
  accessLink: "Zugriff: wer wen erreicht →",
  devicesTitle: "Geräte",
  addPhone: "Telefon hinzufügen",
  addPhoneCode: "QR-Code, der die wave-mesh-App mit diesem Server öffnet",
  addPhoneHint:
    "Mit der iPhone-Kamera scannen: Die wave-mesh-App öffnet sich mit diesem Server. Danach das Gerät wie gewohnt hier freigeben.",
  addPhoneManual: "Oder diese Adresse in der App eingeben:",
  peopleTitle: "Personen",
  deleteWave: "Wave löschen",
  leaveWave: "Wave verlassen",
  leaveWaveHint:
    "Du verlässt diesen Wave, und deine Geräte darin gehen mit. Zurück geht es nur mit einer neuen Einladung.",
  leaveWaveConfirm: "Diesen Wave verlassen",
  renameDevice: "Umbenennen",
  newDeviceName: "Neuer Name",
  renameDeviceHint:
    "Kleinbuchstaben, Ziffern und Bindestriche; alles andere wird zum Bindestrich. Ein vergebener Name bekommt eine Nummer. Alle Geräte im Wave lernen den neuen Namen.",
  deleteConfirm: "Zum Bestätigen {name} eintippen",
  deleteForGood: "Endgültig löschen",
  deleteHint:
    "Nimmt {devices} und {people} mit. Jedes Gerät verliert seine Anmeldung und muss neu freigegeben werden, und {suffix} ist danach wieder frei. Rückgängig geht das nicht.",
  connectedCount: (online, total) => `${online} von ${total} ${total === 1 ? "Gerät" : "Geräten"} verbunden`,

  memberSince: (date) => `dabei seit ${date}`,
  invitedNotJoined: "eingeladen, noch nicht beigetreten",
  until: (date) => `bis ${date}`,
  withdraw: "Zurückziehen",
  inviteSomeone: "Jemanden einladen",
  role: "Rolle",
  invite: "Einladen",
  inviteHint:
    "Die Einladung wird als Link ausgegeben — es wird keine E-Mail verschickt. Wer entfernt wird, verliert seine Geräte in diesem Wave.",

  ephemeral: "flüchtig",
  notApproved: "nicht freigegeben",
  services: (n) => (n === 1 ? "1 Dienst" : `${n} Dienste`),
  updateChannel: (channel) => `Update-Kanal: ${channel}`,
  versionUnknown: "Version unbekannt",
  online: "verbunden",
  noDevices: "In diesem Wave ist noch kein Gerät angemeldet.",
  removeDeviceHint:
    "Ein entferntes Gerät verliert den Zugang sofort — für die anderen ist es aus der Netzkarte, und es selbst muss mit {command} neu freigegeben werden.",
  feedOffline:
    "Keine Live-Verbindung — die Geräte stehen so da, wie sie beim Laden der Seite waren. Der nächste Versuch läuft.",
};

export type AppMessages = typeof en;

export const appMessages = (locale: Locale): AppMessages => messagesFor({ en, de }, locale);

/**
 * A sign-in provider as the buttons name it. Brands keep their own name; an
 * OIDC provider is called what its operator called it ("Pocket ID"), and the
 * development login is the one name that is ours to translate.
 */
export const providerName = (provider: { id: string; label: string | null }, t: AppMessages): string =>
  provider.id === "dev"
    ? t.providerDev
    : provider.id === "google"
      ? "Google"
      : (provider.label ?? provider.id);
