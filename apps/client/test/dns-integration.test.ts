import { describe, expect, test } from "bun:test";
import type { CommandRunner } from "../src/link.ts";
import { DarwinLink } from "../src/link-darwin.ts";
import { LinuxLink } from "../src/link-linux.ts";

/** Records every invocation and answers with a given exit code. */
function recorder(code = 0): { run: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args) => {
      calls.push(args);
      return { code, stdout: "", stderr: "" };
    },
  };
}

const settings = {
  resolver: "10.77.0.1",
  suffixes: ["rl.wave.example.com", "corp.example.com"],
  search: "rl.wave.example.com",
};

describe("linux", () => {
  test("routes the given domains to our resolver and searches only our own", async () => {
    const ip = recorder();
    const resolvectl = recorder();
    const result = await new LinuxLink(ip.run, resolvectl.run).configureDns("wave0", settings);

    expect(result).toEqual({ routed: true, searched: true });
    expect(resolvectl.calls).toContainEqual(["dns", "wave0", "10.77.0.1"]);
    // The "~" is what makes a domain routing-only. The wave's own zone goes in
    // without it, which is what completes a bare `laptop`; the delegated zone
    // keeps the "~" so it never captures an unqualified name.
    expect(resolvectl.calls).toContainEqual(["domain", "wave0", "rl.wave.example.com", "~corp.example.com"]);
    // Nothing was done to the interface itself.
    expect(ip.calls).toEqual([]);
  });

  test("routes without searching when no zone is named as the search domain", async () => {
    const resolvectl = recorder();
    const result = await new LinuxLink(recorder().run, resolvectl.run).configureDns("wave0", {
      resolver: "10.77.0.1",
      suffixes: ["rl.wave.example.com"],
    });

    expect(result).toEqual({ routed: true, searched: false });
    expect(resolvectl.calls).toContainEqual(["domain", "wave0", "~rl.wave.example.com"]);
  });

  test("declines rather than seizing the system resolver when resolved is absent", async () => {
    const resolvectl = recorder(127);
    const result = await new LinuxLink(recorder().run, resolvectl.run).configureDns("wave0", settings);

    expect(result).toEqual({ routed: false, searched: false });
    // Only the probe ran; no configuration was attempted and no file touched.
    expect(resolvectl.calls).toEqual([["--version"]]);
  });

  test("gives the interface's settings back on revert", async () => {
    const resolvectl = recorder();
    await new LinuxLink(recorder().run, resolvectl.run).revertDns("wave0");
    expect(resolvectl.calls).toEqual([["revert", "wave0"]]);
  });

  test("routes each wave name on its own, with no search domain, under a zone the user owns", async () => {
    const resolvectl = recorder();
    const result = await new LinuxLink(recorder().run, resolvectl.run).configureDns("wave0", {
      resolver: "10.77.0.1",
      suffixes: ["corp.example.com"],
      names: ["laptop.rolenz-digital.de", "nas.rolenz-digital.de"],
    });

    // Every entry has the "~": none is a search domain, which in resolved is
    // routing of the whole domain as well -- the apex would be caught.
    expect(result).toEqual({ routed: true, searched: false });
    expect(resolvectl.calls).toContainEqual([
      "domain",
      "wave0",
      "~corp.example.com",
      "~laptop.rolenz-digital.de",
      "~nas.rolenz-digital.de",
    ]);
    expect(resolvectl.calls.flat()).not.toContain("rolenz-digital.de");
    expect(resolvectl.calls.flat()).not.toContain("~rolenz-digital.de");
  });

  test("replaces the whole list on a change, so a zone from an older client does not stay", async () => {
    const resolvectl = recorder();
    const link = new LinuxLink(recorder().run, resolvectl.run);
    await link.configureDns("wave0", {
      resolver: "10.77.0.1",
      suffixes: ["rolenz-digital.de"],
      search: "rolenz-digital.de",
    });
    await link.configureDns("wave0", {
      resolver: "10.77.0.1",
      suffixes: [],
      names: ["nas.rolenz-digital.de"],
    });

    const domains = resolvectl.calls.filter((call) => call[0] === "domain");
    expect(domains.at(-1)).toEqual(["domain", "wave0", "~nas.rolenz-digital.de"]);
  });

  test("does not call a search domain one when it is not among the routed entries", async () => {
    const result = await new LinuxLink(recorder().run, recorder().run).configureDns("wave0", {
      resolver: "10.77.0.1",
      suffixes: ["corp.example.com"],
      search: "rl.wave.internal",
    });
    expect(result).toEqual({ routed: true, searched: false });
  });

  test("does nothing when there are no suffixes to route", async () => {
    const resolvectl = recorder();
    expect(
      await new LinuxLink(recorder().run, resolvectl.run).configureDns("wave0", {
        resolver: "10.77.0.1",
        suffixes: [],
      }),
    ).toEqual({ routed: true, searched: false });
    expect(resolvectl.calls).toEqual([]);
  });
});

describe("macos", () => {
  const darwin = (written: Map<string, string>, removed: string[] = []) =>
    new DarwinLink({
      resolverDir: "/tmp/wave-test-resolver",
      writeFile: async (path, content) => void written.set(path, content),
      removeFile: async (path) => void removed.push(path),
    });

  test("writes one resolver file per domain, and says it cannot search", async () => {
    const written = new Map<string, string>();
    // /etc/resolver routes a name that carries the suffix; it cannot make macOS
    // append one to a bare `laptop`, and saying so is better than pretending.
    expect(await darwin(written).configureDns("utun7", settings)).toEqual({
      routed: true,
      searched: false,
    });

    expect([...written.keys()]).toEqual([
      "/tmp/wave-test-resolver/rl.wave.example.com",
      "/tmp/wave-test-resolver/corp.example.com",
    ]);
    expect(written.get("/tmp/wave-test-resolver/rl.wave.example.com")).toBe("nameserver 10.77.0.1\n");
  });

  test("writes the port too, once a second wave has pushed it off 53", async () => {
    const written = new Map<string, string>();
    await darwin(written).configureDns("utun7", { ...settings, port: 5355 });
    expect(written.get("/tmp/wave-test-resolver/rl.wave.example.com")).toBe(
      "nameserver 10.77.0.1\nport 5355\n",
    );
  });

  test("writes a file per wave name, and none for the zone, under a zone the user owns", async () => {
    const written = new Map<string, string>();
    const result = await darwin(written).configureDns("utun7", {
      resolver: "127.0.0.1",
      port: 5354,
      suffixes: ["77.10.in-addr.arpa"],
      names: ["laptop.rolenz-digital.de", "nas.rolenz-digital.de"],
    });

    expect(result).toEqual({ routed: true, searched: false });
    expect([...written.keys()]).toEqual([
      "/tmp/wave-test-resolver/77.10.in-addr.arpa",
      "/tmp/wave-test-resolver/laptop.rolenz-digital.de",
      "/tmp/wave-test-resolver/nas.rolenz-digital.de",
    ]);
    expect(written.has("/tmp/wave-test-resolver/rolenz-digital.de")).toBe(false);
  });

  /** A directory of files, as /etc/resolver would hold them. */
  const dir = (files: Record<string, string>, removed: string[] = []) => {
    const base = "/tmp/wave-test-resolver/";
    return new DarwinLink({
      resolverDir: "/tmp/wave-test-resolver",
      writeFile: async (path, content) => {
        files[path.slice(base.length)] = content;
      },
      removeFile: async (path) => {
        removed.push(path);
        delete files[path.slice(base.length)];
      },
      listFiles: async () => Object.keys(files),
      readFile: async (path) => files[path.slice(base.length)] ?? "",
    });
  };
  const ours = "nameserver 127.0.0.1\nport 5354\n";

  test("removes the files of names that have gone, and the whole-zone file an older client wrote", async () => {
    const removed: string[] = [];
    const files: Record<string, string> = {
      "rolenz-digital.de": ours, // the old client's zone
      "gone.rolenz-digital.de": ours, // a node that has left
      "nas.rolenz-digital.de": ours,
    };
    await dir(files, removed).configureDns("utun7", {
      resolver: "127.0.0.1",
      port: 5354,
      suffixes: [],
      names: ["nas.rolenz-digital.de", "new.rolenz-digital.de"],
    });

    expect(removed.sort()).toEqual([
      "/tmp/wave-test-resolver/gone.rolenz-digital.de",
      "/tmp/wave-test-resolver/rolenz-digital.de",
    ]);
    expect(Object.keys(files).sort()).toEqual(["nas.rolenz-digital.de", "new.rolenz-digital.de"]);
  });

  test("leaves alone what is not ours: another wave's resolver, someone else's file", async () => {
    const removed: string[] = [];
    const files: Record<string, string> = {
      "second.example.com": "nameserver 127.0.0.1\nport 5355\n", // another wave
      "vpn.corp": "nameserver 10.0.0.53\n", // the user's own
      "odd name": ours,
    };
    await dir(files, removed).configureDns("utun7", {
      resolver: "127.0.0.1",
      port: 5354,
      suffixes: [],
      names: ["nas.rolenz-digital.de"],
    });
    expect(removed).toEqual([]);
  });

  test("never writes a name that could leave the directory", async () => {
    const written = new Map<string, string>();
    await darwin(written).configureDns("utun7", {
      resolver: "127.0.0.1",
      suffixes: [],
      names: ["../../etc/hosts", "nas.rolenz-digital.de"],
    });
    expect([...written.keys()]).toEqual(["/tmp/wave-test-resolver/nas.rolenz-digital.de"]);
  });

  test("reverting takes back what was set, and what an earlier run left of ours", async () => {
    const removed: string[] = [];
    const files: Record<string, string> = {
      "nas.rolenz-digital.de": ours,
      "stale.rolenz-digital.de": ours,
      "vpn.corp": "nameserver 10.0.0.53\n",
    };
    await dir(files, removed).revertDns("utun7", {
      resolver: "127.0.0.1",
      port: 5354,
      suffixes: [],
      names: ["nas.rolenz-digital.de"],
    });
    expect(removed.sort()).toEqual([
      "/tmp/wave-test-resolver/nas.rolenz-digital.de",
      "/tmp/wave-test-resolver/stale.rolenz-digital.de",
    ]);
    expect(Object.keys(files)).toEqual(["vpn.corp"]);
  });

  test("removes them again", async () => {
    const removed: string[] = [];
    await darwin(new Map(), removed).revertDns("utun7", settings);
    expect(removed).toEqual([
      "/tmp/wave-test-resolver/rl.wave.example.com",
      "/tmp/wave-test-resolver/corp.example.com",
    ]);
  });
});

describe("where the resolver listens", () => {
  test("linux uses the tunnel address, which the kernel delivers locally", () => {
    const linux = new LinuxLink(recorder().run, recorder().run);
    expect(linux.resolverEndpoint("100.64.0.1")).toEqual({ address: "100.64.0.1", port: 53 });
    // Every wave has an address of its own here, so none has to leave port 53.
    expect(linux.resolverEndpoint("100.65.0.1", 1)).toEqual({ address: "100.65.0.1", port: 53 });
  });

  test("macOS uses loopback, because a utun sends its own address out of the interface", () => {
    // Bound to the tunnel address the resolver would never hear a query: macOS
    // routes that address into utun instead of delivering it here, which is why
    // even a ping to one's own wave address times out.
    expect(new DarwinLink().resolverEndpoint("100.64.0.1")).toEqual({
      address: "127.0.0.1",
      port: 5354,
    });
  });

  test("macOS gives every wave its own port, because they share loopback", () => {
    expect(new DarwinLink().resolverEndpoint("100.65.0.1", 1).port).toBe(5355);
  });
});
