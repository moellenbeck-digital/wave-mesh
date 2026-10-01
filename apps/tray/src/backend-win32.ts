import { JSCallback, ptr } from "bun:ffi";
import type { TrayBackend, TrayBackendOptions } from "./backend.ts";
import { type IconState, iconPixmap } from "./icon.ts";
import type { MenuEntry } from "./menu.ts";
import { defWindowProc, gdi32, type Handle, kernel32, shell32, user32, WND_PROC_SIGNATURE } from "./win32.ts";
import {
  andMaskFromPixmap,
  bgraFromPixmap,
  iconAction,
  iconInfo,
  MESSAGE_SIZE,
  menuFlags,
  NIF,
  NIM,
  notifyIconData,
  PM_REMOVE,
  SM_CXSMICON,
  TPM,
  TRAY_MESSAGE,
  WM,
  WS_POPUP,
  wide,
  windowClass,
} from "./win32-layout.ts";

/**
 * The Windows notification area icon.
 *
 * Four things differ from the other two platforms.
 *
 * The icon needs a window to report to -- Shell_NotifyIcon has no callback, it
 * posts a message -- so there is a window here even though nothing is ever
 * drawn in it. It is deliberately *not* a message-only window (HWND_MESSAGE):
 * such a window can never take the foreground, and a popup menu put up by a
 * window that is not in the foreground does not close when the user clicks
 * elsewhere. So it is an ordinary top-level window that is simply never shown.
 *
 * The message loop is pumped by hand in small slices, for the same reason as
 * the AppKit and GTK loops: blocking in GetMessage would stop the daemon socket
 * being serviced.
 *
 * The menu is put up on demand rather than owned by the icon, the same split
 * the other backends make: the left button goes to the window, the right one
 * opens the menu.
 *
 * And the icon is built from pixels at runtime, so there is no .ico to ship
 * beside a single-binary client.
 */

/** Long enough to feel responsive, short enough not to starve the socket. */
const PUMP_INTERVAL_MS = 50;
/** One icon, so one id; it only has to be unique within this window. */
const ICON_ID = 1;
const CLASS_NAME = "wave-tray";
/** Windows hands back 0 when the menu was dismissed; no entry carries that id. */
const MENU_CANCELLED = 0;

export class WindowsTray implements TrayBackend {
  readonly platform = "win32";

  private hwnd?: Handle;
  private icon?: Handle;
  private menu?: Handle;
  private wndProc?: JSCallback;
  private pump?: ReturnType<typeof setInterval>;
  private entries: MenuEntry[] = [];
  private state: IconState = "off";
  private size = 16;
  /** Held for as long as the window class is registered against it. */
  private className = wide(CLASS_NAME);
  private readonly message = new Uint8Array(MESSAGE_SIZE);
  private readonly point = new Uint8Array(8);

  constructor(private readonly options: TrayBackendOptions) {}

  async start(): Promise<void> {
    const instance = kernel32.symbols.GetModuleHandleW(null);

    this.wndProc = new JSCallback((hwnd: Handle, message: number, wParam: bigint, lParam: bigint) => {
      if (message !== TRAY_MESSAGE) return defWindowProc(hwnd, message, wParam, lParam);
      const action = iconAction(lParam);
      if (action === "click") this.options.onClick();
      if (action === "menu") this.showMenu();
      return 0n;
    }, WND_PROC_SIGNATURE);

    // A class that is already registered fails here, which is fine: this
    // process registered it, and the name is all CreateWindowExW needs.
    user32.symbols.RegisterClassExW(
      ptr(
        windowClass({
          wndProc: this.wndProc.ptr ?? 0,
          instance: instance ?? 0,
          className: ptr(this.className),
        }),
      ),
    );

    const hwnd = user32.symbols.CreateWindowExW(
      0,
      ptr(this.className),
      ptr(this.className),
      WS_POPUP,
      0,
      0,
      0,
      0,
      null,
      null,
      instance,
      null,
    );
    if (!hwnd) throw new Error("could not create the window the tray icon reports to");
    this.hwnd = hwnd;

    // Asking beats scaling: a disc drawn at 22 and squeezed into 16 looks it.
    this.size = user32.symbols.GetSystemMetrics(SM_CXSMICON) || 16;
    this.icon = this.makeIcon(this.state);

    shell32.symbols.Shell_NotifyIconW(
      NIM.add,
      ptr(
        notifyIconData({
          hwnd,
          id: ICON_ID,
          flags: NIF.message | NIF.icon | NIF.tip,
          callbackMessage: TRAY_MESSAGE,
          icon: this.icon ?? 0,
          tip: "wave",
        }),
      ),
    );

    this.pump = setInterval(() => this.step(), PUMP_INTERVAL_MS);
  }

  /** Every pending message, then return. */
  private step(): void {
    for (let guard = 0; guard < 64; guard++) {
      if (!user32.symbols.PeekMessageW(ptr(this.message), null, 0, 0, PM_REMOVE)) break;
      user32.symbols.TranslateMessage(ptr(this.message));
      user32.symbols.DispatchMessageW(ptr(this.message));
    }
  }

  /**
   * Puts the menu up at the cursor and waits for a choice.
   *
   * TrackPopupMenu runs its own loop and does not return until the menu closes,
   * so the socket is unattended for as long as it is open -- the same pause the
   * other two platforms take, and harmless because the daemon holds the tunnel
   * either way.
   *
   * The two calls around it are not decoration. Without SetForegroundWindow the
   * menu stays up after a click elsewhere, and without the posted message it
   * does not close on the *first* such click. Both are documented quirks of
   * TrackPopupMenu and have no other cure.
   */
  private showMenu(): void {
    if (!this.menu || !this.hwnd) return;
    user32.symbols.GetCursorPos(ptr(this.point));
    const cursor = new DataView(this.point.buffer);

    user32.symbols.SetForegroundWindow(this.hwnd);
    const chosen = user32.symbols.TrackPopupMenu(
      this.menu,
      TPM.returnCmd | TPM.noNotify | TPM.rightButton | TPM.leftAlign,
      cursor.getInt32(0, true),
      cursor.getInt32(4, true),
      0,
      this.hwnd,
      null,
    );
    user32.symbols.PostMessageW(this.hwnd, WM.null, 0n, 0n);

    if (chosen !== MENU_CANCELLED) this.options.onActivate(chosen);
  }

  /**
   * An icon from two bitmaps.
   *
   * CreateIconIndirect copies both, so they have to be deleted afterwards --
   * otherwise every status push that changes the colour leaks two GDI objects,
   * and a process only gets ten thousand of them.
   */
  private makeIcon(state: IconState): Handle {
    const pixmap = iconPixmap(state, this.size);
    const colour = gdi32.symbols.CreateBitmap(
      pixmap.width,
      pixmap.height,
      1,
      32,
      ptr(bgraFromPixmap(pixmap.data)),
    );
    const mask = gdi32.symbols.CreateBitmap(
      pixmap.width,
      pixmap.height,
      1,
      1,
      ptr(andMaskFromPixmap(pixmap.data, pixmap.width, pixmap.height)),
    );
    const icon = user32.symbols.CreateIconIndirect(ptr(iconInfo(mask ?? 0, colour ?? 0)));
    gdi32.symbols.DeleteObject(colour);
    gdi32.symbols.DeleteObject(mask);
    return icon;
  }

  update(input: { state: IconState; tooltip: string; entries: MenuEntry[] }): void {
    if (!this.hwnd) return;

    // Only when the colour actually changed: redrawing costs two bitmaps and an
    // icon handle, and this runs on every status push.
    const previousIcon = input.state === this.state ? undefined : this.icon;
    if (previousIcon !== undefined) {
      this.state = input.state;
      this.icon = this.makeIcon(input.state);
    }

    shell32.symbols.Shell_NotifyIconW(
      NIM.modify,
      ptr(
        notifyIconData({
          hwnd: this.hwnd,
          id: ICON_ID,
          flags: NIF.icon | NIF.tip,
          icon: this.icon ?? 0,
          tip: input.tooltip,
        }),
      ),
    );
    // After the modify, never before: until then the shell is still showing it.
    if (previousIcon) user32.symbols.DestroyIcon(previousIcon);

    if (sameEntries(this.entries, input.entries)) return;
    this.entries = input.entries;
    const previousMenu = this.menu;
    this.menu = this.buildMenu(input.entries);
    // An open menu cannot be reached from here: its loop has the thread.
    if (previousMenu) user32.symbols.DestroyMenu(previousMenu);
  }

  private buildMenu(entries: MenuEntry[]): Handle {
    const menu = user32.symbols.CreatePopupMenu();
    for (const entry of entries) {
      // AppendMenuW keeps no reference to the text, so the buffer may go.
      const label = entry.separator ? null : ptr(wide(entry.label ?? ""));
      user32.symbols.AppendMenuW(menu, menuFlags(entry), BigInt(entry.id), label);
    }
    return menu;
  }

  async stop(): Promise<void> {
    if (this.pump) clearInterval(this.pump);
    if (this.hwnd) {
      shell32.symbols.Shell_NotifyIconW(
        NIM.delete,
        ptr(notifyIconData({ hwnd: this.hwnd, id: ICON_ID, flags: 0 })),
      );
      user32.symbols.DestroyWindow(this.hwnd);
    }
    if (this.menu) user32.symbols.DestroyMenu(this.menu);
    if (this.icon) user32.symbols.DestroyIcon(this.icon);
    // The window is gone, so nothing can call back into it any more.
    this.wndProc?.close();
  }
}

const sameEntries = (a: MenuEntry[], b: MenuEntry[]): boolean =>
  a.length === b.length &&
  a.every((entry, index) => entry.label === b[index]?.label && entry.id === b[index]?.id);
