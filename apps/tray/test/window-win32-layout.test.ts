import { describe, expect, test } from "bun:test";
import type { WindowView } from "../src/window-view.ts";
import {
  hitTest,
  MAX_LIST_HEIGHT,
  PALETTE,
  type Paint,
  switchKnob,
  WIDTH,
  type WindowLayout,
  windowLayout,
} from "../src/window-win32-layout.ts";

const connection = (label: string, connected: boolean) => ({
  controlUrl: `https://${label}`,
  label,
  connected,
  busy: false,
  detail: connected ? "10.77.0.1" : "not connected",
});

const service = (name: string) => ({
  key: `k/${name}`,
  label: `${name}.rl.wave.internal`,
  url: `https://${name}.rl.wave.internal`,
  address: "10.77.0.4",
});

const machine = (hostname: string, online = true, services: ReturnType<typeof service>[] = []) => ({
  key: `k/${hostname}`,
  hostname,
  address: "10.77.0.2",
  dnsName: `${hostname}.rl.wave.internal`,
  path: "direct 192.168.1.5 · 16 ms",
  online,
  waveLabel: "wave-mesh-1",
  services,
});

const view = (overrides: Partial<WindowView> = {}): WindowView => ({
  title: "laptop",
  subtitle: "10.77.0.1",
  connections: [connection("one", true)],
  machines: [machine("desktop")],
  labelMachines: false,
  emptyMachines: "No other machines in this wave yet.",
  ...overrides,
});

const lay = (input: WindowView, scroll = 0, scale = 1): WindowLayout =>
  windowLayout(input, { scale, scroll });

const texts = (paints: Paint[]): string[] =>
  paints.flatMap((paint) => (paint.kind === "text" ? [paint.text] : []));

describe("the card's shape", () => {
  test("grows by a row for each connection and each machine", () => {
    const one = lay(view());
    const more = lay(view({ connections: [connection("one", true), connection("two", false)] }));
    // A row and the gap above it; the same arithmetic the Cocoa card does.
    expect(more.height - one.height).toBe(50);
  });

  test("stops growing once the machine list would push the card off-screen", () => {
    const many = lay(view({ machines: Array.from({ length: 40 }, (_, i) => machine(`m${i}`)) }));
    const few = lay(view({ machines: [machine("a"), machine("b")] }));
    expect(many.clip.h).toBe(MAX_LIST_HEIGHT);
    expect(many.height - few.height).toBe(MAX_LIST_HEIGHT - (48 * 2 + 2));
    expect(many.maxScroll).toBeGreaterThan(0);
  });

  test("an empty list keeps a row's worth of height and says why it is empty", () => {
    const empty = lay(view({ machines: [] }));
    expect(empty.clip.h).toBe(48);
    expect(empty.maxScroll).toBe(0);
    expect(texts(empty.list)).toEqual(["No other machines in this wave yet."]);
  });

  test("the subtitle is shouted, as it is on the other two platforms", () => {
    expect(texts(lay(view()).chrome)).toContain("10.77.0.1".toUpperCase());
    expect(texts(lay(view()).chrome)).toContain("CONNECTIONS");
    expect(texts(lay(view()).chrome)).toContain("MACHINES");
  });

  test("only a connected wave gets the lit background", () => {
    const fills = (input: WindowView) =>
      lay(input).chrome.filter((paint) => paint.kind === "fill" && paint.colour === PALETTE.active);
    expect(fills(view())).toHaveLength(1);
    expect(fills(view({ connections: [connection("one", false)] }))).toHaveLength(0);
  });

  test("a machine that is not reachable is written in the quieter colour", () => {
    const offline = lay(view({ machines: [machine("desktop", false)] }));
    const name = offline.list.find((paint) => paint.kind === "text" && paint.text === "desktop");
    expect(name).toMatchObject({ colour: PALETTE.offline });
  });

  test("the wave is named on a machine only once two of them could collide", () => {
    expect(texts(lay(view()).list)).toContain("desktop");
    expect(texts(lay(view({ labelMachines: true })).list)).toContain("desktop  ·  wave-mesh-1");
  });

  test("the path is written on the row, because there is no tooltip to hide it in", () => {
    const paints = lay(view()).list;
    const path = paints.find((paint) => paint.kind === "text" && paint.text.startsWith("direct"));
    // Right-aligned on the first line, so a long name runs into an ellipsis
    // rather than into the path.
    expect(path).toMatchObject({ align: "right" });
  });
});

describe("scale", () => {
  test("every rectangle is in device pixels, so a 200% display gets a full-size card", () => {
    const plain = lay(view());
    const doubled = lay(view(), 0, 2);
    expect(plain.width).toBe(WIDTH);
    expect(doubled.width).toBe(WIDTH * 2);
    expect(doubled.height).toBe(plain.height * 2);
    expect(doubled.hits[0]?.x).toBe((plain.hits[0]?.x ?? 0) * 2);
  });

  test("the scroll offset is not scaled: it is what the layout clamps", () => {
    const many = view({ machines: Array.from({ length: 40 }, (_, i) => machine(`m${i}`)) });
    expect(lay(many, 0, 2).maxScroll).toBe(lay(many).maxScroll);
  });
});

describe("what a click lands on", () => {
  test("the switch asks for the opposite of what the wave is doing", () => {
    const connected = lay(view());
    const hit = connected.hits[0];
    expect(hit?.action).toEqual({ kind: "toggle", controlUrl: "https://one", connect: false });
    expect(hitTest(connected, (hit?.x ?? 0) + 4, (hit?.y ?? 0) + 4)).toEqual(hit?.action ?? null);

    const down = lay(view({ connections: [connection("one", false)] }));
    expect(down.hits[0]?.action).toMatchObject({ connect: true });
  });

  test("the copy button carries the name, not the address", () => {
    // The address is assigned by the wave and can change; the name keeps
    // pointing at the machine.
    const layout = lay(view());
    const copy = layout.hits.find((hit) => hit.action.kind === "copy");
    expect(copy?.action).toEqual({ kind: "copy", text: "desktop.rl.wave.internal" });
    expect(hitTest(layout, (copy?.x ?? 0) + 2, (copy?.y ?? 0) + 2)).toEqual(copy?.action ?? null);
  });

  test("the card itself is not a button", () => {
    expect(hitTest(lay(view()), 2, 2)).toBeNull();
  });

  test("a row scrolled half out of the list cannot be pressed", () => {
    const many = view({ machines: Array.from({ length: 10 }, (_, i) => machine(`m${i}`)) });
    const copies = (scroll: number) =>
      lay(many, scroll).hits.filter((hit) => hit.action.kind === "copy").length;
    // Six rows fit in 300px; a scroll of half a row leaves one of them cut.
    expect(copies(0)).toBe(6);
    expect(copies(25)).toBe(5);
  });

  test("rows scrolled out of sight are not drawn at all", () => {
    const many = view({ machines: Array.from({ length: 40 }, (_, i) => machine(`m${i}`)) });
    expect(texts(lay(many, 0).list)).toContain("m0");
    expect(texts(lay(many, 400).list)).not.toContain("m0");
  });

  test("the scroll offset is clamped where the list ends", () => {
    const many = view({ machines: Array.from({ length: 40 }, (_, i) => machine(`m${i}`)) });
    const far = lay(many, 10_000);
    const last = lay(many, far.maxScroll);
    expect(texts(far.list)).toEqual(texts(last.list));
    expect(texts(far.list)).toContain("m39");
  });
});

describe("the switch's knob", () => {
  test("sits on the side that says what the switch means", () => {
    const track = { x: 100, y: 10, w: 38, h: 22 };
    const on = switchKnob(track, true);
    const off = switchKnob(track, false);
    expect(off.x).toBeLessThan(on.x);
    // Symmetric: the same inset from either end, and inside the track either way.
    expect(off.x - track.x).toBe(track.x + track.w - (on.x + on.w));
    expect(on.h).toBeLessThan(track.h);
  });

  test("is measured in device pixels like everything else", () => {
    const doubled = switchKnob({ x: 0, y: 0, w: 76, h: 44 }, false, 2);
    expect(doubled.w).toBe(36);
  });
});

describe("the services under a machine", () => {
  const connector = view({
    machines: [machine("desktop"), machine("connector", true, [service("grafana"), service("git")])],
  });

  test("are not in the card until the machine is opened", () => {
    const folded = windowLayout(connector, { scale: 1, scroll: 0 });
    const texts = folded.list.filter((paint) => paint.kind === "text").map((paint) => paint.text);
    expect(texts).not.toContain("https://grafana.rl.wave.internal");
    // The count stands where the name would: what is under the row, not a
    // second copy of the row's own name.
    expect(texts.some((text) => text.includes("2 services"))).toBe(true);
    expect(texts).toContain("▸");
  });

  test("and are there, with their addresses, once it is", () => {
    const open = windowLayout(connector, { scale: 1, scroll: 0, expanded: new Set(["k/connector"]) });
    const texts = open.list.filter((paint) => paint.kind === "text").map((paint) => paint.text);
    expect(texts).toContain("https://grafana.rl.wave.internal");
    expect(texts).toContain("https://git.rl.wave.internal");
    expect(texts).toContain("▾");
  });

  test("the card grows by exactly the rows it gained", () => {
    const folded = windowLayout(connector, { scale: 1, scroll: 0 });
    const open = windowLayout(connector, { scale: 1, scroll: 0, expanded: new Set(["k/connector"]) });
    // Two service rows and the gap above each of them.
    expect(open.height - folded.height).toBe(2 * (30 + 2));
  });

  test("a press on the machine folds it out, and the copy button still copies", () => {
    const folded = windowLayout(connector, { scale: 1, scroll: 0 });
    const row = folded.hits.find((hit) => hit.action.kind === "expand");
    expect(row?.action).toEqual({ kind: "expand", key: "k/connector" });
    expect(hitTest(folded, (row?.x ?? 0) + 4, (row?.y ?? 0) + 4)).toEqual({
      kind: "expand",
      key: "k/connector",
    });

    // The trailing column is the copy button's and stays that way: the press
    // area for the row deliberately stops short of it.
    const copy = folded.hits.find((hit) => hit.action.kind === "copy");
    expect(hitTest(folded, (copy?.x ?? 0) + 2, (copy?.y ?? 0) + 2)?.kind).toBe("copy");
  });

  test("a machine without services offers no press at all", () => {
    const folded = windowLayout(view({ machines: [machine("desktop")] }), { scale: 1, scroll: 0 });
    expect(folded.hits.some((hit) => hit.action.kind === "expand")).toBe(false);
  });

  test("a press on a service asks for it to be opened", () => {
    const open = windowLayout(connector, { scale: 1, scroll: 0, expanded: new Set(["k/connector"]) });
    const hit = open.hits.find((h) => h.action.kind === "open");
    expect(hit?.action).toEqual({ kind: "open", url: "https://grafana.rl.wave.internal" });
    expect(hitTest(open, (hit?.x ?? 0) + 4, (hit?.y ?? 0) + 4)).toEqual({
      kind: "open",
      url: "https://grafana.rl.wave.internal",
    });
  });

  test("and a service scrolled half out of the list cannot be pressed", () => {
    const many = view({
      machines: [
        ...Array.from({ length: 6 }, (_, index) => machine(`m${index}`)),
        machine("connector", true, [service("grafana")]),
      ],
    });
    const open = windowLayout(many, { scale: 1, scroll: 0, expanded: new Set(["k/connector"]) });
    expect(open.maxScroll).toBeGreaterThan(0);
    // Nothing that is not wholly inside the clip may be a target -- the same
    // rule the copy button follows, for the same reason.
    for (const hit of open.hits.filter((h) => h.action.kind === "open")) {
      expect(hit.y).toBeGreaterThanOrEqual(open.clip.y);
      expect(hit.y + hit.h).toBeLessThanOrEqual(open.clip.y + open.clip.h);
    }
  });
});
