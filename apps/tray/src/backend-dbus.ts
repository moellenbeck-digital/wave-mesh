import dbus from "dbus-next";
import type { TrayBackend, TrayBackendOptions } from "./backend.ts";
import type { IconState } from "./icon.ts";
import { TrayItem } from "./item.ts";
import { type MenuEntry, TrayMenu } from "./menu.ts";

const ITEM_PATH = "/StatusNotifierItem";
const MENU_PATH = "/StatusNotifierMenu";

/**
 * The Linux tray, as StatusNotifierItem on the session bus.
 *
 * No native code is involved: the desktop's tray is a D-Bus protocol, so
 * speaking it is a matter of exporting two interfaces and registering with the
 * watcher the bar provides.
 */
export class DbusTray implements TrayBackend {
  readonly platform = "linux";
  private readonly item: TrayItem;
  private readonly menu: TrayMenu;
  private bus?: ReturnType<typeof dbus.sessionBus>;

  constructor(options: TrayBackendOptions) {
    this.menu = new TrayMenu(MENU_PATH, options.onActivate);
    this.item = new TrayItem(MENU_PATH, options.onClick);
  }

  async start(): Promise<void> {
    this.bus = dbus.sessionBus();
    const name = `org.kde.StatusNotifierItem-${process.pid}-1`;
    this.bus.export(ITEM_PATH, this.item);
    this.bus.export(MENU_PATH, this.menu);
    await this.bus.requestName(name, 0);

    const watcher = await this.bus.getProxyObject("org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher");
    const register = watcher.getInterface("org.kde.StatusNotifierWatcher") as unknown as {
      RegisterStatusNotifierItem: (service: string) => Promise<void>;
    };
    await register.RegisterStatusNotifierItem(name);
  }

  update(input: { state: IconState; tooltip: string; entries: MenuEntry[] }): void {
    this.item.update(input.state, input.tooltip);
    this.menu.setEntries(input.entries);
  }

  async stop(): Promise<void> {
    this.bus?.disconnect();
  }
}
