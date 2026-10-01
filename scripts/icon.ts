/**
 * Writes the web app's favicon from the tray's geometry.
 *
 *   bun scripts/icon.ts
 *
 * The mark is defined once, in apps/tray/src/icon.ts. This turns it into the
 * two files Next.js picks up by name -- `app/icon.svg` for browsers that take
 * SVG, `app/favicon.ico` for the rest -- and apps/tray/test/icon.test.ts fails
 * when the checked-in files no longer match, so a change to the geometry cannot
 * leave the browser showing the old one.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND_COLOUR, markPixmap, markSvg } from "../apps/tray/src/icon.ts";
import { concat, pngFromPixmap } from "../apps/tray/src/png.ts";

export const APP_DIR = join(import.meta.dir, "..", "apps", "web", "src", "app");

/** The sizes a browser or the OS asks an .ico for, smallest first. */
const ICO_SIZES = [16, 32, 48];

/**
 * An .ico holding PNGs, which every browser and Windows since Vista read. One
 * image per size, drawn at that size rather than scaled, for the same reason
 * the tray draws its own sizes.
 */
export function faviconIco(): Uint8Array {
  const images = ICO_SIZES.map((size) => pngFromPixmap(markPixmap(BRAND_COLOUR, size)));
  const header = new Uint8Array(6 + 16 * images.length);
  const view = new DataView(header.buffer);
  view.setUint16(2, 1, true); // type: icon
  view.setUint16(4, images.length, true);
  let offset = header.length;
  images.forEach((image, i) => {
    const entry = 6 + 16 * i;
    const size = ICO_SIZES[i] ?? 0;
    header[entry] = size; // width; 0 would mean 256
    header[entry + 1] = size;
    view.setUint16(entry + 4, 1, true); // colour planes
    view.setUint16(entry + 6, 32, true); // bits per pixel
    view.setUint32(entry + 8, image.length, true);
    view.setUint32(entry + 12, offset, true);
    offset += image.length;
  });
  return concat([header, ...images]);
}

export const faviconSvg = (): string => markSvg(BRAND_COLOUR);

if (import.meta.main) {
  writeFileSync(join(APP_DIR, "icon.svg"), faviconSvg());
  writeFileSync(join(APP_DIR, "favicon.ico"), faviconIco());
  console.log(`wrote icon.svg and favicon.ico to ${APP_DIR}`);
}
