import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureTunDevice,
  missingTunMessage,
  pidFileFor,
  readWhenFilled,
  resolveInterfaceName,
  resolverMoved,
  type Started,
  TUN_DEVICE,
  TUN_LOADERS,
  unwind,
  usesDynamicName,
  watchOutput,
} from "../src/engine.ts";
import type { LinkBackend } from "../src/link.ts";

describe("usesDynamicName", () => {
  test("Linux keeps the name it was given", () => {
    expect(usesDynamicName("wave0", "linux")).toBe(false);
  });

  test("Windows keeps it too -- wintun takes the name we ask for", () => {
    expect(usesDynamicName("wave0", "win32")).toBe(false);
  });

  test("Darwin has to let the kernel pick a utun", () => {
    expect(usesDynamicName("wave0", "darwin")).toBe(true);
  });

  test("a utun the user named themselves is used as is", () => {
    expect(usesDynamicName("utun7", "darwin")).toBe(false);
  });
});

describe("pidFileFor", () => {
  test("Linux needs none: the interface outlives the process that made it", () => {
    expect(pidFileFor("wave0", "linux")).toBeNull();
  });

  test("macOS and Windows both need one, because the interface is the process", () => {
    // A utun and a wintun adapter alike vanish with wireguard-go, so `wave
    // down` has nothing to delete and must signal instead.
    expect(pidFileFor("utun7", "darwin")).toContain("utun7.pid");
    expect(pidFileFor("wave0", "win32")).toContain("wave0.pid");
  });
});

describe("resolveInterfaceName", () => {
  test("passes the name through on Linux", () => {
    expect(resolveInterfaceName("wave0", "linux")).toBe("wave0");
  });

  test("falls back to the label when no run has reported a utun yet", () => {
    expect(resolveInterfaceName("wave-no-such-interface", "darwin")).toBe("wave-no-such-interface");
  });
});

describe("resolverMoved", () => {
  const at = (address: string, port = 53) => ({ address, port });

  test("a renumbered wave takes its resolver's address with it", () => {
    // Exactly what the /16-per-wave migration does to an existing wave.
    expect(resolverMoved(at("10.77.0.1"), at("100.64.0.1"))).toBe(true);
  });

  test("an unchanged address leaves it alone", () => {
    expect(resolverMoved(at("100.64.0.1"), at("100.64.0.1"))).toBe(false);
  });

  test("on macOS the port is what differs, and that counts too", () => {
    expect(resolverMoved(at("127.0.0.1", 5354), at("127.0.0.1", 5355))).toBe(true);
  });

  test("nothing running is nothing to move", () => {
    expect(resolverMoved(undefined, at("100.64.0.1"))).toBe(false);
  });
});

describe("readWhenFilled", () => {
  const scratch = () => join(mkdtempSync(join(tmpdir(), "wave-name-")), "wave0.name");

  test("waits for the name instead of settling for the empty file", async () => {
    const path = scratch();
    // wireguard-go creates the file first and writes into it afterwards; a
    // reader that stops at the first step loses the interface it just started.
    writeFileSync(path, "");
    setTimeout(() => writeFileSync(path, "utun7\n"), 100);

    expect(await readWhenFilled(path, 2000)).toBe("utun7");
  });

  test("gives up rather than returning nothing", async () => {
    await expect(readWhenFilled(scratch(), 100)).rejects.toThrow("did not appear");
  });
});

/**
 * A Synology NAS reported `/usr/local/bin/wireguard-go exited with code 1` and
 * nothing else: the streams were inherited, so what it actually said went to
 * the daemon's journal while the person read the status view.
 */
describe("when wireguard-go will not start", () => {
  test("names the missing tun device before anything is spawned", () => {
    const absent = (): boolean => false;
    const message = missingTunMessage("linux", absent);
    expect(message).toContain(TUN_DEVICE);
    expect(message).toContain("modprobe tun");
    // The NAS this came from needs a different incantation for the same thing.
    expect(message).toContain("insmod");
  });

  test("says nothing where the device is there, or is not the mechanism", () => {
    expect(missingTunMessage("linux", () => true)).toBeNull();
    // macOS makes utuns through the kernel control socket, Windows through
    // wintun; neither has ever had a /dev/net/tun to miss.
    expect(missingTunMessage("darwin", () => false)).toBeNull();
    expect(missingTunMessage("win32", () => false)).toBeNull();
  });

  test("keeps what it said, logging it as it arrives", async () => {
    const kept: string[] = [];
    const logged: string[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Split mid-line on purpose: a chunk boundary is not a line boundary.
        controller.enqueue(new TextEncoder().encode("Failed to create TUN dev"));
        controller.enqueue(new TextEncoder().encode("ice: operation not permitted\n"));
        controller.close();
      },
    });
    await watchOutput(stream, (line) => logged.push(line), kept);
    expect(kept).toEqual(["Failed to create TUN device: operation not permitted"]);
    expect(logged).toEqual(kept);
  });

  test("keeps only the tail, so a running tunnel does not grow a log", async () => {
    const kept: string[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 20; i++) controller.enqueue(new TextEncoder().encode(`line ${i}\n`));
        controller.close();
      },
    });
    await watchOutput(stream, () => {}, kept, 3);
    expect(kept).toEqual(["line 17", "line 18", "line 19"]);
  });

  test("a stream that is not there is not an error", async () => {
    const kept: string[] = [];
    await watchOutput(null, () => {}, kept);
    expect(kept).toEqual([]);
  });
});

/**
 * `sudo insmod /lib/modules/tun.ko` made the device appear on the NAS -- and
 * would have to be typed again after every reboot. The daemon is already root
 * and already the thing that is supposed to bring the tunnel back by itself.
 */
describe("making the tun driver available", () => {
  test("does nothing where the device is already there", async () => {
    const tried: string[][] = [];
    const message = await ensureTunDevice(
      "linux",
      async (command) => {
        tried.push(command);
        return 0;
      },
      () => true,
    );
    expect(message).toBeNull();
    expect(tried).toEqual([]);
  });

  test("stops at the first loader that works", async () => {
    const tried: string[][] = [];
    let loaded = false;
    const message = await ensureTunDevice(
      "linux",
      async (command) => {
        tried.push(command);
        loaded = true;
        return 0;
      },
      () => loaded,
    );
    expect(message).toBeNull();
    expect(tried).toEqual([TUN_LOADERS[0] as string[]]);
  });

  test("falls through to insmod, which is what the NAS needed", async () => {
    const tried: string[][] = [];
    let loaded = false;
    const message = await ensureTunDevice(
      "linux",
      async (command) => {
        tried.push(command);
        // modprobe is not there; the module file is.
        if (command[0] === "insmod") loaded = true;
        return command[0] === "insmod" ? 0 : 127;
      },
      () => loaded,
    );
    expect(message).toBeNull();
    expect(tried.map((command) => command[0])).toEqual(["modprobe", "insmod"]);
  });

  test("gives up with the message rather than pretending", async () => {
    const message = await ensureTunDevice(
      "linux",
      async () => 127,
      () => false,
    );
    expect(message).toContain(TUN_DEVICE);
    expect(message).toContain("insmod");
  });

  test("is not attempted off Linux, where no such device has ever existed", async () => {
    const tried: string[][] = [];
    for (const platform of ["darwin", "win32"] as const) {
      const message = await ensureTunDevice(
        platform,
        async (command) => {
          tried.push(command);
          return 0;
        },
        () => false,
      );
      expect(message).toBeNull();
    }
    expect(tried).toEqual([]);
  });
});

describe("a start that failed halfway", () => {
  /** Only what unwinding touches; the rest of a backend is not in the way here. */
  const fakeLink = (remove: LinkBackend["remove"]) => ({ remove }) as unknown as LinkBackend;

  test("takes off exactly what it put on", async () => {
    // Left behind, a tunnel is worse than none: wireguard-go keeps the
    // interface, and the next attempt fails over its predecessor's routes
    // rather than over whatever went wrong here.
    const done: string[] = [];
    const started: Started = {
      linkName: "utun7",
      magic: { close: async () => done.push("magic") } as unknown as Started["magic"],
      tunnel: { stop: async () => void done.push("tunnel") } as unknown as Started["tunnel"],
    };

    await unwind(
      started,
      fakeLink(async (name) => void done.push(`remove ${name}`)),
      () => {},
    );

    // The socket is not closed twice: stopping the tunnel already did it.
    expect(done).toEqual(["tunnel", "remove utun7"]);
  });

  test("closes the socket itself when there was no tunnel yet", async () => {
    const done: string[] = [];
    const started: Started = {
      linkName: "wave0",
      magic: { close: async () => done.push("magic") } as unknown as Started["magic"],
    };

    await unwind(
      started,
      fakeLink(async (name) => void done.push(`remove ${name}`)),
      () => {},
    );

    expect(done).toEqual(["magic", "remove wave0"]);
  });

  test("says so rather than throwing, because the first error is the one that matters", async () => {
    const said: string[] = [];
    const started: Started = {
      linkName: "wave0",
      tunnel: {
        stop: async () => {
          throw new Error("nothing to revert");
        },
      } as unknown as Started["tunnel"],
    };

    await unwind(
      started,
      fakeLink(async () => {
        throw new Error("no such device");
      }),
      (message) => said.push(message),
    );

    expect(said).toEqual([
      "could not stop the tunnel after a failed start: nothing to revert",
      "could not remove the interface after a failed start: no such device",
    ]);
  });

  test("does nothing when nothing was started", async () => {
    const done: string[] = [];
    await unwind(
      {},
      fakeLink(async (name) => void done.push(`remove ${name}`)),
      () => {},
    );
    expect(done).toEqual([]);
  });
});
