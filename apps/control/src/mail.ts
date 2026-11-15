import { createTransport } from "nodemailer";
import type { SmtpConfig } from "./env.ts";

/** One mail, plain text: nothing here needs markup, and a link survives every client. */
export interface Mail {
  to: string;
  subject: string;
  text: string;
}

/**
 * How mail leaves the server. An interface, like the DNS and ACME providers:
 * the routes take a `Mailer`, the tests hand them one that collects the mails
 * in memory (`test/mail-sink.ts`), and the SMTP transport below is tested
 * against an SMTP server that runs in the test process.
 *
 * `send` rejects when the mail did not go out. A caller never treats that as
 * success: a registration that could not be confirmed makes no account.
 */
export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** Long enough for a slow relay, short enough that a request does not hang for minutes. */
const SMTP_TIMEOUT_MS = 15_000;

/**
 * Generic SMTP through nodemailer: `smtp://` upgrades with STARTTLS when the
 * server offers it, `smtps://` is TLS from the first byte. Authentication comes
 * from the credentials in the URL, if any. The sender is the one address
 * `WAVE_MAIL_FROM` names.
 */
export function createSmtpMailer(config: SmtpConfig): Mailer {
  const transport = createTransport({
    url: config.url,
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  });
  return {
    async send(mail) {
      await transport.sendMail({
        from: config.from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
      });
    },
  };
}
