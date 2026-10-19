import { type Locale, type Messages, messagesFor } from "@wave/i18n";
import { z } from "zod";

/**
 * What the daemon has to say to a person, as a code and its parameters.
 *
 * The daemon runs as root under systemd, launchd or the Task Scheduler, with
 * no `LANG` of anyone's -- it cannot know which language the person at the
 * other end of the socket reads. So it says *what* happened, and the CLI or
 * the tray, which run as that person, say it in their language. Every reply
 * that carries a notice also carries the English sentence as `message`: an
 * older CLI reads only that, and the journal gets the same words.
 *
 * Parameters are strings, and what goes in them is data -- a URL, a version,
 * an error from somewhere deeper. A reason that comes from the network or the
 * filesystem stays as it came; translating it would mean guessing.
 */
export const Notice = z.object({
  code: z.string(),
  params: z.record(z.string(), z.string()).default({}),
});
export type Notice = z.infer<typeof Notice>;

const en = {
  "not-enrolled": () => "not in any wave yet — `wave login <control-server-url>` joins one",
  "no-such-wave": (p: Params) => `not in a wave at ${p.name}; \`wave profiles\` lists the ones there are`,
  "ambiguous-wave": (p: Params) => `${p.name} fits ${p.count} waves (${p.urls}); name the full address`,
  "not-a-control-url": (p: Params) => `${p.name} is not a control server address`,
  "cert-which-wave": (p: Params) => `this device is in ${p.count} waves; name the one the certificate is for`,
  "cert-failed": (p: Params) =>
    `no certificate for ${p.names ?? (p.wildcard ? "the wave's wildcard" : p.controlUrl)}: ${p.reason}`,
  "unknown-command": () => "unknown command",
  "daemon-silent": () => "the daemon did not answer",
  "updates-from-source": () => "this daemon does not update itself (it runs from source)",
  "update-dev-build": () => "this is a development build, not a release",
  "update-package-managed": (p: Params) => `${p.path} belongs to a package manager, which updates it`,
  "update-not-installed-copy": (p: Params) =>
    `${p.path} is not the installed copy; only ${p.installed}, where \`wave install\` puts it, updates itself`,
  "update-busy": () => "an update is already being installed",
  "update-newest": (p: Params) => `${p.version} is the newest release on offer`,
  "update-installing": (p: Params) => `installing ${p.version}`,
  "update-failed": (p: Params) => `the update to ${p.version} failed: ${p.reason}`,
  "waiting-for-control": (p: Params) => `waiting for the control server … (${p.reason})`,
} satisfies Messages;

const de: typeof en = {
  "not-enrolled": () => "noch in keinem Wave — `wave login <control-server-url>` tritt einem bei",
  "no-such-wave": (p) => `kein Wave unter ${p.name}; \`wave profiles\` zeigt, welche es gibt`,
  "ambiguous-wave": (p) => `${p.name} passt auf ${p.count} Waves (${p.urls}); nenne die ganze Adresse`,
  "not-a-control-url": (p) => `${p.name} ist keine Adresse eines Control-Servers`,
  "cert-which-wave": (p) => `dieses Gerät ist in ${p.count} Waves; nenne den, für den das Zertifikat ist`,
  "cert-failed": (p) =>
    `kein Zertifikat für ${p.names ?? (p.wildcard ? "den Wildcard des Waves" : p.controlUrl)}: ${p.reason}`,
  "unknown-command": () => "unbekannter Befehl",
  "daemon-silent": () => "der Dienst hat nicht geantwortet",
  "updates-from-source": () => "dieser Dienst aktualisiert sich nicht selbst (er läuft aus dem Quelltext)",
  "update-dev-build": () => "das ist ein Entwicklungsbuild, kein Release",
  "update-package-managed": (p) => `${p.path} gehört einem Paketmanager, der es aktualisiert`,
  "update-not-installed-copy": (p) =>
    `${p.path} ist nicht die installierte Kopie; nur ${p.installed}, wohin \`wave install\` es legt, aktualisiert sich selbst`,
  "update-busy": () => "ein Update wird schon installiert",
  "update-newest": (p) => `${p.version} ist das neueste angebotene Release`,
  "update-installing": (p) => `installiere ${p.version}`,
  "update-failed": (p) => `das Update auf ${p.version} ist gescheitert: ${p.reason}`,
  "waiting-for-control": (p) => `wartet auf den Control-Server … (${p.reason})`,
};

type Params = Record<string, string | undefined>;
export type NoticeCode = keyof typeof en;

const catalogs = { en, de };

/** A notice to send: its code is checked here, so a typo cannot reach the wire. */
export const notice = (code: NoticeCode, params: Record<string, string> = {}): Notice => ({ code, params });

/**
 * The notice in a person's language. Null for a code this build does not know
 * -- a newer daemon -- so the caller falls back to the English `message` that
 * came with it rather than printing a code.
 */
export function noticeText(value: Notice, locale: Locale = "en"): string | null {
  const messages = messagesFor(catalogs, locale);
  if (!Object.hasOwn(messages, value.code)) return null;
  return messages[value.code as NoticeCode](value.params);
}

/** The English sentence for the wire's `message` field and for the log. */
export const englishText = (value: Notice): string => noticeText(value, "en") ?? value.code;

/** What a reply means to a person: the notice when known, the English text otherwise. */
export function readNotice(
  reply: { message?: string | null; notice?: Notice | null },
  locale: Locale,
): string | null {
  return (reply.notice ? noticeText(reply.notice, locale) : null) ?? reply.message ?? null;
}
