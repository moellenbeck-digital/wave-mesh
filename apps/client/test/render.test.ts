import { describe, expect, test } from "bun:test";
import { profileStatusFromSnapshot, type Status } from "@wave/ipc";
import { renderStatus, shouldWatch } from "../src/render.ts";

/** The view is coloured; assertions care about the text. */
const ESC = "\u001b";
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const plain = (text: string) => text.replace(ANSI, "");

type SnapshotInput = NonNullable<Parameters<typeof profileStatusFromSnapshot>[0]>;

const profile = (over: Partial<SnapshotInput> = {}, events: string[] = []) =>
  profileStatusFromSnapshot(
    {
      controlUrl: "http://control.example",
      interfaceName: "wave0",
      addresses: ["10.77.0.1/32", "fd7a:1:2::1/128"],
      self: { hostname: "laptop", dnsName: "laptop.rl.wave.internal", ipv4: "10.77.0.1" },
      dnsSuffix: "rl.wave.internal",
      peers: [],
      ...over,
    },
    { controlUrl: "http://control.example", state: "up", events },
  );

const snapshot = (over: Partial<SnapshotInput> = {}, events: string[] = []): Status => ({
  profiles: [profile(over, events)],
  events: [],
});

type SnapshotPeer = SnapshotInput["peers"][number];

const peer = (over: Partial<SnapshotPeer> = {}): SnapshotPeer => ({
  hostname: "macbook",
  dnsName: "macbook.rl.wave.internal",
  ipv4: "10.77.0.2",
  ipv6: "fd7a:1:2::2",
  ...over,
});

describe("when a view stays open", () => {
  test("on a terminal, unless one snapshot was asked for", () => {
    expect(shouldWatch({ once: false, isTty: true })).toBe(true);
    expect(shouldWatch({ once: true, isTty: true })).toBe(false);
  });

  test("never off one -- a piped `wave status` must not hang the reader", () => {
    expect(shouldWatch({ once: false, isTty: false })).toBe(false);
    expect(shouldWatch({ once: true, isTty: false })).toBe(false);
  });
});

describe("the footer", () => {
  test("says what Ctrl-C does, and can say something else", () => {
    expect(plain(renderStatus(snapshot()))).toContain("Ctrl-C to disconnect.");
    // `wave status` only watches: interrupting it disconnects nothing.
    expect(plain(renderStatus(snapshot(), "Ctrl-C to stop watching."))).toContain("Ctrl-C to stop watching.");
    expect(plain(renderStatus(snapshot(), "Ctrl-C to stop watching."))).not.toContain("to disconnect");
  });

  test("a single printed snapshot gets none", () => {
    const out = plain(renderStatus(snapshot(), null));
    expect(out).toContain("wave0");
    expect(out).not.toContain("Ctrl-C");
  });
});

describe("status view", () => {
  test("shows the interface, its address and the node's name", () => {
    const out = plain(renderStatus(snapshot()));
    expect(out).toContain("wave0");
    expect(out).toContain("10.77.0.1");
    expect(out).toContain("laptop.rl.wave.internal");
    expect(out).toContain("fd7a:1:2::1/128");
  });

  test("says so when there is nobody to talk to yet", () => {
    expect(plain(renderStatus(snapshot()))).toContain("No peers yet");
  });

  test("shows a direct path with its latency", () => {
    const out = plain(renderStatus(snapshot({ peers: [peer({ via: "192.168.1.20:41641", rttMs: 7.8 })] })));
    expect(out).toContain("macbook");
    expect(out).toContain("10.77.0.2");
    expect(out).toContain("direct 192.168.1.20:41641");
    expect(out).toContain("8ms");
  });

  test("marks a relayed peer as such", () => {
    const out = plain(renderStatus(snapshot({ peers: [peer({ via: "relay", rttMs: 56 })] })));
    expect(out).toContain("via relay");
    expect(out).not.toContain("direct");
  });

  test("shows a peer that has no path and no handshake as connecting", () => {
    expect(plain(renderStatus(snapshot({ peers: [peer()] })))).toContain("connecting");
  });

  test("a peer without a path but with a fresh handshake is not called connecting", () => {
    // Without a confirmed path the magic socket sprays each packet to every
    // candidate, so the tunnel carries traffic -- a ping through it answered in
    // 16 ms while this said "connecting".
    const out = plain(
      renderStatus(snapshot({ peers: [peer({ via: undefined, lastHandshakeSecondsAgo: 20 })] })),
    );
    expect(out).toContain("no fixed path");
    expect(out).not.toContain("connecting…");
  });

  test("a peer nothing is being sent to is idle -- not direct, and not connecting", () => {
    // Its path is the last one known; nobody has measured it, and nobody needs
    // to until something is sent (ACTIVE_TIMEOUT_MS in @wave/magicsock).
    const out = plain(renderStatus(snapshot({ peers: [peer({ via: "idle", rttMs: 12 })] })));
    expect(out).toContain("idle");
    expect(out).not.toContain("direct");
    expect(out).not.toContain("connecting");
    expect(out).not.toContain("12ms");
  });

  test("but a handshake old enough to prove nothing is connecting again", () => {
    const out = plain(
      renderStatus(snapshot({ peers: [peer({ via: undefined, lastHandshakeSecondsAgo: 600 })] })),
    );
    expect(out).toContain("connecting");
  });

  test("reports the handshake age, or a dash when there was none", () => {
    expect(plain(renderStatus(snapshot({ peers: [peer({ lastHandshakeSecondsAgo: 12 })] })))).toContain(
      "12s ago",
    );
    expect(plain(renderStatus(snapshot({ peers: [peer({ lastHandshakeSecondsAgo: 600 })] })))).toContain(
      "10m ago",
    );
    expect(plain(renderStatus(snapshot({ peers: [peer()] })))).toContain("—");
  });

  test("shows the relay connection", () => {
    const connected = plain(renderStatus(snapshot({ relay: { url: "ws://r/relay", connected: true } })));
    expect(connected).toContain("relay connected");
    const pending = plain(renderStatus(snapshot({ relay: { url: "ws://r/relay", connected: false } })));
    expect(pending).toContain("connecting");
  });

  test("keeps the columns aligned despite the colour codes", () => {
    const out = renderStatus(
      snapshot({
        peers: [
          peer({ via: "relay", lastHandshakeSecondsAgo: 1 }),
          peer({ hostname: "phone", via: "1.2.3.4:5", rttMs: 1, lastHandshakeSecondsAgo: 1 }),
        ],
      }),
    );
    const rows = plain(out)
      .split("\n")
      .filter((line) => line.includes("ago"));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.indexOf("1s ago"))).size).toBe(1);
  });

  test("shows recent events when there are any", () => {
    expect(plain(renderStatus(snapshot({}, ["netmap v4: 1 peer(s)"])))).toContain("netmap v4");
  });
});

describe("the services a machine fronts", () => {
  test("stand under their machine, with the address the server wrote out", () => {
    const text = plain(
      renderStatus(
        snapshot({
          peers: [
            peer({
              hostname: "connector",
              services: [
                {
                  name: "grafana",
                  dnsName: "grafana.rl.wave.internal",
                  ipv4: "10.77.0.4",
                  url: "https://grafana.rl.wave.internal",
                },
                {
                  name: "git",
                  dnsName: "git.rl.wave.internal",
                  ipv4: "10.77.0.5",
                  url: "http://git.rl.wave.internal",
                },
              ],
            }),
          ],
        }),
      ),
    );

    const lines = text.split("\n");
    const machine = lines.findIndex((line) => line.startsWith("connector"));
    expect(lines[machine + 1]).toContain("https://grafana.rl.wave.internal");
    expect(lines[machine + 1]).toContain("10.77.0.4");
    // A name served in plain text must not be offered as https: the link would
    // go nowhere, which is the whole reason the server writes the address out
    // rather than every view assembling one.
    expect(lines[machine + 2]).toContain("http://git.rl.wave.internal");
  });

  test("and under this device itself, which is how a connector sees its own", () => {
    const text = plain(
      renderStatus(
        snapshot({
          self: {
            hostname: "connector",
            dnsName: "connector.rl.wave.internal",
            ipv4: "10.77.0.1",
            services: [
              {
                name: "grafana",
                dnsName: "grafana.rl.wave.internal",
                ipv4: "10.77.0.4",
                url: "https://grafana.rl.wave.internal",
              },
            ],
          },
        }),
      ),
    );
    expect(text).toContain("https://grafana.rl.wave.internal");
  });

  test("and a machine without any adds no line at all", () => {
    const text = plain(renderStatus(snapshot({ peers: [peer()] })));
    expect(text).not.toContain("↳");
  });
});
