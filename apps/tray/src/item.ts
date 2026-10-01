import dbus from "dbus-next";
import { type IconState, iconPixmap } from "./icon.ts";

const { Interface } = dbus.interface;

/**
 * The tray icon itself, as org.kde.StatusNotifierItem.
 *
 * The host reads the properties and watches the New* signals; there is no
 * drawing to do beyond handing over pixels.
 */
export class TrayItem extends Interface {
  private state: IconState = "off";
  private tooltip = "wave: not connected";

  constructor(
    readonly menuPath: string,
    private readonly onActivate: () => void,
  ) {
    super("org.kde.StatusNotifierItem");
  }

  update(state: IconState, tooltip: string): void {
    const iconChanged = state !== this.state;
    this.state = state;
    this.tooltip = tooltip;
    // configureMembers replaces these with emitters that call the original for
    // the payload, so calling them is how a signal goes out.
    if (iconChanged) this.NewIcon();
    this.NewToolTip();
  }

  NewIcon(): void {}

  NewToolTip(): void {}

  NewStatus(): string {
    return "Active";
  }

  /**
   * Two sizes, so a HiDPI panel picks real pixels instead of scaling up the
   * small one. The host chooses; the specification allows any number.
   */
  get pixmap(): Array<[number, number, Buffer]> {
    return [22, 44].map((size) => {
      const icon = iconPixmap(this.state, size);
      return [icon.width, icon.height, Buffer.from(icon.data)];
    });
  }

  Activate(_x: number, _y: number): void {
    this.onActivate();
  }

  SecondaryActivate(_x: number, _y: number): void {
    this.onActivate();
  }

  ContextMenu(_x: number, _y: number): void {
    // The host opens the menu itself; nothing to do here.
  }

  Scroll(_delta: number, _orientation: string): void {}

  /** Exposed so the property getters can read it. */
  currentState(): IconState {
    return this.state;
  }

  currentTooltip(): string {
    return this.tooltip;
  }
}

TrayItem.configureMembers({
  properties: {
    Category: { signature: "s", access: "read" },
    Id: { signature: "s", access: "read" },
    Title: { signature: "s", access: "read" },
    Status: { signature: "s", access: "read" },
    IconName: { signature: "s", access: "read" },
    IconPixmap: { signature: "a(iiay)", access: "read" },
    ToolTip: { signature: "(sa(iiay)ss)", access: "read" },
    ItemIsMenu: { signature: "b", access: "read" },
    Menu: { signature: "o", access: "read" },
  },
  methods: {
    Activate: { inSignature: "ii", outSignature: "" },
    SecondaryActivate: { inSignature: "ii", outSignature: "" },
    ContextMenu: { inSignature: "ii", outSignature: "" },
    Scroll: { inSignature: "is", outSignature: "" },
  },
  signals: {
    NewIcon: { signature: "" },
    NewStatus: { signature: "s" },
    NewToolTip: { signature: "" },
  },
});

Object.defineProperties(TrayItem.prototype, {
  Category: { get: () => "SystemServices" },
  Id: { get: () => "wave" },
  Title: { get: () => "wave" },
  Status: { get: () => "Active" },
  // Empty, so the host falls back to the pixmap rather than hunting a theme.
  IconName: { get: () => "" },
  IconPixmap: {
    get(this: TrayItem) {
      return this.pixmap;
    },
  },
  ToolTip: {
    get(this: TrayItem) {
      return ["", [], "wave", this.currentTooltip()];
    },
  },
  ItemIsMenu: { get: () => false },
  Menu: {
    get(this: TrayItem) {
      return this.menuPath;
    },
  },
});
