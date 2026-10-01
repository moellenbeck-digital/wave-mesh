import { dlopen, FFIType } from "bun:ffi";

/**
 * Just enough Win32 to put an icon in the notification area.
 *
 * The same shape as objc.ts and gtk.ts, and for the same reason: the platform
 * offers a C API and nothing else, so the binding is hand-written and kept in
 * one place. What the calls do with bytes lives next door in win32-layout.ts,
 * which is where the structures can be tested without a Windows machine.
 *
 * This module opens its libraries as it loads, so nothing may import it except
 * behind a platform check.
 */

const { ptr: P, i32, u32, u64, i64, u16, bool } = FFIType;

export const kernel32 = dlopen("kernel32.dll", {
  GetModuleHandleW: { args: [P], returns: P },

  // The clipboard takes a moveable block and owns it afterwards.
  GlobalAlloc: { args: [u32, u64], returns: P },
  GlobalLock: { args: [P], returns: P },
  GlobalUnlock: { args: [P], returns: bool },
});

export const user32 = dlopen("user32.dll", {
  RegisterClassExW: { args: [P], returns: u16 },
  CreateWindowExW: {
    // dwExStyle, className, windowName, dwStyle, x, y, w, h, parent, menu, instance, param
    args: [u32, P, P, u32, i32, i32, i32, i32, P, P, P, P],
    returns: P,
  },
  DefWindowProcW: { args: [P, u32, u64, i64], returns: i64 },
  DestroyWindow: { args: [P], returns: bool },

  PeekMessageW: { args: [P, P, u32, u32, u32], returns: bool },
  TranslateMessage: { args: [P], returns: bool },
  DispatchMessageW: { args: [P], returns: i64 },
  PostMessageW: { args: [P, u32, u64, i64], returns: bool },

  CreatePopupMenu: { args: [], returns: P },
  AppendMenuW: { args: [P, u32, u64, P], returns: bool },
  DestroyMenu: { args: [P], returns: bool },
  TrackPopupMenu: { args: [P, u32, i32, i32, i32, P, P], returns: i32 },

  GetCursorPos: { args: [P], returns: bool },
  LoadCursorW: { args: [P, P], returns: P },
  SetProcessDPIAware: { args: [], returns: bool },
  SetForegroundWindow: { args: [P], returns: bool },
  GetSystemMetrics: { args: [i32], returns: i32 },

  CreateIconIndirect: { args: [P], returns: P },
  DestroyIcon: { args: [P], returns: bool },

  // The window behind the icon: shown, placed, painted and clicked.
  ShowWindow: { args: [P, i32], returns: bool },
  IsWindowVisible: { args: [P], returns: bool },
  SetWindowPos: { args: [P, P, i32, i32, i32, i32, u32], returns: bool },
  SetWindowRgn: { args: [P, P, bool], returns: i32 },
  GetClientRect: { args: [P, P], returns: bool },
  InvalidateRect: { args: [P, P, bool], returns: bool },
  BeginPaint: { args: [P, P], returns: P },
  EndPaint: { args: [P, P], returns: bool },
  FillRect: { args: [P, P, P], returns: i32 },
  DrawTextW: { args: [P, P, i32, P, u32], returns: i32 },
  SystemParametersInfoW: { args: [u32, u32, P, u32], returns: bool },
  GetDC: { args: [P], returns: P },
  ReleaseDC: { args: [P, P], returns: i32 },

  OpenClipboard: { args: [P], returns: bool },
  EmptyClipboard: { args: [], returns: bool },
  SetClipboardData: { args: [u32, P], returns: P },
  CloseClipboard: { args: [], returns: bool },
});

export const gdi32 = dlopen("gdi32.dll", {
  CreateBitmap: { args: [i32, i32, u32, u32, P], returns: P },
  DeleteObject: { args: [P], returns: bool },

  // Drawing the card. Everything in the window is painted by hand, so this is
  // the whole of it: a memory bitmap to draw into, shapes, and text.
  CreateCompatibleDC: { args: [P], returns: P },
  CreateCompatibleBitmap: { args: [P, i32, i32], returns: P },
  SelectObject: { args: [P, P], returns: P },
  DeleteDC: { args: [P], returns: bool },
  BitBlt: { args: [P, i32, i32, i32, i32, P, i32, i32, u32], returns: bool },
  CreateSolidBrush: { args: [u32], returns: P },
  CreatePen: { args: [i32, i32, u32], returns: P },
  GetStockObject: { args: [i32], returns: P },
  RoundRect: { args: [P, i32, i32, i32, i32, i32, i32], returns: bool },
  Ellipse: { args: [P, i32, i32, i32, i32], returns: bool },
  CreateRoundRectRgn: { args: [i32, i32, i32, i32, i32, i32], returns: P },
  IntersectClipRect: { args: [P, i32, i32, i32, i32], returns: i32 },
  SelectClipRgn: { args: [P, P], returns: i32 },
  SaveDC: { args: [P], returns: i32 },
  RestoreDC: { args: [P, i32], returns: bool },
  SetTextColor: { args: [P, u32], returns: u32 },
  SetBkMode: { args: [P, i32], returns: i32 },
  GetDeviceCaps: { args: [P, i32], returns: i32 },
  CreateFontW: {
    // height, width, escapement, orientation, weight, italic, underline,
    // strikeout, charset, outPrecision, clipPrecision, quality, pitch, face
    args: [i32, i32, i32, i32, i32, u32, u32, u32, u32, u32, u32, u32, u32, P],
    returns: P,
  },
});

export const shell32 = dlopen("shell32.dll", {
  Shell_NotifyIconW: { args: [u32, P], returns: bool },
});

export type Handle = ReturnType<typeof user32.symbols.CreateWindowExW>;

/** The WndProc signature, for the JSCallback that implements it. */
export const WND_PROC_SIGNATURE = {
  args: [P, u32, u64, i64],
  returns: i64,
} as const;

export const defWindowProc = (hwnd: Handle, message: number, wParam: bigint, lParam: bigint): bigint =>
  BigInt(user32.symbols.DefWindowProcW(hwnd, message, wParam, lParam) ?? 0);
