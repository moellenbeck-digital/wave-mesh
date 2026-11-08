import type { Locale } from "@wave/i18n";

/**
 * The guided link of an account a provider login split off: the notice on the
 * overview and the account page, and the three steps. The control server
 * answers with codes (`wrong-password`, `no-target`, ...) in the query string,
 * and this is where they turn into sentences.
 *
 * Every consequence is named with its numbers and names before the person
 * confirms; none of it happens silently.
 */
type Role = "owner" | "admin" | "member";
type Billing = "active" | "suspended" | "ended" | null;

const en = {
  linkTitle: "Join your accounts",
  linkBack: "← Your account",
  // ---- the notice ----
  noticeTitle: "You are signed in to a separate account",
  noticeActive: (who: string) => `Active account: ${who}`,
  noticeVia: (list: string) => `Signed in through ${list}.`,
  noticeWhy:
    "When this account was made, the sign-in service did not confirm your email address. wave-mesh therefore did not join it to an account that already uses the same address, and the waves of that other account do not show here. That is why a wave you expect can be missing.",
  noticeHow:
    "Once the address is confirmed at the sign-in service, you can join this account with the other one in three steps. Nothing is joined without your say.",
  noticeAction: "Join the accounts",
  // ---- the page ----
  activeTitle: "Active account",
  activeText: (who: string) => `You are signed in as ${who}.`,
  steps: ["Confirm the address", "Show control of the other account", "Review and confirm"] as string[],
  stepOf: (n: number) => `Step ${n} of 3`,
  expires: (when: string) => `This request expires ${when}.`,
  cancel: "Cancel",
  // step 1
  startTitle: "Confirm your address with the sign-in service",
  startText: (provider: string) =>
    `You are sent to ${provider} and asked to sign in again. It has to state that your address is confirmed: only then can the other account be found. Nothing changes yet.`,
  startButton: (provider: string) => `Continue with ${provider}`,
  noProvider:
    "This account has no sign-in through a provider, so there is nothing to confirm the address with.",
  notNeeded: "The address of this account is confirmed, so there is nothing to join.",
  addressWaiting: "The sign-in at the provider has not finished. Start it again.",
  // step 2
  controlTitle: (address: string) => `Show that you control the account of ${address}`,
  controlText:
    "Another account already uses this address, and it is confirmed. Sign in to that account once more, with one of its own ways in. This does not sign you in there: you stay in this account until the last step.",
  passwordLabel: "Password of the other account",
  passwordButton: "Check password",
  codeIntro: "The password is right. That account has a second factor, so one more proof is needed.",
  codeLabel: "Code from the authenticator app, or a recovery code",
  codeButton: "Check code",
  providerButton: (provider: string) => `Check with ${provider}`,
  noWay:
    "The other account has no way in that can be offered here: no password and no other provider. Nothing can be joined, and nothing was changed.",
  // step 3
  confirmTitle: (into: string) => `Review, then join into ${into}`,
  confirmText:
    "This is exactly what happens when you confirm. Until then nothing has changed, and you can cancel.",
  confirmButton: "Join the accounts",
  sumIdentitiesTitle: "Sign-ins",
  sumIdentities: (list: string, into: string) =>
    `${list} move to ${into}. From then on this sign-in leads to ${into} and its waves.`,
  sumOwnedTitle: "Waves this account owns",
  sumOwnedNone: "This account owns no wave.",
  sumOwned: (wave: string, into: string, billing: Billing, member: boolean) =>
    `${wave} goes to ${into}.${member ? ` ${into} is a member of it already and becomes its owner.` : ""}${billing ? ` Billing and subscription stay on the wave (${billingName(billing, "en")}).` : ""}`,
  sumMemberTitle: "Memberships",
  sumMemberNone: "No memberships besides those of owned waves.",
  sumMember: (wave: string, role: Role, into: string, target: Role | null) =>
    target
      ? `${wave}: you are ${roleName(role, "en")} there. ${into} is in it already as ${roleName(target, "en")} and keeps that role; this membership ends.`
      : `${wave}: your membership as ${roleName(role, "en")} moves to ${into}.`,
  sumDevicesTitle: "Devices",
  sumDevicesNone: "This account has no devices.",
  sumDevices: (n: number, into: string) =>
    `${n === 1 ? "1 device moves" : `${n} devices move`} to ${into} and stays connected. Hostnames and addresses do not change.`,
  sumSessionsTitle: "Sessions",
  sumSessions: (n: number, from: string, into: string) =>
    `${n === 1 ? "The 1 session" : `All ${n} sessions`} of ${from} end. Afterwards you are signed in as ${into}.`,
  sumPassword: (from: string) => `${from} has a password. It ends with this account.`,
  // ---- done ----
  doneTitle: "The accounts are joined",
  doneText: (waves: number, devices: number) =>
    `You are signed in to the account that held the address. ${waves === 1 ? "1 wave" : `${waves} waves`} and ${devices === 1 ? "1 device" : `${devices} devices`} came over.`,
  doneOverview: "To the overview",
  errors: {
    expired: "This request is over: it was cancelled or took too long. Nothing was changed. Start again.",
    changed: "Something the request was bound to changed meanwhile. Nothing was changed. Start again.",
    unverified: "The sign-in service does not confirm this address. Nothing was changed.",
    "foreign-identity": "That sign-in is not the one of this account. Nothing was changed.",
    stale:
      "The sign-in service answered from an old session instead of asking you to sign in. Try again and sign in when asked.",
    "no-target":
      "No other account holds this address as a confirmed one, so there is nothing to join. Nothing was changed.",
    ambiguous:
      "More than one account holds this address, so it cannot be told which one is meant. Ask the operator. Nothing was changed.",
    "wrong-password": "That password did not work.",
    "wrong-code": "That code did not work.",
    throttled: "Too many wrong attempts. Wait a quarter of an hour and try again.",
    "password-needed": "That took too long or went wrong too often. Enter the password again.",
    "not-target": "That sign-in is not one of the other account's. Nothing was changed.",
    "no-provider": "That sign-in is not one of this account's.",
    "provider-unavailable": "The sign-in service is not available right now. Try again later.",
    "no-way": "The other account has not been shown to be yours yet.",
    unknown: "That did not work. Nothing was changed.",
  } as Record<string, string>,
};

const de: typeof en = {
  linkTitle: "Konten verknüpfen",
  linkBack: "← Dein Konto",
  noticeTitle: "Du bist an einem getrennten Konto angemeldet",
  noticeActive: (who) => `Aktives Konto: ${who}`,
  noticeVia: (list) => `Angemeldet über ${list}.`,
  noticeWhy:
    "Als dieses Konto angelegt wurde, hat der Anmeldedienst deine E-Mail-Adresse nicht bestätigt. wave-mesh hat es deshalb nicht mit einem Konto verbunden, das dieselbe Adresse schon nutzt, und die Waves jenes Kontos siehst du hier nicht. Darum kann ein Wave fehlen, den du erwartest.",
  noticeHow:
    "Ist die Adresse beim Anbieter bestätigt, kannst du dieses Konto in drei Schritten mit dem anderen zusammenführen. Ohne dein Zutun wird nichts verbunden.",
  noticeAction: "Konten verknüpfen",
  activeTitle: "Aktives Konto",
  activeText: (who) => `Du bist als ${who} angemeldet.`,
  steps: ["Adresse bestätigen", "Kontrolle über das andere Konto nachweisen", "Prüfen und bestätigen"],
  stepOf: (n) => `Schritt ${n} von 3`,
  expires: (when) => `Diese Anfrage läuft ${when} ab.`,
  cancel: "Abbrechen",
  startTitle: "Adresse beim Anmeldedienst bestätigen",
  startText: (provider) =>
    `Du wirst zu ${provider} geschickt und musst dich dort noch einmal anmelden. Der Dienst muss angeben, dass deine Adresse bestätigt ist: Nur dann lässt sich das andere Konto finden. Noch ändert sich nichts.`,
  startButton: (provider) => `Weiter mit ${provider}`,
  noProvider:
    "Dieses Konto hat keine Anmeldung über einen Anbieter, also gibt es nichts, womit sich die Adresse bestätigen ließe.",
  notNeeded: "Die Adresse dieses Kontos ist bestätigt, also gibt es nichts zu verknüpfen.",
  addressWaiting: "Die Anmeldung beim Anbieter ist nicht abgeschlossen. Starte sie noch einmal.",
  controlTitle: (address) => `Nachweisen, dass du das Konto von ${address} kontrollierst`,
  controlText:
    "Ein anderes Konto nutzt diese Adresse schon, und sie ist dort bestätigt. Melde dich noch einmal an jenem Konto an, mit einem seiner eigenen Anmeldewege. Das meldet dich dort nicht an: Du bleibst in diesem Konto, bis zum letzten Schritt.",
  passwordLabel: "Passwort des anderen Kontos",
  passwordButton: "Passwort prüfen",
  codeIntro:
    "Das Passwort stimmt. Jenes Konto hat einen zweiten Faktor, also braucht es noch einen Nachweis.",
  codeLabel: "Code aus der Authenticator-App oder ein Wiederherstellungscode",
  codeButton: "Code prüfen",
  providerButton: (provider) => `Mit ${provider} prüfen`,
  noWay:
    "Das andere Konto hat keinen Anmeldeweg, den diese Seite anbieten kann: kein Passwort und keinen anderen Anbieter. Es lässt sich nichts verknüpfen, und es wurde nichts geändert.",
  confirmTitle: (into) => `Prüfen, dann mit ${into} zusammenführen`,
  confirmText:
    "Genau das passiert, wenn du bestätigst. Bis dahin hat sich nichts geändert, und du kannst abbrechen.",
  confirmButton: "Konten zusammenführen",
  sumIdentitiesTitle: "Anmeldungen",
  sumIdentities: (list, into) =>
    `${list} wechseln zu ${into}. Danach führt diese Anmeldung zu ${into} und seinen Waves.`,
  sumOwnedTitle: "Waves, die diesem Konto gehören",
  sumOwnedNone: "Diesem Konto gehört kein Wave.",
  sumOwned: (wave, into, billing, member) =>
    `${wave} geht an ${into}.${member ? ` ${into} ist dort schon Mitglied und wird Eigentümer.` : ""}${billing ? ` Abrechnung und Abo bleiben am Wave (${billingName(billing, "de")}).` : ""}`,
  sumMemberTitle: "Mitgliedschaften",
  sumMemberNone: "Keine Mitgliedschaften außer denen in eigenen Waves.",
  sumMember: (wave, role, into, target) =>
    target
      ? `${wave}: Du bist dort ${roleName(role, "de")}. ${into} ist dort schon ${roleName(target, "de")} und behält diese Rolle; diese Mitgliedschaft entfällt.`
      : `${wave}: Deine Mitgliedschaft als ${roleName(role, "de")} wechselt zu ${into}.`,
  sumDevicesTitle: "Geräte",
  sumDevicesNone: "Dieses Konto hat keine Geräte.",
  sumDevices: (n, into) =>
    `${n === 1 ? "1 Gerät wechselt" : `${n} Geräte wechseln`} zu ${into} und ${n === 1 ? "bleibt" : "bleiben"} verbunden. Hostnamen und Adressen ändern sich nicht.`,
  sumSessionsTitle: "Sitzungen",
  sumSessions: (n, from, into) =>
    `${n === 1 ? "Die 1 Sitzung" : `Alle ${n} Sitzungen`} von ${from} ${n === 1 ? "endet" : "enden"}. Danach bist du als ${into} angemeldet.`,
  sumPassword: (from) => `${from} hat ein Passwort. Es endet mit diesem Konto.`,
  doneTitle: "Die Konten sind zusammengeführt",
  doneText: (waves, devices) =>
    `Du bist an dem Konto angemeldet, das die Adresse hielt. ${waves === 1 ? "1 Wave" : `${waves} Waves`} und ${devices === 1 ? "1 Gerät" : `${devices} Geräte`} sind dazugekommen.`,
  doneOverview: "Zur Übersicht",
  errors: {
    expired:
      "Diese Anfrage ist vorbei: abgebrochen oder zu lange her. Es wurde nichts geändert. Fang noch einmal an.",
    changed:
      "Etwas, woran die Anfrage gebunden war, hat sich inzwischen geändert. Es wurde nichts geändert. Fang noch einmal an.",
    unverified: "Der Anmeldedienst bestätigt diese Adresse nicht. Es wurde nichts geändert.",
    "foreign-identity": "Diese Anmeldung gehört nicht zu diesem Konto. Es wurde nichts geändert.",
    stale:
      "Der Anmeldedienst hat aus einer alten Sitzung geantwortet, statt dich anmelden zu lassen. Versuch es noch einmal und melde dich an, wenn er danach fragt.",
    "no-target":
      "Kein anderes Konto hält diese Adresse als bestätigte, also gibt es nichts zu verknüpfen. Es wurde nichts geändert.",
    ambiguous:
      "Mehr als ein Konto hält diese Adresse, es lässt sich also nicht sagen, welches gemeint ist. Frag den Betreiber. Es wurde nichts geändert.",
    "wrong-password": "Dieses Passwort hat nicht funktioniert.",
    "wrong-code": "Dieser Code hat nicht funktioniert.",
    throttled: "Zu viele falsche Versuche. Warte eine Viertelstunde und versuch es dann noch einmal.",
    "password-needed": "Das hat zu lange gedauert oder ging zu oft schief. Gib das Passwort noch einmal ein.",
    "not-target": "Diese Anmeldung gehört nicht zum anderen Konto. Es wurde nichts geändert.",
    "no-provider": "Diese Anmeldung gehört nicht zu diesem Konto.",
    "provider-unavailable": "Der Anmeldedienst ist gerade nicht erreichbar. Versuch es später noch einmal.",
    "no-way": "Das andere Konto wurde noch nicht als deins nachgewiesen.",
    unknown: "Das hat nicht geklappt. Es wurde nichts geändert.",
  },
};

function roleName(role: Role, locale: Locale): string {
  if (locale === "de") return role === "owner" ? "Eigentümer" : role === "admin" ? "Admin" : "Mitglied";
  return role === "owner" ? "owner" : role === "admin" ? "administrator" : "member";
}

function billingName(state: Exclude<Billing, null>, locale: Locale): string {
  if (locale === "de") return state === "active" ? "aktiv" : state === "suspended" ? "pausiert" : "beendet";
  return state === "active" ? "active" : state === "suspended" ? "paused" : "ended";
}

export type LinkMessages = typeof en;

const catalogs: Record<Locale, LinkMessages> = { en, de };

export const linkMessages = (locale: Locale): LinkMessages => catalogs[locale];

/** The name a sign-in goes by in a sentence: the operator's label, else the raw provider id. */
export const identityName = (identity: { provider: string; label: string | null }): string =>
  identity.label ?? (identity.provider.startsWith("oidc:") ? "OIDC" : identity.provider);
