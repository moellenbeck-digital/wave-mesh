import type { Locale } from "@wave/i18n";
import type { Mail } from "../mail.ts";

/**
 * The two mails of the password registration (ticket #150), in the language of
 * the request. Plain text with one link each.
 *
 * What a person who registers sees on the page is the same whether the address
 * is new or taken; what differs is this mail, and only its reader sees it.
 */

const confirmTexts = {
  en: {
    subject: "Confirm your wave-mesh account",
    body: (url: string, hours: number) =>
      `Someone, hopefully you, signed up at wave-mesh with this address.\n\nConfirm it to create the account:\n\n${url}\n\nThe link works once and for ${hours} hours. If it was not you, ignore this mail; nothing is created without the link.\n`,
  },
  de: {
    subject: "Bestätige dein wave-mesh-Konto",
    body: (url: string, hours: number) =>
      `Jemand, hoffentlich du, hat sich mit dieser Adresse bei wave-mesh registriert.\n\nBestätige sie, um das Konto anzulegen:\n\n${url}\n\nDer Link gilt einmal und ${hours} Stunden. Warst du es nicht, ignoriere diese Mail; ohne den Link entsteht nichts.\n`,
  },
} satisfies Record<Locale, unknown>;

const knownTexts = {
  en: {
    subject: "You already have a wave-mesh account",
    body: (url: string) =>
      `Someone, hopefully you, tried to sign up at wave-mesh with this address, which already has an account.\n\nNothing was changed. Sign in here:\n\n${url}\n\nIf it was not you, ignore this mail.\n`,
  },
  de: {
    subject: "Du hast bereits ein wave-mesh-Konto",
    body: (url: string) =>
      `Jemand, hoffentlich du, wollte sich mit dieser Adresse bei wave-mesh registrieren, sie hat aber schon ein Konto.\n\nEs wurde nichts geändert. Hier meldest du dich an:\n\n${url}\n\nWarst du es nicht, ignoriere diese Mail.\n`,
  },
} satisfies Record<Locale, unknown>;

export function confirmationMail(locale: Locale, to: string, url: string, ttlMs: number): Mail {
  const t = confirmTexts[locale] ?? confirmTexts.en;
  return { to, subject: t.subject, text: t.body(url, Math.round(ttlMs / 3_600_000)) };
}

export function alreadyRegisteredMail(locale: Locale, to: string, loginUrl: string): Mail {
  const t = knownTexts[locale] ?? knownTexts.en;
  return { to, subject: t.subject, text: t.body(loginUrl) };
}
