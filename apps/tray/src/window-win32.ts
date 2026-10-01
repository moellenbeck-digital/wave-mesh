import { JSCallback, type Pointer, ptr, toArrayBuffer } from "bun:ffi";
import { defWindowProc, gdi32, type Handle, kernel32, user32, WND_PROC_SIGNATURE } from "./win32.ts";
import {
  CF_UNICODETEXT,
  CLEARTYPE_QUALITY,
  colorref,
  DEFAULT_CHARSET,
  DT,
  FW,
  GMEM_MOVEABLE,
  hiWord,
  IDC_ARROW,
  LOGPIXELSX,
  loWord,
  NULL_BRUSH,
  NULL_PEN,
  PAINT_STRUCT_SIZE,
  PS_SOLID,
  RECT_SIZE,
  rectFrom,
  rectStruct,
  SPI_GETWORKAREA,
  SRCCOPY,
  SW,
  SWP,
  TRANSPARENT,
  VK_ESCAPE,
  WA_INACTIVE,
  WHEEL_DELTA,
  WM,
  WS_EX_TOOLWINDOW,
  WS_EX_TOPMOST,
  WS_POPUP,
  wide,
  windowClass,
} from "./win32-layout.ts";
import type { TrayWindow, TrayWindowOptions } from "./window.ts";
import type { WindowView } from "./window-view.ts";
import {
  CORNER,
  EDGE_MARGIN,
  FONTS,
  type FontRole,
  hitTest,
  PALETTE,
  type Paint,
  type Rect,
  switchKnob,
  type WindowLayout,
  windowLayout,
} from "./window-win32-layout.ts";

/**
 * The Windows window behind the tray icon.
 *
 * The same card the GTK overlay and the Cocoa panel show, drawn with GDI. That
 * is the part that differs: on the other two platforms the toolkit has widgets
 * for a switch and a list, and a stylesheet or a layer to colour them. Windows
 * has common controls, but they are the system's colours and the system's
 * shapes -- a light grey checkbox on a dark card, whichever theme is set -- so
 * everything here is painted by hand instead. Where each rectangle goes is
 * worked out in window-win32-layout.ts, which has no Windows in it and can
 * therefore be checked from anywhere.
 *
 * Four things are worth knowing before changing anything here.
 *
 * **The message loop is not pumped here.** The icon's loop already steps this
 * thread in slices, and PeekMessage takes everything queued for it, this window
 * included -- the same arrangement the macOS window has with the menu bar item.
 * A second pump would be harmless but pointless.
 *
 * **Drawing goes through a memory bitmap.** Painting a few dozen shapes
 * straight onto the window flickers, because the card is repainted whole on
 * every status push.
 *
 * **Every GDI object is deleted, and no stock object ever is.** A brush per
 * shape is cheap; ten thousand of them is the handle limit, and the card is
 * redrawn once a second while it is open.
 *
 * **The corners are the window's, not the paint's.** A rounded card drawn into
 * a square window leaves four opaque corners of whatever the card colour is;
 * the region is what actually cuts them off.
 */

const CLASS_NAME = "wave-window";
/** One notch of the wheel moves about a row. Layout units, not pixels. */
const SCROLL_STEP = 50;
/**
 * How long after the window dismissed itself a click on the icon is ignored.
 *
 * Clicking the icon of an open window deactivates it, which hides it -- and
 * the icon's own click arrives afterwards and would open it straight back up.
 * Every tray popover on this platform has this problem and this cure.
 */
const DISMISS_GUARD_MS = 300;

/** Before the first status arrives; the window cannot be shown yet anyway. */
const BLANK: WindowView = {
  title: "wave",
  subtitle: "",
  connections: [],
  machines: [],
  labelMachines: false,
  emptyMachines: "",
};

export class WindowsWindow implements TrayWindow {
  readonly platform = "win32";

  private readonly hwnd: Handle;
  private readonly wndProc: JSCallback;
  /** Held for as long as the window class is registered against it. */
  private readonly className = wide(CLASS_NAME);
  private readonly fonts = new Map<FontRole, Handle>();
  private readonly paintStruct = new Uint8Array(PAINT_STRUCT_SIZE);

  private view: WindowView = BLANK;
  private layout: WindowLayout;
  private scale: number;
  private scroll = 0;
  /**
   * Which machines have their services showing, by row key.
   *
   * Here and not in the layout: the card is re-measured on every status push,
   * a second apart, and a list that folded itself back up that often would be
   * unusable. The layout stays a pure function of the view and this set.
   */
  private readonly expanded = new Set<string>();
  private dismissedAt = 0;

  constructor(private readonly options: TrayWindowOptions) {
    // Before any window exists, which is what this call requires: the icon's
    // window comes later, and both want the same idea of what a pixel is.
    // Without it Windows reports 96 dpi everywhere and scales the result,
    // which is merely blurry rather than wrong -- so a missing call is not
    // worth failing over.
    user32.symbols.SetProcessDPIAware();
    this.scale = this.displayScale();
    this.layout = windowLayout(this.view, { scale: this.scale, scroll: 0, expanded: this.expanded });

    const instance = kernel32.symbols.GetModuleHandleW(null);

    this.wndProc = new JSCallback(
      (hwnd: Handle, message: number, wParam: bigint, lParam: bigint) =>
        this.onMessage(hwnd, message, wParam, lParam),
      WND_PROC_SIGNATURE,
    );

    user32.symbols.RegisterClassExW(
      ptr(
        windowClass({
          wndProc: this.wndProc.ptr ?? 0,
          instance: instance ?? 0,
          className: ptr(this.className),
          // Unlike the icon's window this one is actually on screen, and a
          // class without a cursor leaves whatever the last window set.
          // A resource id is an integer where a pointer is expected, which is
          // what MAKEINTRESOURCE amounts to and the one place that shows here.
          cursor: user32.symbols.LoadCursorW(null, IDC_ARROW as unknown as Pointer) ?? 0,
        }),
      ),
    );

    // Tool window and topmost: no taskbar button, no Alt-Tab entry, and above
    // ordinary windows -- the way the layer surface sits on Linux and the
    // floating level on macOS. It starts hidden; open() is what shows it.
    const hwnd = user32.symbols.CreateWindowExW(
      WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
      ptr(this.className),
      ptr(wide("wave")),
      WS_POPUP,
      0,
      0,
      this.layout.width,
      this.layout.height,
      null,
      null,
      instance,
      null,
    );
    if (!hwnd) throw new Error("could not create the tray window");
    this.hwnd = hwnd;
  }

  /** How many device pixels the layout's units are worth on this display. */
  private displayScale(): number {
    const screen = user32.symbols.GetDC(null);
    if (!screen) return 1;
    const dpi = gdi32.symbols.GetDeviceCaps(screen, LOGPIXELSX);
    user32.symbols.ReleaseDC(null, screen);
    return dpi > 0 ? dpi / 96 : 1;
  }

  private onMessage(hwnd: Handle, message: number, wParam: bigint, lParam: bigint): bigint {
    if (message === WM.paint) {
      this.paint();
      return 0n;
    }
    // Claimed, so Windows does not wipe the window with a background brush
    // first: the card is painted whole and the wipe would only flicker.
    if (message === WM.eraseBackground) return 1n;

    if (message === WM.lButtonUp) {
      this.press(loWord(lParam), hiWord(lParam));
      return 0n;
    }
    if (message === WM.mouseWheel) {
      this.wheel(hiWord(wParam) / WHEEL_DELTA);
      return 0n;
    }
    if (message === WM.keyDown && Number(wParam) === VK_ESCAPE) {
      // The second way out, as on the other two platforms.
      this.close();
      return 0n;
    }
    // Turning to another window puts the card away, the way a popover behaves.
    // Unlike Hyprland, Windows really does report this.
    if (message === WM.activate && loWord(wParam) === WA_INACTIVE) {
      this.dismissedAt = Date.now();
      this.hide();
      return 0n;
    }
    // Never destroyed from here: the icon has to be able to bring it back.
    if (message === WM.close) {
      this.close();
      return 0n;
    }
    return defWindowProc(hwnd, message, wParam, lParam);
  }

  private press(x: number, y: number): void {
    const action = hitTest(this.layout, x, y);
    if (!action) return;
    if (action.kind === "toggle") {
      // The switch does not move until the daemon says the wave moved. A GTK
      // switch flips under the finger and can be wrong for a second; this one
      // shows what is, which is the same thing the rest of the card does.
      this.options.onToggle(action.controlUrl, action.connect);
      return;
    }
    if (action.kind === "open") {
      this.options.onOpen?.(action.url);
      return;
    }
    if (action.kind === "expand") {
      // Straight away, not on the next tick: nothing here is a live control
      // whose handler the rebuild could pull out from under itself -- the card
      // is a painting, and this only changes what the next one contains.
      if (!this.expanded.delete(action.key)) this.expanded.add(action.key);
      this.relayout();
      return;
    }
    this.copy(action.text);
    this.options.onCopy?.(action.text);
  }

  private wheel(notches: number): void {
    if (this.layout.maxScroll === 0) return;
    const next = Math.min(Math.max(this.scroll - notches * SCROLL_STEP, 0), this.layout.maxScroll);
    if (next === this.scroll) return;
    this.scroll = next;
    this.relayout();
  }

  /**
   * The clipboard, which is a handle and not a string.
   *
   * The block belongs to the clipboard the moment SetClipboardData takes it;
   * freeing it afterwards is a use-after-free in whatever pastes next.
   */
  private copy(text: string): void {
    if (!user32.symbols.OpenClipboard(this.hwnd)) return;
    user32.symbols.EmptyClipboard();
    const bytes = wide(text);
    const block = kernel32.symbols.GlobalAlloc(GMEM_MOVEABLE, BigInt(bytes.length));
    const target = block ? kernel32.symbols.GlobalLock(block) : null;
    if (block && target) {
      new Uint8Array(toArrayBuffer(target, 0, bytes.length)).set(bytes);
      kernel32.symbols.GlobalUnlock(block);
      user32.symbols.SetClipboardData(CF_UNICODETEXT, block);
    }
    user32.symbols.CloseClipboard();
  }

  open(): void {
    this.relayout();
    user32.symbols.ShowWindow(this.hwnd, SW.show);
    user32.symbols.SetForegroundWindow(this.hwnd);
  }

  close(): void {
    this.hide();
    // After hiding, not before: hiding an active window deactivates it, and
    // that arrives here as a dismissal. Escape is not one -- a click on the
    // icon right afterwards should open the card again.
    this.dismissedAt = 0;
  }

  /** Hidden rather than closed, so the icon can bring the same window back. */
  private hide(): void {
    user32.symbols.ShowWindow(this.hwnd, SW.hide);
  }

  toggle(): void {
    if (user32.symbols.IsWindowVisible(this.hwnd)) {
      this.close();
      return;
    }
    // Just deactivated by this very click, so the window is already away and
    // this is the second half of putting it there, not a request to open it.
    if (Date.now() - this.dismissedAt < DISMISS_GUARD_MS) {
      this.dismissedAt = 0;
      return;
    }
    this.scroll = 0;
    this.open();
  }

  update(view: WindowView): void {
    this.view = view;
    // A machine that left takes its open state with it; otherwise the set
    // grows for the life of a tray that runs for weeks.
    const keys = new Set(view.machines.map((machine) => machine.key));
    for (const key of this.expanded) if (!keys.has(key)) this.expanded.delete(key);

    if (!user32.symbols.IsWindowVisible(this.hwnd)) {
      // Laid out anyway: open() places the window by its size, and a stale one
      // would put the card in the wrong corner for a frame.
      this.layout = windowLayout(view, { scale: this.scale, scroll: this.scroll, expanded: this.expanded });
      return;
    }
    this.relayout();
  }

  /**
   * Re-measures the card, resizes the window to it and asks for a repaint.
   *
   * The corners come off the window with a region rather than out of the paint,
   * so it has to be replaced whenever the size changes. Windows owns the region
   * after SetWindowRgn -- deleting it here would be a double free.
   */
  private relayout(): void {
    this.layout = windowLayout(this.view, {
      scale: this.scale,
      scroll: this.scroll,
      expanded: this.expanded,
    });
    const { width, height } = this.layout;
    const place = this.corner(width, height);

    user32.symbols.SetWindowPos(
      this.hwnd,
      null,
      place.x,
      place.y,
      width,
      height,
      SWP.noZOrder | SWP.noActivate,
    );
    const corner = Math.round(CORNER * this.scale) * 2;
    const region = gdi32.symbols.CreateRoundRectRgn(0, 0, width + 1, height + 1, corner, corner);
    if (region) user32.symbols.SetWindowRgn(this.hwnd, region, true);
    user32.symbols.InvalidateRect(this.hwnd, null, false);
  }

  /** Bottom right, clear of the taskbar -- where the icon that opened it is. */
  private corner(width: number, height: number): { x: number; y: number } {
    const buffer = new Uint8Array(RECT_SIZE);
    if (!user32.symbols.SystemParametersInfoW(SPI_GETWORKAREA, 0, ptr(buffer), 0)) return { x: 0, y: 0 };
    const area = rectFrom(buffer);
    const margin = Math.round(EDGE_MARGIN * this.scale);
    return {
      x: area.x + area.w - width - margin,
      y: area.y + area.h - height - margin,
    };
  }

  private paint(): void {
    const dc = user32.symbols.BeginPaint(this.hwnd, ptr(this.paintStruct));
    if (!dc) return;
    const { width, height } = this.layout;

    // Everything is drawn into a bitmap and blitted in one go: the card is
    // repainted whole on every status push, and shape by shape it flickers.
    const memory = gdi32.symbols.CreateCompatibleDC(dc);
    const bitmap = gdi32.symbols.CreateCompatibleBitmap(dc, width, height);
    if (memory && bitmap) {
      const previous = gdi32.symbols.SelectObject(memory, bitmap);
      this.draw(memory);
      gdi32.symbols.BitBlt(dc, 0, 0, width, height, memory, 0, 0, SRCCOPY);
      gdi32.symbols.SelectObject(memory, previous);
    }
    if (bitmap) gdi32.symbols.DeleteObject(bitmap);
    if (memory) gdi32.symbols.DeleteDC(memory);

    user32.symbols.EndPaint(this.hwnd, ptr(this.paintStruct));
  }

  private draw(dc: Handle): void {
    gdi32.symbols.SetBkMode(dc, TRANSPARENT);
    for (const paint of this.layout.chrome) this.paintOne(dc, paint);

    // The machine list is the only part that can overflow, so it is the only
    // part that is clipped; a half-scrolled row stops at the edge of the list
    // instead of drawing over the rule below it.
    const clip = this.layout.clip;
    const saved = gdi32.symbols.SaveDC(dc);
    gdi32.symbols.IntersectClipRect(dc, clip.x, clip.y, clip.x + clip.w, clip.y + clip.h);
    for (const paint of this.layout.list) this.paintOne(dc, paint);
    if (saved) gdi32.symbols.RestoreDC(dc, saved);
  }

  private paintOne(dc: Handle, paint: Paint): void {
    if (paint.kind === "fill") {
      this.shape(dc, paint.colour, paint.border, () => this.roundRect(dc, paint, paint.radius ?? 0));
      return;
    }
    if (paint.kind === "text") {
      this.drawText(dc, paint);
      return;
    }
    if (paint.kind === "switch") {
      this.shape(dc, paint.on ? PALETTE.accent : PALETTE.track, undefined, () =>
        this.roundRect(dc, paint, Math.round(paint.h / 2)),
      );
      const knob = switchKnob(paint, paint.on, this.scale);
      this.shape(dc, PALETTE.knob, undefined, () =>
        gdi32.symbols.Ellipse(dc, knob.x, knob.y, knob.x + knob.w, knob.y + knob.h),
      );
      return;
    }
    this.copyGlyph(dc, paint);
  }

  /**
   * Two sheets of paper, which is the copy icon everywhere else.
   *
   * The front one is filled with the card colour rather than left hollow, so it
   * hides the corner of the back one it overlaps.
   */
  private copyGlyph(dc: Handle, box: Rect): void {
    const unit = box.w / 24;
    const at = (x: number, y: number, w: number, h: number): Rect => ({
      x: Math.round(box.x + x * unit),
      y: Math.round(box.y + y * unit),
      w: Math.round(w * unit),
      h: Math.round(h * unit),
    });
    const radius = Math.max(2, Math.round(3 * unit));
    this.shape(dc, undefined, PALETTE.muted, () => this.roundRect(dc, at(8, 2, 12, 15), radius));
    this.shape(dc, PALETTE.card, PALETTE.muted, () => this.roundRect(dc, at(4, 7, 12, 15), radius));
  }

  private roundRect(dc: Handle, rect: Rect, radius: number): void {
    gdi32.symbols.RoundRect(dc, rect.x, rect.y, rect.x + rect.w, rect.y + rect.h, radius * 2, radius * 2);
  }

  /**
   * Selects a brush and a pen for one shape and puts the old ones back.
   *
   * A missing colour means the stock null object: no fill, or no outline. Those
   * are the system's and must never be deleted -- only the two this call made
   * are.
   */
  private shape(dc: Handle, fill: string | undefined, border: string | undefined, body: () => void): void {
    const brush = fill
      ? gdi32.symbols.CreateSolidBrush(colorref(fill))
      : gdi32.symbols.GetStockObject(NULL_BRUSH);
    const pen = border
      ? gdi32.symbols.CreatePen(PS_SOLID, Math.max(1, Math.round(this.scale)), colorref(border))
      : gdi32.symbols.GetStockObject(NULL_PEN);
    const oldBrush = gdi32.symbols.SelectObject(dc, brush);
    const oldPen = gdi32.symbols.SelectObject(dc, pen);

    body();

    gdi32.symbols.SelectObject(dc, oldBrush);
    gdi32.symbols.SelectObject(dc, oldPen);
    if (fill) gdi32.symbols.DeleteObject(brush);
    if (border) gdi32.symbols.DeleteObject(pen);
  }

  private drawText(dc: Handle, paint: Extract<Paint, { kind: "text" }>): void {
    const font = this.font(paint.font);
    const previous = font ? gdi32.symbols.SelectObject(dc, font) : null;
    gdi32.symbols.SetTextColor(dc, colorref(paint.colour));
    user32.symbols.DrawTextW(
      dc,
      ptr(wide(paint.text)),
      -1,
      ptr(rectStruct(paint)),
      (paint.align === "right" ? DT.right : DT.left) |
        DT.singleLine |
        DT.vCentre |
        DT.endEllipsis |
        // Without it an ampersand in a hostname turns into an underline.
        DT.noPrefix,
    );
    if (previous) gdi32.symbols.SelectObject(dc, previous);
  }

  /** One font per role, made once: they are handles, and the scale is fixed. */
  private font(role: FontRole): Handle {
    const existing = this.fonts.get(role);
    if (existing !== undefined) return existing;
    const { size, bold } = FONTS[role];
    const font = gdi32.symbols.CreateFontW(
      -Math.round(size * this.scale),
      0,
      0,
      0,
      bold ? FW.bold : FW.normal,
      0,
      0,
      0,
      DEFAULT_CHARSET,
      0,
      0,
      CLEARTYPE_QUALITY,
      0,
      ptr(wide("Segoe UI")),
    );
    this.fonts.set(role, font);
    return font;
  }

  destroy(): void {
    for (const font of this.fonts.values()) if (font) gdi32.symbols.DeleteObject(font);
    this.fonts.clear();
    user32.symbols.DestroyWindow(this.hwnd);
    // The window is gone, so nothing can call back into it any more.
    this.wndProc.close();
  }
}
