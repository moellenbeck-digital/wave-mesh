import { describe, expect, test } from "bun:test";
import { type CommandRunner, diffAddresses } from "../src/link.ts";
import { LinuxLink, parseAddresses, parseRoutes } from "../src/link-linux.ts";

/** Records the ip invocations and answers the queries from a fixture. */
function fakeIp(responses: Record<string, string>): { run: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: CommandRunner = async (args) => {
    calls.push(args);
    const key = args.join(" ");
    return { code: 0, stdout: responses[key] ?? "", stderr: "" };
  };
  return { run, calls };
}

describe("diffAddresses", () => {
  test("ignores the difference between an address and its canonical form", () => {
    expect(diffAddresses(["fd7a:0001:2::1/128"], ["fd7a:1:2::1/128"])).toEqual({ add: [], remove: [] });
  });

  test("never removes the kernel's link-local address", () => {
    expect(diffAddresses(["fe80::1/64"], []).remove).toEqual([]);
  });
});

describe("parseAddresses", () => {
  test("reads IPv4 and IPv6 from `ip -o addr`", () => {
    const output = [
      "5: wave0    inet 100.64.0.1/32 scope global wave0\\       valid_lft forever",
      "5: wave0    inet6 fd7a:1:2::1/128 scope global \\       valid_lft forever",
      "5: wave0    inet6 fe80::1/64 scope link \\       valid_lft forever",
    ].join("\n");
    expect(parseAddresses(output)).toEqual(["100.64.0.1/32", "fd7a:1:2::1/128", "fe80::1/64"]);
  });
});

describe("LinuxLink.syncAddresses", () => {
  test("adds what is missing", async () => {
    const { run, calls } = fakeIp({ "-o addr show dev wave0": "" });
    const result = await new LinuxLink(run).syncAddresses("wave0", ["100.64.0.1/32"]);
    expect(result.added).toEqual(["100.64.0.1/32"]);
    expect(calls).toContainEqual(["addr", "add", "100.64.0.1/32", "dev", "wave0"]);
  });

  test("does nothing when the address is already there", async () => {
    const { run, calls } = fakeIp({
      "-o addr show dev wave0": "5: wave0    inet 100.64.0.1/32 scope global wave0",
    });
    expect((await new LinuxLink(run).syncAddresses("wave0", ["100.64.0.1/32"])).added).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test("removes an address the netmap no longer contains", async () => {
    const { run } = fakeIp({
      "-o addr show dev wave0": "5: wave0    inet 100.64.9.9/32 scope global wave0",
    });
    const result = await new LinuxLink(run).syncAddresses("wave0", ["100.64.0.1/32"]);
    expect(result.removed).toEqual(["100.64.9.9/32"]);
  });

  test("never touches the kernel's link-local address", async () => {
    const { run } = fakeIp({ "-o addr show dev wave0": "5: wave0    inet6 fe80::1/64 scope link" });
    expect((await new LinuxLink(run).syncAddresses("wave0", [])).removed).toEqual([]);
  });
});

describe("LinuxLink.syncRoutes", () => {
  test("adds host routes per family", async () => {
    const { run, calls } = fakeIp({ "-4 route show dev wave0": "", "-6 route show dev wave0": "" });
    const result = await new LinuxLink(run).syncRoutes("wave0", ["100.64.0.2/32", "fd7a:1:2::2/128"]);
    expect(result.added).toEqual(["100.64.0.2/32", "fd7a:1:2::2/128"]);
    expect(calls).toContainEqual(["route", "replace", "100.64.0.2/32", "dev", "wave0"]);
  });

  test("skips routes the kernel already has, which it prints without /32", async () => {
    const { run } = fakeIp({
      "-4 route show dev wave0": "100.64.0.2 scope link",
      "-6 route show dev wave0": "",
    });
    expect((await new LinuxLink(run).syncRoutes("wave0", ["100.64.0.2/32"])).added).toEqual([]);
  });
});

describe("LinuxLink.remove", () => {
  test("treats a missing interface as success", async () => {
    const run: CommandRunner = async () => ({ code: 1, stdout: "", stderr: 'Cannot find device "wave0"' });
    expect(await new LinuxLink(run).remove("wave0")).toBeUndefined();
  });
});

describe("LinuxLink.syncRoutes pruning", () => {
  test("removes a route the netmap no longer asks for", async () => {
    const { run, calls } = fakeIp({
      "-4 route show dev wave0": "100.64.0.2 scope link\n10.77.0.2 scope link",
      "-6 route show dev wave0": "",
    });
    const result = await new LinuxLink(run).syncRoutes("wave0", ["10.77.0.2/32"]);
    expect(result.removed).toEqual(["100.64.0.2"]);
    expect(calls).toContainEqual(["route", "del", "100.64.0.2", "dev", "wave0"]);
  });

  test("does not remove what it just added", async () => {
    const { run } = fakeIp({ "-4 route show dev wave0": "", "-6 route show dev wave0": "" });
    const result = await new LinuxLink(run).syncRoutes("wave0", ["10.77.0.2/32"]);
    expect(result.added).toEqual(["10.77.0.2/32"]);
    expect(result.removed).toEqual([]);
  });
});

describe("parseRoutes", () => {
  test("ignores the default route", () => {
    expect(parseRoutes("default via 10.0.0.1\n100.64.0.2 scope link\n")).toEqual(["100.64.0.2"]);
  });
});
