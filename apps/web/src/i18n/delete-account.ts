import type { Locale } from "@wave/i18n";
import type { DeleteFailure } from "@/lib/delete-account";

/**
 * The page "delete account" (`/account/delete`) and the link to it on
 * `/account`. The control server answers with codes (`confirmation-mismatch`,
 * `last-admin`, ...); `failureText` is where they turn into sentences.
 *
 * Every consequence is named before the person confirms, the waves by name.
 */
const en = {
  // ---- the link on /account ----
  entryTitle: "Delete account",
  entryIntro:
    "Removes your account and your data for good: your sign-ins, your devices and your place in every wave. You see what that means before you confirm.",
  entryLink: "Delete account…",
  // ---- the page ----
  title: "Delete your account",
  back: "← Your account",
  intro: (who: string) =>
    `You are signed in as ${who}. Deleting the account removes your sign-ins, your devices and your memberships, and it cannot be undone.`,
  previewTitle: "What happens",
  deletedTitle: "Deleted with your account",
  deletedHint: "You are the only member of these waves. They go, with their devices.",
  handoverTitle: "Stay, with a new owner",
  handoverHint: "Another administrator takes over these waves.",
  leftTitle: "You leave",
  leftHint: "These waves stay as they are, without you.",
  devices: (n: number) => (n === 1 ? "1 device of yours is removed." : `${n} devices of yours are removed.`),
  nothingElse: "You are not in any wave.",
  // ---- billing ----
  billedTitle: "Your subscription is not cancelled",
  billedBody:
    "Deleting the account does not cancel a subscription. It keeps running, and you keep being charged, until you cancel it in the customer portal. Your account is deleted either way, so do it before or right after.",
  billedWaves: "Waves with a subscription:",
  billedAccount: "Your account has a subscription of its own, which covers all your waves.",
  outcome: {
    delete: "deleted",
    handover: "stays, new owner",
    leave: "stays",
  } as Record<string, string>,
  // ---- blocked ----
  blockedTitle: "You cannot delete your account yet",
  blockedBody: (names: string) =>
    `You are the last administrator of ${names}, and other people are in it. Hand it over first (make another member an administrator) or delete the wave, then come back.`,
  blockedLocked: "The form is locked until then.",
  // ---- the form ----
  confirmTitle: "Confirm",
  confirmEmail: "Type your email address to confirm",
  confirmWord: (word: string) => `Type ${word} to confirm`,
  codeLabel: "Code from your app, or a recovery code",
  codeHint: "Your account has a second factor. Each code works once.",
  submit: "Delete my account for good",
  busy: "Deleting…",
  // ---- after ----
  doneTitle: "Account deleted",
  doneBody:
    "Your account and its data are deleted, and you are signed out. You cannot sign in with it again.",
  doneHome: "Back to the start page",
  // ---- failures ----
  failures: {
    emailMismatch: "That is not the address of this account. Check it and try again.",
    wordMismatch: "That is not the word shown. Type it exactly as it is written.",
    invalidCode: "That code did not work. Check that your phone's clock is right.",
    codeRequired: "Enter a code from your app, or a recovery code.",
    throttled: "Too many wrong codes. Wait a quarter of an hour and try again.",
    lastAdmin: (names: string) =>
      names
        ? `You are the last administrator of ${names}, and others are in it. Hand it over or delete it first.`
        : "You are the last administrator of a wave with other people in it. Hand it over or delete it first.",
    unauthenticated: "You are no longer signed in. Sign in again to delete the account.",
    unknown: "That did not work. Reload the page and try again.",
  },
};

const de: typeof en = {
  entryTitle: "Konto löschen",
  entryIntro:
    "Entfernt dein Konto und deine Daten endgültig: deine Anmeldungen, deine Geräte und deinen Platz in jedem Wave. Was das bedeutet, siehst du vor der Bestätigung.",
  entryLink: "Konto löschen …",
  title: "Konto löschen",
  back: "← Dein Konto",
  intro: (who: string) =>
    `Du bist als ${who} angemeldet. Das Löschen entfernt deine Anmeldungen, deine Geräte und deine Mitgliedschaften und lässt sich nicht rückgängig machen.`,
  previewTitle: "Was passiert",
  deletedTitle: "Wird mit deinem Konto gelöscht",
  deletedHint: "Du bist das einzige Mitglied dieser Waves. Sie gehen samt ihren Geräten.",
  handoverTitle: "Bleibt, mit neuem Eigentümer",
  handoverHint: "Ein anderer Administrator übernimmt diese Waves.",
  leftTitle: "Du verlässt",
  leftHint: "Diese Waves bleiben, wie sie sind, nur ohne dich.",
  devices: (n: number) =>
    n === 1 ? "1 Gerät von dir wird entfernt." : `${n} Geräte von dir werden entfernt.`,
  nothingElse: "Du bist in keinem Wave.",
  billedTitle: "Dein Abo wird nicht gekündigt",
  billedBody:
    "Das Löschen des Kontos kündigt kein Abo. Es läuft weiter und wird weiter abgebucht, bis du es im Kundenportal kündigst. Dein Konto wird in jedem Fall gelöscht, kündige also davor oder gleich danach.",
  billedWaves: "Waves mit Abo:",
  billedAccount: "Dein Konto hat ein eigenes Abo, das alle deine Waves abdeckt.",
  outcome: {
    delete: "wird gelöscht",
    handover: "bleibt, neuer Eigentümer",
    leave: "bleibt",
  },
  blockedTitle: "Du kannst dein Konto noch nicht löschen",
  blockedBody: (names: string) =>
    `Du bist der letzte Administrator von ${names}, und es sind noch andere Personen darin. Übergib den Wave zuerst (mach ein anderes Mitglied zum Administrator) oder lösche ihn, und komm dann wieder.`,
  blockedLocked: "Das Formular ist bis dahin gesperrt.",
  confirmTitle: "Bestätigen",
  confirmEmail: "Gib zur Bestätigung deine E-Mail-Adresse ein",
  confirmWord: (word: string) => `Gib zur Bestätigung ${word} ein`,
  codeLabel: "Code aus deiner App oder ein Wiederherstellungscode",
  codeHint: "Dein Konto hat einen zweiten Faktor. Jeder Code gilt nur einmal.",
  submit: "Mein Konto endgültig löschen",
  busy: "Wird gelöscht …",
  doneTitle: "Konto gelöscht",
  doneBody:
    "Dein Konto und seine Daten sind gelöscht, und du bist abgemeldet. Eine Anmeldung damit ist nicht mehr möglich.",
  doneHome: "Zur Startseite",
  failures: {
    emailMismatch: "Das ist nicht die Adresse dieses Kontos. Prüf sie und versuch es noch einmal.",
    wordMismatch: "Das ist nicht das angezeigte Wort. Tipp es genau so, wie es dasteht.",
    invalidCode: "Dieser Code hat nicht funktioniert. Prüf, ob die Uhr deines Telefons stimmt.",
    codeRequired: "Gib einen Code aus deiner App oder einen Wiederherstellungscode ein.",
    throttled: "Zu viele falsche Codes. Warte eine Viertelstunde und versuch es dann noch einmal.",
    lastAdmin: (names: string) =>
      names
        ? `Du bist der letzte Administrator von ${names}, und andere sind darin. Übergib den Wave oder lösche ihn zuerst.`
        : "Du bist der letzte Administrator eines Waves mit weiteren Personen. Übergib ihn oder lösche ihn zuerst.",
    unauthenticated: "Du bist nicht mehr angemeldet. Melde dich neu an, um das Konto zu löschen.",
    unknown: "Das hat nicht geklappt. Lade die Seite neu und versuch es noch einmal.",
  },
};

export type DeleteAccountMessages = typeof en;

const catalogs: Record<Locale, DeleteAccountMessages> = { en, de };

export const deleteAccountMessages = (locale: Locale): DeleteAccountMessages => catalogs[locale];

/** A list of names as one phrase: "a", "a and b", "a, b and c". */
export function nameList(names: string[], locale: Locale): string {
  const quoted = names.map((name) => `“${name}”`);
  return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(quoted);
}

/** The sentence for a failed deletion. `confirmation` decides which "wrong text" it is. */
export function failureText(failure: DeleteFailure, confirmation: "email" | "word", locale: Locale): string {
  const t = deleteAccountMessages(locale).failures;
  switch (failure.kind) {
    case "confirmation-mismatch":
      return confirmation === "word" ? t.wordMismatch : t.emailMismatch;
    case "invalid-code":
      return t.invalidCode;
    case "code-required":
      return t.codeRequired;
    case "throttled":
      return t.throttled;
    case "last-admin":
      return t.lastAdmin(nameList(failure.waves, locale));
    case "unauthenticated":
      return t.unauthenticated;
    default:
      return t.unknown;
  }
}
