import type { Locale } from "@wave/i18n";
import type { Mail } from "../mail.ts";

/**
 * The mails of "forgot password" (ticket #159), in the language of the request.
 * Plain text with one link each; what a person sees on the page is the same
 * whether the address has an account or not, and only the mailbox differs.
 */

const resetTexts = {
  en: {
    subject: "Reset your wave-mesh password",
    body: (url: string, hours: number) =>
      `Someone, hopefully you, asked to reset the password of this wave-mesh account.\n\nChoose a new password here:\n\n${url}\n\nThe link works once and for ${hours} ${hours === 1 ? "hour" : "hours"}. Your password stays as it is until you use it. If it was not you, ignore this mail.\n`,
  },
  de: {
    subject: "Setze dein wave-mesh-Passwort zurück",
    body: (url: string, hours: number) =>
      `Jemand, hoffentlich du, hat darum gebeten, das Passwort dieses wave-mesh-Kontos zurückzusetzen.\n\nWähle hier ein neues Passwort:\n\n${url}\n\nDer Link gilt einmal und ${hours} ${hours === 1 ? "Stunde" : "Stunden"}. Dein Passwort bleibt, wie es ist, bis du ihn benutzt. Warst du es nicht, ignoriere diese Mail.\n`,
  },
} satisfies Record<Locale, unknown>;

const noPasswordTexts = {
  en: {
    subject: "Your wave-mesh account has no password",
    body: (url: string) =>
      `Someone, hopefully you, asked to reset the password of this wave-mesh account. It has no password: it signs in with an identity provider.\n\nNothing was changed. Sign in here:\n\n${url}\n\nIf it was not you, ignore this mail.\n`,
  },
  de: {
    subject: "Dein wave-mesh-Konto hat kein Passwort",
    body: (url: string) =>
      `Jemand, hoffentlich du, hat darum gebeten, das Passwort dieses wave-mesh-Kontos zurückzusetzen. Es hat keins: Die Anmeldung läuft über einen Anbieter.\n\nEs wurde nichts geändert. Hier meldest du dich an:\n\n${url}\n\nWarst du es nicht, ignoriere diese Mail.\n`,
  },
} satisfies Record<Locale, unknown>;

export function passwordResetMail(locale: Locale, to: string, url: string, ttlMs: number): Mail {
  const t = resetTexts[locale] ?? resetTexts.en;
  return { to, subject: t.subject, text: t.body(url, Math.round(ttlMs / 3_600_000)) };
}

export function noPasswordMail(locale: Locale, to: string, loginUrl: string): Mail {
  const t = noPasswordTexts[locale] ?? noPasswordTexts.en;
  return { to, subject: t.subject, text: t.body(loginUrl) };
}
