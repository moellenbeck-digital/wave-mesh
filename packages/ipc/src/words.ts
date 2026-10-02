import { type Locale, type Messages, messagesFor } from "@wave/i18n";
import { type PathKind, pathKind } from "./protocol.ts";

/**
 * The few words every view of a tunnel needs: how a peer is reached, and the
 * one state that waits for a person. Here and not in each view because the
 * CLI, the tray's menu and the tray's window said them three times, and three
 * copies of "no fixed path" are three places to forget a language.
 */
const en = {
  direct: (via: string) => `direct ${via}`,
  relay: "via relay",
  // Sprayed to every candidate rather than down a confirmed path: slower and
  // noisier, but carrying traffic -- see pathKind().
  loose: "no fixed path",
  connecting: "connecting…",
  waitingInBrowser: "waiting for approval in the browser",
} satisfies Messages;

const de: typeof en = {
  direct: (via) => `direkt ${via}`,
  relay: "über Relay",
  loose: "kein fester Pfad",
  connecting: "verbinde…",
  waitingInBrowser: "wartet auf Freigabe im Browser",
};

export const tunnelWords = (locale: Locale = "en") => messagesFor({ en, de }, locale);

/** How a peer is reached, in words -- without the RTT, which each view places itself. */
export function pathWords(
  peer: { via: string | null; lastHandshakeSecondsAgo: number | null },
  locale: Locale = "en",
): { kind: PathKind; text: string } {
  const words = tunnelWords(locale);
  const kind = pathKind(peer);
  const text =
    kind === "loose"
      ? words.loose
      : kind === "none"
        ? words.connecting
        : kind === "relay"
          ? words.relay
          : words.direct(peer.via ?? "");
  return { kind, text };
}
