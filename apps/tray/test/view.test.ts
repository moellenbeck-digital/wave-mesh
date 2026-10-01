import { describe, expect, test } from "bun:test";
import { profileStatusFromSnapshot, type Status } from "@wave/ipc";
import { iconPixmap } from "../src/icon.ts";
import { actionForId, Ids, iconFor, menuFor, toggleId, tooltipFor } from "../src/view.ts";

const oneProfile = (
  peers: Array<{ hostname: string; ipv4: string; via: string | null }> = [],
  controlUrl = "http://control.example",
) =>
  profileStatusFromSnapshot(
    {
      controlUrl,
      interfaceName: "wave0",
      addresses: ["10.77.0.1/32"],
      self: { hostname: "laptop", dnsName: "laptop.rl.example.com", ipv4: "10.77.0.1" },
      peers: peers.map((peer) => ({
        hostname: peer.hostname,
        dnsName: `${peer.hostname}.rl.example.com`,
        ipv4: peer.ipv4,
        ipv6: "fd7a::2",
        via: peer.via ?? undefined,
      })),
    },
    { controlUrl, state: "up" },
  );

const up = (peers: Array<{ hostname: string; ipv4: string; via: string | null }> = []): Status => ({
  profiles: [oneProfile(peers)],
  events: [],
});

const labels = (entries: ReturnType<typeof menuFor>) =>
  entries.filter((e) => !e.separator).map((e) => e.label);

/** One profile in some state other than up. */
const inState = (
  state: "starting" | "waiting-for-approval" | "failed" | "stopped",
  message?: string,
): Status => ({
  profiles: [
    profileStatusFromSnapshot(undefined, {
      controlUrl: "http://control.example",
      state,
      message,
    }),
  ],
  events: [],
});

describe("icon", () => {
  test("reflects the tunnel's state", () => {
    expect(iconFor(null)).toBe("off");
    expect(iconFor(up())).toBe("connected");
    expect(iconFor(inState("starting"))).toBe("connecting");
    expect(iconFor(inState("waiting-for-approval"))).toBe("connecting");
    expect(iconFor(inState("failed", "nope"))).toBe("off");
  });

  test("is drawn as ARGB pixels of the declared size", () => {
    const icon = iconPixmap("connected");
    expect(icon.width).toBe(22);
    expect(icon.data.length).toBe(icon.width * icon.height * 4);
    // Centre is opaque, the corner is outside the disc and therefore clear.
    const centre = ((icon.height / 2) * icon.width + icon.width / 2) * 4;
    expect(icon.data[centre]).toBe(255);
    expect(icon.data[0]).toBe(0);
  });

  test("differs by state, or the icon would say nothing", () => {
    expect(Buffer.from(iconPixmap("connected").data)).not.toEqual(Buffer.from(iconPixmap("off").data));
  });
});

describe("tooltip", () => {
  test("counts the peers that actually have a path", () => {
    const status = up([
      { hostname: "phone", ipv4: "10.77.0.2", via: "relay" },
      { hostname: "nas", ipv4: "10.77.0.3", via: null },
    ]);
    expect(tooltipFor(status)).toBe("10.77.0.1 — 1/2 peer(s) reachable");
  });

  test("explains what it is waiting for", () => {
    expect(tooltipFor(inState("waiting-for-approval"))).toContain("approval");
    expect(tooltipFor(null)).toContain("daemon");
  });

  test("passes a failure through rather than hiding it", () => {
    expect(tooltipFor(inState("failed", "no route"))).toBe("no route");
  });
});

describe("menu", () => {
  test("offers to disconnect while connected, and to connect otherwise", () => {
    expect(labels(menuFor(up()))).toContain("Disconnect");
    expect(labels(menuFor(null))).toContain("Connect");
  });

  test("lists peers with how they are reached", () => {
    const entries = menuFor(up([{ hostname: "phone", ipv4: "10.77.0.2", via: "203.0.113.9:41641" }]));
    expect(labels(entries)).toContain("phone  10.77.0.2  direct 203.0.113.9:41641");
  });

  test("says when a peer is relayed or still looking", () => {
    const relayed = menuFor(up([{ hostname: "phone", ipv4: "10.77.0.2", via: "relay" }]));
    expect(labels(relayed).some((label) => label?.includes("via relay"))).toBe(true);
    const searching = menuFor(up([{ hostname: "phone", ipv4: "10.77.0.2", via: null }]));
    expect(labels(searching).some((label) => label?.includes("connecting"))).toBe(true);
  });

  test("opens the server each wave enrolled with", () => {
    // Every address comes from the daemon, one per wave -- the tray is not
    // configured with a server of its own and has none to fall back on.
    const status = up();
    const entries = menuFor(status);

    expect(labels(entries)).toContain("Open control.example");

    const entry = entries.find((e) => e.label === "Open control.example");
    expect(actionForId(status, entry?.id ?? -1)).toEqual({
      kind: "open",
      url: "http://control.example",
    });
  });

  test("says so plainly while this device has joined nothing", () => {
    const empty: Status = { profiles: [], events: [] };
    const shown = labels(menuFor(empty));
    expect(shown).toContain("Not in any wave yet");
    expect(shown.some((label) => label?.includes("wave login"))).toBe(true);
    // No server is enrolled, so there is nothing to open and nothing to
    // connect to -- offering either would be a dead end.
    expect(shown.some((label) => label?.startsWith("Open"))).toBe(false);
    expect(shown.some((label) => label === "Connect")).toBe(false);
  });

  test("gives every entry a distinct id, or clicks would land on the wrong one", () => {
    const entries = menuFor(
      up([
        { hostname: "a", ipv4: "10.77.0.2", via: "relay" },
        { hostname: "b", ipv4: "10.77.0.3", via: "relay" },
      ]),
    );
    const ids = entries.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(Ids.quit);
  });
});

describe("platform support", () => {
  test("has a backend for macOS", async () => {
    const { createTrayBackend, UnsupportedPlatform } = await import("../src/backend.ts");
    // Only the choice of backend is checked here: the backend itself talks to
    // Cocoa, so it loads on a Mac and fails while opening the macOS libraries
    // anywhere else. Either way the platform is known -- what must never
    // happen is UnsupportedPlatform.
    try {
      const backend = await createTrayBackend({ onActivate: () => {}, onClick: () => {} }, "darwin");
      expect(backend.platform).toBe("darwin");
    } catch (error) {
      expect(error).not.toBeInstanceOf(UnsupportedPlatform);
    }
  });

  test("refuses politely where there is no tray yet, and says the tunnel is fine", async () => {
    // The tray is a convenience; its absence must not read like a broken VPN.
    const { UnsupportedPlatform, createTrayBackend } = await import("../src/backend.ts");
    const attempt = createTrayBackend({ onActivate: () => {}, onClick: () => {} }, "freebsd");
    await expect(attempt).rejects.toBeInstanceOf(UnsupportedPlatform);
    await expect(attempt).rejects.toThrow(/tunnel itself is unaffected/);
  });

  test("has a backend for Windows", async () => {
    const { createTrayBackend, UnsupportedPlatform } = await import("../src/backend.ts");
    // Same as macOS above: the backend opens user32 and friends, so it loads on
    // Windows and fails opening them anywhere else. The platform being known is
    // the whole claim.
    try {
      const backend = await createTrayBackend({ onActivate: () => {}, onClick: () => {} }, "win32");
      expect(backend.platform).toBe("win32");
    } catch (error) {
      expect(error).not.toBeInstanceOf(UnsupportedPlatform);
    }
  });

  test("has a backend for linux", async () => {
    const { createTrayBackend } = await import("../src/backend.ts");
    const backend = await createTrayBackend({ onActivate: () => {}, onClick: () => {} }, "linux");
    expect(backend.platform).toBe("linux");
  });
});

describe("when the daemon is out of reach", () => {
  test("says which kind of out of reach it is", () => {
    expect(tooltipFor(null, "denied")).toContain("log out and back in");
    expect(tooltipFor(null, "no-daemon")).toContain("not running");
    expect(tooltipFor(null, "unreachable")).toContain("not answering");
  });

  test("does not offer actions it cannot carry out", () => {
    const entries = menuFor(null, { unreachable: "denied" });
    const labels = entries.filter((entry) => !entry.separator).map((entry) => entry.label);
    expect(labels.some((label) => label?.includes("Connect"))).toBe(false);
    expect(labels.some((label) => label?.includes("group"))).toBe(true);
    expect(labels).toContain("Quit the tray icon");
  });

  test("still offers to connect when the daemon is simply not running", () => {
    const labels = menuFor(null, { unreachable: "no-daemon" })
      .filter((entry) => !entry.separator)
      .map((entry) => entry.label);
    expect(labels).toContain("Connect");
  });
});

describe("several waves", () => {
  const two = (): Status => ({
    profiles: [
      oneProfile([{ hostname: "phone", ipv4: "10.64.0.2", via: "relay" }], "http://a.example"),
      oneProfile([{ hostname: "nas", ipv4: "10.96.0.2", via: null }], "http://b.example"),
    ],
    events: [],
  });

  test("names each wave by its server once there is more than one", () => {
    const shown = labels(menuFor(two())).join("\n");
    expect(shown).toContain("Disconnect a.example");
    expect(shown).toContain("Disconnect b.example");
  });

  test("a click maps back to the wave it belongs to, by its full address", () => {
    // The label is shortened for the menu; what goes to the daemon is not.
    expect(actionForId(two(), toggleId(0))).toEqual({
      kind: "disconnect",
      controlUrl: "http://a.example",
    });
    expect(actionForId(two(), toggleId(1))).toEqual({
      kind: "disconnect",
      controlUrl: "http://b.example",
    });
  });

  test("a peer entry is not a button", () => {
    // Peers sit inside a profile's id block but must not act on anything.
    const entries = menuFor(two());
    const peer = entries.find((e) => e.label?.includes("phone"));
    expect(peer).toBeDefined();
    expect(actionForId(two(), peer?.id ?? -1)).toBeNull();
  });

  test("each wave offers its own server", () => {
    const status = two();
    const entries = menuFor(status);
    expect(labels(entries)).toContain("Open a.example");
    expect(labels(entries)).toContain("Open b.example");

    const second = entries.find((e) => e.label === "Open b.example");
    expect(actionForId(status, second?.id ?? -1)).toEqual({
      kind: "open",
      url: "http://b.example",
    });
  });

  test("the tooltip counts waves rather than repeating one", () => {
    expect(tooltipFor(two())).toBe("2/2 waves connected");
  });

  test("an id past the last wave does nothing", () => {
    expect(actionForId(two(), toggleId(7))).toBeNull();
    expect(actionForId(null, toggleId(0))).toBeNull();
  });

  test("quit still works whatever is running", () => {
    expect(actionForId(two(), Ids.quit)).toEqual({ kind: "quit" });
  });
});

describe("an update (D13)", () => {
  const withUpdate = (update: Partial<NonNullable<NonNullable<Status["daemon"]>["update"]>>): Status => ({
    ...up(),
    daemon: {
      version: "0.1.0",
      platform: "linux-amd64",
      update: {
        autoUpdate: true,
        wish: null,
        channels: [],
        available: "0.2.0",
        state: "idle",
        message: null,
        scheduledAt: null,
        ...update,
      },
    },
  });

  test("is said in the tooltip and offered in the menu", () => {
    const status = withUpdate({});
    expect(tooltipFor(status)).toEndWith("· Update to 0.2.0 available");
    expect(labels(menuFor(status))).toContain("Update to 0.2.0 available");
    expect(actionForId(status, Ids.update)).toEqual({ kind: "update" });
  });

  test("says when it is going to happen by itself", () => {
    const status = withUpdate({ state: "scheduled", scheduledAt: new Date().toISOString() });
    expect(labels(menuFor(status)).some((label) => label?.startsWith("Update to 0.2.0 at "))).toBe(true);
    expect(labels(menuFor(status))).toContain("Install update now");
  });

  test("offers no button where this copy cannot install it", () => {
    // A development build or a package-managed one: a button would only fail.
    const status = withUpdate({ state: "unavailable", message: "this is a development build" });
    expect(labels(menuFor(status))).toContain("wave 0.2.0 is available");
    expect(labels(menuFor(status))).not.toContain("Install update now");
  });

  test("says nothing when there is nothing newer", () => {
    const status = withUpdate({ available: null });
    expect(tooltipFor(status)).not.toContain("Update");
    expect(actionForId(status, Ids.update)).toBeNull();
    expect(menuFor(status).some((entry) => entry.id === Ids.update)).toBe(false);
  });
});
