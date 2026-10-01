import { describe, expect, test } from "bun:test";
import { iconPixmap } from "../src/icon.ts";
import { menuFor } from "../src/view.ts";
import {
  andMaskFromPixmap,
  bgraFromPixmap,
  colorref,
  hiWord,
  iconAction,
  iconInfo,
  loWord,
  menuFlags,
  NOTIFY_ICON_SIZE,
  notifyIconData,
  RECT_SIZE,
  rectFrom,
  rectStruct,
  TIP_LIMIT,
  TRAY_MESSAGE,
  WINDOW_CLASS_SIZE,
  WM,
  wide,
  windowClass,
} from "../src/win32-layout.ts";

describe("wide", () => {
  test("is UTF-16LE and terminated, which is what every W function reads", () => {
    const bytes = wide("ab");
    expect([...bytes]).toEqual([0x61, 0x00, 0x62, 0x00, 0x00, 0x00]);
  });

  test("carries what is outside Latin-1 through", () => {
    expect(Buffer.from(wide("wave — verbunden")).toString("utf16le")).toBe("wave — verbunden\0");
  });
});

describe("notifyIconData", () => {
  const view = (bytes: Uint8Array) => new DataView(bytes.buffer);

  test("puts every field where the 64-bit struct has it", () => {
    const bytes = notifyIconData({
      hwnd: 0x1234n,
      id: 1,
      flags: 0x07,
      callbackMessage: TRAY_MESSAGE,
      icon: 0xabcdn,
      tip: "wave",
    });

    expect(bytes.length).toBe(NOTIFY_ICON_SIZE);
    // cbSize doubles as the version tag: the wrong number is silently refused.
    expect(view(bytes).getUint32(0, true)).toBe(NOTIFY_ICON_SIZE);
    expect(view(bytes).getBigUint64(8, true)).toBe(0x1234n);
    expect(view(bytes).getUint32(16, true)).toBe(1);
    expect(view(bytes).getUint32(20, true)).toBe(0x07);
    expect(view(bytes).getUint32(24, true)).toBe(TRAY_MESSAGE);
    expect(view(bytes).getBigUint64(32, true)).toBe(0xabcdn);
    expect(Buffer.from(bytes.subarray(40, 48)).toString("utf16le")).toBe("wave");
  });

  test("truncates the tip instead of writing past its field", () => {
    // szTip is WCHAR[128]; a status line naming several waves goes past it, and
    // the next field along is dwState.
    const bytes = notifyIconData({ hwnd: 1, id: 1, flags: 0, tip: "x".repeat(400) });
    expect(Buffer.from(bytes.subarray(40, 40 + TIP_LIMIT * 2)).toString("utf16le")).toBe(
      "x".repeat(TIP_LIMIT),
    );
    // The terminator's slot, and dwState behind it, stay zero.
    expect(new DataView(bytes.buffer).getUint32(296, true)).toBe(0);
  });
});

describe("windowClass", () => {
  test("puts the procedure, the instance and the name where they belong", () => {
    const bytes = windowClass({ wndProc: 0x11n, instance: 0x22n, className: 0x33n });
    const view = new DataView(bytes.buffer);

    expect(bytes.length).toBe(WINDOW_CLASS_SIZE);
    expect(view.getUint32(0, true)).toBe(WINDOW_CLASS_SIZE);
    expect(view.getBigUint64(8, true)).toBe(0x11n);
    expect(view.getBigUint64(24, true)).toBe(0x22n);
    expect(view.getBigUint64(64, true)).toBe(0x33n);
    // The icon's window is never shown and needs none; a zero there is what
    // tells Windows to leave the cursor alone.
    expect(view.getBigUint64(40, true)).toBe(0n);
  });

  test("carries a cursor for the class whose window is on screen", () => {
    const view = new DataView(windowClass({ wndProc: 1, instance: 2, className: 3, cursor: 0x44n }).buffer);
    expect(view.getBigUint64(40, true)).toBe(0x44n);
    // hCursor sits between hIcon and hbrBackground; one field out and the
    // window comes up with a brush for a cursor.
    expect(view.getBigUint64(32, true)).toBe(0n);
    expect(view.getBigUint64(48, true)).toBe(0n);
  });
});

describe("iconInfo", () => {
  test("says icon rather than cursor, and takes the mask before the colour", () => {
    const view = new DataView(iconInfo(0xaan, 0xbbn).buffer);
    expect(view.getUint32(0, true)).toBe(1);
    expect(view.getBigUint64(16, true)).toBe(0xaan);
    expect(view.getBigUint64(24, true)).toBe(0xbbn);
  });
});

describe("bgraFromPixmap", () => {
  test("reverses the order, which is the whole difference between the platforms", () => {
    // ARGB in memory on the way in, BGRA on the way out.
    expect([...bgraFromPixmap(new Uint8Array([0x11, 0x22, 0x33, 0x44]))]).toEqual([0x44, 0x33, 0x22, 0x11]);
  });

  test("leaves a real icon the same size, and actually changes it", () => {
    const pixmap = iconPixmap("connected", 16);
    const converted = bgraFromPixmap(pixmap.data);
    expect(converted.length).toBe(pixmap.data.length);
    expect(Buffer.from(converted)).not.toEqual(Buffer.from(pixmap.data));
  });
});

describe("andMaskFromPixmap", () => {
  /** One row of `width` pixels, alpha taken from the list. */
  const row = (alphas: number[]) => {
    const data = new Uint8Array(alphas.length * 4);
    alphas.forEach((alpha, index) => {
      data[index * 4] = alpha;
    });
    return data;
  };

  test("sets a bit where the pixel is transparent, high bit leftmost", () => {
    const mask = andMaskFromPixmap(row([0, 255, 255, 255, 255, 255, 255, 0]), 8, 1);
    expect(mask[0]).toBe(0b1000_0001);
  });

  test("pads each row to a two-byte boundary, as a Windows bitmap requires", () => {
    // Getting this wrong skews the mask diagonally across the icon.
    expect(andMaskFromPixmap(new Uint8Array(16 * 4 * 2), 16, 2).length).toBe(4);
    expect(andMaskFromPixmap(new Uint8Array(22 * 4 * 2), 22, 2).length).toBe(8);
    expect(andMaskFromPixmap(new Uint8Array(8 * 4), 8, 1).length).toBe(2);
  });

  test("keeps the disc of a real icon opaque and its corners not", () => {
    const pixmap = iconPixmap("off", 16);
    const mask = andMaskFromPixmap(pixmap.data, 16, 16);
    // Top-left corner is outside the circle; the middle of the first row is in
    // the gap above it, and the centre row is solidly inside.
    expect((mask[0] ?? 0) & 0x80).not.toBe(0);
    const centre = 8 * 2;
    expect((mask[centre] ?? 0) & 0x08).toBe(0);
  });
});

describe("iconAction", () => {
  test("splits the buttons the way the other two platforms do", () => {
    expect(iconAction(WM.lButtonUp)).toBe("click");
    expect(iconAction(WM.rButtonUp)).toBe("menu");
    expect(iconAction(WM.contextMenu)).toBe("menu");
  });

  test("ignores everything else the icon reports", () => {
    // The icon posts a message for movement and for both button-downs too;
    // acting on those would open the menu twice per click.
    expect(iconAction(0x0200)).toBeNull();
    expect(iconAction(WM.lButtonUp - 1)).toBeNull();
  });
});

describe("menuFlags", () => {
  test("a separator ignores its label, a disabled entry greys out", () => {
    expect(menuFlags({ id: 1, separator: true })).toBe(0x0800);
    expect(menuFlags({ id: 1, label: "x" })).toBe(0x0000);
    expect(menuFlags({ id: 1, label: "x", enabled: false })).toBe(0x0001);
  });
});

describe("the id space TrackPopupMenu reports into", () => {
  test("never uses 0, which is what lets 0 mean 'dismissed'", () => {
    // TPM_RETURNCMD answers with the chosen id or 0 for none, so an entry with
    // id 0 would be indistinguishable from the user clicking away.
    for (const unreachable of [null, "no-daemon", "denied", "unreachable"] as const) {
      for (const entry of menuFor(null, { unreachable })) {
        expect(entry.id).not.toBe(0);
      }
    }
  });
});

describe("TRAY_MESSAGE", () => {
  test("sits in the range reserved for the application", () => {
    expect(TRAY_MESSAGE).toBeGreaterThanOrEqual(WM.app);
    expect(TRAY_MESSAGE).toBeLessThan(0xc000);
  });
});

describe("colorref", () => {
  test("is 0x00bbggrr, not the hex as written", () => {
    // The same reversal bgraFromPixmap makes. Missed, the card comes up in the
    // wrong colour rather than not at all -- which is the harder bug to spot.
    expect(colorref("#14161f")).toBe(0x1f1614);
    expect(colorref("#0f6e6e")).toBe(0x6e6e0f);
    expect(colorref("#ff0000")).toBe(0x0000ff);
  });
});

describe("rectStruct", () => {
  test("writes edges where GDI reads them, not an origin and a size", () => {
    const bytes = rectStruct({ x: 10, y: 20, w: 100, h: 50 });
    const view = new DataView(bytes.buffer);
    expect(bytes.length).toBe(RECT_SIZE);
    expect([view.getInt32(0, true), view.getInt32(4, true)]).toEqual([10, 20]);
    expect([view.getInt32(8, true), view.getInt32(12, true)]).toEqual([110, 70]);
  });

  test("survives the trip back, which is how the work area comes in", () => {
    const rect = { x: -1920, y: 0, w: 1920, h: 1040 };
    expect(rectFrom(rectStruct(rect))).toEqual(rect);
  });
});

describe("the halves of a message parameter", () => {
  test("are signed, so a click on a monitor left of the first still lands", () => {
    // Unsigned, x would be some 65,000 pixels and hit nothing at all.
    const lParam = ((-30 & 0xffff) | ((40 & 0xffff) << 16)) >>> 0;
    expect(loWord(BigInt(lParam))).toBe(-30);
    expect(hiWord(BigInt(lParam))).toBe(40);
  });

  test("read a wheel notch in either direction", () => {
    expect(hiWord(BigInt((120 << 16) >>> 0))).toBe(120);
    expect(hiWord(BigInt(((-120 & 0xffff) << 16) >>> 0))).toBe(-120);
  });
});
