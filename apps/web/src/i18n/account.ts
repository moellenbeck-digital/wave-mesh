import type { Locale } from "@wave/i18n";

/**
 * The account page and the second step of the password login. The control
 * server answers these with codes (`invalid-code`, `throttled`), and this is
 * where they turn into sentences.
 */
const en = {
  accountTitle: "Your account",
  backToOverview: "← Overview",
  securityTitle: "Two-factor sign-in",
  // Why it only concerns the password: the other ways in bring their own.
  securityIntro:
    "With a second factor, signing in with your password also asks for a code from an authenticator app on your phone — Aegis, 2FAS, Google Authenticator, 1Password and the like.",
  noPassword:
    "This account signs in through a provider such as Google or Pocket ID, which brings its own second factor. There is nothing to set up here.",
  statusOn: (since: string) => `On since ${since}.`,
  statusOff: "Off. Your password alone signs you in.",
  recoveryLeft: (n: number) => (n === 1 ? "1 recovery code left." : `${n} recovery codes left.`),
  setUp: "Set up",
  scanTitle: "1. Scan this code with your app",
  scanAlt: "QR code for your authenticator app",
  manualKey: "Or enter the key by hand:",
  confirmTitle: "2. Enter the code your app shows",
  confirm: "Turn on",
  cancel: "Cancel",
  codeLabel: "Six-digit code",
  codeOrRecovery: "Code from your app, or a recovery code",
  recoveryTitle: "Your recovery codes",
  recoveryIntro:
    "Each one signs you in once if your phone is gone. Keep them somewhere that is not this phone. They are shown only now.",
  copy: "Copy",
  copied: "Copied",
  done: "I have saved them",
  newCodes: "New recovery codes",
  newCodesIntro: "Makes new codes and voids the old ones. Confirm with a code.",
  turnOff: "Turn off",
  turnOffIntro: "Your password alone will sign you in again. Confirm with a code.",
  errors: {
    "invalid-code": "That code did not work. Check that your phone's clock is right.",
    throttled: "Too many wrong codes. Wait a quarter of an hour and try again.",
    "already-enabled": "It is already on.",
    "no-password": "This account has no password, so there is no second factor to set up.",
    unknown: "That did not work. Reload the page and try again.",
  } as Record<string, string>,
  // --- the second step of the login ---
  loginCodeTitle: "Enter your code",
  loginCodeIntro:
    "Open your authenticator app and enter the code for wave-mesh. Without your phone, a recovery code works too.",
  loginCodeSubmit: "Sign in",
  loginCodeBack: "Back to sign-in",
  loginCodeInvalid: "That code did not work.",
  loginCodeThrottled: "Too many wrong codes. Wait a quarter of an hour, then sign in again.",
  loginExpired: "That took too long. Sign in again.",
};

const de: typeof en = {
  accountTitle: "Dein Konto",
  backToOverview: "← Übersicht",
  securityTitle: "Zwei-Faktor-Anmeldung",
  securityIntro:
    "Mit einem zweiten Faktor fragt die Anmeldung mit Passwort zusätzlich nach einem Code aus einer Authenticator-App auf deinem Telefon — Aegis, 2FAS, Google Authenticator, 1Password und ähnliche.",
  noPassword:
    "Dieses Konto meldet sich über einen Anbieter wie Google oder Pocket ID an, der seinen eigenen zweiten Faktor mitbringt. Hier gibt es nichts einzurichten.",
  statusOn: (since) => `An seit ${since}.`,
  statusOff: "Aus. Dein Passwort allein meldet dich an.",
  recoveryLeft: (n) => (n === 1 ? "Noch 1 Wiederherstellungscode." : `Noch ${n} Wiederherstellungscodes.`),
  setUp: "Einrichten",
  scanTitle: "1. Scanne diesen Code mit deiner App",
  scanAlt: "QR-Code für deine Authenticator-App",
  manualKey: "Oder gib den Schlüssel von Hand ein:",
  confirmTitle: "2. Gib den Code ein, den deine App zeigt",
  confirm: "Einschalten",
  cancel: "Abbrechen",
  codeLabel: "Sechsstelliger Code",
  codeOrRecovery: "Code aus deiner App oder ein Wiederherstellungscode",
  recoveryTitle: "Deine Wiederherstellungscodes",
  recoveryIntro:
    "Jeder meldet dich einmal an, falls dein Telefon weg ist. Bewahr sie woanders auf als auf diesem Telefon. Sie werden nur jetzt angezeigt.",
  copy: "Kopieren",
  copied: "Kopiert",
  done: "Ich habe sie gesichert",
  newCodes: "Neue Wiederherstellungscodes",
  newCodesIntro: "Erzeugt neue Codes und macht die alten ungültig. Bestätige mit einem Code.",
  turnOff: "Ausschalten",
  turnOffIntro: "Dann meldet dich wieder dein Passwort allein an. Bestätige mit einem Code.",
  errors: {
    "invalid-code": "Dieser Code hat nicht funktioniert. Prüf, ob die Uhr deines Telefons stimmt.",
    throttled: "Zu viele falsche Codes. Warte eine Viertelstunde und versuch es dann noch einmal.",
    "already-enabled": "Das ist schon eingeschaltet.",
    "no-password": "Dieses Konto hat kein Passwort, also gibt es keinen zweiten Faktor einzurichten.",
    unknown: "Das hat nicht geklappt. Lade die Seite neu und versuch es noch einmal.",
  },
  loginCodeTitle: "Code eingeben",
  loginCodeIntro:
    "Öffne deine Authenticator-App und gib den Code für wave-mesh ein. Ohne dein Telefon geht auch ein Wiederherstellungscode.",
  loginCodeSubmit: "Anmelden",
  loginCodeBack: "Zurück zur Anmeldung",
  loginCodeInvalid: "Dieser Code hat nicht funktioniert.",
  loginCodeThrottled: "Zu viele falsche Codes. Warte eine Viertelstunde und melde dich dann noch einmal an.",
  loginExpired: "Das hat zu lange gedauert. Melde dich noch einmal an.",
};

export type AccountMessages = typeof en;

// Not messagesFor(): the errors are a lookup table, which the generic
// Messages shape has no room for. `typeof en` keeps the German one in step.
const catalogs: Record<Locale, AccountMessages> = { en, de };

export const accountMessages = (locale: Locale): AccountMessages => catalogs[locale];
