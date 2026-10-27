import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSpks,
  DSM_APP_NAME,
  PAYLOAD,
  runAs,
  SPK_TARGETS,
  spkName,
  synologyVersion,
} from "./build-spk.ts";

/**
 * What a package must contain to be one DSM will install, checked on the file
 * the build writes -- listed and unpacked by the system's own tar, which is
 * what DSM reads it with, rather than by the code that wrote it.
 */

// The first build draws the 256 px icon, which takes a couple of seconds.
setDefaultTimeout(30_000);

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "wave-spk-test-"));
  cleanup.push(dir);
  return dir;
};

async function run(command: string[]): Promise<string> {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${command.join(" ")}: ${err}`);
  return out;
}

/** A dist/ as `build-clients.sh --package` leaves it, with stand-ins for the binaries. */
async function fakeDist(): Promise<string> {
  const dist = scratch();
  for (const { archive } of SPK_TARGETS) {
    const stage = scratch();
    for (const { name } of PAYLOAD) writeFileSync(join(stage, name), `${archive} ${name}\n`);
    await run(["tar", "-czf", join(dist, archive), "-C", stage, ...PAYLOAD.map((file) => file.name)]);
  }
  writeFileSync(join(dist, "SHA256SUMS"), "aaaa  wave-linux-amd64.tar.gz\nbbbb  wave-linux-arm64.tar.gz\n");
  return dist;
}

const parseInfo = (text: string): Record<string, string> =>
  Object.fromEntries(
    text
      .trim()
      .split("\n")
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), JSON.parse(line.slice(at + 1)) as string];
      }),
  );

describe("the version DSM sees", () => {
  test("a release, an insiders and a develop build sort the way semver does", () => {
    expect(synologyVersion("0.12.0")).toBe("0.12.0-3000");
    expect(synologyVersion("0.12.0-insiders.2")).toBe("0.12.0-2002");
    expect(synologyVersion("0.12.0-develop.1")).toBe("0.12.0-1001");
  });

  test("numbers only, so anything with words in it is refused", () => {
    expect(() => synologyVersion("0.12.0-rc.1")).toThrow(/not a release version/);
    expect(() => synologyVersion("0.12.0-develop.1000")).toThrow(/do not fit/);
  });
});

describe("the packages", () => {
  test("one per architecture, named for the version and the arch", async () => {
    const dist = await fakeDist();
    const names = await buildSpks(dist, "0.12.0");
    expect(names).toEqual(["wave-0.12.0-dsm7-x86_64.spk", "wave-0.12.0-dsm7-armv8.spk"]);
    expect(spkName("0.12.0", "armv8")).toBe("wave-0.12.0-dsm7-armv8.spk");
  });

  for (const { arch, archive } of SPK_TARGETS) {
    describe(arch, () => {
      const build = async () => {
        const dist = await fakeDist();
        await buildSpks(dist, "0.12.0-develop.3");
        return join(dist, spkName("0.12.0-develop.3", arch));
      };

      test("holds what DSM looks for, owned by root", async () => {
        const listing = (await run(["tar", "-tvf", await build()])).trim().split("\n");
        const names = listing.map((line) => line.trim().split(/\s+/).at(-1));
        expect(names.sort()).toEqual(
          [
            "INFO",
            "PACKAGE_ICON.PNG",
            "PACKAGE_ICON_256.PNG",
            "conf/",
            "conf/privilege",
            "conf/resource",
            "package.tgz",
            "scripts/",
            "scripts/preuninst",
            "scripts/setup",
            "scripts/start-stop-status",
          ].sort(),
        );
        // A package extracted on a NAS keeps the owner the archive names; the
        // builder's own uid is no one's there.
        for (const line of listing) expect(line).toContain("root");
        // DSM runs these directly.
        for (const script of ["scripts/start-stop-status", "scripts/preuninst", "scripts/setup"]) {
          expect(listing.find((line) => line.endsWith(script))?.startsWith("-rwxr-xr-x")).toBe(true);
        }
      });

      test("INFO names the package, the architecture and a version DSM can compare", async () => {
        const info = parseInfo(await run(["tar", "-xOf", await build(), "INFO"]));
        expect(info.package).toBe("wave");
        expect(info.arch).toBe(arch);
        expect(info.version).toBe("0.12.0-1003");
        expect(info.os_min_ver).toBe("7.0-40000");
        expect(info.thirdparty).toBe("yes");
        expect(Number(info.extractsize)).toBeGreaterThan(0);
      });

      test("carries the archive's own files, with a checksum DSM can verify", async () => {
        const spk = await build();
        const work = scratch();
        await run(["tar", "-xf", spk, "-C", work]);

        const inner = readFileSync(join(work, "package.tgz"));
        const info = parseInfo(readFileSync(join(work, "INFO"), "utf8"));
        expect(info.checksum).toBe(createHash("md5").update(inner).digest("hex"));

        const payload = join(work, "payload");
        mkdirSync(payload);
        await run(["tar", "-xzf", join(work, "package.tgz"), "-C", payload]);
        for (const { name } of PAYLOAD) {
          // Not rebuilt, not repackaged: the bytes the release archive has.
          expect(readFileSync(join(payload, name), "utf8")).toBe(`${archive} ${name}\n`);
        }
        const listing = (await run(["tar", "-tvzf", join(work, "package.tgz")])).trim().split("\n");
        for (const name of ["wave", "wireguard-go"]) {
          expect(listing.find((line) => line.endsWith(` ${name}`))?.startsWith("-rwxr-xr-x")).toBe(true);
        }
        // The licences go with the binaries they cover.
        expect(listing.some((line) => line.endsWith("LICENSE.wireguard-go"))).toBe(true);
      });

      test("brings its page for DSM's main menu, under the name INFO gives it", async () => {
        const spk = await build();
        const work = scratch();
        await run(["tar", "-xf", spk, "-C", work]);
        const info = parseInfo(readFileSync(join(work, "INFO"), "utf8"));
        expect(info.dsmuidir).toBe("ui");
        expect(info.dsmappname).toBe(DSM_APP_NAME);

        const payload = join(work, "payload");
        mkdirSync(payload);
        await run(["tar", "-xzf", join(work, "package.tgz"), "-C", payload]);
        const config = JSON.parse(readFileSync(join(payload, "ui", "config"), "utf8"));
        const app = config[".url"][DSM_APP_NAME];
        expect(app.type).toBe("url");
        // Relative to DSM's root, under the folder DSM links ui/ to, and with
        // the trailing slash the page's relative API paths rely on.
        expect(app.url).toBe("webman/3rdparty/wave/index.cgi/");
        expect(
          readFileSync(join(payload, "ui", app.icon))
            .subarray(1, 4)
            .toString(),
        ).toBe("PNG");

        const listing = (await run(["tar", "-tvzf", join(work, "package.tgz")])).trim().split("\n");
        // DSM runs it directly, as the package's user.
        expect(listing.find((line) => line.endsWith(" ui/index.cgi"))?.startsWith("-rwxr-xr-x")).toBe(true);
        expect(readFileSync(join(payload, "ui", "index.cgi"), "utf8")).toContain(
          "exec /var/packages/wave/target/wave dsm-ui",
        );
      });

      test("never asks DSM for root, which DSM 7 refuses to install", async () => {
        const work = scratch();
        await run(["tar", "-xf", await build(), "-C", work]);
        const privilege = JSON.parse(readFileSync(join(work, "conf/privilege"), "utf8"));
        expect(privilege.defaults["run-as"]).toBe("package");
        // Not in `defaults`, not in a tool or a script entry, not under any other key.
        expect(runAs(privilege)).toEqual(["package"]);
        expect(readFileSync(join(work, "conf/privilege"), "utf8")).not.toMatch(/"root"/);
      });

      test("asks DSM for `wave` on the PATH, and has icons of the sizes DSM wants", async () => {
        const work = scratch();
        await run(["tar", "-xf", await build(), "-C", work]);
        expect(JSON.parse(readFileSync(join(work, "conf/resource"), "utf8"))).toEqual({
          "usr-local-linker": { bin: ["wave"] },
        });
        for (const [file, size] of [
          ["PACKAGE_ICON.PNG", 72],
          ["PACKAGE_ICON_256.PNG", 256],
        ] as const) {
          const png = readFileSync(join(work, file));
          expect([...png.subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
          // IHDR: width and height, big-endian, right after the signature.
          expect(png.readUInt32BE(16)).toBe(size);
          expect(png.readUInt32BE(20)).toBe(size);
        }
      });
    });
  }

  test("the same input gives the same file", async () => {
    const dist = await fakeDist();
    await buildSpks(dist, "0.12.0");
    const first = readFileSync(join(dist, "wave-0.12.0-dsm7-armv8.spk"));
    await buildSpks(dist, "0.12.0");
    expect(readFileSync(join(dist, "wave-0.12.0-dsm7-armv8.spk")).equals(first)).toBe(true);
  });

  test("a build that has not happened yet is said, not guessed at", async () => {
    await expect(buildSpks(scratch(), "0.12.0")).rejects.toThrow(/build-clients\.sh --package/);
  });
});

describe("SHA256SUMS", () => {
  test("lists the packages next to the archives, once each however often it runs", async () => {
    const dist = await fakeDist();
    await buildSpks(dist, "0.12.0");
    await buildSpks(dist, "0.12.0");
    const lines = readFileSync(join(dist, "SHA256SUMS"), "utf8").trim().split("\n");

    expect(lines.slice(0, 2)).toEqual(["aaaa  wave-linux-amd64.tar.gz", "bbbb  wave-linux-arm64.tar.gz"]);
    expect(lines).toHaveLength(4);
    for (const { arch } of SPK_TARGETS) {
      const name = spkName("0.12.0", arch);
      const sum = createHash("sha256")
        .update(readFileSync(join(dist, name)))
        .digest("hex");
      expect(lines).toContain(`${sum}  ${name}`);
    }
  });
});

describe("run-as in a privilege file", () => {
  test("is found wherever it stands", () => {
    expect(runAs({ defaults: { "run-as": "package" } })).toEqual(["package"]);
    expect(
      runAs({ defaults: { "run-as": "package" }, "ctrl-script": [{ action: "start", "run-as": "root" }] }),
    ).toEqual(["package", "root"]);
    expect(runAs({})).toEqual([]);
  });
});

const scriptPath = (name: string): string => join(import.meta.dir, "..", "packaging", "dsm", "scripts", name);

describe("the scripts DSM runs", () => {
  for (const script of ["start-stop-status", "preuninst", "setup"]) {
    test(`${script} is valid shell`, async () => {
      await run(["sh", "-n", scriptPath(script)]);
    });
  }
  test("ui/index.cgi is valid shell", async () => {
    await run(["sh", "-n", join(import.meta.dir, "..", "packaging", "dsm", "ui", "index.cgi")]);
  });
});

/**
 * The scripts run against a stand-in `systemctl`, `id` and `wave` put ahead on
 * the PATH: what they were asked is written to `calls`, what they answer is the
 * test's to say. Nothing here needs a DSM, or root.
 */
function sandbox(options: { uid: number; unit: boolean; active?: boolean }) {
  const dir = scratch();
  const bin = join(dir, "bin");
  const pkg = join(dir, "target");
  mkdirSync(bin);
  mkdirSync(pkg);
  const calls = join(dir, "calls");
  writeFileSync(calls, "");
  const tool = (path: string, body: string): void => {
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  };
  tool(join(bin, "id"), `echo ${options.uid}`);
  tool(
    join(bin, "systemctl"),
    `echo "systemctl $*" >> "${calls}"
case "$1" in
  cat) exit ${options.unit ? 0 : 1} ;;
  is-active) exit ${options.active ? 0 : 3} ;;
esac
exit 0`,
  );
  // chown needs root; the script is told to carry on without it.
  tool(join(bin, "chown"), "exit 0");
  tool(join(pkg, "wave"), `echo "wave $*" >> "${calls}"`);
  writeFileSync(join(pkg, "wireguard-go"), "");

  return {
    /** Runs a script from the package: what it said, how it ended and what it called. */
    async run(script: string, ...args: string[]) {
      const proc = Bun.spawn(["sh", scriptPath(script), ...args], {
        env: { PATH: `${bin}:${process.env.PATH}`, SYNOPKG_PKGDEST: pkg },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { out: out + err, code, calls: readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) };
    },
  };
}

describe("the package as the package user", () => {
  // DSM runs these as the package's own user, who is no one's root.
  test("start does not fail, and does not try to be root, while the daemon is not set up", async () => {
    const result = await sandbox({ uid: 1024, unit: false }).run("start-stop-status", "start");
    expect(result.code).toBe(0);
    expect(result.out).toContain("sudo /var/packages/wave/scripts/setup");
    expect(result.calls.filter((call) => !call.startsWith("systemctl cat"))).toEqual([]);
  });

  test("start and stop leave a running daemon alone, and succeed", async () => {
    const box = sandbox({ uid: 1024, unit: true, active: true });
    for (const action of ["start", "stop", "prestart", "prestop"]) {
      expect((await box.run("start-stop-status", action)).code).toBe(0);
    }
    const { calls } = await box.run("start-stop-status", "start");
    expect(calls.filter((call) => /enable|disable|stop|restart|install/.test(call))).toEqual([]);
  });

  test("status says running when the daemon is", async () => {
    const result = await sandbox({ uid: 1024, unit: true, active: true }).run("start-stop-status", "status");
    expect(result.code).toBe(0);
    expect(result.out).toContain("running");
  });

  test("status says stopped when it is set up and is not running", async () => {
    const result = await sandbox({ uid: 1024, unit: true, active: false }).run("start-stop-status", "status");
    expect(result.code).toBe(3);
  });

  test("status does not call a package crashed for a step that only waits for root", async () => {
    const result = await sandbox({ uid: 1024, unit: false }).run("start-stop-status", "status");
    expect(result.code).toBe(0);
    expect(result.out).toContain("not set up yet");
  });

  test("preuninst never fails, and says what is left to do when the service is still there", async () => {
    const result = await sandbox({ uid: 1024, unit: true }).run("preuninst");
    expect(result.code).toBe(0);
    expect(result.out).toContain("setup uninstall");
    expect(result.calls.some((call) => call.startsWith("wave "))).toBe(false);
  });

  test("preuninst is silent when there is nothing to take out", async () => {
    const result = await sandbox({ uid: 1024, unit: false }).run("preuninst");
    expect(result.code).toBe(0);
    expect(result.out).toBe("");
  });

  test("preuninst takes the service out itself where it happens to be root", async () => {
    const result = await sandbox({ uid: 0, unit: true }).run("preuninst");
    expect(result.code).toBe(0);
    expect(result.calls).toContain("wave uninstall");
  });
});

describe("the one step as root", () => {
  test("is refused to anyone else, and changes nothing", async () => {
    const result = await sandbox({ uid: 1024, unit: false }).run("setup");
    expect(result.code).toBe(1);
    expect(result.out).toContain("must run as root");
    expect(result.calls).toEqual([]);
  });

  test("installs the service from the package's own binary", async () => {
    const result = await sandbox({ uid: 0, unit: false }).run("setup");
    expect(result.code).toBe(0);
    expect(result.calls).toHaveLength(1);
    // The socket goes to the package's user too: DSM runs the page as that user.
    expect(result.calls[0]).toMatch(/^wave install --binary .*\/target\/wave --socket-user wave-pkg$/);
    expect(
      readFileSync(join(import.meta.dir, "..", "packaging", "dsm", "conf", "privilege"), "utf8"),
    ).toContain('"username": "wave-pkg"');
  });

  test("uninstall takes it out again", async () => {
    const result = await sandbox({ uid: 0, unit: true }).run("setup", "uninstall");
    expect(result.code).toBe(0);
    expect(result.calls).toEqual(["wave uninstall"]);
  });

  test("an argument it does not know is not guessed at", async () => {
    const result = await sandbox({ uid: 0, unit: false }).run("setup", "remove");
    expect(result.code).toBe(2);
    expect(result.calls).toEqual([]);
  });
});
