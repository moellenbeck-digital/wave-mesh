import type { MenuEntry } from "./menu.ts";

/**
 * The byte-level half of the Windows tray: structures, strings and pixels.
 *
 * Kept apart from win32.ts because that module opens user32 and friends the
 * moment it loads, which no other platform can do -- and these are exactly the
 * parts worth testing, since a field at the wrong offset is a silent failure
 * rather than an error.
 *
 * Every layout here is LLP64: pointers are eight bytes, `long` is four. That is
 * the convention on both architectures we target (x64 and arm64), and there is
 * no 32-bit Windows build to keep in step.
 */

/** Messages, from winuser.h. */
export const WM = {
  /** The first message number applications may use for themselves. */
  app: 0x8000,
  null: 0x0000,
  destroy: 0x0002,
  close: 0x0010,
  activate: 0x0006,
  paint: 0x000f,
  eraseBackground: 0x0014,
  keyDown: 0x0100,
  lButtonUp: 0x0202,
  rButtonUp: 0x0205,
  mouseWheel: 0x020a,
  contextMenu: 0x007b,
} as const;

/** WM_ACTIVATE's low word when the window is the one being left. */
export const WA_INACTIVE = 0;
export const VK_ESCAPE = 0x1b;
/** One notch of a wheel; WM_MOUSEWHEEL reports multiples of it. */
export const WHEEL_DELTA = 120;

/** Ours, for the icon to call back on. */
export const TRAY_MESSAGE = WM.app + 1;

export const NIM = { add: 0, modify: 1, delete: 2 } as const;
export const NIF = { message: 0x01, icon: 0x02, tip: 0x04 } as const;
export const MF = { string: 0x0000, grayed: 0x0001, separator: 0x0800 } as const;
export const TPM = { leftAlign: 0x0000, rightButton: 0x0002, noNotify: 0x0080, returnCmd: 0x0100 } as const;
export const PM_REMOVE = 0x0001;
/** A top-level window that is never shown; see WindowsTray for why not HWND_MESSAGE. */
export const WS_POPUP = 0x80000000;
/** No taskbar button and no Alt-Tab entry, which is what a tray popover wants. */
export const WS_EX_TOOLWINDOW = 0x00000080;
export const WS_EX_TOPMOST = 0x00000008;
export const SW = { hide: 0, show: 5 } as const;
/** SetWindowPos: leave the z-order and the activation alone. */
export const SWP = { noZOrder: 0x0004, noActivate: 0x0010, noSize: 0x0001, noMove: 0x0002 } as const;
/** SystemParametersInfo: the screen minus the taskbar. */
export const SPI_GETWORKAREA = 0x0030;
export const CF_UNICODETEXT = 13;
/** GMEM_MOVEABLE: what SetClipboardData insists its block was allocated with. */
export const GMEM_MOVEABLE = 0x0002;
export const SRCCOPY = 0x00cc0020;
export const TRANSPARENT = 1;
export const NULL_BRUSH = 5;
export const NULL_PEN = 8;
/** IDC_ARROW, which is an integer masquerading as a pointer. */
export const IDC_ARROW = 32512;
export const PS_SOLID = 0;
export const LOGPIXELSX = 88;
export const DEFAULT_CHARSET = 1;
export const CLEARTYPE_QUALITY = 5;
export const FW = { normal: 400, bold: 700 } as const;
/** DrawText: one line, centred in its rectangle, cut with an ellipsis. */
export const DT = {
  left: 0x0000,
  right: 0x0002,
  singleLine: 0x0020,
  vCentre: 0x0004,
  endEllipsis: 0x8000,
  noPrefix: 0x0800,
} as const;
/** SM_CXSMICON: the width Windows wants a notification-area icon to be. */
export const SM_CXSMICON = 49;

/** sizeof(NOTIFYICONDATAW) on 64-bit Windows; it doubles as the version tag. */
export const NOTIFY_ICON_SIZE = 976;
/** sizeof(WNDCLASSEXW). */
export const WINDOW_CLASS_SIZE = 80;
/** sizeof(ICONINFO). */
export const ICON_INFO_SIZE = 32;
/** sizeof(MSG), rounded up: over-allocating a buffer costs nothing. */
export const MESSAGE_SIZE = 64;
/** sizeof(PAINTSTRUCT), rounded up for the same reason. */
export const PAINT_STRUCT_SIZE = 96;
/** RECT: four 32-bit edges, and the only struct GDI takes by pointer a lot. */
export const RECT_SIZE = 16;
/** szTip is WCHAR[128], and one of those has to be the terminator. */
export const TIP_LIMIT = 127;

/** A null-terminated UTF-16LE string, which is what every W function wants. */
export function wide(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(`${text}\0`, "utf16le"));
}

const handle = (value: bigint | number | undefined): bigint => BigInt(value ?? 0);

/**
 * NOTIFYICONDATAW.
 *
 * The tip is truncated rather than left to overflow into dwState: the struct
 * has a fixed 128-character field, and a status line naming several waves goes
 * past it easily.
 */
export function notifyIconData(input: {
  hwnd: bigint | number;
  id: number;
  flags: number;
  callbackMessage?: number;
  icon?: bigint | number;
  tip?: string;
}): Uint8Array {
  const buffer = new Uint8Array(NOTIFY_ICON_SIZE);
  const view = new DataView(buffer.buffer);
  view.setUint32(0, NOTIFY_ICON_SIZE, true);
  view.setBigUint64(8, handle(input.hwnd), true);
  view.setUint32(16, input.id, true);
  view.setUint32(20, input.flags, true);
  view.setUint32(24, input.callbackMessage ?? 0, true);
  view.setBigUint64(32, handle(input.icon), true);

  if (input.tip !== undefined) {
    const text = Buffer.from(input.tip.slice(0, TIP_LIMIT), "utf16le");
    buffer.set(new Uint8Array(text), 40);
  }
  return buffer;
}

/** WNDCLASSEXW. Only the fields either of our two windows needs are filled in. */
export function windowClass(input: {
  wndProc: bigint | number;
  instance: bigint | number;
  className: bigint | number;
  /** Only a class whose window is ever shown needs one; see WindowsWindow. */
  cursor?: bigint | number;
}): Uint8Array {
  const buffer = new Uint8Array(WINDOW_CLASS_SIZE);
  const view = new DataView(buffer.buffer);
  view.setUint32(0, WINDOW_CLASS_SIZE, true);
  view.setBigUint64(8, handle(input.wndProc), true);
  view.setBigUint64(24, handle(input.instance), true);
  view.setBigUint64(40, handle(input.cursor), true);
  view.setBigUint64(64, handle(input.className), true);
  return buffer;
}

/** ICONINFO, always for an icon rather than a cursor. */
export function iconInfo(mask: bigint | number, colour: bigint | number): Uint8Array {
  const buffer = new Uint8Array(ICON_INFO_SIZE);
  const view = new DataView(buffer.buffer);
  view.setUint32(0, 1, true);
  view.setBigUint64(16, handle(mask), true);
  view.setBigUint64(24, handle(colour), true);
  return buffer;
}

/**
 * The pixmap as a Windows colour bitmap.
 *
 * iconPixmap draws ARGB in that byte order, because that is what
 * StatusNotifierItem asks for. A Windows bitmap is the reverse: the memory
 * order is blue, green, red, alpha. Handing one to the other is the classic way
 * to get an icon in the wrong colour, so the swap happens here and nowhere
 * else.
 */
export function bgraFromPixmap(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let offset = 0; offset < data.length; offset += 4) {
    out[offset] = data[offset + 3] ?? 0;
    out[offset + 1] = data[offset + 2] ?? 0;
    out[offset + 2] = data[offset + 1] ?? 0;
    out[offset + 3] = data[offset] ?? 0;
  }
  return out;
}

/**
 * The 1-bit AND mask that goes with it.
 *
 * Belt and braces: a 32-bit colour bitmap carries the alpha that gives the disc
 * a smooth edge, but whether it survives into the icon depends on the Windows
 * version. The mask does not -- a set bit is transparent, always -- so with
 * both the icon is at worst a hard-edged circle and never a square.
 *
 * Scanlines in a Windows bitmap are padded to a two-byte boundary, and getting
 * that wrong skews the mask diagonally across the icon.
 */
export function andMaskFromPixmap(data: Uint8Array, width: number, height: number): Uint8Array {
  const stride = Math.ceil(width / 16) * 2;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4] ?? 0;
      if (alpha >= 128) continue;
      const index = y * stride + (x >> 3);
      // The high bit of each byte is the leftmost pixel.
      out[index] = (out[index] ?? 0) | (0x80 >> (x & 7));
    }
  }
  return out;
}

/**
 * What a click on the icon was asking for.
 *
 * Without NIM_SETVERSION the icon reports the plain mouse message in lParam,
 * which is the simplest arrangement and the only one that needs no version
 * negotiation. The split matches the other two platforms: left opens the
 * window, right opens the menu.
 */
export function iconAction(mouseMessage: number | bigint): "click" | "menu" | null {
  const message = Number(mouseMessage);
  if (message === WM.lButtonUp) return "click";
  if (message === WM.rButtonUp || message === WM.contextMenu) return "menu";
  return null;
}

/** MF_* for one entry: a separator ignores its label, a disabled one greys out. */
export const menuFlags = (entry: MenuEntry): number => {
  if (entry.separator) return MF.separator;
  return MF.string | (entry.enabled === false ? MF.grayed : 0);
};

/**
 * A RECT, which GDI wants as edges rather than as a size.
 *
 * Every rectangle in this tray is an origin and an extent, so the conversion
 * happens here instead of at each of the dozen call sites that would otherwise
 * each have a chance to get the bottom edge wrong.
 */
export function rectStruct(rect: { x: number; y: number; w: number; h: number }): Uint8Array {
  const buffer = new Uint8Array(RECT_SIZE);
  const view = new DataView(buffer.buffer);
  view.setInt32(0, Math.round(rect.x), true);
  view.setInt32(4, Math.round(rect.y), true);
  view.setInt32(8, Math.round(rect.x + rect.w), true);
  view.setInt32(12, Math.round(rect.y + rect.h), true);
  return buffer;
}

/** The other direction, for the work area Windows hands back. */
export function rectFrom(buffer: Uint8Array): { x: number; y: number; w: number; h: number } {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const left = view.getInt32(0, true);
  const top = view.getInt32(4, true);
  return { x: left, y: top, w: view.getInt32(8, true) - left, h: view.getInt32(12, true) - top };
}

/**
 * "#14161f" as a COLORREF, which is 0x00bbggrr.
 *
 * The same reversal bgraFromPixmap makes, and the same silent failure if it is
 * missed: the card comes up in the wrong colour rather than not at all.
 */
export function colorref(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const red = (value >> 16) & 0xff;
  const green = (value >> 8) & 0xff;
  const blue = value & 0xff;
  return (blue << 16) | (green << 8) | red;
}

/**
 * The two halves of an LPARAM or WPARAM, signed.
 *
 * Mouse coordinates are signed 16-bit and go negative on a second monitor left
 * of the first; read unsigned, a click there lands at 65,000 pixels and hits
 * nothing.
 */
export const loWord = (value: bigint | number): number => Number(BigInt.asIntN(16, BigInt(value)));
export const hiWord = (value: bigint | number): number => Number(BigInt.asIntN(16, BigInt(value) >> 16n));
