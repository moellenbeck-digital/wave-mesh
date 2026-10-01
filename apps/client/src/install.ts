import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  findWintun,
  findWireguardGo,
  missingMessage,
  missingWintunMessage,
  WINTUN_DLL,
} from "./wireguard-go.ts";

/**
 * Sets the client up as a service, so one binary and one command are enough.
 *
 * The file contents are built by pure functions: what lands in a system
 * directory should be reviewable and testable without running anything.
 */

export interface InstallPlan {
  /**
   * Commands to run before anything is written.
   *
   * Only Windows needs this, and it needs it badly: a running executable cannot
   * be replaced there, so an upgrade that does not stop the daemon first fails
   * on the binary and leaves the old one in place. Unix has no such rule --
   * renaming over a running file is exactly what {@link replaceFile} relies on.
   *
   * Every step here is best effort and its failure is never reported: on a
   * first install there is nothing to stop, and the binary these steps invoke
   * does not exist yet. Classifying the failures instead is not on the table,
   * because `schtasks` is localised -- on a German Windows its errors are
   * German -- and Bun truncates a Windows exit status to eight bits, so
   * neither the text nor the number is something to match on.
   */
  before?: string[][];
  /**
   * Files to write, in order.
   *
   * `encoding` exists for one file: schtasks has always accepted a UTF-16
   * task definition and only newer Windows takes UTF-8, and "newer" is not
   * something an installer gets to assume.
   */
  files: Array<{ path: string; content: string; mode?: number; encoding?: "utf8" | "utf16le" }>;
  /** Commands to run afterwards. A failure among these fails the install. */
  commands: string[][];
  /**
   * Commands whose failure is worth saying and not worth failing over.
   *
   * The tray is not the tunnel. A NAS has no session to put an icon in, its
   * systemd may be too old for what the unit wants, and there may be no user
   * bus at all -- none of which stops the daemon from carrying traffic. Counted
   * as failures, they made `wave install` end in "wave is not set up" on a
   * machine where the tunnel was up and working, which is the one thing the
   * closing line must not get wrong.
   */
  optional?: string[][];
  /** Shown to the user when there is something left for them to do. */
  notes: string[];
  /**
   * A group the install is supposed to bring into being, checked afterwards.
   *
   * Whether the socket can be reached is decided by the group database and by
   * nothing else -- not by which tool was available, and not by what it
   * returned. Synology's `synogroup` is why this is a check and not a trusted
   * exit status: its spelling is not something to take on faith, and a wrong
   * guess has to leave the person with the same clear instruction as no tool
   * at all rather than with a usage message.
   */
  requiresGroup?: string;
}

/**
 * Where a tool actually is, even when PATH does not say so.
 *
 * `sudo` hands root a PATH assembled for a login shell, and on plenty of
 * systems that PATH has no sbin in it -- while groupadd, usermod and runuser
 * live nowhere else. Spawned by bare name they then fail with "Executable not
 * found in $PATH" on a machine where the file is sitting in /usr/sbin, which
 * reads as "this system cannot do it" when it means "you cannot see it from
 * here". Seen on Synology DSM, where the whole install came apart on it.
 *
 * PATH comes first regardless: an operator who put something ahead of the
 * system copy meant it.
 */
const TOOL_DIRS = [
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
  // Synology keeps its own administration tools here, and PATH says nothing
  // about it even for root: `synogroup` answered "Permission denied" from a
  // user shell, which means it was found and would have run as root.
  "/usr/syno/sbin",
  "/usr/syno/bin",
];

/** Finds the program behind a command name, or says there is none. */
export type Lookup = (name: string) => string | null;

export function findTool(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string | null {
  for (const dir of [...(env.PATH ?? "").split(":").filter(Boolean), ...TOOL_DIRS]) {
    const candidate = join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * The first candidate whose program exists, spelled out with its full path.
 *
 * One job, several tools that can do it: groupadd where shadow-utils is
 * installed, busybox's addgroup where it is not. Choosing here rather than
 * running all of them means a machine that has one of them sees no failure at
 * all, and a machine that has none gets told so in a note instead of a stack
 * of "not found" lines.
 */
export function firstAvailable(candidates: string[][], lookup: Lookup): string[] | null {
  for (const [name, ...rest] of candidates) {
    if (!name) continue;
    const path = lookup(name);
    if (path) return [path, ...rest];
  }
  return null;
}

/** An account's line in the passwd database, split into what we need of it. */
function passwdEntry(user: string, passwd: string): { gid: string; home: string } | null {
  try {
    for (const line of readFileSync(passwd, "utf8").split("\n")) {
      const [name, , , gid, , home] = line.split(":");
      if (name === user && gid) return { gid, home: home ?? "" };
    }
  } catch {
    // No database to read; every caller has a fallback.
  }
  return null;
}

/**
 * Where the account's home really is.
 *
 * /home/<name> is the common arrangement and not the rule: a NAS puts them on
 * a volume, macOS in /Users, older Unixes in /export/home. Guessing writes the
 * tray unit into a directory that looks like a home and is not one -- it gets
 * created, nothing complains, and `systemctl --user` never finds the unit.
 */
export function homeOf(user: string, passwd = "/etc/passwd"): string | null {
  const home = passwdEntry(user, passwd)?.home;
  return home ? home : null;
}

/** Whether a group is in the database, which is what decides the socket. */
export function groupExists(name: string, group = "/etc/group"): boolean {
  try {
    for (const entry of readFileSync(group, "utf8").split("\n")) {
      if (entry.split(":")[0] === name) return true;
    }
  } catch {
    // Unreadable is as good as absent: the daemon reads the same file.
  }
  return false;
}

/** The account's own group, from the passwd and group databases. */
export function primaryGroupOf(user: string, passwd = "/etc/passwd", group = "/etc/group"): string | null {
  const gid = passwdEntry(user, passwd)?.gid;
  if (!gid) return null;
  try {
    for (const entry of readFileSync(group, "utf8").split("\n")) {
      const [groupName, , groupId] = entry.split(":");
      if (groupId === gid && groupName) return groupName;
    }
  } catch {
    // No databases to read: the caller falls back to a dedicated group.
  }
  // Nameless but real: chown takes a number just as happily as a name, and on
  // a system whose groups come from a directory service that is all there is.
  return gid;
}

/**
 * Which group may use the control socket.
 *
 * A dedicated "wave" group is the tidy answer for a shared machine, but it has
 * a sharp edge: a group added during install does not apply to sessions that
 * are already running, so the person who just installed it cannot use their own
 * tunnel until they log out and back in. Where the account has a group of its
 * own -- the usual arrangement on Linux and macOS -- that group is already
 * active, belongs to exactly that person, and needs no such detour.
 */
export function chooseSocketGroup(
  options: { group?: string; user?: string; platform?: NodeJS.Platform },
  passwd?: string,
  groups?: string,
): string {
  if (options.group) return options.group;
  // macOS keeps its accounts in Directory Services, so /etc/passwd knows
  // nothing about them and there is no group named after the user to find.
  // What every account that can run this install does have is "admin" -- it
  // is what sudo just asked for, and it is already active in this session.
  if (options.platform === "darwin") return "admin";
  if (!options.user) return "wave";
  const own = primaryGroupOf(options.user, passwd, groups);
  return own === options.user ? own : "wave";
}

export interface InstallOptions {
  /** Where the binary should live once installed. */
  binaryPath?: string;
  /** The human's account, so the tray can run in their session. */
  user?: string;
  userHome?: string;
  userId?: number;
  platform?: NodeJS.Platform;
  /** Group allowed to use the control socket; chosen automatically otherwise. */
  group?: string;
  /** Where the account databases are; overridden by the tests. */
  passwdPath?: string;
  groupPath?: string;
  /** How a command name is turned into a program; overridden by the tests. */
  lookup?: Lookup;
}

export const LINUX_SERVICE = "/etc/systemd/system/wave.service";
export const LINUX_ENV = "/etc/wave/wave.env";
export const DARWIN_DAEMON_PLIST = "/Library/LaunchDaemons/net.wave.daemon.plist";
export const DARWIN_TRAY_PLIST = "/Library/LaunchAgents/net.wave.tray.plist";
/**
 * The scheduled task that carries the daemon, and the file describing it.
 *
 * A task and not a service, for a measured reason: a Windows service has to
 * call StartServiceCtrlDispatcher and hold ServiceMain on the SCM's thread
 * until it stops, and Bun's FFI cannot hold a thread that way -- a JSCallback
 * called from a foreign thread returns to it at once when it is threadsafe and
 * never runs at all when it is not. `sc create` on wave.exe therefore always
 * ended in 1053, "did not respond to the start or control request in a timely
 * fashion". A task run as S-1-5-18 gives the one thing that actually matters
 * here, a daemon running as LocalSystem, which is what wireguard-go's UAPI
 * pipe demands.
 */
export const WINDOWS_DAEMON_TASK = "wave daemon";
export const windowsTaskDefinition = (env: NodeJS.ProcessEnv = process.env): string =>
  join(env.PROGRAMDATA ?? "C:\\ProgramData", "wave", "wave-daemon.xml");
/** The scheduled task that starts the tray in the user's session. */
export const WINDOWS_TRAY_TASK = "wave tray";
export const windowsTrayTaskDefinition = (env: NodeJS.ProcessEnv = process.env): string =>
  join(env.PROGRAMDATA ?? "C:\\ProgramData", "wave", "wave-tray.xml");

/**
 * The task definition. Written as a file rather than assembled from schtasks
 * flags because two of these settings have no flag: restarting after a crash,
 * and running without a time limit -- and a daemon that Task Scheduler stops
 * after three days is worse than no daemon, because it looks like a network
 * fault.
 *
 * PT1M is the floor Task Scheduler enforces on a restart interval; the systemd
 * unit restarts after two seconds and `sc failure` could too, so this is the
 * one place where the task is genuinely worse than a service.
 */
const xmlText = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The frame both tasks share, so that neither can quietly drift from the other.
 *
 * The settings below are the reason these are files and not schtasks flags at
 * all: `RestartOnFailure` and `ExecutionTimeLimit` have none, and both matter
 * to both tasks. Without the time limit Task Scheduler stops the job after
 * three days -- for the daemon a failure that reads as a network fault, for the
 * tray an icon that is simply gone one morning. The battery settings are here
 * for the same kind of reason: their defaults keep a task from starting on
 * battery, which on a laptop is most of the time.
 */
function windowsTask(parts: {
  description: string;
  triggers: string;
  principal: string;
  binary: string;
  args: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<!-- Written by \`wave install\`. -->
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${parts.description}</Description>
  </RegistrationInfo>
  <Triggers>
${parts.triggers}
  </Triggers>
  <Principals>
    <Principal id="Author">
${parts.principal}
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlText(parts.binary)}</Command>
      <Arguments>${parts.args}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

export function windowsTaskXml(binary: string): string {
  return windowsTask({
    description: "wave-mesh tunnel daemon",
    triggers: `    <BootTrigger>
      <Enabled>true</Enabled>
    </BootTrigger>`,
    principal: `      <UserId>S-1-5-18</UserId>
      <RunLevel>HighestAvailable</RunLevel>`,
    binary,
    args: "daemon",
  });
}

/**
 * The tray is the user's, not the machine's.
 *
 * So it logs on with them rather than booting with the machine, and it runs
 * with an interactive token at their own privilege level: an icon belongs in a
 * session, and an elevated one could not be clicked by the desktop it sits in.
 * `InteractiveToken` is also what lets the task be registered without their
 * password -- the same trade `/it` makes on the command line, except that a
 * file can carry the two settings a flag cannot.
 */
export function windowsTrayTaskXml(binary: string, user: string): string {
  return windowsTask({
    description: "wave-mesh tray icon",
    triggers: `    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlText(user)}</UserId>
    </LogonTrigger>`,
    principal: `      <UserId>${xmlText(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>`,
    binary,
    args: "tray",
  });
}

export function systemdService(binary: string, group = "wave"): string {
  return `# Written by \`wave install\`.
[Unit]
Description=wave-mesh tunnel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=-${LINUX_ENV}
Environment=WAVE_SOCKET_GROUP=${group}
ExecStart=${binary} daemon
Restart=always
RestartSec=2
RuntimeDirectory=wave
StateDirectory=wave

[Install]
WantedBy=multi-user.target
`;
}

export function systemdTrayService(binary: string): string {
  return `# Written by \`wave install\`. Runs in the desktop session, unprivileged.
[Unit]
Description=wave-mesh tray icon
PartOf=graphical-session.target
After=graphical-session.target

[Service]
Type=simple
ExecStart=${binary} tray
Restart=on-failure
RestartSec=3

[Install]
WantedBy=graphical-session.target
`;
}

const plist = (label: string, args: string[], extra: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${arg}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
${extra}</dict>
</plist>
`;

export function launchdDaemon(binary: string, group = "admin"): string {
  // Without WAVE_SOCKET_GROUP the daemon leaves the socket root-only, and the
  // tray -- which runs in the user's session, not as root -- could never read it.
  const variables = `<key>WAVE_SOCKET_GROUP</key><string>${group}</string>`;
  return plist(
    "net.wave.daemon",
    [binary, "daemon"],
    `  <key>EnvironmentVariables</key>\n  <dict>${variables}</dict>\n`,
  );
}

export const launchdTray = (binary: string): string => plist("net.wave.tray", [binary, "tray"], "");

/**
 * What to say when no tool on this machine can make a group.
 *
 * Naming the way out matters more than naming the lack: without the group the
 * socket stays root-only, and the person is left with `sudo wave status` and
 * no idea why. Reinstalling against a group they already have is the fix that
 * needs nothing installed.
 */
export function groupByHand(name: string, own: string | null): string {
  // The account's own group by name rather than "<name>": on the machine this
  // was written for it is `users`, which is not something anyone guesses, and
  // an instruction with a placeholder in it is one more thing to look up. The
  // cost is said out loud, because on a NAS that group tends to be everyone.
  const fallback = own
    ? `, or hand the socket to a group you already have: sudo wave install --group ${own} ` +
      `(which lets every member of '${own}' use it)`
    : "";
  return (
    `The '${name}' group does not exist, so only root can use the control socket. ` +
    `Create it and put your account in it${fallback}.`
  );
}

/** Everything the install would do, without doing any of it. */
export function planInstall(options: InstallOptions = {}): InstallPlan {
  const platform = options.platform ?? process.platform;
  const binary = options.binaryPath ?? defaultBinaryPath(platform);
  const user = options.user;
  const passwd = options.passwdPath ?? "/etc/passwd";
  const groups = options.groupPath ?? "/etc/group";
  const lookup = options.lookup ?? ((name: string) => findTool(name));
  const group = chooseSocketGroup({ group: options.group, user, platform }, passwd, groups);
  // Only a dedicated group has to be created and joined; an account's own
  // group already exists and is already active in its sessions.
  const dedicated = group === "wave";

  if (platform === "linux") {
    const files: InstallPlan["files"] = [
      { path: LINUX_SERVICE, content: systemdService(binary, group), mode: 0o644 },
    ];

    const commands: string[][] = [];
    const optional: string[][] = [];
    const notes: string[] = [];

    // Two tools for each of these jobs, because not every Linux has
    // shadow-utils: busybox calls both of them addgroup, and a NAS or a
    // container image may carry nothing else. Where neither is present the
    // plan says so rather than running a command that cannot work.
    if (dedicated) {
      // synogroup takes its members along with the group, so there the second
      // command confirms the membership rather than being the other half of
      // the job. It lives in /usr/syno/sbin, which is why TOOL_DIRS names it.
      const create = firstAvailable(
        [
          ["groupadd", "-f", "wave"],
          ["addgroup", "wave"],
          user ? ["synogroup", "--add", "wave", user] : ["synogroup", "--add", "wave"],
        ],
        lookup,
      );
      if (create) commands.push(create);
      const member = user
        ? firstAvailable(
            [
              ["usermod", "-aG", "wave", user],
              ["addgroup", user, "wave"],
              ["synogroup", "--member", "wave", user],
            ],
            lookup,
          )
        : null;
      if (member) commands.push(member);
    }

    commands.push(
      ["systemctl", "daemon-reload"],
      ["systemctl", "enable", "wave"],
      // restart rather than start: an upgrade has to pick up the new binary.
      ["systemctl", "restart", "wave"],
    );

    if (user && options.userHome) {
      files.push({
        path: join(options.userHome, ".config/systemd/user/wave-tray.service"),
        content: systemdTrayService(binary),
        mode: 0o644,
      });
      // The account's real group, not its name. They match on most desktop
      // Linuxes and on few of the others -- where they do not, `chown
      // user:user` fails with "invalid group" and the unit stays root's,
      // which is a file the user's own systemd cannot manage.
      const owner = `${user}:${primaryGroupOf(user, passwd, groups) ?? user}`;
      optional.push(["chown", "-R", owner, join(options.userHome, ".config/systemd")]);
      if (options.userId !== undefined) {
        // `enable --now` in one go is a newer systemd's convenience, and not
        // every system has one: Synology's answered "unrecognized option
        // '--now'". Two verbs say the same thing to every version there is.
        const session = (verb: string): string[] => [
          "env",
          `XDG_RUNTIME_DIR=/run/user/${options.userId}`,
          "systemctl",
          "--user",
          verb,
          "wave-tray",
        ];
        // runuser is util-linux and missing from some systems; sudo got us
        // here, so it is the one thing we know exists.
        const asUser = (argv: string[]): string[] | null =>
          firstAvailable(
            [
              ["runuser", "-u", user, "--", ...argv],
              ["sudo", "-u", user, "--", ...argv],
            ],
            lookup,
          );
        const enable = asUser(session("enable"));
        const start = asUser(session("start"));
        if (enable && start) optional.push(enable, start);
        else
          notes.push(
            `Nothing here can run a command as ${user}; start the tray yourself: systemctl --user enable wave-tray && systemctl --user start wave-tray`,
          );
      }
    }
    // Only promise the logging-out cure where the group is actually being
    // made: told to log out and back in over a group that does not exist,
    // someone spends the evening on their session instead of on the note
    // above that says what really went wrong.
    if (!dedicated) {
      notes.push(`The control socket belongs to group '${group}', which this account already has.`);
    }
    // Which note the dedicated group gets -- "log out and back in" or "make it
    // yourself" -- is not knowable here: it depends on whether the commands
    // above actually produced it. install() looks and then says.
    return { files, commands, optional, notes, ...(dedicated ? { requiresGroup: "wave" } : {}) };
  }

  if (platform === "darwin") {
    return {
      files: [
        { path: DARWIN_DAEMON_PLIST, content: launchdDaemon(binary, group), mode: 0o644 },
        { path: DARWIN_TRAY_PLIST, content: launchdTray(binary), mode: 0o644 },
      ],
      // launchd keeps the job definition it loaded, so bootstrapping over a
      // running service does nothing and kickstart only restarts the process
      // with the definition already in memory -- a new binary is picked up,
      // a changed plist is not. Booting the job out first is what makes an
      // upgrade actually apply.
      commands: [
        ["launchctl", "bootout", "system", DARWIN_DAEMON_PLIST],
        ["launchctl", "bootstrap", "system", DARWIN_DAEMON_PLIST],
        ["launchctl", "kickstart", "-k", "system/net.wave.daemon"],
        ...(options.userId !== undefined
          ? [
              ["launchctl", "bootout", `gui/${options.userId}`, DARWIN_TRAY_PLIST],
              ["launchctl", "bootstrap", `gui/${options.userId}`, DARWIN_TRAY_PLIST],
              ["launchctl", "kickstart", "-k", `gui/${options.userId}/net.wave.tray`],
            ]
          : []),
      ],
      notes:
        options.userId === undefined
          ? [
              "The tray agent is installed but not loaded: as the user who should see the icon, run " +
                `\`launchctl bootstrap gui/$(id -u) ${DARWIN_TRAY_PLIST}\`.`,
            ]
          : [],
    };
  }

  if (platform === "win32") {
    const definition = windowsTaskDefinition();
    const trayDefinition = windowsTrayTaskDefinition();
    return {
      // Two steps, and the order is the point. `wave down` asks the running
      // daemon to take the waves apart -- routes, and above all the NRPT
      // rules, which are registry entries and would otherwise survive the
      // process and keep pointing a namespace at a resolver that is gone.
      // Only then is the task ended, which is a hard kill and has to be: a
      // running .exe cannot be replaced, and the daemon is that .exe.
      before: [
        [binary, "down"],
        ["schtasks.exe", "/end", "/tn", WINDOWS_DAEMON_TASK],
        // The tray runs the same wave.exe, so it holds the file open just as
        // firmly as the daemon does. It goes down with everything else and
        // comes back with everything else.
        ["schtasks.exe", "/end", "/tn", WINDOWS_TRAY_TASK],
      ],
      files: [
        { path: definition, content: windowsTaskXml(binary), encoding: "utf16le" as const },
        ...(user
          ? [
              {
                path: trayDefinition,
                content: windowsTrayTaskXml(binary, user),
                encoding: "utf16le" as const,
              },
            ]
          : []),
      ],
      commands: [
        // /f replaces an existing definition, so the same plan is a first
        // install and an upgrade without asking which one this is.
        ["schtasks.exe", "/create", "/f", "/tn", WINDOWS_DAEMON_TASK, "/xml", definition],
        ["schtasks.exe", "/run", "/tn", WINDOWS_DAEMON_TASK],
        // From a file for the same reasons the daemon's is: a tray that Task
        // Scheduler stops after three days is an icon that vanishes overnight,
        // and a crash should bring it back.
        ...(user
          ? [["schtasks.exe", "/create", "/f", "/tn", WINDOWS_TRAY_TASK, "/xml", trayDefinition]]
          : []),
      ],
      // Started now rather than at the next sign-in, which is what launchd and
      // systemd do on the other two platforms -- the icon should be there when
      // the install says it is done. It is optional because it is the one step
      // that needs a session: run from an elevated prompt belonging to another
      // account, or over a locked machine, `/run` fails, and a tray that did
      // not start is not a tunnel that failed.
      optional: user ? [["schtasks.exe", "/run", "/tn", WINDOWS_TRAY_TASK]] : [],
      notes: [
        "Run this from an elevated prompt: creating the task and a tunnel adapter both need Administrator.",
        // Said plainly because the failure it prevents reads as a network
        // fault: without LocalSystem, wireguard-go cannot own its UAPI pipe.
        'The daemon runs as a scheduled task under LocalSystem, not as a service — `schtasks /query /tn "wave daemon"` is where to look, not services.msc.',
        // Not an instruction any more: wireguard-go and wintun.dll are copied
        // beside the binary by the install itself, and their absence is
        // reported there. This only says where they ended up.
        "wireguard-go and wintun.dll are installed beside wave.exe; the daemon looks there and nowhere else.",
        user
          ? `The tray icon runs as ${user}: started now, and again at every sign-in. If no icon appeared, this prompt belongs to another account — start it there with: wave tray`
          : "No account to run the tray icon as, so none was set up. Start it yourself with: wave tray",
      ],
    };
  }

  return {
    files: [],
    commands: [],
    notes: [`wave install does not support ${platform} yet. Run \`wave daemon\` by hand for now.`],
  };
}

/**
 * Puts a file in place even when the old one is running.
 *
 * Writing over a running executable fails with ETXTBSY -- which is exactly the
 * case when upgrading, because the service is that executable. Renaming over it
 * replaces the directory entry and leaves the running process on its old inode
 * until it restarts.
 */
export function replaceFile(source: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const staged = `${target}.new`;
  copyFileSync(source, staged);
  chmodSync(staged, 0o755);
  renameSync(staged, target);
}

export const defaultBinaryPath = (platform: NodeJS.Platform = process.platform): string =>
  platform === "win32" ? "C:\\Program Files\\wave\\wave.exe" : "/usr/local/bin/wave";

/**
 * What a step said, and how it ended.
 *
 * Both streams are one field on purpose: `launchctl` reports on stderr, while
 * `sc.exe` and `schtasks.exe` report on stdout -- so a runner that reads only
 * stderr sees nothing at all from either. That is how a plan that was working
 * got reported as three failures with no message, against a filter that could
 * only ever have tested a string that is always empty.
 *
 * The code is worth less than the text here: Bun truncates a Windows exit
 * status to eight bits, so sc's 1053 arrived as 29 and its 1073 as 49. The
 * number in "[SC] StartService FAILED 1053" is the one that survives.
 */
export type Runner = (command: string[]) => Promise<{ code: number; output: string }>;

const spawnRunner: Runner = async (command) => {
  try {
    const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, output: `${stdout}${stderr}` };
  } catch (error) {
    // Not an exit status at all: the executable is missing, which is the
    // normal case for a first install's `before` steps.
    return { code: 127, output: String(error) };
  }
};

/**
 * Two launchctl failures are the normal course of an install and not worth
 * reporting: booting out a service that was never loaded (a first install),
 * and bootstrapping one that still is (which the bootout before it should
 * have prevented, but does no harm either way).
 */
export function expectedLaunchctlNoise(command: string[], output: string): boolean {
  if (command[0] !== "launchctl") return false;
  if (command[1] === "bootout") return /Boot-out failed: 3\b|No such process/.test(output);
  if (command[1] === "bootstrap") return /Bootstrap failed: 5\b/.test(output);
  return false;
}

/**
 * A second install finding the group already there.
 *
 * `groupadd -f` is spared this -- the flag means "and do not mind if it
 * exists" -- but busybox's addgroup has no such flag and fails outright. The
 * program is matched by its base name because the plan carries full paths.
 */
export function expectedAddgroupNoise(command: string[], output: string): boolean {
  const program = command[0];
  if (!program || basename(program) !== "addgroup") return false;
  return /already (in use|exists)/i.test(output);
}

/** "This failure was the plan working." */
export const expectedNoise = (command: string[], output: string): boolean =>
  expectedLaunchctlNoise(command, output) || expectedAddgroupNoise(command, output);

/** Carries out {@link planInstall}. Must run with administrative rights. */
export async function install(
  options: InstallOptions & { selfPath?: string } = {},
  run: Runner = spawnRunner,
  log: (message: string) => void = console.log,
): Promise<number> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" && process.getuid?.() !== 0) {
    log("wave install needs to run as root: sudo wave install");
    return 1;
  }

  const binary = options.binaryPath ?? defaultBinaryPath(platform);
  const self = options.selfPath ?? process.execPath;
  const plan = planInstall({ ...options, binaryPath: binary });

  if (plan.files.length === 0 && plan.commands.length === 0) {
    for (const note of plan.notes) log(note);
    return 1;
  }

  // Windows cannot overwrite a running executable, and the service is that
  // executable -- so it has to stop before anything is written, not after.
  // Counted rather than merely logged: an install where every step failed used
  // to end with "wave is installed and running" and an exit status of 0, which
  // is the one thing a caller must not be told wrongly.
  let failed = 0;
  const step = async (command: string[], fatal = true): Promise<void> => {
    const result = await run(command);
    if (result.code === 0 || expectedNoise(command, result.output)) return;
    if (fatal) failed++;
    log(`${command.join(" ")} failed: ${result.output.trim() || result.code}`);
  };

  // Best effort, and silent: see InstallPlan.before for why nothing here can
  // be told apart from the normal course of a first install.
  for (const command of plan.before ?? []) await run(command);

  /**
   * Everything the tunnel needs travels with the binary, always.
   *
   * The daemon runs as root or LocalSystem and sees neither the user's GOPATH
   * nor their PATH, so a dependency left where they installed it is one the
   * daemon cannot find. Copying it here is not a convenience -- it is the only
   * place the runtime will look.
   */
  const installDir = dirname(binary);
  const selfDir = dirname(self);

  const place = (source: string | null, name: string, missing: () => string): void => {
    const target = join(installDir, name);
    if (!source) {
      // Counted: an install that cannot produce a working tunnel is not an
      // install that succeeded, whatever else went right.
      failed++;
      log(missing());
      return;
    }
    if (source === target) {
      log(`${target} is already in place.`);
      return;
    }
    replaceFile(source, target);
    log(`installed ${target} (from ${source})`);
  };

  const wireguard = findWireguardGo({ platform, selfDir });
  place(wireguard, platform === "win32" ? "wireguard.exe" : "wireguard-go", () =>
    missingMessage(process.env, platform),
  );

  // Without it wireguard-go starts, reports a device, and then fails to make
  // an adapter -- a failure that reads as a network fault and is a missing file.
  if (platform === "win32") {
    place(findWintun({ selfDir, beside: wireguard }), WINTUN_DLL, () =>
      missingWintunMessage(process.env, selfDir),
    );
  }

  if (self !== binary) {
    replaceFile(self, binary);
    log(`installed ${binary}`);
  } else {
    // Running `wave install` from the installed copy reinstalls that copy --
    // units, service, tray, all of it -- but cannot upgrade the binary, since
    // it is the binary. Saying so beats a silent no-op that looks like an
    // upgrade: the service restarts, and the old version comes back up.
    log(`${binary} is the copy running right now, so it stays as it is.`);
    log("To upgrade, run the new build instead:  sudo ./dist/wave install");
  }

  for (const file of plan.files) {
    mkdirSync(dirname(file.path), { recursive: true });
    // A UTF-16 file gets its BOM: schtasks reads the mark, not the extension,
    // and without it the definition is parsed as if it were bytes.
    const content =
      file.encoding === "utf16le"
        ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(file.content, "utf16le")])
        : Buffer.from(file.content, "utf8");
    writeFileSync(file.path, content, { mode: file.mode ?? 0o644 });
    log(`wrote ${file.path}`);
  }

  // A step that fails is worth saying out loud, but the rest still runs:
  // adding a group member can fail while the service starts perfectly well.
  for (const command of plan.commands) await step(command);
  // Said, not counted: see InstallPlan.optional.
  for (const command of plan.optional ?? []) await step(command, false);

  for (const note of plan.notes) log(note);
  // Asked of the database, not of the commands: a tool that is missing and a
  // tool whose arguments we guessed wrong leave exactly the same machine
  // behind, and the person needs the same sentence either way.
  if (plan.requiresGroup) {
    if (groupExists(plan.requiresGroup, options.groupPath)) {
      log(
        `The '${plan.requiresGroup}' group applies only to sessions started after this one, so log out and back in — until then: sudo wave status`,
      );
    } else {
      log(
        groupByHand(
          plan.requiresGroup,
          options.user ? primaryGroupOf(options.user, options.passwdPath, options.groupPath) : null,
        ),
      );
    }
  }
  if (failed > 0) {
    log(`${failed} step${failed === 1 ? "" : "s"} above failed; wave is not set up. The messages say why.`);
    return 1;
  }
  log("wave is installed and running. Try: wave status");
  return 0;
}

/** Removes what {@link install} put in place. */
export async function uninstall(
  options: InstallOptions = {},
  run: Runner = spawnRunner,
  log: (message: string) => void = console.log,
): Promise<number> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" && process.getuid?.() !== 0) {
    log("wave uninstall needs to run as root: sudo wave uninstall");
    return 1;
  }

  if (platform === "linux") {
    // Two verbs, for the same reason as in the plan: `--now` is not a thing
    // every systemd knows, and stopping is the half that actually matters.
    await run(["systemctl", "stop", "wave"]);
    await run(["systemctl", "disable", "wave"]);
  } else if (platform === "darwin") {
    await run(["launchctl", "bootout", "system", DARWIN_DAEMON_PLIST]);
  } else if (platform === "win32") {
    // Down before end, for the same reason as in the install plan: ending the
    // task kills the daemon where it stands, and the NRPT rules it wrote are
    // registry entries that would outlive it.
    await run([options.binaryPath ?? defaultBinaryPath(platform), "down"]);
    await run(["schtasks.exe", "/end", "/tn", WINDOWS_DAEMON_TASK]);
    await run(["schtasks.exe", "/delete", "/f", "/tn", WINDOWS_DAEMON_TASK]);
    await run(["schtasks.exe", "/delete", "/f", "/tn", WINDOWS_TRAY_TASK]);
  }

  for (const file of planInstall(options).files) {
    if (!existsSync(file.path)) continue;
    rmSync(file.path, { force: true });
    log(`removed ${file.path}`);
  }
  if (platform === "linux") await run(["systemctl", "daemon-reload"]);
  // The binary and the keys stay: removing a service should not throw away an
  // enrolment the user may still want.
  log("service removed. The binary and this device's keys are untouched.");
  return 0;
}
