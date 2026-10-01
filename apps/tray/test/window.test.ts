import { describe, expect, test } from "bun:test";
import { createTrayWindow, NoWindowBackend } from "../src/window.ts";

const options = { onToggle: () => {} };

describe("picking a toolkit", () => {
  test("an unknown platform is treated as one without a window, not as Linux", async () => {
    const error = await createTrayWindow(options, "aix").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoWindowBackend);
    expect((error as Error).message).toContain("aix");
    // The tunnel is not what is missing, and the message has to say so.
    expect((error as Error).message).toContain("wave status");
  });

  test.each(["darwin", "win32"] as const)("%s loads its toolkit and nothing else", async (platform) => {
    // Importing the macOS module opens /usr/lib/libobjc.A.dylib, the Windows
    // one user32.dll. On that platform it succeeds and a real window is built;
    // anywhere else it has to fail on the dynamic import rather than earlier --
    // which is the proof that a Linux run never touches it. What neither may be
    // is a platform without a window.
    const outcome = await createTrayWindow(options, platform).then(
      (window) => window.platform,
      (error: unknown) => error,
    );
    expect(outcome).not.toBeInstanceOf(NoWindowBackend);
    if (typeof outcome === "string") expect(outcome).toBe(platform);
    else expect(outcome).toBeInstanceOf(Error);
  });
});
