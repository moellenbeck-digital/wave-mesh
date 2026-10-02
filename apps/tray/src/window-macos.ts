import { t, type WindowLabels } from "./messages.ts";
import {
  cls,
  type Id,
  mainDisplaySize,
  makeHandler,
  msg,
  msg1,
  msg1Double,
  msg2,
  msg3,
  msgDouble,
  msgDouble4,
  msgGetDouble,
  msgInt,
  msgSize,
  NIL,
  nsString,
  sel,
  sharedApplication,
} from "./objc.ts";
import type { TrayWindow, TrayWindowOptions } from "./window.ts";
import { labelsOf, type WindowView } from "./window-view.ts";

/**
 * The macOS window, through the same Objective-C runtime binding that draws
 * the menu bar item.
 *
 * It is meant to read as the same thing the Linux overlay is: one dark card
 * pinned under the menu bar, the connections with a switch each and the
 * machines below them. The palette and the metrics are the ones in the GTK
 * stylesheet, so the two stay recognisably one design.
 *
 * Three constraints shape the whole file.
 *
 * **No NSRect ever crosses the boundary.** Its four doubles are passed in
 * registers on arm64 and on the stack on x86-64, so a single objc_msgSend
 * signature cannot be right on both. The window is therefore built with
 * +[NSWindow windowWithContentViewController:], which takes one object, and
 * sized with setContentSize:, whose NSSize is two doubles and lands in the same
 * two registers under either convention. Loose doubles -- a colour's four
 * components -- are safe, because only the packing of a struct is in dispute.
 *
 * **Layout is Auto Layout's job, not ours.** Placing views by frame would need
 * rects again; anchors take an object and a scalar and nothing else.
 *
 * **The height is arithmetic, not a measurement.** Asking AppKit for a fitting
 * size means an NSSize coming back, which is the one direction the boundary
 * cannot go. So every row is pinned to a known height and the card's is their
 * sum -- exact, as long as the constants below are the ones the constraints
 * use.
 *
 * AppKit's run loop is not pumped here. The menu bar item already steps it in
 * slices, and a window in the same process rides along.
 */

const ORIENTATION = { horizontal: 0, vertical: 1 } as const;
const DISTRIBUTION_FILL = 0;
/** NSLayoutAttribute: which edge of a stack its children line up on. */
const ALIGN = { leading: 5, centerY: 10 } as const;
/** NSControlStateValue */
const STATE = { off: 0, on: 1 } as const;
/** NSWindowStyleMask: titled, with the content reaching into the title bar. */
const STYLE_MASK = 1 | (1 << 15);
/** NSFloatingWindowLevel -- above ordinary windows, the way a popover sits. */
const FLOATING = 3;
const TITLE_HIDDEN = 1;
const TRUNCATE_TAIL = 4;
/** What -[NSButton setKeyEquivalent:] wants for the escape key. */
const ESCAPE = "\u001b";

/** The GTK stylesheet's colours, so both platforms show the same card. */
const PALETTE = {
  card: "#14161f",
  border: "#262b3b",
  text: "#d7dbe8",
  muted: "#7f88a3",
  active: "#232838",
  offline: "#5c6480",
  /** A service, the one thing on the card that opens something elsewhere. */
  service: "#7ecfcf",
} as const;

const WIDTH = 420;
/** Clear of the menu bar without floating off into the middle of the screen. */
const EDGE_MARGIN = 12;
const CORNER = 12;
const PAD = 20;
const RULE = 1;
const BEFORE_RULE = 16;
const AFTER_RULE = 12;
const HEADER_GAP = 2;
const AFTER_SECTION = 6;
const TITLE_HEIGHT = 28;
const SUBTITLE_HEIGHT = 15;
const SECTION_HEIGHT = 14;
const ROW_HEIGHT = 48;
/** A service line: one name, no second line, so it is shorter than a machine. */
const SERVICE_HEIGHT = 30;
/** The triangle that folds a machine's services out; a hair wider than it. */
const DISCLOSURE_WIDTH = 16;
const ROW_GAP = 2;
const ROW_INSET = 8;
const ROW_GAP_X = 10;
/** Wide enough for an NSSwitch, which is the wider of the two trailing views. */
const TRAILING_WIDTH = 38;
/** Past this the machine list scrolls rather than the card growing. */
const MAX_LIST_HEIGHT = 300;

const CONTENT_WIDTH = WIDTH - PAD * 2;
/**
 * The text beside a switch or a copy button.
 *
 * Auto Layout would rather derive this from hugging priorities, but those are
 * NSLayoutPriority -- a float, and a double passed where one is expected leaves
 * the wrong half of the register to be read. The row is a known width, so the
 * arithmetic is there for the taking.
 */
const TEXT_WIDTH = CONTENT_WIDTH - ROW_INSET * 2 - TRAILING_WIDTH - ROW_GAP_X;

/** Everything above the connections, and what stands between the two lists. */
const HEADER_HEIGHT = TITLE_HEIGHT + HEADER_GAP + SUBTITLE_HEIGHT;
const SECTION_BREAK = BEFORE_RULE + RULE + AFTER_RULE + SECTION_HEIGHT + AFTER_SECTION;

/**
 * Tags carry which row was clicked back out of AppKit, as the menu does.
 *
 * Read from the highest base down, because each one is a floor: a tag is
 * whichever band it falls into.
 */
const TAG = {
  dismiss: 1,
  toggleBase: 10_000,
  copyBase: 20_000,
  expandBase: 30_000,
  openBase: 40_000,
} as const;

/**
 * How often the card is asked whether it still has the focus.
 *
 * The same slice the menu bar item pumps AppKit in; any coarser and a click on
 * the icon would arrive before the card had noticed it lost the focus to it.
 */
const FOCUS_POLL_MS = 50;

/**
 * How long after the card dismissed itself a click on the icon is ignored.
 *
 * Clicking the icon of an open card takes the focus off it, which dismisses it
 * -- and the icon's own click arrives afterwards and would put it straight back
 * up. The same sequence and the same cure as on Windows.
 */
const DISMISS_GUARD_MS = 300;

/**
 * What a click on the icon means for a card in this state.
 *
 * Separate from the plumbing because the sequence it exists for cannot be
 * produced in a test: the click dismisses the card first and reports itself
 * only afterwards, so what reaches {@link MacosWindow.toggle} is a card that is
 * already away and a user who never asked for that.
 */
export const clickOnIcon = (visible: boolean, sinceDismissal: number): "close" | "open" | "ignore" => {
  if (visible) return "close";
  if (sinceDismissal < DISMISS_GUARD_MS) return "ignore";
  return "open";
};

const need = (value: Id | null | undefined, what: string): Id => {
  if (!value) throw new Error(`AppKit did not give us ${what}`);
  return value;
};

/** The height `count` stacked rows take. No rows is no height, not one row. */
const rowsHeight = (count: number): number => (count === 0 ? 0 : count * ROW_HEIGHT + (count - 1) * ROW_GAP);

/**
 * The machine list, whose rows are not all the same height once services are
 * unfolded under one of them.
 *
 * Every size here is arithmetic rather than something read back: an NSRect
 * cannot cross the FFI boundary, so a card that grew by a service row has to
 * be told by how much.
 */
const listHeight = (machines: number, services: number): number => {
  const count = machines + services;
  if (count === 0) return 0;
  return machines * ROW_HEIGHT + services * SERVICE_HEIGHT + (count - 1) * ROW_GAP;
};

export class MacosWindow implements TrayWindow {
  readonly platform = "darwin";

  private readonly app: Id;
  private readonly window: Id;
  private readonly root: Id;
  private readonly handler: { instance: Id; keepAlive: unknown };
  private titleLabel: Id;
  private subtitleLabel: Id;
  /** Built once with the card, but worded by every view: the language comes with it. */
  private connectionsHeading: Id;
  private machinesHeading: Id;
  /** What the rows of the view being built are worded with. */
  private labels: WindowLabels;
  private connectionsStack: Id;
  private machinesStack: Id;
  /** The one constraint that changes with the contents; see {@link resize}. */
  private listConstraint: Id;

  /** What each tag means right now; rebuilt with every update. */
  private toggles: Array<{ controlUrl: string; control: Id }> = [];
  private copies: string[] = [];
  private connectionViews: Id[] = [];
  private machineViews: Id[] = [];
  /**
   * Which machines have their services showing, by row key.
   *
   * Here and not in a row: `update()` rebuilds every view on each status push,
   * a second apart, and a card that folded itself back up that often would be
   * unusable. The view is kept so a click can redraw without waiting for the
   * next push.
   */
  private readonly expanded = new Set<string>();
  private view?: WindowView;
  /** What each expand and open tag means right now; rebuilt with every update. */
  private expandKeys: string[] = [];
  private opens: string[] = [];

  /** Runs only while the card is up; see {@link dismissWhenUnfocused}. */
  private watcher?: ReturnType<typeof setInterval>;
  /** The card had the focus at least once, so losing it now means something. */
  private wasFocused = false;
  /** When the card took itself down, or 0 if the user did. */
  private dismissedAt = 0;

  constructor(private readonly options: TrayWindowOptions) {
    this.app = sharedApplication();

    this.handler = makeHandler((tag) => this.onTag(tag), "WaveWindowTarget");

    this.titleLabel = label("", 20, true, PALETTE.text);
    fixHeight(this.titleLabel, TITLE_HEIGHT);
    this.subtitleLabel = label("", 10, true, PALETTE.muted);
    fixHeight(this.subtitleLabel, SUBTITLE_HEIGHT);
    this.connectionsStack = stack(ORIENTATION.vertical, ROW_GAP);
    this.machinesStack = stack(ORIENTATION.vertical, ROW_GAP);
    // Empty until the first view says them; the height is fixed either way,
    // so a longer German heading changes nothing that resize() adds up.
    this.connectionsHeading = sectionLabel("");
    this.machinesHeading = sectionLabel("");
    this.labels = t().window;

    const scroller = this.scrollingMachines();
    this.listConstraint = fixHeight(scroller, rowsHeight(1));

    this.root = stack(ORIENTATION.vertical, 0);
    for (const child of [
      this.titleLabel,
      spacer(HEADER_GAP),
      this.subtitleLabel,
      spacer(BEFORE_RULE),
      rule(),
      spacer(AFTER_RULE),
      this.connectionsHeading,
      spacer(AFTER_SECTION),
      this.connectionsStack,
      spacer(BEFORE_RULE),
      rule(),
      spacer(AFTER_RULE),
      this.machinesHeading,
      spacer(AFTER_SECTION),
      scroller,
    ]) {
      append(this.root, child);
    }

    const card = this.card();
    const controller = need(msg(msg(cls("NSViewController"), "alloc"), "init"), "a view controller");
    msg1(controller, "setView:", card);

    this.window = need(msg1(cls("NSWindow"), "windowWithContentViewController:", controller), "a window");
    this.dress(this.window);
    this.dismissOnEscape(card);
    this.resize(0, 0, 0);
  }

  /**
   * The card: the only thing that is actually drawn.
   *
   * The window behind it is transparent and its title bar is gone, so what the
   * user sees is this view's layer -- the same dark panel with the same corner
   * radius the GTK stylesheet paints.
   */
  private card(): Id {
    const card = need(msg(msg(cls("NSView"), "alloc"), "init"), "a view");
    msgInt(card, "setTranslatesAutoresizingMaskIntoConstraints:", 0);
    msgInt(card, "setWantsLayer:", 1);
    const layer = need(msg(card, "layer"), "a layer");
    msg1(layer, "setBackgroundColor:", cgColor(PALETTE.card));
    msg1(layer, "setBorderColor:", cgColor(PALETTE.border));
    msgDouble(layer, "setBorderWidth:", 1);
    msgDouble(layer, "setCornerRadius:", CORNER);
    msgInt(layer, "setMasksToBounds:", 1);

    msg1(card, "addSubview:", this.root);
    pinSides(this.root, card, PAD);
    activate(
      msg1Double(
        msg(this.root, "topAnchor"),
        "constraintEqualToAnchor:constant:",
        msg(card, "topAnchor"),
        PAD,
      ),
    );
    return card;
  }

  /** The machine list, which scrolls once it would push the card off-screen. */
  private scrollingMachines(): Id {
    const scroller = need(msg(msg(cls("NSScrollView"), "alloc"), "init"), "a scroll view");
    msgInt(scroller, "setTranslatesAutoresizingMaskIntoConstraints:", 0);
    msgInt(scroller, "setDrawsBackground:", 0);
    msgInt(scroller, "setHasVerticalScroller:", 1);
    msgInt(scroller, "setAutohidesScrollers:", 1);
    msg1(scroller, "setDocumentView:", this.machinesStack);

    // A document view under Auto Layout has to be told how wide it is; pinned
    // to the clip view it matches the scroller and only ever scrolls upwards.
    const clip = need(msg(scroller, "contentView"), "a clip view");
    pinSides(this.machinesStack, clip, 0);
    activate(msg1(msg(this.machinesStack, "topAnchor"), "constraintEqualToAnchor:", msg(clip, "topAnchor")));
    return scroller;
  }

  /**
   * Strips the window down to the card.
   *
   * Titled rather than borderless, because a borderless window cannot become
   * key and Escape would have nowhere to land; the title bar is made
   * transparent and the content reaches into it instead. Floating puts it over
   * ordinary windows the way the layer surface does on Linux.
   *
   * What is deliberately *not* here is setHidesOnDeactivate:. It is the
   * documented way to get "turn to something else and it goes away", and in a
   * process whose run loop is pumped by hand it does not happen: measured on
   * 24.09.2026, the app resigned active -- NSApplicationDidResignActiveNotification
   * was delivered and [NSApp isActive] flipped -- and the window stayed on
   * screen, on the window server's list, with isVisible still 1. So the card
   * was still up when the next click on the icon arrived, toggle() read that as
   * "it is open, close it", and opening took two clicks. The card takes itself
   * down instead; see {@link dismissWhenUnfocused}.
   */
  private dress(window: Id): void {
    msgInt(window, "setStyleMask:", STYLE_MASK);
    msg1(window, "setTitle:", nsString("wave"));
    msgInt(window, "setTitleVisibility:", TITLE_HIDDEN);
    msgInt(window, "setTitlebarAppearsTransparent:", 1);
    msgInt(window, "setMovable:", 0);
    msgInt(window, "setLevel:", FLOATING);
    msgInt(window, "setOpaque:", 0);
    msg1(window, "setBackgroundColor:", msg(cls("NSColor"), "clearColor"));
    msgInt(window, "setHasShadow:", 1);
    msgInt(window, "setReleasedWhenClosed:", 0);
    // Nothing hides the traffic lights, because the style mask never asks for
    // them: without closable, miniaturizable or resizable AppKit builds none.

    // The card is dark whatever the user's appearance is, so the stock controls
    // on it -- the switch, the scroller -- have to be told which side they are on.
    const dark = msg1(cls("NSAppearance"), "appearanceNamed:", nsString("NSAppearanceNameDarkAqua"));
    if (dark) msg1(window, "setAppearance:", dark);
  }

  /**
   * Escape closes it, the same second exit the Linux overlay has.
   *
   * A key equivalent needs a control to hang off, so there is a transparent
   * button with no title: it draws nothing and takes no space, but
   * -[NSView performKeyEquivalent:] still walks past it.
   */
  private dismissOnEscape(card: Id): void {
    const button = need(
      msg3(
        cls("NSButton"),
        "buttonWithTitle:target:action:",
        nsString(""),
        this.handler.instance,
        sel("onSelect:"),
      ),
      "a button",
    );
    msgInt(button, "setTag:", TAG.dismiss);
    msg1(button, "setKeyEquivalent:", nsString(ESCAPE));
    msgInt(button, "setTransparent:", 1);
    // Left to the autoresizing mask it keeps its empty frame; under Auto Layout
    // it would be a view with no constraints and an ambiguous position.
    msgInt(button, "setTranslatesAutoresizingMaskIntoConstraints:", 1);
    msg1(card, "addSubview:", button);
  }

  private onTag(tag: number): void {
    if (tag === TAG.dismiss) {
      this.close();
      return;
    }

    if (tag >= TAG.openBase) {
      const url = this.opens[tag - TAG.openBase];
      if (url) this.options.onOpen?.(url);
      return;
    }

    if (tag >= TAG.expandBase) {
      const key = this.expandKeys[tag - TAG.expandBase];
      if (key) this.toggleServices(key);
      return;
    }

    if (tag >= TAG.copyBase) {
      const text = this.copies[tag - TAG.copyBase];
      if (!text) return;
      const pasteboard = msg(cls("NSPasteboard"), "generalPasteboard");
      msg(pasteboard, "clearContents");
      msg2(pasteboard, "setString:forType:", nsString(text), nsString("public.utf8-plain-text"));
      this.options.onCopy?.(text);
      return;
    }

    const entry = this.toggles[tag - TAG.toggleBase];
    if (!entry) return;
    this.options.onToggle(entry.controlUrl, Number(msg(entry.control, "state")) === STATE.on);
  }

  /**
   * Folds a machine's services out or away.
   *
   * Redrawn on the next turn of the loop rather than from inside the action:
   * the rebuild takes the very button that was clicked out of the hierarchy,
   * and AppKit is still in the middle of sending its action. The card pumps
   * AppKit from a timer here, so the next tick is an action that has returned.
   */
  private toggleServices(key: string): void {
    if (!this.expanded.delete(key)) this.expanded.add(key);
    setTimeout(() => {
      if (this.view) this.update(this.view);
    }, 0);
  }

  open(): void {
    msgInt(this.app, "activateIgnoringOtherApps:", 1);
    msg1(this.window, "makeKeyAndOrderFront:", NIL);
    this.place();
    this.wasFocused = false;
    this.watcher ??= setInterval(() => this.dismissWhenUnfocused(), FOCUS_POLL_MS);
  }

  close(): void {
    this.hide();
    // After hiding, not before: this is the user putting the card away, and a
    // click on the icon right afterwards should bring it back.
    this.dismissedAt = 0;
  }

  /** Ordered out rather than closed, so the icon can bring the same card back. */
  private hide(): void {
    msg1(this.window, "orderOut:", NIL);
    this.stopWatching();
  }

  private stopWatching(): void {
    if (this.watcher) clearInterval(this.watcher);
    this.watcher = undefined;
  }

  /**
   * Takes the card down once the focus has gone somewhere else.
   *
   * This is what setHidesOnDeactivate: would do if it worked here; see
   * {@link dress}. The card's own key status is asked rather than the
   * application's active state, because it is the narrower question and the one
   * that is actually meant: a menu, another window or another app taking the
   * focus all end the card, whether or not the process stops being active.
   *
   * The card is given until it has been focused once, because
   * activateIgnoringOtherApps: is asynchronous -- judging it before that would
   * dismiss a card in the moment it was opened.
   */
  private dismissWhenUnfocused(): void {
    if (!this.visible()) {
      this.stopWatching();
      return;
    }
    if (Number(msg(this.window, "isKeyWindow")) !== 0) {
      this.wasFocused = true;
      return;
    }
    if (!this.wasFocused) return;
    this.hide();
    this.dismissedAt = Date.now();
  }

  private visible(): boolean {
    return Number(msg(this.window, "isVisible")) !== 0;
  }

  toggle(): void {
    const action = clickOnIcon(this.visible(), Date.now() - this.dismissedAt);
    if (action === "close") {
      this.close();
      return;
    }
    if (action === "ignore") {
      // The click that dismissed the card, reporting itself. The card is
      // already away; the next click is a real one and has to open it.
      this.dismissedAt = 0;
      return;
    }
    this.open();
  }

  update(view: WindowView): void {
    this.view = view;
    // A machine that left takes its open state with it; otherwise the set
    // grows for the life of a tray that runs for weeks.
    const keys = new Set(view.machines.map((machine) => machine.key));
    for (const key of this.expanded) if (!keys.has(key)) this.expanded.delete(key);

    msg1(this.titleLabel, "setStringValue:", nsString(view.title));
    msg1(this.subtitleLabel, "setStringValue:", nsString(view.subtitle.toUpperCase()));
    this.labels = labelsOf(view);
    msg1(this.connectionsHeading, "setStringValue:", nsString(this.labels.connections));
    msg1(this.machinesHeading, "setStringValue:", nsString(this.labels.machines));

    this.toggles = [];
    this.connectionViews = this.replace(this.connectionsStack, this.connectionViews, () =>
      view.connections.map((row, index) => this.connectionRow(row, index)),
    );

    this.copies = view.machines.map((row) => row.dnsName);
    this.expandKeys = view.machines.map((row) => row.key);
    this.opens = [];
    this.machineViews = this.replace(this.machinesStack, this.machineViews, () =>
      view.machines.length === 0
        ? [emptyRow(view.emptyMachines)]
        : view.machines.flatMap((row, index) => [
            this.machineRow(row, view.labelMachines, index),
            ...(this.expanded.has(row.key) ? row.services.map((service) => this.serviceRow(service)) : []),
          ]),
    );

    this.resize(view.connections.length, view.machines.length, this.opens.length);
  }

  /**
   * Grows the card to its contents and puts it back under the menu bar.
   *
   * setContentSize: leaves the bottom-left corner where it was, so a card that
   * grew would walk up the screen; anchoring again afterwards is what keeps it
   * in the corner.
   */
  private resize(connections: number, machines: number, services: number): void {
    // An empty machine list is not empty: it carries the line that says why.
    const list = Math.min(listHeight(Math.max(machines, 1), services), MAX_LIST_HEIGHT);
    msgDouble(this.listConstraint, "setConstant:", list);
    const height = PAD + HEADER_HEIGHT + SECTION_BREAK + rowsHeight(connections) + SECTION_BREAK + list + PAD;
    msgSize(this.window, "setContentSize:", WIDTH, height);
    this.place();
  }

  /** Top right, clear of the menu bar -- where the icon that opened it is. */
  private place(): void {
    const screen = mainDisplaySize();
    const menuBar = msgGetDouble(msg(cls("NSStatusBar"), "systemStatusBar"), "thickness");
    msgSize(
      this.window,
      "setFrameTopLeftPoint:",
      screen.width - WIDTH - EDGE_MARGIN,
      screen.height - menuBar - EDGE_MARGIN,
    );
  }

  /**
   * Swaps a stack's children wholesale.
   *
   * removeArrangedSubview: only takes a view out of the layout, not out of the
   * hierarchy -- without removeFromSuperview the old rows keep drawing over the
   * new ones.
   */
  private replace(parent: Id, previous: Id[], build: () => Id[]): Id[] {
    for (const child of previous) {
      msg1(parent, "removeArrangedSubview:", child);
      msg(child, "removeFromSuperview");
    }
    const next = build();
    for (const child of next) append(parent, child);
    return next;
  }

  private connectionRow(row: WindowView["connections"][number], index: number): Id {
    const { view, content } = rowView(row.connected ? PALETTE.active : undefined);

    const text = stack(ORIENTATION.vertical, 1);
    fixWidth(text, TEXT_WIDTH);
    msg1(text, "addArrangedSubview:", label(row.label, 13, true, PALETTE.text));
    msg1(text, "addArrangedSubview:", label(row.detail, 11, false, PALETTE.muted));

    const toggle = need(msg(msg(cls("NSSwitch"), "alloc"), "init"), "a switch");
    msgInt(toggle, "setState:", row.connected ? STATE.on : STATE.off);
    msgInt(toggle, "setTag:", TAG.toggleBase + index);
    msg1(toggle, "setTarget:", this.handler.instance);
    msg1(toggle, "setAction:", sel("onSelect:"));
    this.toggles[index] = { controlUrl: row.controlUrl, control: toggle };

    msg1(content, "addArrangedSubview:", text);
    msg1(content, "addArrangedSubview:", toggle);
    return view;
  }

  private machineRow(row: WindowView["machines"][number], labelled: boolean, index: number): Id {
    const { view, content } = rowView();
    msg1(view, "setToolTip:", nsString(row.path));
    const open = this.expanded.has(row.key);
    const hasServices = row.services.length > 0;

    const text = stack(ORIENTATION.vertical, 1);
    // The triangle takes its width out of the text's, so every row's name
    // still starts in the same place.
    fixWidth(text, hasServices ? TEXT_WIDTH - DISCLOSURE_WIDTH - ROW_GAP_X : TEXT_WIDTH);
    const name = labelled ? `${row.hostname}  ·  ${row.waveLabel}` : row.hostname;
    msg1(text, "addArrangedSubview:", label(name, 13, true, row.online ? PALETTE.text : PALETTE.offline));
    const detail = hasServices
      ? `${row.address} · ${this.labels.services(row.services.length)}`
      : `${row.address} · ${row.dnsName}`;
    msg1(text, "addArrangedSubview:", label(detail, 11, false, PALETTE.muted));

    msg1(content, "addArrangedSubview:", text);
    // Only a machine with something under it gets a triangle. One that offers
    // a press and then does nothing is a broken control.
    const triangle = hasServices ? this.disclosure(open, index) : undefined;
    if (triangle) msg1(content, "addArrangedSubview:", triangle);
    msg1(content, "addArrangedSubview:", this.copyButton(row.dnsName, index));
    if (triangle) this.expandArea(view, text, triangle, index, row.path);
    return view;
  }

  /**
   * The whole line up to the copy button, as one press.
   *
   * The triangle on its own is sixteen points wide, on a row whose name and
   * address are what reads as the thing to click: a target that is missed, and
   * reported as the card not reacting at all. GTK gets this for free because a
   * button there takes a child, so the text sits inside it; AppKit has no such
   * thing, so a transparent button is laid over the text and the triangle
   * instead -- it draws nothing but tracks the mouse and sends the action,
   * which is the whole of what is wanted.
   *
   * It stops at the triangle, exactly as the Windows card does: the one thing
   * on this line that means something else is the copy button.
   */
  private expandArea(view: Id, text: Id, triangle: Id, index: number, tooltip: string): void {
    const area = need(
      msg3(
        cls("NSButton"),
        "buttonWithTitle:target:action:",
        nsString(""),
        this.handler.instance,
        sel("onSelect:"),
      ),
      "a button",
    );
    msgInt(area, "setTag:", TAG.expandBase + index);
    msgInt(area, "setTransparent:", 1);
    msgInt(area, "setTranslatesAutoresizingMaskIntoConstraints:", 0);
    // The labels under it are not hit-testable, so the row's own tooltip would
    // simply stop appearing once something covers them; it moves up with the
    // clicks.
    msg1(area, "setToolTip:", nsString(tooltip));
    // Added after the row's contents, so it lies over them.
    msg1(view, "addSubview:", area);
    pinEdge(area, "leadingAnchor", text);
    pinEdge(area, "trailingAnchor", triangle);
    pinEdge(area, "topAnchor", view);
    pinEdge(area, "bottomAnchor", view);
  }

  /** The triangle that folds a machine's services out, and away again. */
  private disclosure(open: boolean, index: number): Id {
    const button = need(
      msg3(
        cls("NSButton"),
        "buttonWithTitle:target:action:",
        nsString(open ? "▾" : "▸"),
        this.handler.instance,
        sel("onSelect:"),
      ),
      "a button",
    );
    msgInt(button, "setTag:", TAG.expandBase + index);
    msgInt(button, "setBordered:", 0);
    msg1(button, "setContentTintColor:", nsColor(PALETTE.muted));
    msg1(button, "setToolTip:", nsString(open ? this.labels.hideServices : this.labels.showServices));
    fixWidth(button, DISCLOSURE_WIDTH);
    return button;
  }

  /**
   * A service under the machine that fronts it: the whole line opens it.
   *
   * A button rather than a label with a gesture, because a gesture recogniser
   * carries no tag and the tag is how a click finds its way back out of AppKit.
   */
  private serviceRow(service: WindowView["machines"][number]["services"][number]): Id {
    const { view, content } = rowView(undefined, SERVICE_HEIGHT);
    const index = this.opens.push(service.url) - 1;

    const button = need(
      msg3(
        cls("NSButton"),
        "buttonWithTitle:target:action:",
        nsString(`${service.url}   ${service.address}`),
        this.handler.instance,
        sel("onSelect:"),
      ),
      "a button",
    );
    msgInt(button, "setTag:", TAG.openBase + index);
    msgInt(button, "setBordered:", 0);
    // Left, not centred: it reads as a line under its machine, not as a button.
    msgInt(button, "setAlignment:", 0);
    msg1(button, "setContentTintColor:", nsColor(PALETTE.service));
    msg1(button, "setToolTip:", nsString(this.labels.open(service.url)));
    fixWidth(button, TEXT_WIDTH);

    const indent = spacer(0);
    fixWidth(indent, ROW_INSET);
    msg1(content, "addArrangedSubview:", indent);
    msg1(content, "addArrangedSubview:", button);
    return view;
  }

  /** The same icon-only button GTK gets from its symbolic theme. */
  private copyButton(copyText: string, index: number): Id {
    const image = msg2(
      cls("NSImage"),
      "imageWithSystemSymbolName:accessibilityDescription:",
      nsString("doc.on.doc"),
      nsString(this.labels.copy(copyText)),
    );
    const copy = need(
      image
        ? msg3(
            cls("NSButton"),
            "buttonWithImage:target:action:",
            image,
            this.handler.instance,
            sel("onSelect:"),
          )
        : msg3(
            cls("NSButton"),
            "buttonWithTitle:target:action:",
            nsString(this.labels.copyButton),
            this.handler.instance,
            sel("onSelect:"),
          ),
      "a button",
    );
    msgInt(copy, "setTag:", TAG.copyBase + index);
    msgInt(copy, "setBordered:", 0);
    msg1(copy, "setContentTintColor:", nsColor(PALETTE.muted));
    msg1(copy, "setToolTip:", nsString(this.labels.copy(copyText)));
    fixWidth(copy, TRAILING_WIDTH);
    return copy;
  }

  destroy(): void {
    this.close();
  }
}

function stack(orientation: number, spacing: number): Id {
  const view = need(msg(msg(cls("NSStackView"), "alloc"), "init"), "a stack view");
  msgInt(view, "setTranslatesAutoresizingMaskIntoConstraints:", 0);
  msgInt(view, "setOrientation:", orientation);
  msgDouble(view, "setSpacing:", spacing);
  msgInt(view, "setDistribution:", DISTRIBUTION_FILL);
  // A vertical stack centres its children unless told otherwise, which would
  // put every label in the middle of the card.
  msgInt(view, "setAlignment:", orientation === ORIENTATION.vertical ? ALIGN.leading : ALIGN.centerY);
  return view;
}

/** Adds a child and gives it the stack's full width, as a GTK box would. */
function append(parent: Id, child: Id): void {
  msg1(parent, "addArrangedSubview:", child);
  activate(msg1(msg(child, "widthAnchor"), "constraintEqualToAnchor:", msg(parent, "widthAnchor")));
}

const activate = (constraint: Id): void => void msgInt(constraint, "setActive:", 1);

function fixHeight(view: Id, height: number): Id {
  const constraint = msgDouble(msg(view, "heightAnchor"), "constraintEqualToConstant:", height);
  activate(constraint);
  return constraint;
}

function fixWidth(view: Id, width: number): Id {
  const constraint = msgDouble(msg(view, "widthAnchor"), "constraintEqualToConstant:", width);
  activate(constraint);
  return constraint;
}

/** The same edge of two views, tied to each other. */
function pinEdge(child: Id, anchor: string, other: Id): void {
  activate(msg1(msg(child, anchor), "constraintEqualToAnchor:", msg(other, anchor)));
}

/** Leading and trailing against another view, inset by the same amount. */
function pinSides(child: Id, parent: Id, inset: number): void {
  activate(
    msg1Double(
      msg(child, "leadingAnchor"),
      "constraintEqualToAnchor:constant:",
      msg(parent, "leadingAnchor"),
      inset,
    ),
  );
  activate(
    msg1Double(
      msg(child, "trailingAnchor"),
      "constraintEqualToAnchor:constant:",
      msg(parent, "trailingAnchor"),
      -inset,
    ),
  );
}

/** A row of known height, its contents inset and centred within it. */
function rowView(background?: string, height: number = ROW_HEIGHT): { view: Id; content: Id } {
  const view = need(msg(msg(cls("NSView"), "alloc"), "init"), "a view");
  msgInt(view, "setTranslatesAutoresizingMaskIntoConstraints:", 0);
  fixHeight(view, height);
  if (background) {
    msgInt(view, "setWantsLayer:", 1);
    const layer = msg(view, "layer");
    if (layer) {
      msg1(layer, "setBackgroundColor:", cgColor(background));
      msgDouble(layer, "setCornerRadius:", 8);
    }
  }

  const content = stack(ORIENTATION.horizontal, ROW_GAP_X);
  msg1(view, "addSubview:", content);
  pinSides(content, view, ROW_INSET);
  activate(msg1(msg(content, "centerYAnchor"), "constraintEqualToAnchor:", msg(view, "centerYAnchor")));
  return { view, content };
}

/** Stands in for the machine list, so the card keeps its shape when empty. */
function emptyRow(text: string): Id {
  const { view, content } = rowView();
  msg1(content, "addArrangedSubview:", label(text, 11, false, PALETTE.muted));
  return view;
}

/** An empty view of a known height, which is how a stack spells vertical space. */
function spacer(height: number): Id {
  const view = need(msg(msg(cls("NSView"), "alloc"), "init"), "a view");
  msgInt(view, "setTranslatesAutoresizingMaskIntoConstraints:", 0);
  fixHeight(view, height);
  return view;
}

/** The hairline between two sections. */
function rule(): Id {
  const view = need(msg(msg(cls("NSView"), "alloc"), "init"), "a view");
  msgInt(view, "setTranslatesAutoresizingMaskIntoConstraints:", 0);
  msgInt(view, "setWantsLayer:", 1);
  const layer = msg(view, "layer");
  if (layer) msg1(layer, "setBackgroundColor:", cgColor(PALETTE.border));
  fixHeight(view, RULE);
  return view;
}

function label(text: string, size: number, bold: boolean, colour: string): Id {
  const view = need(msg1(cls("NSTextField"), "labelWithString:", nsString(text)), "a label");
  const font = msgDouble(cls("NSFont"), bold ? "boldSystemFontOfSize:" : "systemFontOfSize:", size);
  msg1(view, "setFont:", font);
  msg1(view, "setTextColor:", nsColor(colour));
  msgInt(view, "setLineBreakMode:", TRUNCATE_TAIL);
  return view;
}

const sectionLabel = (text: string): Id => {
  const view = label(text, 10, true, PALETTE.muted);
  fixHeight(view, SECTION_HEIGHT);
  return view;
};

/**
 * "#14161f" as an NSColor, in sRGB rather than the device's own space, so the
 * card comes out the colour the stylesheet names on any display.
 */
function nsColor(hex: string): Id {
  const value = Number.parseInt(hex.slice(1), 16);
  return need(
    msgDouble4(
      cls("NSColor"),
      "colorWithSRGBRed:green:blue:alpha:",
      ((value >> 16) & 0xff) / 255,
      ((value >> 8) & 0xff) / 255,
      (value & 0xff) / 255,
      1,
    ),
    "a colour",
  );
}

/** A layer wants the CoreGraphics colour, not the AppKit one. */
const cgColor = (hex: string): Id => need(msg(nsColor(hex), "CGColor"), "a colour");
