import { ptr } from "bun:ffi";
import type { TrayBackend, TrayBackendOptions } from "./backend.ts";
import { type IconState, iconPixmap } from "./icon.ts";
import type { MenuEntry } from "./menu.ts";
import {
  cls,
  type Id,
  makeHandler,
  msg,
  msg1,
  msg2,
  msg3,
  msgDouble,
  msgInt,
  msgSize,
  nextEvent,
  nsString,
  sel,
  sharedApplication,
} from "./objc.ts";
import { pngFromPixmap } from "./png.ts";

/**
 * The macOS menu bar item.
 *
 * Three things differ from Linux beyond the API. The icon reaches AppKit as PNG
 * bytes rather than a pixmap (see pngFromPixmap for why). AppKit's run loop has
 * to be pumped by hand: calling [NSApp run]
 * would never return and the daemon connection would stop being serviced, so
 * the loop is stepped in small slices instead.
 *
 * And the menu is deliberately *not* attached to the item. An attached menu is
 * opened by AppKit on every click and reported to nobody, which would leave the
 * window unreachable. So the item keeps the menu to itself and puts it up for
 * the right button, while the left one goes to the window -- the same split the
 * Linux host makes between ContextMenu and Activate.
 */

/**
 * The menu bar is 22 points high and its icons are drawn in an 18-point square;
 * the pixmap is twice that so a Retina bar gets real pixels. Not a template
 * image: the state is the icon's colour, and a template is recoloured by the
 * system into black or white.
 */
const ICON_POINTS = 18;
const ICON_PIXELS = ICON_POINTS * 2;

/** Long enough to feel responsive, short enough not to starve the socket. */
const PUMP_INTERVAL_MS = 50;
const VARIABLE_LENGTH = -1;
/** A status item button reports the left button only until both are asked for. */
const CLICK_MASK = (1 << 2) | (1 << 4);
/** NSEventTypeRightMouseUp, and the modifier that stands in for it. */
const RIGHT_MOUSE_UP = 4;
const CONTROL_KEY = 1 << 18;
/** No menu entry carries id 0, which leaves it to mean the icon itself. */
const ICON_TAG = 0;

/**
 * Whether a click on the icon was asking for the menu rather than the window.
 *
 * Separate from the plumbing because it cannot be tried out in place: the menu
 * it leads to opens a tracking loop that only a person can close.
 */
export const opensMenu = (eventType: number, modifierFlags: number): boolean =>
  eventType === RIGHT_MOUSE_UP || (modifierFlags & CONTROL_KEY) !== 0;

export class MacosTray implements TrayBackend {
  readonly platform = "darwin";
  private statusItem?: Id;
  private button?: Id;
  private handler?: { instance: Id; keepAlive: unknown };
  private pump?: ReturnType<typeof setInterval>;
  private entries: MenuEntry[] = [];
  private menu?: Id;
  private app?: Id;
  private defaultMode?: Id;
  /**
   * One image per state, built on first use and kept. The state is pushed once
   * a second; building an NSImage each time would leak one each time, because
   * nothing here runs an autorelease pool that would take them back.
   */
  private readonly images = new Map<IconState, Id>();

  constructor(private readonly options: TrayBackendOptions) {}

  async start(): Promise<void> {
    this.app = sharedApplication();
    // Run loop modes are compared by value, so an equal string will do.
    this.defaultMode = nsString("kCFRunLoopDefaultMode");

    this.handler = makeHandler((tag) => {
      if (tag === ICON_TAG) this.onClick();
      else this.options.onActivate(tag);
    });

    const bar = msg(cls("NSStatusBar"), "systemStatusBar");
    this.statusItem = msgDouble(bar, "statusItemWithLength:", VARIABLE_LENGTH);
    const button = msg(this.statusItem, "button");
    if (!button) throw new Error("the menu bar item has no button to hang the icon on");
    this.button = button;

    msg1(button, "setImage:", this.imageFor("off"));
    msgInt(button, "setTag:", ICON_TAG);
    msg1(button, "setTarget:", this.handler.instance);
    msg1(button, "setAction:", sel("onSelect:"));
    msgInt(button, "sendActionOn:", CLICK_MASK);

    this.pump = setInterval(() => this.step(), PUMP_INTERVAL_MS);
  }

  /**
   * A click on the icon: the window, unless the user asked for the menu.
   *
   * Which button it was is not handed to the action, so it is read back off the
   * event AppKit is delivering right now. Control-click stands in for the right
   * button everywhere else on this platform, so it does here too.
   */
  private imageFor(state: IconState): Id {
    const cached = this.images.get(state);
    if (cached) return cached;
    const png = pngFromPixmap(iconPixmap(state, ICON_PIXELS));
    // NSData copies the bytes, so the buffer does not have to outlive the call.
    const data = msg2(cls("NSData"), "dataWithBytes:length:", ptr(png), png.length as unknown as Id);
    const image = msg1(msg(cls("NSImage"), "alloc"), "initWithData:", data);
    if (!image) throw new Error("AppKit could not read the tray icon");
    // Without a size in points the image would be shown at one point per pixel.
    msgSize(image, "setSize:", ICON_POINTS, ICON_POINTS);
    this.images.set(state, image);
    return image;
  }

  private onClick(): void {
    if (!this.app) return;
    const event = msg(this.app, "currentEvent");
    const wantsMenu = !!event && opensMenu(Number(msg(event, "type")), Number(msg(event, "modifierFlags")));
    if (!wantsMenu) {
      this.options.onClick();
      return;
    }
    // popUpContextMenu: opens AppKit's own tracking loop, which does not return
    // until the menu closes -- the same pause an attached menu would cause, and
    // harmless because the daemon keeps the tunnel either way.
    if (this.menu && this.button && event) {
      msg3(cls("NSMenu"), "popUpContextMenu:withEvent:forView:", this.menu, event, this.button);
    }
  }

  /**
   * Runs the event loop for a moment. Clicking a menu opens AppKit's own
   * tracking loop, which does not return until the menu closes -- that pause is
   * expected and harmless, because the daemon keeps the tunnel either way.
   */
  private step(): void {
    if (!this.app) return;
    const distantPast = msg(cls("NSDate"), "distantPast");
    // Every pending event, then return: NSEventMaskAny is all bits set.
    for (let guard = 0; guard < 64; guard++) {
      const event = nextEvent(this.app, 0xffffffffffffffffn, distantPast, this.defaultMode as Id);
      if (!event) break;
      msg1(this.app, "sendEvent:", event);
    }
  }

  update(input: { state: IconState; tooltip: string; entries: MenuEntry[] }): void {
    if (!this.button) return;
    msg1(this.button, "setImage:", this.imageFor(input.state));
    msg1(this.button, "setToolTip:", nsString(input.tooltip));

    // Rebuilding is simpler than diffing and happens once a second at most.
    if (sameEntries(this.entries, input.entries)) return;
    this.entries = input.entries;
    // Nothing else holds the old menu now that the item does not, so replacing
    // it without releasing would leak one per status push. An open menu cannot
    // be reached from here: its tracking loop has the thread.
    const previous = this.menu;
    this.menu = this.buildMenu(input.entries);
    if (previous) msg(previous, "release");
  }

  private buildMenu(entries: MenuEntry[]): Id {
    const menu = msg(msg(cls("NSMenu"), "alloc"), "init");
    msgInt(menu, "setAutoenablesItems:", 0);

    for (const entry of entries) {
      if (entry.separator) {
        msg1(menu, "addItem:", msg(cls("NSMenuItem"), "separatorItem"));
        continue;
      }
      const item = msg(msg(cls("NSMenuItem"), "alloc"), "init");
      msg1(item, "setTitle:", nsString(entry.label ?? ""));
      msgInt(item, "setTag:", entry.id);
      msgInt(item, "setEnabled:", entry.enabled === false ? 0 : 1);
      if (entry.enabled !== false && this.handler) {
        msg1(item, "setTarget:", this.handler.instance);
        msg1(item, "setAction:", sel("onSelect:"));
      }
      msg1(menu, "addItem:", item);
    }
    return menu;
  }

  async stop(): Promise<void> {
    if (this.pump) clearInterval(this.pump);
    if (this.statusItem) {
      const bar = msg(cls("NSStatusBar"), "systemStatusBar");
      msg1(bar, "removeStatusItem:", this.statusItem);
    }
  }
}

const sameEntries = (a: MenuEntry[], b: MenuEntry[]): boolean =>
  a.length === b.length &&
  a.every((entry, index) => entry.label === b[index]?.label && entry.id === b[index]?.id);
