import type { Locale, Messages } from "@wave/i18n";

/**
 * Everything this server says to a person in a browser: its own plain pages,
 * the error pages the web app's forms land on, and the errors of the JSON
 * routes those pages show.
 *
 * A key ending in `Html` returns markup and escapes its own parameters, so a
 * caller hands it raw values and wraps the result in `raw()`. Every other
 * message is plain text, interpolated into a template that escapes it.
 *
 * English is the shape and the fallback; a request that names no language
 * gets exactly what this server always said.
 */
const e = (value: string): string => Bun.escapeHTML(value);

const en = {
  // --- signing in -----------------------------------------------------------
  signInWithPassword: "Sign in with email and password",
  signInWith: (provider: string) => `Login with ${provider}`,
  signedInAs: (who: string) => `Signed in as ${who}`,
  noWaveYetHtml: 'No wave yet. <a href="/waves/new">Create one</a>.',
  logOut: "Log out",
  devLogin: "Dev login",
  signIn: "Sign in",
  email: "Email",
  password: "Password",
  tooManyAttempts: "Too many attempts. Try again later.",
  wrongCredentials: "Wrong email or password.",

  // --- approving a device ---------------------------------------------------
  requestExpired: "Device request expired",
  runUpAgainHtml: "Run <code>wave up</code> again.",
  connected: (host: string) => `${host} is connected`,
  joinedAsHtml: (wave: string, ipv4: string) =>
    `It joined <strong>${e(wave)}</strong> as <code>${e(ipv4)}</code>.`,
  closeTab: "You can close this tab — the command line has taken over.",
  willJoinHtml: (wave: string) =>
    `It will get an address in <strong>${e(wave)}</strong> and appear to every device in it.`,
  addToWave: (host: string) => `Add ${host} to your wave?`,
  whichWave: (host: string) => `Which wave should ${host} join?`,
  addDevice: "Add device",

  // --- making a wave --------------------------------------------------------
  createYourWave: "Create your wave",
  invitationWaitingHtml: (wave: string) =>
    `An invitation into <strong>${e(wave)}</strong> is waiting for you. Opening that link
              puts your devices in there — make a wave of your own only if you want a second network.`,
  name: "Name",
  domain: "Domain",
  devicesCalledHtml: (suffix: string) => `Devices will be called <code>&lt;host&gt;.${e(suffix)}</code>.`,
  keepSuggestion: `Keep the suggestion if you have no domain of your own. A public certificate needs one you
            own — you can change this later, which renames every device in the wave.`,
  createWave: "Create wave",
  invalidInput: (kind: "domain" | "wave-name", input: string) =>
    kind === "domain" ? `not a domain name: ${input}` : `not a wave name: ${input}`,
  invalid: "Invalid.",

  // --- error pages ----------------------------------------------------------
  notWorkingAsName: "That will not work as a name",
  notAWaveName: "That is not a wave name",
  notADomain: "That is not a domain",
  domainTaken: "That domain is taken",
  domainTakenBody: (suffix: string) => `Another wave already answers for ${suffix}.`,
  unknownWave: "Unknown wave",
  nothingToChange: "Nothing to change.",
  nothingToRemove: "Nothing to remove.",
  nothingToDelete: "Nothing to delete.",
  notAnEmail: "That is not an email address",
  cannotInvite: (email: string) => `Cannot invite ${email || "an empty address"}.`,
  notAMember: "Not a member",
  ownerStays: "The owner stays",
  ownerStaysBody: "A wave without its owner could not be administered. Hand ownership over first.",
  notAllowed: "Not allowed",
  onlyOwnerRemovesAdmins: "Only the owner can remove another administrator.",
  onlyOwnerDeletes: "Only the wave's owner can delete it.",
  noSuchDevice: "No such device",
  notInThisWave: "It is not in this wave.",
  notItsName: "That is not its name",
  typeToConfirm: (name: string) => `Type ${name} to confirm. Nothing was deleted.`,

  // --- invitations ----------------------------------------------------------
  invited: (email: string, wave: string) => `${email} is invited to ${wave}`,
  sendLink: (until: string) => `Send them this link. It works once and expires ${until}.`,
  back: "Back",
  invitationGone: "This invitation is gone",
  invitationGoneBody: "It was used, withdrawn or has expired.",
  join: (wave: string) => `Join ${wave}`,
  invitedAsHtml: (email: string) =>
    `You were invited as <code>${e(email)}</code>. Sign in with that address to accept.`,
  passwordTooShort: "Password too short",
  useAtLeast: (n: number) => `Use at least ${n} characters.`,
  accountExists: "There is already an account",
  signInAsAndReopen: (email: string) => `Sign in as ${email} and open the link again.`,
  youAreIn: (wave: string) => `You are in ${wave}`,
  bringDeviceHtml: (url: string) => `Run <code>wave login ${e(url)}</code> to bring a device into it.`,
  otherAddress: "This invitation is for another address",
  otherAddressBody: "Sign out and sign in with the address it was sent to.",
  unverifiedAddress: "Your address is not verified",
  unverifiedAddressBody:
    "The provider you signed in with does not vouch for it, so it cannot claim an invitation.",

  // --- JSON errors the web pages show ----------------------------------------
  apiUnauthenticated: "unauthenticated",
  apiUnknownWave: "unknown wave",
  apiNotAllowed: "not allowed",
  apiExpectedJson: "expected application/json",
  apiNotJson: "not JSON",
  apiNoPolicy: "no policy",
  apiExpectedTags: "expected { tags: [...] }",
  apiNoSuchDevice: "no such device",
} satisfies Messages;

const de: typeof en = {
  signInWithPassword: "Mit E-Mail und Passwort anmelden",
  signInWith: (provider) => `Mit ${provider} anmelden`,
  signedInAs: (who) => `Angemeldet als ${who}`,
  noWaveYetHtml: 'Noch kein Wave. <a href="/waves/new">Leg einen an</a>.',
  logOut: "Abmelden",
  devLogin: "Dev-Anmeldung",
  signIn: "Anmelden",
  email: "E-Mail",
  password: "Passwort",
  tooManyAttempts: "Zu viele Versuche. Versuch es später noch einmal.",
  wrongCredentials: "E-Mail oder Passwort ist falsch.",

  requestExpired: "Geräteanfrage abgelaufen",
  runUpAgainHtml: "Führe <code>wave up</code> noch einmal aus.",
  connected: (host) => `${host} ist verbunden`,
  joinedAsHtml: (wave, ipv4) => `Es ist jetzt in <strong>${e(wave)}</strong>, unter <code>${e(ipv4)}</code>.`,
  closeTab: "Du kannst diesen Tab schließen — die Kommandozeile hat übernommen.",
  willJoinHtml: (wave) =>
    `Es bekommt eine Adresse in <strong>${e(wave)}</strong> und ist für jedes Gerät darin sichtbar.`,
  addToWave: (host) => `${host} zu deinem Wave hinzufügen?`,
  whichWave: (host) => `Welchem Wave soll ${host} beitreten?`,
  addDevice: "Gerät hinzufügen",

  createYourWave: "Leg deinen Wave an",
  invitationWaitingHtml: (wave) =>
    `Eine Einladung in <strong>${e(wave)}</strong> wartet auf dich. Öffnest du den Link, kommen
              deine Geräte dorthin — leg nur dann einen eigenen Wave an, wenn du ein zweites Netz willst.`,
  name: "Name",
  domain: "Domain",
  devicesCalledHtml: (suffix) => `Geräte heißen dann <code>&lt;host&gt;.${e(suffix)}</code>.`,
  keepSuggestion: `Behalte den Vorschlag, wenn du keine eigene Domain hast. Ein öffentliches Zertifikat braucht
            eine, die dir gehört — ändern kannst du das später, dabei wird jedes Gerät im Wave umbenannt.`,
  createWave: "Wave anlegen",
  invalidInput: (kind, input) =>
    kind === "domain" ? `kein gültiger Domainname: ${input}` : `kein gültiger Wave-Name: ${input}`,
  invalid: "Ungültig.",

  notWorkingAsName: "Das geht als Name nicht",
  notAWaveName: "Das ist kein Wave-Name",
  notADomain: "Das ist keine Domain",
  domainTaken: "Diese Domain ist vergeben",
  domainTakenBody: (suffix) => `Ein anderer Wave antwortet schon für ${suffix}.`,
  unknownWave: "Unbekannter Wave",
  nothingToChange: "Es gibt nichts zu ändern.",
  nothingToRemove: "Es gibt nichts zu entfernen.",
  nothingToDelete: "Es gibt nichts zu löschen.",
  notAnEmail: "Das ist keine E-Mail-Adresse",
  cannotInvite: (email) =>
    email ? `${email} lässt sich nicht einladen.` : "Eine leere Adresse lässt sich nicht einladen.",
  notAMember: "Kein Mitglied",
  ownerStays: "Der Eigentümer bleibt",
  ownerStaysBody:
    "Ein Wave ohne seinen Eigentümer ließe sich nicht verwalten. Übergib zuerst die Eigentümerschaft.",
  notAllowed: "Nicht erlaubt",
  onlyOwnerRemovesAdmins: "Nur der Eigentümer kann einen anderen Admin entfernen.",
  onlyOwnerDeletes: "Nur der Eigentümer des Waves kann ihn löschen.",
  noSuchDevice: "Gerät nicht gefunden",
  notInThisWave: "Es ist nicht in diesem Wave.",
  notItsName: "Das ist nicht sein Name",
  typeToConfirm: (name) => `Tippe ${name} zur Bestätigung. Es wurde nichts gelöscht.`,

  invited: (email, wave) => `${email} ist in ${wave} eingeladen`,
  sendLink: (until) => `Schick diesen Link weiter. Er funktioniert einmal und gilt bis ${until}.`,
  back: "Zurück",
  invitationGone: "Diese Einladung gibt es nicht mehr",
  invitationGoneBody: "Sie wurde schon benutzt, zurückgezogen oder ist abgelaufen.",
  join: (wave) => `${wave} beitreten`,
  invitedAsHtml: (email) =>
    `Du wurdest als <code>${e(email)}</code> eingeladen. Melde dich mit dieser Adresse an, um anzunehmen.`,
  passwordTooShort: "Passwort zu kurz",
  useAtLeast: (n) => `Nimm mindestens ${n} Zeichen.`,
  accountExists: "Es gibt schon ein Konto",
  signInAsAndReopen: (email) => `Melde dich als ${email} an und öffne den Link noch einmal.`,
  youAreIn: (wave) => `Du bist jetzt in ${wave}`,
  bringDeviceHtml: (url) => `Führe <code>wave login ${e(url)}</code> aus, um ein Gerät hineinzubringen.`,
  otherAddress: "Diese Einladung gilt einer anderen Adresse",
  otherAddressBody: "Melde dich ab und mit der Adresse an, an die sie ging.",
  unverifiedAddress: "Deine Adresse ist nicht bestätigt",
  unverifiedAddressBody:
    "Der Anmeldedienst, mit dem du dich angemeldet hast, bestätigt sie nicht — deshalb kann sie keine Einladung annehmen.",

  apiUnauthenticated: "nicht angemeldet",
  apiUnknownWave: "unbekannter Wave",
  apiNotAllowed: "nicht erlaubt",
  apiExpectedJson: "application/json erwartet",
  apiNotJson: "kein JSON",
  apiNoPolicy: "keine Policy",
  apiExpectedTags: "{ tags: [...] } erwartet",
  apiNoSuchDevice: "Gerät nicht gefunden",
};

export type PageMessages = typeof en;

export const pageMessages = (locale: Locale = "en"): PageMessages => (locale === "de" ? de : en);
