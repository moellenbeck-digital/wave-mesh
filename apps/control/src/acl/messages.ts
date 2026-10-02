import type { Locale, Messages } from "@wave/i18n";

/**
 * What a policy check, a preview and the reach listing say, in both languages.
 *
 * The same judgement is read in the browser and on the shell of the server, so
 * the texts belong to the code that judges, not to either of the two places
 * that show them. The selectors, tags and port specs inside stay as written:
 * they are what the reader types back into the document.
 */
const en = {
  document: "document",
  serviceAsSource: (where: string, selector: string) =>
    `${where}.src: ${selector} is a service, which is never a source`,
  undefinedGroup: (where: string, selector: string) => `${where}: ${selector} is not defined under groups`,
  userWithoutDevice: (selector: string) => `${selector} has no untagged device in this wave (yet)`,
  unwornTag: (selector: string) => `no device wears ${selector} (yet)`,
  unknownService: (name: string) => `no service called ${name} (yet)`,
  notATag: (bad: string[]) => `not a tag: ${bad.join(", ")}`,
  portsEnforced: "ports enforced",
  portsNotEnforced: (reason: string | null) => `ports NOT enforced (${reason ?? "no reason given"})`,
  portsNotReported: "ports not reported (a client too old to enforce them)",
  allPorts: "all ports",
  nothing: "nothing",
} satisfies Messages;

const de: typeof en = {
  document: "Dokument",
  serviceAsSource: (where, selector) => `${where}.src: ${selector} ist ein Dienst und nie eine Quelle`,
  undefinedGroup: (where, selector) => `${where}: ${selector} ist unter groups nicht definiert`,
  userWithoutDevice: (selector) => `${selector} hat (noch) kein Gerät ohne Tag in diesem Wave`,
  unwornTag: (selector) => `(noch) kein Gerät trägt ${selector}`,
  unknownService: (name) => `(noch) kein Dienst namens ${name}`,
  notATag: (bad) => `kein Tag: ${bad.join(", ")}`,
  portsEnforced: "Ports durchgesetzt",
  portsNotEnforced: (reason) => `Ports NICHT durchgesetzt (${reason ?? "kein Grund genannt"})`,
  portsNotReported: "Ports nicht gemeldet (ein Client, der zu alt ist, um sie durchzusetzen)",
  allPorts: "alle Ports",
  nothing: "nichts",
};

export type AclMessages = typeof en;

export const aclMessages = (locale: Locale = "en"): AclMessages => (locale === "de" ? de : en);
