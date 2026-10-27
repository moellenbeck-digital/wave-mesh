import { describe, expect, test } from "bun:test";
import {
  defaultBinaryPath,
  install,
  LINUX_ENV,
  LINUX_SERVICE,
  launchdDaemon,
  planInstall,
  systemdService,
  systemdTrayService,
  uninstall,
} from "../src/install.ts";

const BINARY = "/usr/local/bin/wave";

/** A machine where shadow-utils is installed and nothing else matters. */
const SBIN = (name: string): string => `/usr/sbin/${name}`;
/** A machine with busybox and sudo, which is what a NAS tends to look like. */
const BUSYBOX = (name: string): string | null =>
  ["addgroup", "sudo"].includes(name) ? `/bin/${name}` : null;

describe("systemd units", () => {
  test("start the binary as the daemon and keep it running", () => {
    const unit = systemdService(BINARY);
    expect(unit).toContain(`ExecStart=${BINARY} daemon`);
    expect(unit).toContain("Restart=always");
    expect(unit).toContain(`EnvironmentFile=-${LINUX_ENV}`);
  });

  test("run the tray in the desktop session, not as a system service", () => {
    const unit = systemdTrayService(BINARY);
    expect(unit).toContain(`ExecStart=${BINARY} tray`);
    expect(unit).toContain("PartOf=graphical-session.target");
    expect(unit).not.toContain("multi-user.target");
  });
});

describe("launchd", () => {
  test("describes the daemon with its control server", () => {
    const content = launchdDaemon(BINARY, "https://control.example");
    expect(content).toContain("<string>net.wave.daemon</string>");
    expect(content).toContain(`<string>${BINARY}</string>`);
    expect(content).toContain("<string>daemon</string>");
    expect(content).toContain("https://control.example");
  });

  test("names the socket group even when there is nothing else to configure", () => {
    // The group decides whether anything but root can talk to the daemon, so
    // unlike the control URL it is never left out.
    const content = launchdDaemon(BINARY);
    expect(content).toContain("<key>WAVE_SOCKET_GROUP</key><string>admin</string>");
    expect(content).not.toContain("WAVE_CONTROL_URL");
  });
});

describe("the plan", () => {
  test("creates the group and enables the service on linux", () => {
    const plan = planInstall({ platform: "linux", binaryPath: BINARY, user: "robin", lookup: SBIN });
    expect(plan.files.map((file) => file.path)).toContain(LINUX_SERVICE);
    // The full path, not the bare name: sudo's PATH often has no sbin in it.
    expect(plan.commands).toContainEqual(["/usr/sbin/groupadd", "-f", "wave"]);
    expect(plan.commands).toContainEqual(["/usr/sbin/usermod", "-aG", "wave", "robin"]);
    expect(plan.commands).toContainEqual(["systemctl", "enable", "wave"]);
    // restart, not start: installing over a running service has to take effect.
    expect(plan.commands).toContainEqual(["systemctl", "restart", "wave"]);
  });

  test("installs no control server at all", () => {
    // The machine is set up here; which wave it joins is `wave login`.
    const plan = planInstall({ platform: "linux", binaryPath: BINARY });
    expect(plan.files.map((file) => file.path)).not.toContain(LINUX_ENV);
    expect(plan.files.map((file) => file.content).join("")).not.toContain("WAVE_CONTROL_URL");
  });

  test("puts the tray unit in the user's own directory", () => {
    const plan = planInstall({
      platform: "linux",
      binaryPath: BINARY,
      user: "robin",
      userHome: "/home/robin",
      userId: 1000,
    });
    expect(plan.files.map((file) => file.path)).toContain(
      "/home/robin/.config/systemd/user/wave-tray.service",
    );
    // In `optional`: a tray that will not start is not a tunnel that failed.
    expect(plan.optional?.some((command) => command.includes("--user"))).toBe(true);
    expect(plan.commands.some((command) => command.includes("--user"))).toBe(false);
  });

  test("uses launchd on macOS", () => {
    const plan = planInstall({ platform: "darwin", binaryPath: BINARY, userId: 501 });
    expect(plan.files.map((file) => file.path)).toContain("/Library/LaunchDaemons/net.wave.daemon.plist");
    // The bootout has to come first: launchd ignores a plist whose job it has
    // already loaded, so without it an upgrade never sees the new definition.
    expect(plan.commands.slice(0, 2)).toEqual([
      ["launchctl", "bootout", "system", "/Library/LaunchDaemons/net.wave.daemon.plist"],
      ["launchctl", "bootstrap", "system", "/Library/LaunchDaemons/net.wave.daemon.plist"],
    ]);
    const tray = plan.commands.findIndex((command) => command.includes("gui/501"));
    expect(plan.commands[tray]?.[1]).toBe("bootout");
  });

  test("says so where it cannot help yet, instead of writing nothing silently", () => {
    const plan = planInstall({ platform: "freebsd", binaryPath: BINARY });
    expect(plan.files).toEqual([]);
    expect(plan.commands).toEqual([]);
    expect(plan.notes.join(" ")).toContain("freebsd");
  });
});

describe("the Windows daemon", () => {
  const WIN_BINARY = "C:\\Program Files\\wave\\wave.exe";

  test("carries its definition in a file, because two settings have no flag", () => {
    const plan = planInstall({ platform: "win32", binaryPath: WIN_BINARY });
    // Restart-after-crash and "no time limit" cannot be said on the schtasks
    // command line at all, so the definition is XML and /xml creates it.
    expect(plan.files).toHaveLength(1);
    const create = plan.commands.find((command) => command[1] === "/create");
    expect(create?.includes("/xml")).toBe(true);
    expect(create?.[create.indexOf("/xml") + 1]).toBe(plan.files[0]?.path);
  });

  test("creates with /f, so one plan serves a first install and an upgrade", () => {
    const plan = planInstall({ platform: "win32", binaryPath: WIN_BINARY });
    const create = plan.commands.find((command) => command[1] === "/create");
    expect(create?.includes("/f")).toBe(true);
    expect(plan.commands.map((command) => command[1])).toContain("/run");
  });

  test("names what the machine still needs, and where its dependencies went", () => {
    const notes = planInstall({ platform: "win32", binaryPath: WIN_BINARY }).notes.join(" ");
    expect(notes).toContain("Administrator");
    // The install copies both itself now, so this says where -- the daemon
    // runs as LocalSystem and looks nowhere else.
    expect(notes).toContain("wintun.dll");
    expect(notes).toContain("tray");
  });

  test("points at a path Windows can actually open", () => {
    // It used to carry doubled separators, which is not the path anyone typed.
    expect(defaultBinaryPath("win32")).toBe(WIN_BINARY);
  });
});

describe("the Windows daemon is a task running as LocalSystem", () => {
  const WIN_BINARY = "C:\\Program Files\\wave\\wave.exe";

  test("the definition runs as S-1-5-18, which is the whole point", async () => {
    const { planInstall, windowsTaskXml } = await import("../src/install.ts");
    const plan = planInstall({ platform: "win32", binaryPath: WIN_BINARY });
    const xml = plan.files.map((file) => file.content).join("");
    // Without LocalSystem wireguard-go cannot own its UAPI pipe, and the
    // tunnel fails with "security ID may not be assigned as the owner".
    expect(xml).toContain("<UserId>S-1-5-18</UserId>");
    expect(xml).toContain(`<Command>${WIN_BINARY}</Command>`);
    expect(xml).toContain("<Arguments>daemon</Arguments>");
    // A daemon Task Scheduler stops after three days looks like a network
    // fault, so the time limit is off and a crash is restarted.
    expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(xml).toContain("<RestartOnFailure>");
    expect(windowsTaskXml("C:\\x\\a&b.exe")).toContain("<Command>C:\\x\\a&amp;b.exe</Command>");
  });

  test("the definition is written as UTF-16, which is what schtasks reads", async () => {
    const { planInstall } = await import("../src/install.ts");
    const plan = planInstall({ platform: "win32", binaryPath: WIN_BINARY });
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0]?.encoding).toBe("utf16le");
  });

  test("the daemon is asked to leave before the task is killed", async () => {
    const { planInstall } = await import("../src/install.ts");
    const plan = planInstall({ platform: "win32", binaryPath: WIN_BINARY });
    // Ending the task is a hard kill, and the NRPT rules a wave wrote are
    // registry entries that would outlive it.
    expect(plan.before?.[0]).toEqual([WIN_BINARY, "down"]);
    expect(plan.before?.[1]?.slice(0, 2)).toEqual(["schtasks.exe", "/end"]);
    // Nothing reaches for sc any more: a Bun process cannot be a service.
    expect(JSON.stringify(plan)).not.toContain("sc.exe");
  });
});

describe("the Windows tray starts with the daemon, as it does on the other two", () => {
  const WIN_BINARY = "C:\\Program Files\\wave\\wave.exe";
  const forUser = () => planInstall({ platform: "win32", binaryPath: WIN_BINARY, user: "robin" });

  test("is started right away and not only at the next sign-in", () => {
    // launchd kickstarts it and systemd starts it; leaving Windows to wait for
    // a sign-in was the one platform where `wave install` finished without an
    // icon.
    const plan = forUser();
    expect(plan.optional).toContainEqual(["schtasks.exe", "/run", "/tn", "wave tray"]);
    // Optional, because it is the one step that needs a session: an elevated
    // prompt belonging to another account cannot start it, and that is not a
    // tunnel that failed.
    expect(plan.commands).not.toContainEqual(["schtasks.exe", "/run", "/tn", "wave tray"]);
  });

  test("comes from a file, so it outlives three days and survives a crash", () => {
    const plan = forUser();
    const tray = plan.files.find((file) => file.path.endsWith("wave-tray.xml"));
    expect(plan.commands).toContainEqual([
      "schtasks.exe",
      "/create",
      "/f",
      "/tn",
      "wave tray",
      "/xml",
      tray?.path ?? "",
    ]);
    // The trap the daemon's definition already avoids: without this the icon
    // is simply gone after three days.
    expect(tray?.content).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(tray?.content).toContain("<RestartOnFailure>");
    // And the one a laptop would hit: the defaults refuse to start on battery.
    expect(tray?.content).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
    expect(tray?.encoding).toBe("utf16le");
  });

  test("logs on with the user, in their session and at their privilege", () => {
    const tray = forUser().files.find((file) => file.path.endsWith("wave-tray.xml"))?.content ?? "";
    expect(tray).toContain("<LogonTrigger>");
    expect(tray).toContain("<UserId>robin</UserId>");
    // An icon belongs in a session, and an elevated one could not be clicked
    // by the desktop it sits in; InteractiveToken is also what registers the
    // task without asking for a password.
    expect(tray).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(tray).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(tray).toContain("<Arguments>tray</Arguments>");
    expect(tray).toContain(`<Command>${WIN_BINARY}</Command>`);
  });

  test("goes down before the binary is replaced, like the daemon", () => {
    // It runs the same wave.exe and holds the file open just as firmly.
    expect(forUser().before).toContainEqual(["schtasks.exe", "/end", "/tn", "wave tray"]);
  });

  test("is left out entirely when there is no account to run it as", () => {
    const plan = planInstall({ platform: "win32", binaryPath: WIN_BINARY });
    expect(plan.files.some((file) => file.path.endsWith("wave-tray.xml"))).toBe(false);
    expect(plan.commands.some((command) => command.includes("wave tray"))).toBe(false);
    expect(plan.optional ?? []).toEqual([]);
    expect(plan.notes.join(" ")).toContain("Start it yourself");
  });
});

describe("replacing files", () => {
  test("puts a new binary in place while the old one is running", async () => {
    const { replaceFile } = await import("../src/install.ts");
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = await mkdtemp(join(tmpdir(), "wave-replace-"));
    const target = join(dir, "wave");
    // A script standing in for the installed binary, kept running while we
    // replace it -- overwriting it in place would fail with ETXTBSY.
    await Bun.write(target, "#!/bin/sh\nsleep 5\n");
    const { chmodSync } = await import("node:fs");
    chmodSync(target, 0o755);
    const running = Bun.spawn([target], { stdout: "ignore", stderr: "ignore" });

    const source = join(dir, "new-wave");
    await Bun.write(source, "#!/bin/sh\necho new\n");
    replaceFile(source, target);

    expect(await Bun.file(target).text()).toContain("echo new");
    running.kill();
  });

  test("leaves nothing staged behind", async () => {
    const { replaceFile } = await import("../src/install.ts");
    const { mkdtemp } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = await mkdtemp(join(tmpdir(), "wave-replace-"));
    const source = join(dir, "source");
    await Bun.write(source, "x");
    replaceFile(source, join(dir, "target"));
    expect(existsSync(join(dir, "target.new"))).toBe(false);
  });
});

describe("running it", () => {
  test("refuses without root rather than failing halfway through", async () => {
    const messages: string[] = [];
    const code = await install(
      { platform: "linux" },
      async () => ({ code: 0, output: "" }),
      (message) => messages.push(message),
    );
    // The test suite does not run as root, which is exactly the case to catch.
    expect(code).toBe(1);
    expect(messages.join(" ")).toContain("sudo");
  });

  test("a Windows install whose steps all fail says so and exits non-zero", async () => {
    // The run this reproduces: sc.exe reports on stdout, so a runner reading
    // only stderr saw nothing, the noise filter never matched, and the install
    // still ended with "installed and running" and status 0.
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "wave-install-"));
    const self = join(dir, "new-wave.exe");
    await Bun.write(self, "x");
    // The task definition goes under %PROGRAMDATA%, which on this machine is
    // not set -- without this the plan writes a literal "C:\ProgramData" into
    // the working directory.
    const programData = process.env.PROGRAMDATA;
    process.env.PROGRAMDATA = dir;

    const messages: string[] = [];
    const code = await install(
      { platform: "win32", binaryPath: join(dir, "wave.exe"), selfPath: self },
      async (command) => {
        // The before steps are best effort and must stay silent even here.
        if (command[1] === "down" || command[1] === "/end") return { code: 1, output: "nothing to stop" };
        if (command[1] === "/create") return { code: 1, output: "ERROR: Access is denied." };
        return { code: 0, output: "" };
      },
      (message) => messages.push(message),
    );
    if (programData === undefined) delete process.env.PROGRAMDATA;
    else process.env.PROGRAMDATA = programData;

    const said = messages.join("\n");
    expect(code).toBe(1);
    expect(said).not.toContain("installed and running");
    expect(said).toContain("Access is denied");
    // The before steps failed too, and saying so on a first install is the
    // noise that made the real message impossible to find.
    expect(said).not.toContain("nothing to stop");
  });

  test("carries wireguard-go and wintun.dll to where the daemon looks", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { existsSync } = await import("node:fs");
    const dir = await mkdtemp(join(tmpdir(), "wave-deps-"));

    // An unpacked archive: wave.exe with its two dependencies beside it.
    const source = join(dir, "archive");
    const target = join(dir, "installed");
    await Bun.write(join(source, "new-wave.exe"), "wave");
    await Bun.write(join(source, "wireguard.exe"), "wg");
    await Bun.write(join(source, "wintun.dll"), "dll");

    const programData = process.env.PROGRAMDATA;
    process.env.PROGRAMDATA = dir;
    const messages: string[] = [];
    const code = await install(
      {
        platform: "win32",
        binaryPath: join(target, "wave.exe"),
        selfPath: join(source, "new-wave.exe"),
      },
      async () => ({ code: 0, output: "" }),
      (message) => messages.push(message),
    );
    if (programData === undefined) delete process.env.PROGRAMDATA;
    else process.env.PROGRAMDATA = programData;

    expect(code).toBe(0);
    // The daemon runs as LocalSystem and sees neither PATH nor GOPATH, so
    // beside the binary is the only place these may be.
    expect(existsSync(join(target, "wireguard.exe"))).toBe(true);
    expect(existsSync(join(target, "wintun.dll"))).toBe(true);
    expect(messages.join("\n")).toContain("installed and running");
  });

  test("a missing wintun.dll fails the install rather than being a note", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "wave-deps-"));
    const source = join(dir, "archive");
    await Bun.write(join(source, "new-wave.exe"), "wave");
    await Bun.write(join(source, "wireguard.exe"), "wg");

    const programData = process.env.PROGRAMDATA;
    const wintun = process.env.WAVE_WINTUN_DLL;
    process.env.PROGRAMDATA = dir;
    delete process.env.WAVE_WINTUN_DLL;
    const messages: string[] = [];
    const code = await install(
      {
        platform: "win32",
        binaryPath: join(dir, "installed", "wave.exe"),
        selfPath: join(source, "new-wave.exe"),
      },
      async () => ({ code: 0, output: "" }),
      (message) => messages.push(message),
    );
    if (programData === undefined) delete process.env.PROGRAMDATA;
    else process.env.PROGRAMDATA = programData;
    if (wintun !== undefined) process.env.WAVE_WINTUN_DLL = wintun;

    // Without it wireguard-go starts and then cannot make an adapter, which
    // reads as a network fault -- so it is a failure, not a footnote.
    expect(code).toBe(1);
    expect(messages.join("\n")).toContain("wintun.net");
  });

  test("uninstall refuses without root too", async () => {
    const messages: string[] = [];
    expect(
      await uninstall(
        { platform: "linux" },
        async () => ({ code: 0, output: "" }),
        (m) => messages.push(m),
      ),
    ).toBe(1);
  });
});

describe("the service is installed for the machine, not for a server", () => {
  test("macOS puts no server in the launchd job either", async () => {
    const { planInstall } = await import("../src/install.ts");
    const plan = planInstall({ platform: "darwin" });
    const contents = plan.files.map((file) => file.content).join("");
    expect(contents).not.toContain("WAVE_CONTROL_URL");
    // The socket group has to stay: without it the tray cannot reach the daemon.
    expect(contents).toContain("WAVE_SOCKET_GROUP");
  });
});

describe("who may use the control socket", () => {
  const passwd = `${import.meta.dir}/fixtures-passwd`;
  const groups = `${import.meta.dir}/fixtures-groups`;

  test("prefers the account's own group, which its sessions already have", async () => {
    const { chooseSocketGroup } = await import("../src/install.ts");
    await Bun.write(passwd, "root:x:0:0::/root:/bin/sh\nrobin:x:1000:1000::/home/robin:/bin/sh\n");
    await Bun.write(groups, "root:x:0:\nrobin:x:1000:\nwave:x:1004:robin\n");
    // A group added during install does not apply to sessions already running,
    // which is exactly the session the person is installing from.
    expect(chooseSocketGroup({ user: "robin", platform: "linux" }, passwd, groups)).toBe("robin");
  });

  test("falls back to a dedicated group when the account has no group of its own", async () => {
    const { chooseSocketGroup } = await import("../src/install.ts");
    await Bun.write(passwd, "shared:x:1000:100::/home/shared:/bin/sh\n");
    await Bun.write(groups, "users:x:100:shared\n");
    expect(chooseSocketGroup({ user: "shared", platform: "linux" }, passwd, groups)).toBe("wave");
  });

  test("an explicit choice wins over both", async () => {
    const { chooseSocketGroup } = await import("../src/install.ts");
    expect(chooseSocketGroup({ user: "robin", group: "staff", platform: "darwin" }, passwd, groups)).toBe(
      "staff",
    );
  });

  test("uses admin on macOS, where no account has a group of its own", async () => {
    const { chooseSocketGroup } = await import("../src/install.ts");
    // /etc/passwd holds no real accounts there, so the Linux rule would fall
    // through to a "wave" group that nothing ever creates.
    expect(chooseSocketGroup({ user: "robin", platform: "darwin" }, passwd, groups)).toBe("admin");
  });

  test("tells the macOS daemon which group may use the socket", async () => {
    const { planInstall, DARWIN_DAEMON_PLIST } = await import("../src/install.ts");
    // Without this the socket stays root-only and the tray, which runs in the
    // user's session, reports the daemon as unreachable forever.
    const plan = planInstall({ platform: "darwin", user: "robin", binaryPath: "/usr/local/bin/wave" });
    const daemon = plan.files.find((file) => file.path === DARWIN_DAEMON_PLIST);
    expect(daemon?.content).toContain("<key>WAVE_SOCKET_GROUP</key><string>admin</string>");
  });

  test("creates and joins a group only when it is the dedicated one", async () => {
    const { planInstall } = await import("../src/install.ts");
    const dedicated = planInstall({ platform: "linux", user: "robin", group: "wave", lookup: SBIN });
    expect(dedicated.commands).toContainEqual(["/usr/sbin/groupadd", "-f", "wave"]);

    const own = planInstall({ platform: "linux", user: "robin", group: "robin", lookup: SBIN });
    expect(own.commands.some((command) => command[0]?.endsWith("groupadd"))).toBe(false);
    expect(own.commands.some((command) => command[0]?.endsWith("usermod"))).toBe(false);
  });

  test("names the group in the unit, so the daemon hands the socket to it", async () => {
    const { planInstall, LINUX_SERVICE } = await import("../src/install.ts");
    const plan = planInstall({ platform: "linux", user: "robin", group: "robin" });
    const unit = plan.files.find((file) => file.path === LINUX_SERVICE)?.content ?? "";
    expect(unit).toContain("Environment=WAVE_SOCKET_GROUP=robin");
  });

  test("says which of the two situations the user is in", async () => {
    const { planInstall } = await import("../src/install.ts");
    // A dedicated group is a claim about the machine after the commands ran,
    // so its note is install()'s to make; an existing one is settled here.
    expect(planInstall({ platform: "linux", user: "robin", group: "wave" }).requiresGroup).toBe("wave");
    const own = planInstall({ platform: "linux", user: "robin", group: "robin" });
    expect(own.requiresGroup).toBeUndefined();
    expect(own.notes.join(" ")).toContain("already has");
  });
});

describe("launchctl noise", () => {
  test("the two failures an ordinary install produces are not reported", async () => {
    const { expectedLaunchctlNoise } = await import("../src/install.ts");
    // Nothing to boot out on a first install; still loaded on an upgrade.
    expect(
      expectedLaunchctlNoise(
        ["launchctl", "bootout", "system", "/x.plist"],
        "Boot-out failed: 3: No such process",
      ),
    ).toBe(true);
    expect(
      expectedLaunchctlNoise(
        ["launchctl", "bootstrap", "system", "/x.plist"],
        "Bootstrap failed: 5: Input/output error",
      ),
    ).toBe(true);
  });

  test("anything else launchctl says still gets reported", async () => {
    const { expectedLaunchctlNoise } = await import("../src/install.ts");
    expect(expectedLaunchctlNoise(["launchctl", "bootstrap", "system", "/x.plist"], "Load failed: 37")).toBe(
      false,
    );
    expect(
      expectedLaunchctlNoise(
        ["launchctl", "kickstart", "-k", "system/net.wave.daemon"],
        "Bootstrap failed: 5",
      ),
    ).toBe(false);
    expect(expectedLaunchctlNoise(["systemctl", "enable", "wave"], "Bootstrap failed: 5")).toBe(false);
  });
});

/**
 * A Synology NAS, where `sudo ./wave install` reported four failed steps in a
 * row: no groupadd, no usermod, no runuser, and a chown against a group named
 * after the account -- which there, as on any system that gives everyone the
 * same primary group, does not exist.
 */
describe("a machine without shadow-utils", () => {
  const passwd = `${import.meta.dir}/fixtures-passwd`;
  const groups = `${import.meta.dir}/fixtures-groups`;
  const options = {
    platform: "linux" as const,
    binaryPath: BINARY,
    user: "shared",
    userHome: "/home/shared",
    userId: 1026,
    passwdPath: passwd,
    groupPath: groups,
  };

  test("makes the group with busybox where there is no groupadd", async () => {
    const { planInstall } = await import("../src/install.ts");
    const plan = planInstall({ ...options, lookup: BUSYBOX });
    expect(plan.commands).toContainEqual(["/bin/addgroup", "wave"]);
    expect(plan.commands).toContainEqual(["/bin/addgroup", "shared", "wave"]);
  });

  test("chowns to the account's real group, not to its name", async () => {
    const { planInstall } = await import("../src/install.ts");
    const plan = planInstall({ ...options, lookup: BUSYBOX });
    // "shared:shared" is what used to be written, and chown answered
    // "invalid group" -- the account's group is `users`.
    // chown is left a bare name on purpose: it lives in /bin, which every
    // PATH has -- it is the sbin tools that go missing under sudo.
    expect(plan.optional).toContainEqual(["chown", "-R", "shared:users", "/home/shared/.config/systemd"]);
  });

  test("reaches the user's session through sudo where runuser is missing", async () => {
    const { planInstall } = await import("../src/install.ts");
    const plan = planInstall({ ...options, lookup: BUSYBOX });
    const tray = plan.optional?.filter((command) => command.includes("wave-tray")) ?? [];
    expect(tray[0]?.slice(0, 4)).toEqual(["/bin/sudo", "-u", "shared", "--"]);
    expect(tray[0]).toContain("XDG_RUNTIME_DIR=/run/user/1026");
    // Two verbs rather than `enable --now`: Synology's systemctl does not
    // know the flag, and answered "unrecognized option '--now'".
    expect(tray.map((command) => command[command.length - 2])).toEqual(["enable", "start"]);
    expect(plan.optional?.some((command) => command.includes("--now"))).toBe(false);
  });

  test("attempts nothing where no tool can make a group, but still asks for one", async () => {
    const { planInstall } = await import("../src/install.ts");
    const plan = planInstall({ ...options, lookup: () => null });
    expect(plan.commands.some((command) => command.includes("wave") && command.length === 2)).toBe(false);
    // The requirement outlives the missing tool: install() looks at the
    // database afterwards and says which of the two notes applies.
    expect(plan.requiresGroup).toBe("wave");
    expect(plan.notes.join(" ")).not.toContain("log out and back in");
  });

  test("reaches for synogroup, which is the only one a DiskStation has", async () => {
    const { planInstall } = await import("../src/install.ts");
    const syno = (name: string): string | null => (name === "synogroup" ? "/usr/syno/sbin/synogroup" : null);
    const plan = planInstall({ ...options, lookup: syno });
    expect(plan.commands).toContainEqual(["/usr/syno/sbin/synogroup", "--add", "wave", "shared"]);
    expect(plan.commands).toContainEqual(["/usr/syno/sbin/synogroup", "--member", "wave", "shared"]);
  });

  // What the DSM package's start script asks for: no account behind it (DSM
  // calls it as root, not through sudo) and the binary left where the package
  // put it, so a start does not overwrite what the self-updater has put there.
  test("started from the package, the unit runs the binary where the package put it", async () => {
    const { planInstall } = await import("../src/install.ts");
    const syno = (name: string): string | null => (name === "synogroup" ? "/usr/syno/sbin/synogroup" : null);
    const plan = planInstall({
      platform: "linux",
      binaryPath: "/var/packages/wave/target/wave",
      passwdPath: passwd,
      groupPath: groups,
      lookup: syno,
    });

    expect(plan.files[0]?.content).toContain("ExecStart=/var/packages/wave/target/wave daemon");
    expect(plan.files).toHaveLength(1);
    // The group, with nobody to put in it: whoever should use the socket is added in DSM.
    expect(plan.commands).toContainEqual(["/usr/syno/sbin/synogroup", "--add", "wave"]);
    expect(plan.commands.some((command) => command.includes("--member"))).toBe(false);
    expect(plan.commands).toContainEqual(["systemctl", "enable", "wave"]);
    expect(plan.commands).toContainEqual(["systemctl", "restart", "wave"]);
    expect(plan.optional).toEqual([]);
    expect(plan.requiresGroup).toBe("wave");
  });

  test("prefers shadow-utils where both are there", async () => {
    const { planInstall } = await import("../src/install.ts");
    const plan = planInstall({ ...options, lookup: (name) => `/usr/sbin/${name}` });
    expect(plan.commands).toContainEqual(["/usr/sbin/groupadd", "-f", "wave"]);
    expect(plan.commands.some((command) => command[0]?.endsWith("synogroup"))).toBe(false);
  });

  test("names the account's own group instead of a placeholder", async () => {
    const { groupByHand } = await import("../src/install.ts");
    // `users` is what this account has and not something anyone would guess.
    const message = groupByHand("wave", "users");
    expect(message).toContain("--group users");
    // And what that costs, because on a NAS it tends to be everyone.
    expect(message).toContain("every member of 'users'");
    expect(groupByHand("wave", null)).not.toContain("--group");
  });

  test("still writes the unit and starts the service", async () => {
    // The group is what the tray and the CLI need; the tunnel itself is the
    // daemon's, and it comes up either way.
    const { planInstall } = await import("../src/install.ts");
    const plan = planInstall({ ...options, lookup: () => null });
    expect(plan.files.map((file) => file.path)).toContain(LINUX_SERVICE);
    expect(plan.commands).toContainEqual(["systemctl", "restart", "wave"]);
  });
});

describe("finding the tools", () => {
  test("looks in sbin, which sudo's PATH tends to leave out", async () => {
    const { findTool } = await import("../src/install.ts");
    const present = (path: string): boolean => path === "/usr/sbin/groupadd";
    expect(findTool("groupadd", { PATH: "/usr/local/bin:/usr/bin:/bin" }, present)).toBe(
      "/usr/sbin/groupadd",
    );
    expect(findTool("nosuchtool", { PATH: "/usr/bin" }, present)).toBe(null);
  });

  test("PATH wins, because putting something ahead of the system copy is a choice", async () => {
    const { findTool } = await import("../src/install.ts");
    const present = (): boolean => true;
    expect(findTool("groupadd", { PATH: "/opt/bin" }, present)).toBe("/opt/bin/groupadd");
  });

  test("a second install finding the group already there is not a failure", async () => {
    const { expectedNoise } = await import("../src/install.ts");
    // busybox addgroup has no -f, so it fails where `groupadd -f` would not.
    expect(expectedNoise(["/bin/addgroup", "wave"], "addgroup: group wave already in use")).toBe(true);
    expect(expectedNoise(["/bin/addgroup", "wave"], "addgroup: permission denied")).toBe(false);
  });
});

describe("where the home is", () => {
  test("comes from the passwd database, not from the account's name", async () => {
    const { homeOf } = await import("../src/install.ts");
    expect(homeOf("shared", `${import.meta.dir}/fixtures-passwd`)).toBe("/home/shared");
    expect(homeOf("nobody", `${import.meta.dir}/fixtures-passwd`)).toBe(null);
  });
});
