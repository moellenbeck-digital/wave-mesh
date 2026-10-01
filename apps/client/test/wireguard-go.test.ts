import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  binaryNames,
  findWintun,
  findWireguardGo,
  missingMessage,
  missingWintunMessage,
  searchPaths,
  wintunSearchPaths,
} from "../src/wireguard-go.ts";

const never = () => false;
const nothing = () => null;

describe("finding wireguard-go", () => {
  test("prefers what the operator configured", () => {
    const found = findWireguardGo({
      env: { WAVE_WIREGUARD_GO: "/opt/wg" },
      exists: (path) => path === "/opt/wg",
      which: () => "/usr/bin/wireguard-go",
    });
    expect(found).toBe("/opt/wg");
  });

  test("ignores a configured path that is not there", () => {
    const found = findWireguardGo({
      env: { WAVE_WIREGUARD_GO: "/gone" },
      exists: never,
      which: (name) => (name === "wireguard-go" ? "/usr/bin/wireguard-go" : null),
    });
    expect(found).toBe("/usr/bin/wireguard-go");
  });

  test("accepts the name `go install` produces", () => {
    // golang.zx2c4.com/wireguard builds a binary called `wireguard`, which is
    // the single most common reason for a first run to fail.
    const found = findWireguardGo({
      env: {},
      exists: never,
      which: (name) => (name === "wireguard" ? "/usr/local/bin/wireguard" : null),
    });
    expect(found).toBe("/usr/local/bin/wireguard");
  });

  test("looks in the GOPATH a service would never have on its PATH", () => {
    const found = findWireguardGo({
      env: { HOME: "/home/robin" },
      exists: (path) => path === "/home/robin/go/bin/wireguard",
      which: nothing,
    });
    expect(found).toBe("/home/robin/go/bin/wireguard");
  });

  test("looks in the invoking user's home when running under sudo", () => {
    const found = findWireguardGo({
      env: { HOME: "/root", SUDO_USER: "robin" },
      exists: (path) => path === "/home/robin/go/bin/wireguard-go",
      which: nothing,
    });
    expect(found).toBe("/home/robin/go/bin/wireguard-go");
  });

  test("gives up rather than guessing", () => {
    expect(findWireguardGo({ env: {}, exists: never, which: nothing })).toBeNull();
  });

  test("takes the copy shipped beside wave over whatever is on the PATH", () => {
    // An unpacked archive carries the build that belongs to it; an older copy
    // first on the PATH is exactly what should not win.
    const found = findWireguardGo({
      env: {},
      selfDir: "/opt/wave",
      exists: (path) => path === "/opt/wave/wireguard-go",
      which: () => "/usr/bin/wireguard-go",
    });
    expect(found).toBe("/opt/wave/wireguard-go");
  });

  test("beside wave means the Windows spelling on Windows", () => {
    const found = findWireguardGo({
      env: {},
      platform: "win32",
      selfDir: "C:\\dist",
      exists: (path) => path === join("C:\\dist", "wireguard.exe"),
      which: nothing,
    });
    expect(found).toBe(join("C:\\dist", "wireguard.exe"));
  });

  test("a configured path still beats the copy beside wave", () => {
    const found = findWireguardGo({
      env: { WAVE_WIREGUARD_GO: "/opt/wg" },
      selfDir: "/opt/wave",
      exists: (path) => path === "/opt/wg" || path === "/opt/wave/wireguard-go",
      which: nothing,
    });
    expect(found).toBe("/opt/wg");
  });
});

describe("finding wintun.dll", () => {
  test("takes the copy shipped beside wave first", () => {
    const found = findWintun({
      env: {},
      selfDir: "C:\\dist",
      exists: (path) => path === join("C:\\dist", "wintun.dll"),
    });
    expect(found).toBe(join("C:\\dist", "wintun.dll"));
  });

  test("asks wherever wireguard-go was found, because the two travel together", () => {
    const found = findWintun({
      env: {},
      selfDir: "C:\\dist",
      beside: join("C:\\Users\\rl\\go\\bin", "wireguard.exe"),
      exists: (path) => path === join("C:\\Users\\rl\\go\\bin", "wintun.dll"),
    });
    expect(found).toBe(join("C:\\Users\\rl\\go\\bin", "wintun.dll"));
  });

  test("prefers what the operator configured over both", () => {
    const found = findWintun({
      env: { WAVE_WINTUN_DLL: "D:\\wintun.dll" },
      selfDir: "C:\\dist",
      beside: "C:\\go\\wireguard.exe",
      exists: () => true,
    });
    expect(found).toBe("D:\\wintun.dll");
  });

  test("gives up rather than guessing", () => {
    expect(findWintun({ env: {}, selfDir: "C:\\dist", exists: never })).toBeNull();
  });

  test("looks where wave installs things, not only where Go does", () => {
    const paths = wintunSearchPaths({ PROGRAMFILES: "C:\\Program Files" }, "C:\\dist");
    expect(paths[0]).toBe(join("C:\\dist", "wintun.dll"));
    expect(paths).toContain(join("C:\\Program Files", "wave", "wintun.dll"));
  });

  test("the message names the architecture folder, which is the easy mistake", () => {
    const message = missingWintunMessage({}, "C:\\dist");
    expect(message).toContain("wintun.net");
    expect(message).toContain("arm64");
    expect(message).toContain("WAVE_WINTUN_DLL");
  });
});

describe("the message when it is missing", () => {
  test("says how to get it instead of naming an empty PATH", () => {
    const message = missingMessage({});
    expect(message).toContain("wireguard-go");
    expect(message).toContain("go install");
    expect(message).toContain("WAVE_WIREGUARD_GO");
  });

  test("lists both binary names it accepts", () => {
    const paths = searchPaths({ HOME: "/home/robin" });
    expect(paths.some((path) => path.endsWith("/wireguard-go"))).toBe(true);
    expect(paths.some((path) => path.endsWith("/wireguard"))).toBe(true);
  });
});

describe("on Windows", () => {
  test("looks for the name an executable has there", () => {
    expect(binaryNames("win32")).toContain("wireguard.exe");
    expect(binaryNames("linux")).toContain("wireguard-go");
  });

  test("searches where wave install puts it, since no package manager will have", () => {
    const found = findWireguardGo({
      env: { PROGRAMFILES: "C:\\Program Files" },
      platform: "win32",
      exists: (path) => path.includes("wave") && path.endsWith("wireguard.exe"),
      which: nothing,
    });
    expect(found).toContain("wireguard.exe");
  });

  test("names wintun, without which the binary starts and then cannot make an adapter", () => {
    expect(missingMessage({}, "win32")).toContain("wintun.dll");
    expect(missingMessage({}, "linux")).not.toContain("wintun.dll");
  });
});
