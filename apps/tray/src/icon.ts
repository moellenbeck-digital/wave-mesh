/**
 * The wave-mesh mark, drawn in code.
 *
 * Three nodes on a disc, joined into a triangle whose base is a wave: the mesh
 * and the wave in one figure. It is the tray icon on every platform and the
 * browser's favicon, and both come from the geometry below -- the tray rasters
 * it here, `scripts/icon.ts` writes the SVG and the .ico the web app serves
 * from the same numbers, and a test holds the checked-in files to them.
 *
 * Drawn rather than shipped because StatusNotifierItem, Shell_NotifyIcon and
 * NSImage all take raw pixels: no icon files to install and no dependency on
 * the user's theme having something suitable, which matters for a
 * single-binary client.
 */

export type IconState = "connected" | "connecting" | "off";

/**
 * The state is the colour of the whole mark, not a badge on it: a dot small
 * enough to sit in a 16 px icon is too small to read.
 *
 * Connected is a shade lighter than the brand petrol, which on a dark panel
 * sinks into the background.
 */
const COLOURS: Record<IconState, string> = {
  connected: "#0f7f7f",
  connecting: "#d99a14",
  off: "#7c8b9a",
};

/** The accent of the web app (`--color-accent` in globals.css). */
export const BRAND_COLOUR = "#0f6e6e";

const SIZE = 22;

/** Everything below is in a 64-unit square. */
const UNITS = 64;
const DISC = { x: 32, y: 32, r: 30 };
const TOP = { x: 32, y: 12 };
const LEFT = { x: 13, y: 43 };
const RIGHT = { x: 51, y: 43 };

interface Detail {
  stroke: number;
  node: number;
  /** Height of the wave along the base. */
  amplitude: number;
}

/**
 * At tray sizes the figure is drawn heavier: thicker lines, larger nodes and a
 * flatter wave. Drawn at the proportions that look right at 128 px, the wave
 * falls apart into crumbs at 16 and the nodes vanish into the lines.
 */
function detailFor(size: number): Detail {
  return size <= 32 ? { stroke: 4.5, node: 6.5, amplitude: 3.5 } : { stroke: 4, node: 5.5, amplitude: 5 };
}

type Point = { x: number; y: number };

/** One full period of a sine between the two lower nodes, sampled. */
function wavePoints(amplitude: number, steps = 32): Point[] {
  const points: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    points.push({
      x: LEFT.x + (RIGHT.x - LEFT.x) * t,
      y: LEFT.y - amplitude * Math.sin(t * Math.PI * 2),
    });
  }
  return points;
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Parses "#rrggbb"; the colours above are the only input. */
function rgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** Samples per pixel along each axis; sixteen in all are enough for a clean edge. */
const SUPERSAMPLE = 4;

/**
 * The mark in one colour at one size, as ARGB32 big-endian -- the byte order
 * StatusNotifierItem requires. The usual mistake is to hand over little-endian
 * data and get a colour-swapped icon; Windows and macOS convert from this one.
 */
export function markPixmap(
  colour: string,
  size: number,
): { width: number; height: number; data: Uint8Array } {
  const [r, g, b] = rgb(colour);
  const detail = detailFor(size);
  const segments: Array<[Point, Point]> = [
    [TOP, LEFT],
    [TOP, RIGHT],
  ];
  const wave = wavePoints(detail.amplitude);
  for (let i = 1; i < wave.length; i++) segments.push([wave[i - 1] as Point, wave[i] as Point]);
  const nodes = [TOP, LEFT, RIGHT];

  const data = new Uint8Array(size * size * 4);
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let disc = 0;
      let white = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const p = {
            x: ((x + (sx + 0.5) / SUPERSAMPLE) / size) * UNITS,
            y: ((y + (sy + 0.5) / SUPERSAMPLE) / size) * UNITS,
          };
          if (Math.hypot(p.x - DISC.x, p.y - DISC.y) > DISC.r) continue;
          disc++;
          const onNode = nodes.some((node) => Math.hypot(p.x - node.x, p.y - node.y) <= detail.node);
          const onLine = onNode || segments.some(([a, c]) => distanceToSegment(p, a, c) <= detail.stroke / 2);
          if (onLine) white++;
        }
      }
      const offset = (y * size + x) * 4;
      if (disc === 0) continue;
      const mix = (channel: number) => Math.round((channel * (disc - white) + 255 * white) / disc);
      data[offset] = Math.round((255 * disc) / samples);
      data[offset + 1] = mix(r);
      data[offset + 2] = mix(g);
      data[offset + 3] = mix(b);
    }
  }
  return { width: size, height: size, data };
}

/**
 * The tray icon for a state.
 *
 * The size is settable because Windows asks what a small icon is there
 * (`SM_CXSMICON`, normally 16) rather than scaling whatever it is given, and a
 * scaled icon looks it; macOS wants twice its point size for a Retina bar.
 */
export function iconPixmap(
  state: IconState,
  size: number = SIZE,
): { width: number; height: number; data: Uint8Array } {
  return markPixmap(COLOURS[state], size);
}

/**
 * The same mark as SVG, for the browser.
 *
 * Drawn with the small-size detail: a favicon is shown at 16 or 32 px nearly
 * everywhere, which is exactly where the heavier figure is needed.
 */
export function markSvg(colour: string = BRAND_COLOUR, size = 16): string {
  const detail = detailFor(size);
  const f = (n: number) => Number(n.toFixed(2)).toString();
  const wave = wavePoints(detail.amplitude)
    .map((p, i) => `${i === 0 ? "M" : "L"}${f(p.x)} ${f(p.y)}`)
    .join(" ");
  const nodes = [TOP, LEFT, RIGHT]
    .map((n) => `<circle cx="${n.x}" cy="${n.y}" r="${detail.node}"/>`)
    .join("");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${UNITS} ${UNITS}">`,
    `<circle cx="${DISC.x}" cy="${DISC.y}" r="${DISC.r}" fill="${colour}"/>`,
    `<g fill="none" stroke="#fff" stroke-width="${detail.stroke}" stroke-linecap="round" stroke-linejoin="round">`,
    `<path d="M${LEFT.x} ${LEFT.y} L${TOP.x} ${TOP.y} L${RIGHT.x} ${RIGHT.y}"/>`,
    `<path d="${wave}"/>`,
    "</g>",
    `<g fill="#fff">${nodes}</g>`,
    "</svg>",
    "",
  ].join("\n");
}
