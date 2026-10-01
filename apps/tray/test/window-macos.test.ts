import { CString, type Pointer } from "bun:ffi";
import { describe, expect, test } from "bun:test";
import type { Id } from "../src/objc.ts";
import type { TrayWindow } from "../src/window.ts";
import type { WindowView } from "../src/window-view.ts";

/**
 * The Objective-C binding dlopens AppKit as it loads, so this file can only be
 * imported where AppKit exists. That is also why the rule it checks is a
 * function of its own rather than three lines inside `toggle()`.
 */
describe.if(process.platform === "darwin")("what a click on the icon means", () => {
  test("an open card closes", async () => {
    const { clickOnIcon } = await import("../src/window-macos.ts");
    expect(clickOnIcon(true, 10_000)).toBe("close");
    expect(clickOnIcon(true, 0)).toBe("close");
  });

  test("a click that has just dismissed the card does not open it again", async () => {
    const { clickOnIcon } = await import("../src/window-macos.ts");
    expect(clickOnIcon(false, 0)).toBe("ignore");
    expect(clickOnIcon(false, 299)).toBe("ignore");
  });

  test("a click after the card went away on its own opens it", async () => {
    const { clickOnIcon } = await import("../src/window-macos.ts");
    expect(clickOnIcon(false, 300)).toBe("open");
    expect(clickOnIcon(false, 5000)).toBe("open");
  });
});

/** The bands in `window-macos.ts`; a row's controls carry the first of each. */
const TAG = { copy: 20_000, expand: 30_000, open: 40_000 } as const;

type Objc = typeof import("../src/objc.ts");
/** Where a view sits on the card, in points from its left edge. */
interface Span {
  left: number;
  right: number;
}

/**
 * Builds the card and measures it.
 *
 * There is no layout function to check here the way Windows has one: on macOS
 * the geometry is Auto Layout's, so the only way to ask what a click reaches is
 * to put the views up and read their frames back. Exactly that is why the row
 * went dead without anyone noticing -- only the sixteen-point triangle carried
 * the action, and a line whose name and address do nothing reads as a card that
 * has stopped working.
 *
 * An NSRect cannot cross the FFI boundary (see the note in `objc.ts`), but its
 * description can: KVC answers with an NSValue, and that prints its rect.
 */
async function measure(services: number): Promise<Record<"area" | "triangle" | "copy", Span | undefined>> {
  const objc = await import("../src/objc.ts");
  const { MacosWindow } = await import("../src/window-macos.ts");
  // One card per process: its handler is a class registered under a fixed name.
  card ??= new MacosWindow({ onToggle: () => {}, onOpen: (url) => opened.push(url) });
  card.update(cardView(services));

  const content = objc.msg((card as unknown as { window: Id }).window, "contentView");
  objc.msg(content, "layoutSubtreeIfNeeded");
  const views: Array<Span & { tag: number; transparent: boolean }> = [];
  collect(objc, content, 0, views);

  return {
    area: views.find((view) => view.tag === TAG.expand && view.transparent),
    triangle: views.find((view) => view.tag === TAG.expand && !view.transparent),
    copy: views.find((view) => view.tag === TAG.copy),
  };
}

let card: TrayWindow | undefined;
const opened: string[] = [];

function collect(
  objc: Objc,
  view: Id,
  offset: number,
  out: Array<Span & { tag: number; transparent: boolean }>,
): void {
  const printed = readString(
    objc,
    objc.msg(objc.msg1(view, "valueForKey:", objc.nsString("frame")), "description"),
  );
  const [x = 0, , width = 0] = (printed.match(/-?[\d.]+/g) ?? []).map(Number);
  const left = offset + x;
  const tag = Number(objc.msg(view, "tag"));
  // Only a button knows the selector, and asking anything else would be an
  // unrecognised one.
  const transparent =
    Number(objc.msg1(view, "respondsToSelector:", objc.sel("isTransparent"))) !== 0 &&
    Number(objc.msg(view, "isTransparent")) !== 0;
  out.push({ left, right: left + width, tag, transparent });

  const subviews = objc.msg(view, "subviews");
  const count = Number(objc.msg(subviews, "count"));
  for (let index = 0; index < count; index++) {
    collect(objc, objc.msgInt(subviews, "objectAtIndex:", index), left, out);
  }
}

const readString = (objc: Objc, value: Id): string =>
  new CString(objc.msg(value, "UTF8String") as unknown as Pointer).toString();

const cardView = (services: number): WindowView => ({
  title: "mac",
  subtitle: "connected",
  connections: [],
  machines: [
    {
      key: "cluster",
      hostname: "cluster",
      address: "10.64.0.3",
      dnsName: "cluster.wave.example",
      path: "direct 203.0.113.9",
      online: true,
      waveLabel: "control.example",
      services: Array.from({ length: services }, (_, index) => ({
        key: `service-${index}`,
        label: `svc${index}.wave.example`,
        url: `https://svc${index}.wave.example`,
        address: `10.64.0.${10 + index}`,
      })),
    },
  ],
  labelMachines: false,
  emptyMachines: "none",
});

describe.if(process.platform === "darwin")("what a click on a machine row reaches", () => {
  test("the whole line, and only up to the copy button", async () => {
    const { area, triangle, copy } = await measure(2);
    expect(area).toBeDefined();
    expect(triangle).toBeDefined();
    expect(copy).toBeDefined();

    // It starts where the name does and ends with the triangle: one target,
    // not a triangle with a dead line beside it.
    expect(area?.left).toBeLessThan(triangle?.left ?? 0);
    expect(area?.right).toBe(triangle?.right ?? 0);
    // And it stops there. The one thing on this line that means something else
    // is the copy button, the same boundary the Windows card draws.
    expect(area?.right).toBeLessThanOrEqual(copy?.left ?? 0);
  });

  test("a machine with nothing under it keeps its line dead", async () => {
    const { area, triangle, copy } = await measure(0);
    expect(area).toBeUndefined();
    expect(triangle).toBeUndefined();
    // A press that does nothing is a broken control; the copy button stays.
    expect(copy).toBeDefined();
  });
});
