import type { WindowView } from "./window-view.ts";

/**
 * The Windows card, worked out as geometry before a single GDI call.
 *
 * Windows draws nothing of this for us. GTK has a stylesheet and AppKit has
 * NSStackView; here every rectangle has to be named, so the whole layout is a
 * pure function of the view and the display scale -- which is also the only way
 * to check it without a Windows machine, the same split win32-layout.ts makes
 * between bytes and calls.
 *
 * The metrics and the palette are the ones in the GTK stylesheet and in
 * window-macos.ts, so the three platforms stay recognisably one design. Change
 * a constant here and the card stops matching the other two.
 */

/** The GTK stylesheet's colours. */
export const PALETTE = {
  card: "#14161f",
  border: "#262b3b",
  text: "#d7dbe8",
  muted: "#7f88a3",
  active: "#232838",
  offline: "#5c6480",
  /** The wave accent rather than the system's, so the switch belongs here. */
  accent: "#0f6e6e",
  /** A switch that is off: visible against the card, quiet next to the accent. */
  track: "#3a4055",
  knob: "#e8ecf7",
  /** A service, the one thing on the card that opens something elsewhere. */
  service: "#7ecfcf",
} as const;

export const WIDTH = 420;
/** Clear of the taskbar without floating off into the middle of the screen. */
export const EDGE_MARGIN = 12;
export const CORNER = 12;
const PAD = 20;
const RULE = 1;
const BEFORE_RULE = 16;
const AFTER_RULE = 12;
const HEADER_GAP = 2;
const AFTER_SECTION = 6;
const TITLE_HEIGHT = 28;
const SUBTITLE_HEIGHT = 15;
const SECTION_HEIGHT = 14;
const ROW_HEIGHT = 48;
/** A service line: one name and its address, so it is shorter than a machine. */
const SERVICE_HEIGHT = 30;
/** The triangle that folds a machine's services out; drawn, like everything. */
const CHEVRON_WIDTH = 14;
const ROW_GAP = 2;
const ROW_INSET = 8;
const ROW_GAP_X = 10;
/** Wide enough for the switch, which is the wider of the two trailing views. */
const TRAILING_WIDTH = 38;
/** Past this the machine list scrolls rather than the card growing. */
export const MAX_LIST_HEIGHT = 300;

const CONTENT_WIDTH = WIDTH - PAD * 2;
const TEXT_WIDTH = CONTENT_WIDTH - ROW_INSET * 2 - TRAILING_WIDTH - ROW_GAP_X;
/**
 * How much of a machine's first line the name gets before the path begins.
 *
 * The other two platforms hide the path in a tooltip. There is no tooltip here
 * -- everything in this window is drawn by hand, and a tooltip control would be
 * a second window with its own message plumbing -- so the path is written on
 * the row instead, right-aligned. Both halves are ellipsised, so a long name
 * and a long path cannot collide; without measuring text there is no better
 * division than a fixed one.
 */
const NAME_SHARE = 0.55;

const SWITCH_WIDTH = 38;
const SWITCH_HEIGHT = 22;
/** The disc inside the track, with 2px of track left around it. */
const KNOB = SWITCH_HEIGHT - 4;
const COPY_SIZE = 24;
const ROW_CORNER = 8;

/** Everything above the connections, and what stands between the two lists. */
const HEADER_HEIGHT = TITLE_HEIGHT + HEADER_GAP + SUBTITLE_HEIGHT;
const SECTION_BREAK = BEFORE_RULE + RULE + AFTER_RULE + SECTION_HEIGHT + AFTER_SECTION;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type FontRole = "title" | "subtitle" | "section" | "row" | "detail";

/** Which font each role is drawn in; sizes are the ones AppKit is given. */
export const FONTS: Record<FontRole, { size: number; bold: boolean }> = {
  title: { size: 20, bold: true },
  subtitle: { size: 10, bold: true },
  section: { size: 10, bold: true },
  row: { size: 13, bold: true },
  detail: { size: 11, bold: false },
};

export type Paint =
  | (Rect & { kind: "fill"; colour?: string; border?: string; radius?: number })
  | (Rect & { kind: "text"; text: string; font: FontRole; colour: string; align: "left" | "right" })
  | (Rect & { kind: "switch"; on: boolean })
  | (Rect & { kind: "copy" });

export type WindowAction =
  | { kind: "toggle"; controlUrl: string; connect: boolean }
  | { kind: "copy"; text: string }
  /** Fold a machine's services out, or away again. */
  | { kind: "expand"; key: string }
  /** Open a service in a browser. */
  | { kind: "open"; url: string };

export interface Hit extends Rect {
  action: WindowAction;
}

export interface WindowLayout {
  width: number;
  height: number;
  /** Everything outside the machine list. */
  chrome: Paint[];
  /** The machine rows, already shifted by the scroll offset. */
  list: Paint[];
  /** What the list is clipped to; rows are drawn inside it and nowhere else. */
  clip: Rect;
  /** How far the list can be scrolled. Zero when it fits. */
  maxScroll: number;
  hits: Hit[];
}

/** The height `count` stacked rows take. No rows is no height, not one row. */
const rowsHeight = (count: number): number => (count === 0 ? 0 : count * ROW_HEIGHT + (count - 1) * ROW_GAP);

/**
 * The machine list as it is stacked: a machine, and under it its services when
 * they are folded out.
 *
 * Flattened before anything is measured, because the rows are no longer all
 * the same height and every `top` after the first one depends on the ones
 * above it.
 */
type ListRow =
  | { kind: "machine"; row: WindowView["machines"][number]; height: number }
  | {
      kind: "service";
      service: WindowView["machines"][number]["services"][number];
      height: number;
    };

const listRowsOf = (view: WindowView, expanded: ReadonlySet<string>): ListRow[] =>
  view.machines.flatMap((row): ListRow[] => [
    { kind: "machine", row, height: ROW_HEIGHT },
    ...(expanded.has(row.key)
      ? row.services.map((service): ListRow => ({ kind: "service", service, height: SERVICE_HEIGHT }))
      : []),
  ]);

const stackHeight = (rows: ListRow[]): number =>
  rows.length === 0 ? 0 : rows.reduce((sum, row) => sum + row.height, 0) + (rows.length - 1) * ROW_GAP;

const text = (
  rect: Rect,
  content: string,
  font: FontRole,
  colour: string,
  align: "left" | "right" = "left",
): Paint => ({ kind: "text", ...rect, text: content, font, colour, align });

/**
 * The whole card, in device pixels.
 *
 * `scroll` is in the same units and is clamped here rather than by the caller:
 * the layout is the only place that knows how tall the list turned out.
 */
export function windowLayout(
  view: WindowView,
  options: { scale: number; scroll: number; expanded?: ReadonlySet<string> },
): WindowLayout {
  const chrome: Paint[] = [];
  const list: Paint[] = [];
  const hits: Hit[] = [];

  const expanded = options.expanded ?? new Set<string>();
  const rows = listRowsOf(view, expanded);
  // An empty machine list is not empty: it carries the line that says why.
  const stacked = Math.max(stackHeight(rows), ROW_HEIGHT);
  const listHeight = Math.min(stacked, MAX_LIST_HEIGHT);
  const maxScroll = stacked - listHeight;
  const scroll = Math.min(Math.max(options.scroll, 0), maxScroll);
  const height =
    PAD +
    HEADER_HEIGHT +
    SECTION_BREAK +
    rowsHeight(view.connections.length) +
    SECTION_BREAK +
    listHeight +
    PAD;

  chrome.push({
    kind: "fill",
    x: 0,
    y: 0,
    w: WIDTH,
    h: height,
    colour: PALETTE.card,
    border: PALETTE.border,
    radius: CORNER,
  });

  let y = PAD;
  chrome.push(text({ x: PAD, y, w: CONTENT_WIDTH, h: TITLE_HEIGHT }, view.title, "title", PALETTE.text));
  y += TITLE_HEIGHT + HEADER_GAP;
  chrome.push(
    text(
      { x: PAD, y, w: CONTENT_WIDTH, h: SUBTITLE_HEIGHT },
      view.subtitle.toUpperCase(),
      "subtitle",
      PALETTE.muted,
    ),
  );
  y += SUBTITLE_HEIGHT;

  y = sectionBreak(chrome, y, "CONNECTIONS");
  view.connections.forEach((row, index) => {
    const top = y + index * (ROW_HEIGHT + ROW_GAP);
    connectionRow(chrome, hits, row, top);
  });
  y += rowsHeight(view.connections.length);

  y = sectionBreak(chrome, y, "MACHINES");
  const clip = { x: PAD, y, w: CONTENT_WIDTH, h: listHeight };

  if (view.machines.length === 0) {
    list.push(
      text(
        { x: PAD + ROW_INSET, y: y + (ROW_HEIGHT - 16) / 2, w: CONTENT_WIDTH - ROW_INSET * 2, h: 16 },
        view.emptyMachines,
        "detail",
        PALETTE.muted,
      ),
    );
  }
  let rowTop = y - scroll;
  for (const entry of rows) {
    const top = rowTop;
    rowTop += entry.height + ROW_GAP;
    // Rows above or below the window are not drawn at all; clipping keeps the
    // half-visible ones inside the list, and dropping the rest keeps the paint
    // list short on a wave with many machines.
    if (top + entry.height < y || top > y + listHeight) continue;
    if (entry.kind === "machine") {
      machineRow(list, hits, entry.row, top, clip, view.labelMachines, expanded.has(entry.row.key));
    } else serviceRow(list, hits, entry.service, top, clip);
  }

  return {
    width: scaleValue(WIDTH, options.scale),
    height: scaleValue(height, options.scale),
    chrome: chrome.map((paint) => scalePaint(paint, options.scale)),
    list: list.map((paint) => scalePaint(paint, options.scale)),
    clip: scaleRect(clip, options.scale),
    maxScroll,
    hits: hits.map((hit) => ({ ...scaleRect(hit, options.scale), action: hit.action })),
  };
}

/** The hairline and the heading that separate one list from the next. */
function sectionBreak(chrome: Paint[], top: number, heading: string): number {
  let y = top + BEFORE_RULE;
  chrome.push({ kind: "fill", x: PAD, y, w: CONTENT_WIDTH, h: RULE, colour: PALETTE.border });
  y += RULE + AFTER_RULE;
  chrome.push(text({ x: PAD, y, w: CONTENT_WIDTH, h: SECTION_HEIGHT }, heading, "section", PALETTE.muted));
  return y + SECTION_HEIGHT + AFTER_SECTION;
}

function connectionRow(
  chrome: Paint[],
  hits: Hit[],
  row: WindowView["connections"][number],
  top: number,
): void {
  if (row.connected) {
    chrome.push({
      kind: "fill",
      x: PAD,
      y: top,
      w: CONTENT_WIDTH,
      h: ROW_HEIGHT,
      colour: PALETTE.active,
      radius: ROW_CORNER,
    });
  }
  chrome.push(text({ x: PAD + ROW_INSET, y: top + 7, w: TEXT_WIDTH, h: 18 }, row.label, "row", PALETTE.text));
  chrome.push(
    text({ x: PAD + ROW_INSET, y: top + 25, w: TEXT_WIDTH, h: 16 }, row.detail, "detail", PALETTE.muted),
  );

  const trailing = {
    x: PAD + CONTENT_WIDTH - ROW_INSET - TRAILING_WIDTH,
    y: top,
    w: TRAILING_WIDTH,
    h: ROW_HEIGHT,
  };
  chrome.push({
    kind: "switch",
    x: trailing.x,
    y: top + (ROW_HEIGHT - SWITCH_HEIGHT) / 2,
    w: SWITCH_WIDTH,
    h: SWITCH_HEIGHT,
    on: row.connected,
  });
  // The whole trailing column, not just the switch: a 38x22 target is small,
  // and there is nothing else in that column to hit by mistake. A busy
  // connection still takes the click -- the daemon is the one that decides
  // what a second `up` means, and it already guards against two of them.
  hits.push({
    ...trailing,
    action: { kind: "toggle", controlUrl: row.controlUrl, connect: !row.connected },
  });
}

function machineRow(
  list: Paint[],
  hits: Hit[],
  row: WindowView["machines"][number],
  top: number,
  clip: Rect,
  labelled: boolean,
  expanded: boolean,
): void {
  const hasServices = row.services.length > 0;
  // The triangle takes its width out of the text's, so every row's name still
  // starts in the same place and the path still ends where the others do.
  const textWidth = hasServices ? TEXT_WIDTH - CHEVRON_WIDTH - ROW_GAP_X : TEXT_WIDTH;
  const nameWidth = Math.round(textWidth * NAME_SHARE);
  const name = labelled ? `${row.hostname}  ·  ${row.waveLabel}` : row.hostname;
  list.push(
    text(
      { x: PAD + ROW_INSET, y: top + 7, w: nameWidth, h: 18 },
      name,
      "row",
      row.online ? PALETTE.text : PALETTE.offline,
    ),
  );
  list.push(
    text(
      { x: PAD + ROW_INSET + nameWidth, y: top + 8, w: textWidth - nameWidth, h: 16 },
      row.path,
      "detail",
      PALETTE.muted,
      "right",
    ),
  );
  list.push(
    text(
      { x: PAD + ROW_INSET, y: top + 25, w: textWidth, h: 16 },
      hasServices
        ? `${row.address} · ${row.services.length} ${row.services.length === 1 ? "service" : "services"}`
        : `${row.address} · ${row.dnsName}`,
      "detail",
      PALETTE.muted,
    ),
  );

  const copy = {
    x: PAD + CONTENT_WIDTH - ROW_INSET - TRAILING_WIDTH + (TRAILING_WIDTH - COPY_SIZE) / 2,
    y: top + (ROW_HEIGHT - COPY_SIZE) / 2,
    w: COPY_SIZE,
    h: COPY_SIZE,
  };
  list.push({ kind: "copy", ...copy });
  // Only a button that is wholly inside the list can be pressed. A half-scrolled
  // row is drawn clipped, and a click on the sliver of it that shows would
  // otherwise copy a name the user cannot see.
  if (copy.y >= clip.y && copy.y + copy.h <= clip.y + clip.h) {
    hits.push({ ...copy, action: { kind: "copy", text: row.dnsName } });
  }

  if (!hasServices) return;
  list.push(
    text(
      {
        x: PAD + CONTENT_WIDTH - ROW_INSET - TRAILING_WIDTH - ROW_GAP_X - CHEVRON_WIDTH,
        y: top + (ROW_HEIGHT - 16) / 2,
        w: CHEVRON_WIDTH,
        h: 16,
      },
      expanded ? "▾" : "▸",
      "detail",
      PALETTE.muted,
    ),
  );
  // Everything but the trailing column: "click the machine" is the whole row,
  // and the one thing in it that means something else is the copy button.
  const press = {
    x: PAD,
    y: top,
    w: CONTENT_WIDTH - ROW_INSET - TRAILING_WIDTH,
    h: ROW_HEIGHT,
  };
  if (press.y >= clip.y && press.y + press.h <= clip.y + clip.h) {
    hits.push({ ...press, action: { kind: "expand", key: row.key } });
  }
}

/**
 * A service under the machine that fronts it. The whole line opens it.
 *
 * Indented past the machine's text, so it reads as belonging to the row above
 * rather than as another machine.
 */
function serviceRow(
  list: Paint[],
  hits: Hit[],
  service: WindowView["machines"][number]["services"][number],
  top: number,
  clip: Rect,
): void {
  const x = PAD + ROW_INSET * 2;
  const width = CONTENT_WIDTH - ROW_INSET * 3;
  const addressWidth = Math.round(width * (1 - NAME_SHARE));
  list.push(text({ x, y: top + 7, w: width - addressWidth, h: 16 }, service.url, "detail", PALETTE.service));
  list.push(
    text(
      { x: x + width - addressWidth, y: top + 7, w: addressWidth, h: 16 },
      service.address,
      "detail",
      PALETTE.muted,
      "right",
    ),
  );

  const press = { x: PAD, y: top, w: CONTENT_WIDTH, h: SERVICE_HEIGHT };
  if (press.y >= clip.y && press.y + press.h <= clip.y + clip.h) {
    hits.push({ ...press, action: { kind: "open", url: service.url } });
  }
}

/** What the press at these client coordinates was asking for, if anything. */
export function hitTest(layout: WindowLayout, x: number, y: number): WindowAction | null {
  for (const hit of layout.hits) {
    if (x >= hit.x && x < hit.x + hit.w && y >= hit.y && y < hit.y + hit.h) return hit.action;
  }
  return null;
}

/**
 * The knob inside a switch: right when it is on, left when it is off.
 *
 * Its own function because it is the one piece of the card whose position says
 * something, and getting it wrong looks like a switch that never moves.
 */
export function switchKnob(track: Rect, on: boolean, scale = 1): Rect {
  const size = scaleValue(KNOB, scale);
  const inset = Math.round((track.h - size) / 2);
  return {
    x: on ? track.x + track.w - size - inset : track.x + inset,
    y: track.y + inset,
    w: size,
    h: size,
  };
}

const scaleValue = (value: number, scale: number): number => Math.round(value * scale);

const scaleRect = (rect: Rect, scale: number): Rect => ({
  x: scaleValue(rect.x, scale),
  y: scaleValue(rect.y, scale),
  w: scaleValue(rect.w, scale),
  h: scaleValue(rect.h, scale),
});

function scalePaint(paint: Paint, scale: number): Paint {
  const scaled = { ...paint, ...scaleRect(paint, scale) };
  if (scaled.kind === "fill" && scaled.radius !== undefined) {
    scaled.radius = scaleValue(scaled.radius, scale);
  }
  return scaled;
}
