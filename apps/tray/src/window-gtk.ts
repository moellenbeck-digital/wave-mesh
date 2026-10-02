import type { JSCallback, Pointer } from "bun:ffi";
import {
  ALIGN,
  CSS_PRIORITY,
  connect,
  connectClick,
  connectKey,
  cstr,
  EDGE,
  ELLIPSIZE_END,
  gdk,
  glib,
  gtk,
  KEY_ESCAPE,
  KEYBOARD,
  LAYER,
  layerShell,
  need,
  ORIENTATION,
  POLICY,
  pumpEvents,
  setClipboard,
} from "./gtk.ts";
import { t, type WindowLabels } from "./messages.ts";
import type { TrayWindow, TrayWindowOptions } from "./window.ts";
import { labelsOf, type WindowView } from "./window-view.ts";

/** Long enough to feel responsive, short enough not to starve the socket. */
const PUMP_INTERVAL_MS = 30;
/** Clear of the bar without floating off into the middle of the screen. */
const EDGE_MARGIN = 12;
const WIDTH = 420;
/** Past this the machine list scrolls rather than the overlay growing. */
const MAX_LIST_HEIGHT = 300;

const CSS = `
/* The surface covers the screen so a click beside the card can be seen; only
   the card is painted, the rest stays see-through. */
window { background: transparent; }
.card { background: #14161f; border-radius: 12px; border: 1px solid #262b3b; }
label { color: #d7dbe8; }
.title { font-size: 1.35rem; font-weight: 700; }
.subtitle { color: #7f88a3; font-size: 0.85rem; letter-spacing: 0.12em; }
.section { color: #7f88a3; font-size: 0.75rem; font-weight: 700; letter-spacing: 0.14em; }
.row-title { font-weight: 600; }
.row-detail { color: #7f88a3; font-size: 0.85rem; }
.row { background: transparent; border-radius: 8px; }
.row:hover { background: #1c2030; }
/* The machine's own half of the row, and a service under it: flat buttons, so
   hover, focus and the keyboard come from GTK rather than from a gesture. */
button.flat { background: transparent; border: none; box-shadow: none; padding: 0; }
button.flat:hover { background: transparent; }
.service { background: transparent; border-radius: 6px; padding: 4px 8px; }
.service:hover { background: #1c2030; }
.service-name { color: #7ecfcf; font-size: 0.85rem; }
.chevron { color: #7f88a3; font-size: 0.8rem; }
.row-active { background: #232838; border-radius: 8px; }
.offline { color: #5c6480; }
separator { background: #262b3b; min-height: 1px; }
button.copy { background: transparent; border: none; box-shadow: none; padding: 4px; }
button.copy:hover { background: #2b3145; }
/* The wave accent rather than the desktop's, so the switch belongs here. */
switch:checked { background: #0f6e6e; }
switch:checked:hover { background: #12857f; }
`;

/** A widget plus everything that has to be released with it. */
interface Row {
  widget: Pointer;
  callbacks: JSCallback[];
}

export class GtkWindow implements TrayWindow {
  readonly platform = "linux";

  private window: Pointer;
  private titleLabel: Pointer;
  private subtitleLabel: Pointer;
  /** Built once with the card, but worded by every view: the language comes with it. */
  private connectionsHeading: Pointer;
  private machinesHeading: Pointer;
  /** What the rows of the view being built are worded with. */
  private labels: WindowLabels = t().window;
  private connectionsBox: Pointer;
  private machinesBox: Pointer;
  private pump?: ReturnType<typeof setInterval>;

  private overlay = false;
  private card?: Pointer;
  private readonly keepAlive: JSCallback[] = [];
  private connectionRows: Row[] = [];
  private machineRows: Row[] = [];
  /**
   * Which machines have their services showing, by row key.
   *
   * Here and not in a row: `update()` throws every widget away on each status
   * push, a second apart, and a card that folded itself back up that often
   * would be unusable. The view is kept for the same reason -- a click has to
   * redraw the list without waiting for the next push.
   */
  private readonly expanded = new Set<string>();
  private view?: WindowView;
  /** Set while update() moves the switches, so their handler stays quiet. */
  private applying = false;

  constructor(private readonly options: TrayWindowOptions) {
    // Before gtk_init: the Wayland app_id is taken from here, and it is the
    // only handle a compositor has for floating this window instead of tiling
    // it into the session like an editor.
    glib.symbols.g_set_prgname(cstr("wave-tray"));
    gtk.symbols.gtk_init();
    this.installCss();

    const window = need(gtk.symbols.gtk_window_new(), "a window");
    this.window = window;
    gtk.symbols.gtk_window_set_title(window, cstr("wave"));
    // No default size: as a layer surface anchored to all four edges the
    // window is the screen, and the card inside it is what has a size.
    // Closing must not dispose it: the icon has to be able to bring it back.
    gtk.symbols.gtk_window_set_hide_on_close(window, true);
    this.asOverlay(window);

    const card = box(ORIENTATION.vertical, 0);
    gtk.symbols.gtk_widget_add_css_class(card, cstr("card"));
    gtk.symbols.gtk_widget_set_halign(card, ALIGN.end);
    gtk.symbols.gtk_widget_set_valign(card, ALIGN.start);
    gtk.symbols.gtk_widget_set_size_request(card, WIDTH, -1);
    this.card = card;

    const root = box(ORIENTATION.vertical, 0);
    pad(root, 20);
    gtk.symbols.gtk_box_append(card, root);
    gtk.symbols.gtk_window_set_child(window, card);

    this.titleLabel = label("", "title");
    this.subtitleLabel = label("", "subtitle");
    const header = box(ORIENTATION.vertical, 2);
    gtk.symbols.gtk_box_append(header, this.titleLabel);
    gtk.symbols.gtk_box_append(header, this.subtitleLabel);
    gtk.symbols.gtk_box_append(root, header);

    gtk.symbols.gtk_box_append(root, spacer(16));
    gtk.symbols.gtk_box_append(root, gtk.symbols.gtk_separator_new(ORIENTATION.horizontal));
    gtk.symbols.gtk_box_append(root, spacer(12));

    this.connectionsHeading = label("", "section");
    gtk.symbols.gtk_box_append(root, this.connectionsHeading);
    gtk.symbols.gtk_box_append(root, spacer(6));
    this.connectionsBox = box(ORIENTATION.vertical, 2);
    gtk.symbols.gtk_box_append(root, this.connectionsBox);

    gtk.symbols.gtk_box_append(root, spacer(16));
    gtk.symbols.gtk_box_append(root, gtk.symbols.gtk_separator_new(ORIENTATION.horizontal));
    gtk.symbols.gtk_box_append(root, spacer(12));

    this.machinesHeading = label("", "section");
    gtk.symbols.gtk_box_append(root, this.machinesHeading);
    gtk.symbols.gtk_box_append(root, spacer(6));

    // The machine list is the only part that can grow, so it is the only part
    // that scrolls; the header and the connections stay put.
    this.machinesBox = box(ORIENTATION.vertical, 2);
    const scroller = need(gtk.symbols.gtk_scrolled_window_new(), "a scrolled window");
    gtk.symbols.gtk_scrolled_window_set_policy(scroller, POLICY.never, POLICY.automatic);
    gtk.symbols.gtk_scrolled_window_set_child(scroller, this.machinesBox);
    // Take the list's own height, up to a point; beyond it the list scrolls
    // and the overlay stops growing.
    gtk.symbols.gtk_scrolled_window_set_propagate_natural_height(scroller, true);
    gtk.symbols.gtk_scrolled_window_set_max_content_height(scroller, MAX_LIST_HEIGHT);
    gtk.symbols.gtk_box_append(root, scroller);

    this.dismissOnClickOutside(window);
    this.pump = setInterval(pumpEvents, PUMP_INTERVAL_MS);
  }

  /**
   * Puts the overlay away when the user turns to something else, the way a
   * popover behaves. There is no way to see a click that lands outside a layer
   * surface -- the compositor delivers it to whatever is under it -- so what is
   * observed is the keyboard focus that click moves.
   *
   * Escape is wired up as well, and not only for comfort: it is the second way
   * out if a compositor never takes the focus back.
   */
  private dismissOnClickOutside(window: Pointer): void {
    const gesture = need(gtk.symbols.gtk_gesture_click_new(), "a click gesture");
    gtk.symbols.gtk_widget_add_controller(window, gesture);
    this.keepAlive.push(
      connectClick(gesture, (x, y) => {
        // Which widget the press landed on. Inside the card -- or on anything
        // within it -- is a real interaction; anywhere else is "elsewhere",
        // and that is the click a popover disappears on.
        const hit = gtk.symbols.gtk_widget_pick(window, x, y, 0);
        if (hit && this.card && (hit === this.card || gtk.symbols.gtk_widget_is_ancestor(hit, this.card))) {
          return;
        }
        this.close();
      }),
    );

    const keys = need(gtk.symbols.gtk_event_controller_key_new(), "a key controller");
    gtk.symbols.gtk_widget_add_controller(window, keys);
    this.keepAlive.push(
      connectKey(keys, (keyval) => {
        if (keyval !== KEY_ESCAPE) return false;
        this.close();
        return true;
      }),
    );
  }

  /**
   * Makes the window an overlay pinned to the top right, the way a tray popover
   * behaves, instead of a toplevel the compositor tiles into the session.
   *
   * Only wlroots compositors offer the protocol. Everywhere else this quietly
   * does nothing and an ordinary window appears -- which is worth a line in the
   * log, because the difference is visible and otherwise unexplained.
   */
  private asOverlay(window: Pointer): void {
    if (!layerShell?.symbols.gtk_layer_is_supported()) {
      this.overlay = false;
      return;
    }
    layerShell.symbols.gtk_layer_init_for_window(window);
    layerShell.symbols.gtk_layer_set_namespace(window, cstr("wave"));
    layerShell.symbols.gtk_layer_set_layer(window, LAYER.overlay);
    // All four edges: the surface is the whole screen, transparent except for
    // the card. That is the only way to see a click that lands beside it --
    // anything outside a layer surface goes to whatever is underneath, and we
    // never hear about it.
    for (const edge of [EDGE.top, EDGE.right, EDGE.bottom, EDGE.left]) {
      layerShell.symbols.gtk_layer_set_anchor(window, edge, true);
    }
    layerShell.symbols.gtk_layer_set_margin(window, EDGE.top, EDGE_MARGIN);
    layerShell.symbols.gtk_layer_set_margin(window, EDGE.right, EDGE_MARGIN);
    // On demand, not exclusive: the overlay takes the keyboard when clicked
    // and gives it back, rather than holding it while it is merely visible.
    layerShell.symbols.gtk_layer_set_keyboard_mode(window, KEYBOARD.onDemand);
    this.overlay = true;
  }

  /** Whether it really became a layer surface; false means a plain window. */
  readonly overlayMode = (): boolean => this.overlay;

  private installCss(): void {
    const display = gdk.symbols.gdk_display_get_default();
    if (!display) return;
    const provider = gtk.symbols.gtk_css_provider_new();
    if (!provider) return;
    gtk.symbols.gtk_css_provider_load_from_string(provider, cstr(CSS));
    gtk.symbols.gtk_style_context_add_provider_for_display(display, provider, CSS_PRIORITY);
  }

  open(): void {
    gtk.symbols.gtk_window_present(this.window);
  }

  close(): void {
    // Hidden rather than closed: a layer surface has no title bar to bring it
    // back with, so the object has to survive for the icon to show it again.
    gtk.symbols.gtk_widget_set_visible(this.window, false);
  }

  toggle(): void {
    if (gtk.symbols.gtk_widget_get_visible(this.window)) this.close();
    else this.open();
  }

  update(view: WindowView): void {
    this.view = view;
    // A machine that left takes its open state with it; otherwise the set
    // grows for the life of the process over a long-running tray.
    const keys = new Set(view.machines.map((machine) => machine.key));
    for (const key of this.expanded) if (!keys.has(key)) this.expanded.delete(key);
    this.applying = true;
    gtk.symbols.gtk_label_set_text(this.titleLabel, cstr(view.title));
    gtk.symbols.gtk_label_set_text(this.subtitleLabel, cstr(view.subtitle.toUpperCase()));
    this.labels = labelsOf(view);
    gtk.symbols.gtk_label_set_text(this.connectionsHeading, cstr(this.labels.connections));
    gtk.symbols.gtk_label_set_text(this.machinesHeading, cstr(this.labels.machines));

    this.connectionRows = this.replace(this.connectionsBox, this.connectionRows, () =>
      view.connections.map((row) => this.connectionRow(row)),
    );

    this.machineRows = this.replace(this.machinesBox, this.machineRows, () =>
      view.machines.length === 0
        ? [{ widget: label(view.emptyMachines, "row-detail"), callbacks: [] }]
        : view.machines.map((row) => this.machineRow(row, view.labelMachines)),
    );
    this.applying = false;
  }

  /** Swaps a box's children wholesale, releasing the callbacks of the old ones. */
  private replace(parent: Pointer, previous: Row[], build: () => Row[]): Row[] {
    for (const row of previous) {
      gtk.symbols.gtk_box_remove(parent, row.widget);
      // Only now: closing a callback while its widget still exists would leave
      // the signal pointing at freed memory.
      for (const callback of row.callbacks) callback.close();
    }
    const rows = build();
    for (const row of rows) gtk.symbols.gtk_box_append(parent, row.widget);
    return rows;
  }

  private connectionRow(row: WindowView["connections"][number]): Row {
    const line = box(ORIENTATION.horizontal, 12);
    gtk.symbols.gtk_widget_add_css_class(line, cstr(row.connected ? "row-active" : "row"));
    pad(line, 8);

    const text = box(ORIENTATION.vertical, 1);
    gtk.symbols.gtk_widget_set_hexpand(text, true);
    gtk.symbols.gtk_box_append(text, label(row.label, "row-title"));
    gtk.symbols.gtk_box_append(text, label(row.detail, "row-detail"));
    gtk.symbols.gtk_box_append(line, text);

    const toggle = need(gtk.symbols.gtk_switch_new(), "a switch");
    gtk.symbols.gtk_switch_set_active(toggle, row.connected);
    gtk.symbols.gtk_widget_set_valign(toggle, ALIGN.center);
    gtk.symbols.gtk_box_append(line, toggle);

    // notify::active rather than state-set: it is void, and reading the switch
    // back is simpler than deciding what a gboolean return means.
    const callback = connect(toggle, "notify::active", 3, () => {
      if (this.applying) return;
      this.options.onToggle(row.controlUrl, gtk.symbols.gtk_switch_get_active(toggle));
    });

    return { widget: line, callbacks: [callback] };
  }

  private machineRow(row: WindowView["machines"][number], labelled: boolean): Row {
    const line = box(ORIENTATION.horizontal, 12);
    gtk.symbols.gtk_widget_add_css_class(line, cstr("row"));
    // How it is reached changes every few seconds; on the row it would be
    // noise, in a tooltip it is there when someone wonders.
    gtk.symbols.gtk_widget_set_tooltip_text(line, cstr(row.path));
    pad(line, 8);

    const open = this.expanded.has(row.key);
    const hasServices = row.services.length > 0;
    const callbacks: JSCallback[] = [];

    const text = box(ORIENTATION.vertical, 1);
    const name = label(labelled ? `${row.hostname}  ·  ${row.waveLabel}` : row.hostname, "row-title");
    if (!row.online) gtk.symbols.gtk_widget_add_css_class(name, cstr("offline"));
    gtk.symbols.gtk_box_append(text, name);

    const copyText = row.dnsName;
    const detail = hasServices
      ? `${row.address} · ${this.labels.services(row.services.length)}`
      : `${row.address} · ${row.dnsName}`;
    const sub = label(detail, "row-detail");
    gtk.symbols.gtk_label_set_ellipsize(sub, ELLIPSIZE_END);
    gtk.symbols.gtk_box_append(text, sub);

    // Only a machine that has something to unfold becomes a button. One that
    // offers a press and then does nothing is a broken button, and a flat one
    // gives hover, focus and the keyboard without a gesture of our own.
    if (hasServices) {
      const opener = need(gtk.symbols.gtk_button_new(), "a button");
      gtk.symbols.gtk_button_set_has_frame(opener, false);
      gtk.symbols.gtk_widget_add_css_class(opener, cstr("flat"));
      gtk.symbols.gtk_widget_set_hexpand(opener, true);
      const inner = box(ORIENTATION.horizontal, 8);
      gtk.symbols.gtk_widget_set_hexpand(text, true);
      gtk.symbols.gtk_box_append(inner, text);
      gtk.symbols.gtk_box_append(inner, label(open ? "▾" : "▸", "chevron"));
      gtk.symbols.gtk_button_set_child(opener, inner);
      gtk.symbols.gtk_box_append(line, opener);
      callbacks.push(connect(opener, "clicked", 2, () => this.toggleServices(row.key)));
    } else {
      gtk.symbols.gtk_widget_set_hexpand(text, true);
      gtk.symbols.gtk_box_append(line, text);
    }

    const copy = need(gtk.symbols.gtk_button_new_from_icon_name(cstr("edit-copy-symbolic")), "a button");
    gtk.symbols.gtk_button_set_has_frame(copy, false);
    gtk.symbols.gtk_widget_add_css_class(copy, cstr("copy"));
    gtk.symbols.gtk_widget_set_valign(copy, ALIGN.center);
    gtk.symbols.gtk_widget_set_tooltip_text(copy, cstr(this.labels.copy(copyText)));
    gtk.symbols.gtk_box_append(line, copy);

    callbacks.push(
      connect(copy, "clicked", 2, () => {
        setClipboard(copyText);
        this.options.onCopy?.(copyText);
      }),
    );

    if (!open || !hasServices) return { widget: line, callbacks };

    // The machine and its services travel as one widget, so `replace()` keeps
    // handing the box a single child per machine.
    const group = box(ORIENTATION.vertical, 0);
    gtk.symbols.gtk_box_append(group, line);
    for (const service of row.services) {
      const button = need(gtk.symbols.gtk_button_new(), "a button");
      gtk.symbols.gtk_button_set_has_frame(button, false);
      gtk.symbols.gtk_widget_add_css_class(button, cstr("flat"));
      gtk.symbols.gtk_widget_set_tooltip_text(button, cstr(this.labels.open(service.url)));

      const inner = box(ORIENTATION.vertical, 1);
      gtk.symbols.gtk_widget_add_css_class(inner, cstr("service"));
      gtk.symbols.gtk_widget_set_margin_start(inner, 16);
      const url = label(service.url, "service-name");
      gtk.symbols.gtk_label_set_ellipsize(url, ELLIPSIZE_END);
      gtk.symbols.gtk_box_append(inner, url);
      gtk.symbols.gtk_box_append(inner, label(service.address, "row-detail"));
      gtk.symbols.gtk_button_set_child(button, inner);
      gtk.symbols.gtk_box_append(group, button);

      callbacks.push(connect(button, "clicked", 2, () => this.options.onOpen?.(service.url)));
    }
    return { widget: group, callbacks };
  }

  /**
   * Folds a machine's services out or away.
   *
   * Redrawn on the next turn of the loop, never from inside the handler:
   * rebuilding the list releases the very callback this is running in, and
   * closing a JSCallback while it is on the stack is a crash. The events are
   * pumped from a timer here, so the next tick is a handler that has returned.
   */
  private toggleServices(key: string): void {
    if (!this.expanded.delete(key)) this.expanded.add(key);
    setTimeout(() => {
      if (this.view) this.update(this.view);
    }, 0);
  }

  destroy(): void {
    if (this.pump) clearInterval(this.pump);
    for (const callback of this.keepAlive) callback.close();
    this.replace(this.connectionsBox, this.connectionRows, () => []);
    this.replace(this.machinesBox, this.machineRows, () => []);
    gtk.symbols.gtk_window_destroy(this.window);
  }
}

function box(orientation: number, spacing: number): Pointer {
  return need(gtk.symbols.gtk_box_new(orientation, spacing), "a box");
}

function label(text: string, cssClass?: string): Pointer {
  const widget = need(gtk.symbols.gtk_label_new(cstr(text)), "a label");
  gtk.symbols.gtk_label_set_xalign(widget, 0);
  if (cssClass) gtk.symbols.gtk_widget_add_css_class(widget, cstr(cssClass));
  return widget;
}

/** An empty box of a fixed height, which is how GTK4 spells vertical space. */
function spacer(height: number): Pointer {
  const widget = box(ORIENTATION.vertical, 0);
  gtk.symbols.gtk_widget_set_size_request(widget, -1, height);
  return widget;
}

/** GTK4 has no padding on a box, only margins on the widget itself. */
function pad(widget: Pointer, amount: number): void {
  gtk.symbols.gtk_widget_set_margin_top(widget, amount);
  gtk.symbols.gtk_widget_set_margin_bottom(widget, amount);
  gtk.symbols.gtk_widget_set_margin_start(widget, amount);
  gtk.symbols.gtk_widget_set_margin_end(widget, amount);
}
