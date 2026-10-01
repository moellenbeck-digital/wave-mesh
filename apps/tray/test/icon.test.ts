import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { APP_DIR, faviconIco, faviconSvg } from "../../../scripts/icon.ts";
import { iconPixmap } from "../src/icon.ts";
import { crc32, pngFromPixmap } from "../src/png.ts";

const pixel = (icon: ReturnType<typeof iconPixmap>, x: number, y: number) => {
  const at = (y * icon.width + x) * 4;
  return Array.from(icon.data.subarray(at, at + 4));
};

describe("the mark", () => {
  test("is a disc: the corners are transparent, the edge of the disc is not", () => {
    const icon = iconPixmap("connected", 22);
    expect(pixel(icon, 0, 0)[0]).toBe(0);
    expect(pixel(icon, 21, 21)[0]).toBe(0);
    expect(pixel(icon, 11, 20)[0]).toBe(255);
  });

  test("the state is the colour of the disc", () => {
    // Just inside the edge on the left, clear of the figure.
    const [, r, g, b] = pixel(iconPixmap("connecting", 22), 2, 11);
    expect([r, g, b]).toEqual([0xd9, 0x9a, 0x14]);
    expect(pixel(iconPixmap("off", 22), 2, 11).slice(1)).toEqual([0x7c, 0x8b, 0x9a]);
  });

  test("the top node is white in every state", () => {
    for (const state of ["connected", "connecting", "off"] as const) {
      expect(pixel(iconPixmap(state, 22), 11, 4)).toEqual([255, 255, 255, 255]);
    }
  });

  test("is drawn at the size asked for, not scaled", () => {
    for (const size of [16, 22, 36, 44]) {
      const icon = iconPixmap("off", size);
      expect([icon.width, icon.height, icon.data.length]).toEqual([size, size, size * size * 4]);
    }
  });
});

describe("the PNG", () => {
  test("holds the pixels in RGBA, the order PNG stores", () => {
    const icon = iconPixmap("connecting", 16);
    const png = pngFromPixmap(icon);
    const view = new DataView(png.buffer);
    expect(Array.from(png.subarray(1, 4))).toEqual([0x50, 0x4e, 0x47]);
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([16, 16]);

    const idatLength = view.getUint32(33);
    const raw = inflateSync(png.subarray(41, 41 + idatLength));
    const row = 11 * (16 * 4 + 1);
    const [a, r, g, b] = pixel(icon, 2, 11);
    expect(Array.from(raw.subarray(row + 1 + 2 * 4, row + 1 + 3 * 4))).toEqual([r, g, b, a] as number[]);
  });

  test("every chunk carries a checksum over its type and body", () => {
    const png = pngFromPixmap(iconPixmap("off", 16));
    const view = new DataView(png.buffer);
    for (let at = 8; at < png.length; ) {
      const length = view.getUint32(at);
      expect(view.getUint32(at + 8 + length)).toBe(crc32(png.subarray(at + 4, at + 8 + length)));
      at += 12 + length;
    }
  });
});

// The favicon is generated from the same geometry and checked in; this is
// what keeps it from quietly staying on an old drawing. `bun scripts/icon.ts`
// rewrites both.
describe("the web app's favicon", () => {
  test("icon.svg is what the geometry draws", () => {
    expect(readFileSync(join(APP_DIR, "icon.svg"), "utf8")).toBe(faviconSvg());
  });

  test("favicon.ico is what the geometry draws", () => {
    expect(Array.from(readFileSync(join(APP_DIR, "favicon.ico")))).toEqual(Array.from(faviconIco()));
  });
});
