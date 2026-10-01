import type { Pointer } from "bun:ffi";
import { dlopen, FFIType, JSCallback, ptr } from "bun:ffi";

/**
 * Just enough of the Objective-C runtime to put an item in the macOS menu bar.
 *
 * Cocoa has no protocol to speak to, unlike the tray on Linux, so the only way
 * in from a runtime like Bun is the C API underneath it: look up classes and
 * selectors by name and send messages. objc_msgSend is variadic, which FFI
 * cannot express, so it is opened once per argument shape instead.
 */

const LIBOBJC = "/usr/lib/libobjc.A.dylib";
const APPKIT = "/System/Library/Frameworks/AppKit.framework/AppKit";
const CORE_GRAPHICS = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics";
const FOUNDATION = "/System/Library/Frameworks/Foundation.framework/Foundation";

/** An Objective-C object or class pointer. */
export type Id = Pointer;

/** nil. Several AppKit selectors take a sender they do not use. */
export const NIL = 0 as Id;

const runtime = dlopen(LIBOBJC, {
  objc_getClass: { args: [FFIType.cstring], returns: FFIType.ptr },
  sel_registerName: { args: [FFIType.cstring], returns: FFIType.ptr },
  objc_allocateClassPair: { args: [FFIType.ptr, FFIType.cstring, FFIType.u64], returns: FFIType.ptr },
  class_addMethod: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.cstring],
    returns: FFIType.bool,
  },
  objc_registerClassPair: { args: [FFIType.ptr], returns: FFIType.void },
});

/** One opening per call shape; the symbol is the same function every time. */
const send = {
  o: dlopen(LIBOBJC, { objc_msgSend: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr } }),
  oo: dlopen(LIBOBJC, {
    objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  }),
  ooo: dlopen(LIBOBJC, {
    objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  }),
  oooo: dlopen(LIBOBJC, {
    objc_msgSend: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.ptr,
    },
  }),
  /** An object plus a scalar: a layout anchor and its constant, mostly. */
  ood: dlopen(LIBOBJC, {
    objc_msgSend: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.f64],
      returns: FFIType.ptr,
    },
  }),
  oi: dlopen(LIBOBJC, {
    objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.i64], returns: FFIType.ptr },
  }),
  od: dlopen(LIBOBJC, {
    objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.f64], returns: FFIType.ptr },
  }),
  /**
   * An NSSize or NSPoint: two doubles.
   *
   * This is the one struct shape that may be spelled as separate arguments.
   * Two doubles land in the first two floating-point registers under both
   * calling conventions -- v0/v1 on arm64, xmm0/xmm1 on x86-64. An NSRect does
   * not: arm64 passes its four doubles in registers while x86-64 puts anything
   * over sixteen bytes on the stack, so there is no signature that is right on
   * both. That is why nothing here ever takes a rect.
   */
  odd: dlopen(LIBOBJC, {
    objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.f64, FFIType.f64], returns: FFIType.ptr },
  }),
  // nextEventMatchingMask:untilDate:inMode:dequeue:
  /**
   * Four separate doubles -- a colour's components, not a struct.
   *
   * Loose scalars are safe where a rect is not: both conventions put the first
   * eight floating-point arguments in registers, one per argument. It is only
   * the packing of a struct that the two disagree about.
   */
  odddd: dlopen(LIBOBJC, {
    objc_msgSend: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.f64, FFIType.f64, FFIType.f64, FFIType.f64],
      returns: FFIType.ptr,
    },
  }),
  /** For the handful of getters that answer with a CGFloat. */
  retd: dlopen(LIBOBJC, {
    objc_msgSend: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.f64 },
  }),
  event: dlopen(LIBOBJC, {
    objc_msgSend: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.bool],
      returns: FFIType.ptr,
    },
  }),
};

// Loading the frameworks is what makes their classes resolvable by name. We
// want nothing but that, yet bun:ffi refuses an empty symbol set -- so each
// opening names one function that framework is known to export.
dlopen(APPKIT, { NSApplicationLoad: { args: [], returns: FFIType.bool } });
dlopen(FOUNDATION, { NSHomeDirectory: { args: [], returns: FFIType.ptr } });

const cstring = (value: string): Uint8Array => new TextEncoder().encode(`${value}\0`);

export const cls = (name: string): Id => runtime.symbols.objc_getClass(cstring(name)) as Id;
export const sel = (name: string): Id => runtime.symbols.sel_registerName(cstring(name)) as Id;

export const msg = (target: Id, selector: string): Id =>
  send.o.symbols.objc_msgSend(target, sel(selector)) as Id;
export const msg1 = (target: Id, selector: string, a: Id): Id =>
  send.oo.symbols.objc_msgSend(target, sel(selector), a) as Id;
export const msg2 = (target: Id, selector: string, a: Id, b: Id): Id =>
  send.ooo.symbols.objc_msgSend(target, sel(selector), a, b) as Id;
export const msg3 = (target: Id, selector: string, a: Id, b: Id, c: Id): Id =>
  send.oooo.symbols.objc_msgSend(target, sel(selector), a, b, c) as Id;
export const msgInt = (target: Id, selector: string, value: number | bigint): Id =>
  send.oi.symbols.objc_msgSend(target, sel(selector), value) as Id;
export const msgDouble = (target: Id, selector: string, value: number): Id =>
  send.od.symbols.objc_msgSend(target, sel(selector), value) as Id;
/** An object and a scalar, as layout anchors take them. */
export const msg1Double = (target: Id, selector: string, a: Id, value: number): Id =>
  send.ood.symbols.objc_msgSend(target, sel(selector), a, value) as Id;
/** Four loose doubles; see the note on `odddd`. */
export const msgDouble4 = (target: Id, selector: string, a: number, b: number, c: number, d: number): Id =>
  send.odddd.symbols.objc_msgSend(target, sel(selector), a, b, c, d) as Id;
/** A getter answering with a CGFloat rather than an object. */
export const msgGetDouble = (target: Id, selector: string): number =>
  send.retd.symbols.objc_msgSend(target, sel(selector)) as number;
/** For selectors taking an NSSize or NSPoint; see the note on `odd`. */
export const msgSize = (target: Id, selector: string, width: number, height: number): Id =>
  send.odd.symbols.objc_msgSend(target, sel(selector), width, height) as Id;

/** The one call that pumps AppKit's event loop, with its four arguments. */
export const nextEvent = (app: Id, mask: bigint, until: Id, mode: Id): Id | null =>
  send.event.symbols.objc_msgSend(
    app,
    sel("nextEventMatchingMask:untilDate:inMode:dequeue:"),
    mask,
    until,
    mode,
    true,
  ) as Id | null;

/** NSApplicationActivationPolicyAccessory: a menu bar item and no Dock icon. */
const ACCESSORY = 1;

let application: Id | undefined;

/**
 * The shared NSApplication, set up exactly once.
 *
 * The menu bar item and the window both need it, and whichever is built first
 * has to be the one that configures it: the activation policy belongs in place
 * before launching finishes, or the app turns up in the Dock on its way to
 * becoming an accessory.
 */
export function sharedApplication(): Id {
  if (application) return application;
  const app = msg(cls("NSApplication"), "sharedApplication");
  if (!app) throw new Error("AppKit did not give us an application");
  msgInt(app, "setActivationPolicy:", ACCESSORY);
  msg(app, "finishLaunching");
  application = app;
  return app;
}

/** An NSString, which most of AppKit wants instead of a C string. */
export const nsString = (value: string): Id =>
  msg1(cls("NSString"), "stringWithUTF8String:", ptr(cstring(value)));

/**
 * A class created at runtime to receive menu clicks.
 *
 * Menu items need a target and a selector; there is no way around defining a
 * method, and the only way to define one from here is to register a class and
 * point it at a callback.
 */
export function makeHandler(
  onSelect: (tag: number) => void,
  className = "WaveMenuTarget",
): { instance: Id; keepAlive: JSCallback } {
  const superclass = cls("NSObject");
  // A name may only be registered once, so the menu and the window each bring
  // their own -- allocateClassPair returns nil for a name already taken.
  const handlerClass = runtime.symbols.objc_allocateClassPair(superclass, cstring(className), 0n) as Id;
  if (!handlerClass) throw new Error(`the Objective-C class ${className} is already registered`);

  const callback = new JSCallback(
    (_self: number, _cmd: number, sender: number) => {
      // The item carries its id in the tag, which is the simplest way to get a
      // number back out of AppKit.
      const tag = Number(msg(sender as unknown as Id, "tag"));
      onSelect(tag);
    },
    { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.void },
  );

  runtime.symbols.class_addMethod(handlerClass, sel("onSelect:"), callback.ptr as Id, cstring("v@:@"));
  runtime.symbols.objc_registerClassPair(handlerClass);

  const instance = msg(msg(handlerClass, "alloc"), "init");
  // The callback must outlive every click, so the caller holds on to it.
  return { instance, keepAlive: callback };
}

/**
 * How big the main display is, in points.
 *
 * AppKit would answer this too, but only as an NSRect out of `visibleFrame`,
 * and a struct return of four doubles is exactly what cannot cross this
 * boundary. CoreGraphics has the same numbers behind plain C functions that
 * return a scalar, which both conventions agree about. The display space these
 * report is the one Cocoa places windows in: a HiDPI mode answers with its
 * logical size, not its pixel count.
 */
const graphics = dlopen(CORE_GRAPHICS, {
  CGMainDisplayID: { args: [], returns: FFIType.u32 },
  CGDisplayPixelsWide: { args: [FFIType.u32], returns: FFIType.u64 },
  CGDisplayPixelsHigh: { args: [FFIType.u32], returns: FFIType.u64 },
});

export function mainDisplaySize(): { width: number; height: number } {
  const display = graphics.symbols.CGMainDisplayID();
  return {
    width: Number(graphics.symbols.CGDisplayPixelsWide(display)),
    height: Number(graphics.symbols.CGDisplayPixelsHigh(display)),
  };
}
