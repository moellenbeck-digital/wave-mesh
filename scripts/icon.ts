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
import { icoFromPngs, pngFromPixmap } from "../apps/tray/src/png.ts";

export const APP_DIR = join(import.meta.dir, "..", "apps", "web", "src", "app");

/** The sizes a browser or the OS asks an .ico for, smallest first. */
const ICO_SIZES = [16, 32, 48];

export const faviconIco = (): Uint8Array =>
  icoFromPngs(ICO_SIZES.map((size) => ({ size, png: pngFromPixmap(markPixmap(BRAND_COLOUR, size)) })));

export const faviconSvg = (): string => markSvg(BRAND_COLOUR);

if (import.meta.main) {
  writeFileSync(join(APP_DIR, "icon.svg"), faviconSvg());
  writeFileSync(join(APP_DIR, "favicon.ico"), faviconIco());
  console.log(`wrote icon.svg and favicon.ico to ${APP_DIR}`);
}
