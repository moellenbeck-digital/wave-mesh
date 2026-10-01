import { deflateSync } from "node:zlib";

/**
 * A pixmap as PNG bytes.
 *
 * macOS builds its menu bar image from encoded data (`-[NSImage initWithData:]`)
 * rather than from raw pixels, which would need an NSBitmapImageRep and an
 * eleven-argument initialiser over the FFI boundary. Encoding a 36-pixel image
 * is a few lines; that call would be the riskiest one in the bindings.
 *
 * Takes ARGB32 big-endian, as iconPixmap draws it, and writes RGBA, as PNG
 * stores it -- this is the one place that reordering happens for PNG.
 */
export function pngFromPixmap(pixmap: { width: number; height: number; data: Uint8Array }): Uint8Array {
  const { width, height, data } = pixmap;
  // Each row starts with its filter type; 0 is none.
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 4;
      const to = row + 1 + x * 4;
      raw[to] = data[from + 1] ?? 0;
      raw[to + 1] = data[from + 2] ?? 0;
      raw[to + 2] = data[from + 3] ?? 0;
      raw[to + 3] = data[from] ?? 0;
    }
  }

  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // bits per channel
  header[9] = 6; // colour type: RGBA
  // compression, filter and interlace stay 0

  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/**
 * PNGs packed into an .ico, which every browser and Windows since Vista read.
 * One image per size, each drawn at that size rather than scaled, for the same
 * reason the tray draws its own sizes. Smallest first.
 */
export function icoFromPngs(images: Array<{ size: number; png: Uint8Array }>): Uint8Array {
  const header = new Uint8Array(6 + 16 * images.length);
  const view = new DataView(header.buffer);
  view.setUint16(2, 1, true); // type: icon
  view.setUint16(4, images.length, true);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const entry = 6 + 16 * i;
    header[entry] = size >= 256 ? 0 : size; // width; 0 means 256
    header[entry + 1] = size >= 256 ? 0 : size;
    view.setUint16(entry + 4, 1, true); // colour planes
    view.setUint16(entry + 6, 32, true); // bits per pixel
    view.setUint32(entry + 8, png.length, true);
    view.setUint32(entry + 12, offset, true);
    offset += png.length;
  });
  return concat([header, ...images.map((image) => image.png)]);
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
