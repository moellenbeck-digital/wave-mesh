import { createServer, type Server } from "node:net";
import type { Mail, Mailer } from "../src/mail.ts";

/**
 * Where the tests' mail goes (ticket #150): no real server, no network.
 *
 * `MailSink` is a `Mailer` that keeps what it was given; most tests use it.
 * `startSmtpSink` is a small SMTP server in the test process, which the real
 * transport (`createSmtpMailer`) talks to over a loopback socket.
 */
export class MailSink implements Mailer {
  readonly sent: Mail[] = [];
  /** Makes the next sends fail, like a relay that is down. */
  failing = false;

  async send(mail: Mail): Promise<void> {
    if (this.failing) throw new Error("relay down");
    this.sent.push(mail);
  }

  /** The mails to one address, oldest first. */
  to(address: string): Mail[] {
    return this.sent.filter((mail) => mail.to === address);
  }

  /** The token of the confirmation link in a mail, as the person would click it. */
  static tokenOf(mail: Mail | undefined): string {
    const found = mail?.text.match(/\/signup\/confirm\?token=([\w-]+)/);
    if (!found?.[1]) throw new Error(`no confirmation link in: ${mail?.text}`);
    return decodeURIComponent(found[1]);
  }
}

export interface ReceivedMessage {
  from: string;
  to: string[];
  /** Headers and body as they arrived, dot-unstuffed. */
  data: string;
}

export interface SmtpSink {
  port: number;
  messages: ReceivedMessage[];
  close: () => Promise<void>;
}

/** An SMTP server that accepts everything (no TLS, no authentication) and remembers it. */
export async function startSmtpSink(): Promise<SmtpSink> {
  const messages: ReceivedMessage[] = [];
  const server: Server = createServer((socket) => {
    let buffer = "";
    let current: ReceivedMessage = { from: "", to: [], data: "" };
    let inData = false;
    const reply = (line: string) => socket.write(`${line}\r\n`);
    reply("220 sink ESMTP");

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          current.data = buffer.slice(0, end).replace(/\r\n\.\./g, "\r\n.");
          buffer = buffer.slice(end + 5);
          inData = false;
          messages.push(current);
          current = { from: "", to: [], data: "" };
          reply("250 queued");
          continue;
        }
        const eol = buffer.indexOf("\r\n");
        if (eol < 0) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        const command = line.toUpperCase();
        if (command.startsWith("EHLO")) {
          socket.write("250-sink\r\n250 8BITMIME\r\n");
        } else if (command.startsWith("HELO")) reply("250 sink");
        else if (command.startsWith("MAIL FROM:")) {
          current.from = line.slice(10).match(/<([^>]*)>/)?.[1] ?? "";
          reply("250 ok");
        } else if (command.startsWith("RCPT TO:")) {
          current.to.push(line.slice(8).match(/<([^>]*)>/)?.[1] ?? "");
          reply("250 ok");
        } else if (command === "DATA") {
          inData = true;
          reply("354 go ahead");
        } else if (command === "QUIT") {
          reply("221 bye");
          socket.end();
        } else if (command === "RSET" || command === "NOOP") reply("250 ok");
        else reply("502 not implemented");
      }
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    port: address.port,
    messages,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
