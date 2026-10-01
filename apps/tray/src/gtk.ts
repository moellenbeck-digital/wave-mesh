import { dlopen, FFIType, JSCallback, type Pointer } from "bun:ffi";

/**
 * Just enough GTK4 to draw the window, through bun:ffi.
 *
 * The same shape as objc.ts on macOS and for the same reason: the toolkit is a
 * C API, so the binding is hand-written and kept in one place rather than
 * spread through the widget code.
 *
 * Two rules the rest of the file depends on. GTK expects to be called from one
 * thread and never re-entered, and its main loop must be stepped by hand --
 * blocking in gtk_main would stop the daemon socket being serviced, exactly as
 * [NSApp run] would. And every JSCallback handed to g_signal_connect has to be
 * kept alive for as long as the widget is: once it is collected the next click
 * lands in freed memory.
 */

const { ptr: P, i32, f32, f64, u32, u64, bool, void: V } = FFIType;

export const ORIENTATION = { horizontal: 0, vertical: 1 } as const;
export const ALIGN = { fill: 0, start: 1, end: 2, center: 3 } as const;
export const POLICY = { always: 0, automatic: 1, never: 2 } as const;
/** GTK_STYLE_PROVIDER_PRIORITY_APPLICATION */
export const CSS_PRIORITY = 600;

/**
 * wlr-layer-shell, which is what turns the window into an overlay anchored to
 * a corner rather than another window for the compositor to tile.
 *
 * Opened *before* GTK on purpose: the library has to be in place before the
 * Wayland connection is made, or it cannot claim the surface. It is optional --
 * only wlroots compositors (Hyprland, Sway) offer the protocol, so GNOME, KDE
 * and X11 fall back to an ordinary window rather than losing the feature.
 */
export const layerShell = (() => {
  try {
    return dlopen("libgtk4-layer-shell.so.0", {
      gtk_layer_is_supported: { args: [], returns: bool },
      gtk_layer_init_for_window: { args: [P], returns: V },
      gtk_layer_set_layer: { args: [P, i32], returns: V },
      gtk_layer_set_anchor: { args: [P, i32, bool], returns: V },
      gtk_layer_set_margin: { args: [P, i32, i32], returns: V },
      gtk_layer_set_keyboard_mode: { args: [P, i32], returns: V },
      gtk_layer_set_namespace: { args: [P, P], returns: V },
    });
  } catch {
    return null;
  }
})();

export const LAYER = { background: 0, bottom: 1, top: 2, overlay: 3 } as const;
export const EDGE = { left: 0, right: 1, top: 2, bottom: 3 } as const;
export const KEYBOARD = { none: 0, exclusive: 1, onDemand: 2 } as const;

export const gtk = dlopen("libgtk-4.so.1", {
  gtk_init: { args: [], returns: V },

  gtk_window_new: { args: [], returns: P },
  gtk_window_set_title: { args: [P, P], returns: V },
  gtk_window_set_default_size: { args: [P, i32, i32], returns: V },
  gtk_window_set_child: { args: [P, P], returns: V },
  gtk_window_present: { args: [P], returns: V },
  gtk_window_close: { args: [P], returns: V },
  gtk_window_destroy: { args: [P], returns: V },
  /** Closing hides the window instead of disposing it, so it can come back. */
  gtk_window_set_hide_on_close: { args: [P, bool], returns: V },
  gtk_window_set_resizable: { args: [P, bool], returns: V },
  gtk_window_is_active: { args: [P], returns: bool },

  gtk_widget_set_visible: { args: [P, bool], returns: V },
  gtk_widget_get_visible: { args: [P], returns: bool },
  gtk_widget_add_css_class: { args: [P, P], returns: V },
  gtk_widget_set_hexpand: { args: [P, bool], returns: V },
  gtk_widget_set_vexpand: { args: [P, bool], returns: V },
  gtk_widget_set_halign: { args: [P, i32], returns: V },
  gtk_widget_set_valign: { args: [P, i32], returns: V },
  gtk_widget_set_size_request: { args: [P, i32, i32], returns: V },
  gtk_widget_set_tooltip_text: { args: [P, P], returns: V },
  gtk_widget_set_margin_top: { args: [P, i32], returns: V },
  gtk_widget_set_margin_bottom: { args: [P, i32], returns: V },
  gtk_widget_set_margin_start: { args: [P, i32], returns: V },
  gtk_widget_set_margin_end: { args: [P, i32], returns: V },

  gtk_box_new: { args: [i32, i32], returns: P },
  gtk_box_append: { args: [P, P], returns: V },
  gtk_box_remove: { args: [P, P], returns: V },

  gtk_label_new: { args: [P], returns: P },
  gtk_label_set_text: { args: [P, P], returns: V },
  gtk_label_set_xalign: { args: [P, f32], returns: V },
  /** PANGO_ELLIPSIZE_END keeps a long DNS name from stretching the window. */
  gtk_label_set_ellipsize: { args: [P, i32], returns: V },
  gtk_label_set_selectable: { args: [P, bool], returns: V },

  gtk_switch_new: { args: [], returns: P },
  gtk_switch_set_active: { args: [P, bool], returns: V },
  gtk_switch_get_active: { args: [P], returns: bool },

  gtk_button_new: { args: [], returns: P },
  gtk_button_set_child: { args: [P, P], returns: V },
  gtk_button_new_from_icon_name: { args: [P], returns: P },
  gtk_button_set_has_frame: { args: [P, bool], returns: V },

  gtk_separator_new: { args: [i32], returns: P },

  gtk_event_controller_key_new: { args: [], returns: P },
  gtk_widget_add_controller: { args: [P, P], returns: V },
  gtk_gesture_click_new: { args: [], returns: P },
  /** Which widget sits under a point, so a click outside the card is visible. */
  gtk_widget_pick: { args: [P, f64, f64, i32], returns: P },
  gtk_widget_is_ancestor: { args: [P, P], returns: bool },

  gtk_scrolled_window_new: { args: [], returns: P },
  gtk_scrolled_window_set_child: { args: [P, P], returns: V },
  gtk_scrolled_window_set_policy: { args: [P, i32, i32], returns: V },
  gtk_scrolled_window_set_propagate_natural_height: { args: [P, bool], returns: V },
  gtk_scrolled_window_set_max_content_height: { args: [P, i32], returns: V },

  gtk_css_provider_new: { args: [], returns: P },
  gtk_css_provider_load_from_string: { args: [P, P], returns: V },
  gtk_style_context_add_provider_for_display: { args: [P, P, u32], returns: V },
});

export const gdk = dlopen("libgtk-4.so.1", {
  gdk_display_get_default: { args: [], returns: P },
  gdk_display_get_clipboard: { args: [P], returns: P },
  gdk_clipboard_set_text: { args: [P, P], returns: V },
});

export const glib = dlopen("libglib-2.0.so.0", {
  g_main_context_iteration: { args: [P, bool], returns: bool },
  /** GTK derives the Wayland app_id from this, which is what window rules match. */
  g_set_prgname: { args: [P], returns: V },
});

export const gobject = dlopen("libgobject-2.0.so.0", {
  g_signal_connect_data: { args: [P, P, P, P, P, i32], returns: u64 },
  g_object_unref: { args: [P], returns: V },
});

export const ELLIPSIZE_END = 3;

/**
 * Narrows what a widget constructor hands back. Bun types a pointer return
 * loosely, and a NULL here means the toolkit failed to build the widget --
 * which is worth saying out loud rather than passing on as a null pointer.
 */
export function need(value: Pointer | bigint | null | undefined, what: string): Pointer {
  if (!value) throw new Error(`GTK could not create ${what}`);
  return Number(value) as Pointer;
}

/** GTK takes NUL-terminated UTF-8; the buffer only has to outlive the call. */
export const cstr = (value: string): Buffer => Buffer.from(`${value}\0`, "utf8");

/**
 * Connects a signal and hands back the callback so the caller can keep it
 * alive. Letting it be collected turns the next click into a jump into freed
 * memory, which is why this never allocates one it does not return.
 */
export function connect(
  instance: Pointer,
  signal: string,
  argCount: number,
  handler: () => void,
): JSCallback {
  const callback = new JSCallback(handler, {
    args: Array.from({ length: argCount }, () => P),
    returns: V,
  });
  gobject.symbols.g_signal_connect_data(instance, cstr(signal), callback.ptr, null, null, 0);
  return callback;
}

/** GDK_KEY_Escape. */
export const KEY_ESCAPE = 0xff1b;

/**
 * Connects "key-pressed", whose handler returns a gboolean saying whether the
 * key was consumed. That return matters -- a void callback would leave GTK
 * reading whatever happened to be in the register -- so it gets its own helper
 * rather than sharing the void one above.
 */
export function connectKey(instance: Pointer, handler: (keyval: number) => boolean): JSCallback {
  const callback = new JSCallback(
    (_controller: unknown, keyval: number) => (handler(Number(keyval)) ? 1 : 0),
    { args: [P, u32, u32, u32, P], returns: bool },
  );
  gobject.symbols.g_signal_connect_data(instance, cstr("key-pressed"), callback.ptr, null, null, 0);
  return callback;
}

/**
 * Connects "pressed" on a click gesture, whose handler is told how many presses
 * and where. The coordinates are doubles in the widget's own space.
 */
export function connectClick(instance: Pointer, handler: (x: number, y: number) => void): JSCallback {
  const callback = new JSCallback(
    (_gesture: unknown, _presses: number, x: number, y: number) => handler(x, y),
    { args: [P, i32, f64, f64, P], returns: V },
  );
  gobject.symbols.g_signal_connect_data(instance, cstr("pressed"), callback.ptr, null, null, 0);
  return callback;
}

/** Steps the main loop without ever blocking in it. */
export const pumpEvents = (): void => {
  // A bounded number of iterations: a burst of events must not keep us here.
  for (let i = 0; i < 32; i++) {
    if (!glib.symbols.g_main_context_iteration(null, false)) return;
  }
};

export function setClipboard(text: string): void {
  const display = gdk.symbols.gdk_display_get_default();
  if (!display) return;
  const clipboard = gdk.symbols.gdk_display_get_clipboard(display);
  if (clipboard) gdk.symbols.gdk_clipboard_set_text(clipboard, cstr(text));
}
