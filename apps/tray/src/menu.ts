import dbus from "dbus-next";

const { Interface } = dbus.interface;
const { Variant } = dbus;

/**
 * The menu behind the tray icon, as com.canonical.dbusmenu.
 *
 * The layout is a recursive struct the specification spells `(ia{sv}av)`:
 * an id, a property bag, and children wrapped in variants of that same type.
 */

export interface MenuEntry {
  id: number;
  label?: string;
  /** A separator ignores the label. */
  separator?: boolean;
  enabled?: boolean;
}

type LayoutNode = [number, Record<string, dbus.Variant>, dbus.Variant[]];

const properties = (entry: MenuEntry): Record<string, dbus.Variant> => {
  if (entry.separator) return { type: new Variant("s", "separator") };
  return {
    label: new Variant("s", entry.label ?? ""),
    enabled: new Variant("b", entry.enabled ?? true),
    visible: new Variant("b", true),
  };
};

export class TrayMenu extends Interface {
  private entries: MenuEntry[] = [];
  private revision = 1;

  constructor(
    path: string,
    private readonly onActivate: (id: number) => void,
  ) {
    super("com.canonical.dbusmenu");
    this.path = path;
  }

  readonly path: string;

  setEntries(entries: MenuEntry[]): void {
    this.entries = entries;
    this.revision++;
    this.LayoutUpdated(this.revision, 0);
  }

  /** Payload producers; configureMembers turns these into emitters. */
  LayoutUpdated(revision: number, parent: number): [number, number] {
    return [revision, parent];
  }

  ItemsPropertiesUpdated(
    updated: Array<[number, Record<string, dbus.Variant>]>,
    removed: Array<[number, string[]]>,
  ): [Array<[number, Record<string, dbus.Variant>]>, Array<[number, string[]]>] {
    return [updated, removed];
  }

  private layout(): LayoutNode {
    const children = this.entries.map(
      (entry) => new Variant("(ia{sv}av)", [entry.id, properties(entry), []] as LayoutNode),
    );
    return [0, { "children-display": new Variant("s", "submenu") }, children];
  }

  GetLayout(_parentId: number, _depth: number, _propertyNames: string[]): [number, LayoutNode] {
    return [this.revision, this.layout()];
  }

  GetGroupProperties(ids: number[], _propertyNames: string[]): Array<[number, Record<string, dbus.Variant>]> {
    return this.entries
      .filter((entry) => ids.length === 0 || ids.includes(entry.id))
      .map((entry) => [entry.id, properties(entry)]);
  }

  GetProperty(id: number, name: string): dbus.Variant {
    const entry = this.entries.find((candidate) => candidate.id === id);
    return properties(entry ?? { id })[name] ?? new Variant("s", "");
  }

  Event(id: number, eventId: string, _data: dbus.Variant, _timestamp: number): void {
    if (eventId === "clicked") this.onActivate(id);
  }

  AboutToShow(_id: number): boolean {
    return false;
  }
}

TrayMenu.configureMembers({
  properties: {
    Version: { signature: "u", access: "read" },
    Status: { signature: "s", access: "read" },
    TextDirection: { signature: "s", access: "read" },
    IconThemePath: { signature: "as", access: "read" },
  },
  methods: {
    GetLayout: { inSignature: "iias", outSignature: "u(ia{sv}av)" },
    GetGroupProperties: { inSignature: "aias", outSignature: "a(ia{sv})" },
    GetProperty: { inSignature: "is", outSignature: "v" },
    Event: { inSignature: "isvu", outSignature: "" },
    AboutToShow: { inSignature: "i", outSignature: "b" },
  },
  signals: {
    LayoutUpdated: { signature: "ui" },
    ItemsPropertiesUpdated: { signature: "a(ia{sv})a(ias)" },
  },
});

Object.defineProperties(TrayMenu.prototype, {
  Version: { get: () => 3 },
  Status: { get: () => "normal" },
  TextDirection: { get: () => "ltr" },
  IconThemePath: { get: () => [] },
});
