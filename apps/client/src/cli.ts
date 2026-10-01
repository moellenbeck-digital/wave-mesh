#!/usr/bin/env bun
import { parseArgs } from "node:util";
import {
  type CertificateStatus,
  type CertWaiting,
  DAEMON_CLOSED,
  DaemonClient,
  DEFAULT_SOCKET_PATH,
  PLATFORM,
  profileStatusFromSnapshot,
  type Status,
  type UpdateStatus,
  VERSION,
  waveLabel,
} from "@wave/ipc";
import { UpdateChannel } from "@wave/proto";
import { ControlClient } from "./api.ts";
import { DEFAULT_MTU, resolveInterfaceName, up } from "./engine.ts";
import { platformLink } from "./link-platform.ts";
import { paint, renderStatus, shouldWatch } from "./render.ts";
import {
  defaultStatePath,
  describeAmbiguity,
  loadProfiles,
  matchProfiles,
  normaliseControlUrl,
  type Profile,
  removeProfile,
} from "./state.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    control: { type: "string" },
    state: { type: "string", default: process.env.WAVE_STATE ?? defaultStatePath() },
    socket: { type: "string" },
    daemon: { type: "string", default: process.env.WAVE_SOCKET ?? DEFAULT_SOCKET_PATH },
    interface: { type: "string" },
    port: { type: "string" },
    mtu: { type: "string", default: String(DEFAULT_MTU) },
    stun: { type: "string", default: process.env.WAVE_STUN ?? "" },
    "no-dns": { type: "boolean", default: false },
    "no-daemon": { type: "boolean", default: false },
    once: { type: "boolean", default: false },
    group: { type: "string" },
    hook: { type: "string" },
    "auth-key": { type: "string", default: process.env.WAVE_AUTH_KEY ?? "" },
    wildcard: { type: "boolean", default: false },
    channel: { type: "string" },
    "auto-update": { type: "string" },
    "wg-socket": { type: "string" },
    help: { type: "boolean", default: false },
  },
});

const command = positionals[0] ?? "help";

// Until the tunnel is up, messages go straight to the terminal -- that is how
// the connect link gets seen. Afterwards the live view owns the screen and
// keeps the last few messages in a corner of it.
const events: string[] = [];
let live = false;
const log = (message: string) => {
  if (!live) {
    console.log(message);
    return;
  }
  for (const line of message.split("\n")) if (line.trim()) events.push(line);
  while (events.length > 5) events.shift();
};

/** "host:port,host:port" -- hostnames must already be resolved to addresses. */
function parseStunServers(value: string): { ip: string; port: number }[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const index = entry.lastIndexOf(":");
      return { ip: entry.slice(0, index), port: Number(entry.slice(index + 1)) };
    });
}

const usage = `wave — mesh VPN client

  wave install    set everything up: service, tray, autostart  (needs root)
  wave uninstall  remove the service again                     (needs root)

  wave login <url>   join the wave run by that control server
                     (--auth-key <key> for a machine with no browser)
  wave profiles      list the waves this device belongs to
  wave up    [url]   connect and show the tunnels (all of them by default)
  wave down  [url]   tear them down (keeps the enrolment)
  wave status        watch the tunnels and their peers until Ctrl-C
  wave logout <url>  leave one wave and forget its keys

  wave cert  [name…] get a TLS certificate for this device and keep it renewed
  wave certs         list the certificates this device holds

  wave version    which build this is, and the service's update state
  wave update     install the newest release on offer now, instead of later
                  (--channel <name|server>, --auto-update on|off change settings)

  wave daemon     run the privileged part in the foreground
  wave tray       run the tray icon in the foreground

"wave install" sets up the machine and knows no server; joining one is always
"wave login <url>", and a device may join as many as it likes. A wave is always
named by its control server -- there is no profile name to remember, and a
command without one means every wave at once. After the install the everyday
commands need no privileges. Without the service they do the work themselves
and have to run as root.

Options:
  --control <url>   the server for "wave login", if not given as an argument
  --state <path>    state file (default: ${defaultStatePath()})
  --daemon <path>   daemon control socket (default: ${DEFAULT_SOCKET_PATH})
  --no-daemon       do the work here even if a daemon is running
  --once            print one status instead of watching (implied off a tty)
  --socket <path>   WireGuard UAPI socket
  --interface <n>   tunnel interface name (default: wave0)
  --port <n>        WireGuard listen port (default: 41641)
  --mtu <bytes>     tunnel MTU (default: ${DEFAULT_MTU})
  --stun <list>     comma-separated STUN servers, e.g. relay.example:3478
  --no-dns          do not serve the wave's names or touch resolver settings
  --group <name>    group allowed to use the control socket (install)
  --auth-key <key>  enrol without a browser, e.g. in a cluster (WAVE_AUTH_KEY)
  --hook <cmd>      run this after every renewal, e.g. 'systemctl reload caddy'
  --wildcard        ask for *.<wave domain> (an operator has to allow it first)
  --control <url>   also picks the wave for "wave cert" on a multi-wave device
  --channel <name>  update channel to ask for: stable, insiders, develop, or
                    "server" to take each server's default (update, install)
  --auto-update on|off  whether the service installs updates by itself
`;

/**
 * Reads --channel and --auto-update. Undefined means "not given"; a channel of
 * null hands the choice back to the servers.
 */
function updateFlags(): { channel?: UpdateChannel | null; autoUpdate?: boolean } | string {
  const flags: { channel?: UpdateChannel | null; autoUpdate?: boolean } = {};
  if (values.channel !== undefined) {
    if (values.channel === "server") flags.channel = null;
    else {
      const parsed = UpdateChannel.safeParse(values.channel);
      if (!parsed.success) return `--channel takes ${UpdateChannel.options.join(", ")} or server`;
      flags.channel = parsed.data;
    }
  }
  const auto = values["auto-update"];
  if (auto !== undefined) {
    if (auto !== "on" && auto !== "off") return "--auto-update takes on or off";
    flags.autoUpdate = auto === "on";
  }
  return flags;
}

/** The update state as a few lines, for `wave version` and `wave update`. */
function describeUpdate(update: UpdateStatus): string[] {
  const lines: string[] = [];
  lines.push(
    `auto-update ${update.autoUpdate ? "on" : "off"}, channel ${update.wish ?? "as the servers say"}`,
  );
  for (const entry of update.channels) {
    lines.push(`  ${waveLabel(entry.controlUrl)}: ${entry.channel} (offers ${entry.offered.join(", ")})`);
  }
  if (update.available) {
    const when =
      update.state === "scheduled" && update.scheduledAt
        ? `, installing at ${update.scheduledAt}`
        : update.state === "installing"
          ? ", installing now"
          : "; `wave update` installs it now";
    lines.push(`update to ${update.available} available${when}`);
  } else {
    lines.push("up to date with what the servers offer");
  }
  if (update.message) lines.push(update.message);
  return lines;
}

/** Watching changes nothing, so Ctrl-C must not promise that it does. */
const WATCH_HINT = "Ctrl-C to stop watching; the tunnels keep running.";

/** Resolves on Ctrl-C, which is how every live view here ends. */
function untilInterrupted(): Promise<void> {
  return new Promise((resolve) => {
    const stop = () => resolve();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

const isLive = (): boolean => shouldWatch({ once: values.once, isTty: Boolean(process.stdout.isTTY) });

/**
 * Paints the daemon's status stream, on a connection of its own.
 *
 * Its own, because a connection cannot both stream and answer: the client
 * hands every incoming message to the watcher *and* to the oldest pending
 * request (packages/ipc/src/client.ts), so on a watching connection the next
 * pushed status is taken for the answer to whatever was asked. That is how a
 * refusal from `up` never reached anyone.
 *
 * Returns null when the second connection cannot be had -- the command still
 * works then, it just shows nothing until it is done.
 */
async function openStatusStream(onStatus?: (status: Status) => void): Promise<DaemonClient | null> {
  const attempt = await DaemonClient.open(values.daemon);
  if (!attempt.ok) return null;
  await attempt.client.watch((status: Status) => {
    onStatus?.(status);
    paint(renderStatus(status));
  });
  return attempt.client;
}

/** Watches the daemon and repaints until the user detaches. */
async function followDaemon(daemon: DaemonClient, controlUrl?: string): Promise<number> {
  let anyUp = false;
  const stream = await openStatusStream((status) => {
    anyUp = status.profiles.some((entry) => entry.state === "up");
  });

  // Not awaited: enrolment waits for a human, and the stream is what shows the
  // link and then the connection. Only a refusal ends the wait early.
  const refused = new Promise<string>((resolve) => {
    void daemon.request({ command: "up", controlUrl }, 15 * 60 * 1000).then((response) => {
      if (response.type === "error") resolve(response.message);
    });
  });

  const failure = await Promise.race([refused, untilInterrupted().then(() => null)]);
  stream?.close();
  daemon.close();
  if (process.stdout.isTTY) process.stdout.write("\n");
  if (failure !== null) {
    console.error(failure);
    return 1;
  }
  console.log(
    anyUp
      ? "Detached. The tunnels keep running; use `wave down` to stop them."
      : "Detached. Nothing is up; the service keeps trying.",
  );
  return 0;
}

/**
 * Which wave a command without a daemon should act on. Doing several at once is
 * the daemon's job; here one is picked and named by its server, so nobody is
 * left guessing which wave just went down.
 */
async function pickProfile(statePath: string, wanted?: string): Promise<Profile | string> {
  const profiles = await loadProfiles(statePath);
  if (profiles.length === 0) return "not in any wave yet — `wave login <control-server-url>` joins one";

  if (wanted) {
    const found = matchProfiles(profiles, wanted);
    if (found.length === 0) return `not in a wave at ${wanted}; \`wave profiles\` lists the ones there are`;
    if (found.length > 1) return describeAmbiguity(wanted, found);
    return found[0] as Profile;
  }
  const only = profiles[0];
  if (profiles.length === 1 && only) return only;
  return (
    `this device is in ${profiles.length} waves (${profiles.map((p) => waveLabel(p.controlUrl)).join(", ")}); ` +
    "name one by its control server, or use the daemon, which handles them together"
  );
}

/**
 * Runs the tunnel in this process and paints it until interrupted. Used when
 * there is no daemon -- by `up` for a wave already joined, and by `login` for
 * one being joined now.
 */
async function runHere(controlUrl: string, authKey?: string): Promise<number> {
  const tunnel = await up({
    statePath: values.state,
    controlUrl,
    authKey,
    socketPath: values.socket,
    interfaceName: values.interface,
    listenPort: values.port ? Number(values.port) : undefined,
    mtu: Number(values.mtu),
    stunServers: parseStunServers(values.stun),
    dns: !values["no-dns"],
    log,
  });

  live = true;
  const repaint = async () =>
    paint(
      renderStatus({
        profiles: [
          profileStatusFromSnapshot(await tunnel.snapshot(), {
            controlUrl: tunnel.state.controlUrl,
            state: "up",
            events,
          }),
        ],
        events: [],
      }),
    );
  await repaint();
  const timer = setInterval(() => void repaint().catch(() => {}), 1000);

  // Without a daemon the magic socket lives in this process, so the tunnel
  // only works while it does -- here Ctrl-C really does disconnect.
  await untilInterrupted();
  clearInterval(timer);
  if (process.stdout.isTTY) process.stdout.write("\n");
  await tunnel.stop();
  return 0;
}

async function main(): Promise<number> {
  if (values.help || command === "help") {
    console.log(usage);
    return 0;
  }

  // The one binary is also the service and the tray; these are how it runs as
  // either, and what the generated unit files invoke.
  if (command === "daemon") {
    const { runDaemon } = await import("./daemon-main.ts");
    await runDaemon(values);
    return 0;
  }
  if (command === "tray") {
    const { runTray } = await import("@wave/tray");
    await runTray({ socketPath: values.daemon });
    return 0;
  }
  if (command === "install" || command === "uninstall") {
    const { homeOf, install, uninstall } = await import("./install.ts");
    // Windows has no sudo: an elevated prompt keeps the account it was started
    // from, so USERNAME is the person whose session the tray belongs in.
    const user = process.platform === "win32" ? process.env.USERNAME : process.env.SUDO_USER;
    // Asked of the passwd database rather than built from the name: /home/<user>
    // is a convention, and where it does not hold -- a NAS keeping homes on a
    // volume, say -- the guess creates a directory that looks like a home, and
    // the tray unit written into it is one the user's systemd never sees.
    const home = process.env.SUDO_USER ? homeOf(process.env.SUDO_USER) : undefined;
    const update = updateFlags();
    if (typeof update === "string") {
      console.error(update);
      return 1;
    }
    const target = {
      update: Object.keys(update).length > 0 ? update : undefined,
      group: values.group,
      user,
      userHome: home ?? (process.env.SUDO_USER ? `/home/${process.env.SUDO_USER}` : undefined),
      userId: process.env.SUDO_UID ? Number(process.env.SUDO_UID) : undefined,
    };
    return command === "install" ? install(target) : uninstall(target);
  }

  let daemon: DaemonClient | null = null;
  if (!values["no-daemon"]) {
    const attempt = await DaemonClient.open(values.daemon);
    if (attempt.ok) {
      daemon = attempt.client;
    } else if (attempt.reason === "denied") {
      // Quietly doing the work here instead would hide the real problem behind
      // a connection error against whatever default the fallback picked up.
      console.error(
        `The wave service is running, but this account may not use its control socket (${values.daemon}).\n` +
          "The socket belongs to a group chosen when the service was installed. If you were added\n" +
          "to that group during the install, this session predates it -- log out and back in.\n" +
          `For right now:  sudo wave ${command}`,
      );
      return 1;
    } else if (attempt.reason === "unreachable") {
      console.error(`A control socket exists at ${values.daemon} but nothing answers; doing the work here.`);
    }
  }

  if (command === "version") {
    console.log(`wave ${VERSION} (${PLATFORM})`);
    if (!daemon) return 0;
    const response = await daemon.request({ command: "status" });
    daemon.close();
    if (response.type !== "status") return 0;
    const info = response.status.daemon;
    // The service is a separate process and can be another build: the one
    // before an update restarted it, or one installed from elsewhere.
    if (!info) console.log("the service runs an older build that does not say its version");
    else if (info.version !== VERSION) console.log(`the service runs ${info.version}`);
    if (info?.update) for (const line of describeUpdate(info.update)) console.log(line);
    return 0;
  }

  if (command === "update") {
    const flags = updateFlags();
    if (typeof flags === "string") {
      console.error(flags);
      return 1;
    }
    // The daemon is the only process that may write the installation, and
    // the only one that holds the signed offers to decide from.
    if (!daemon) {
      console.error(
        "updating needs the service: it holds the offers and owns the installation (wave install)",
      );
      return 1;
    }
    const settingsOnly = Object.keys(flags).length > 0;
    const response = await daemon.request(
      { command: "update", ...flags, install: !settingsOnly },
      15 * 60 * 1000,
    );
    daemon.close();
    // The daemon ending before it answers is the new build being started:
    // a successful install never gets to reply.
    if (!settingsOnly && response.type === "error" && response.message === DAEMON_CLOSED) {
      console.log("installed; the service is restarting with the new version");
      return 0;
    }
    if (response.type === "error") {
      console.error(response.message);
      return 1;
    }
    if (response.type !== "update") {
      console.error("unexpected answer");
      return 1;
    }
    if (response.message) console.log(response.message);
    for (const line of describeUpdate(response.update)) console.log(line);
    return 0;
  }

  if (command === "login") {
    // The server is the argument, not a setting: a device joins a wave by
    // naming it, and may name several.
    const typed = positionals[1] ?? values.control;
    if (!typed) {
      console.error("name the server: `wave login <control-server-url>`");
      return 1;
    }
    // Refused here rather than stored: an address that is not one becomes an
    // enrolment that can never come up and sits in the list looking real.
    const url = normaliseControlUrl(typed);
    if (!url) {
      console.error(`${typed} is not a control server address`);
      return 1;
    }
    if (!daemon) return runHere(url, values["auth-key"] || undefined);

    // Painted while we wait, because the approval link only ever travels on
    // the status stream: the answer to this request does not come until
    // somebody has opened that link. Awaiting the answer alone printed nothing
    // at all for as long as the approval took -- which is what `wave login`
    // did on Windows the moment there was a daemon there to ask.
    const stream = await openStatusStream();
    const response = await daemon.request(
      { command: "login", controlUrl: url, authKey: values["auth-key"] || undefined },
      15 * 60 * 1000,
    );
    stream?.close();
    daemon.close();
    if (response.type !== "status") {
      if (process.stdout.isTTY) process.stdout.write("\n");
      console.error(response.type === "error" ? response.message : "unexpected answer");
      return 1;
    }
    paint(renderStatus(response.status));
    return 0;
  }

  if (command === "up") {
    if (daemon) return followDaemon(daemon, positionals[1]);

    // Without a daemon only one tunnel can run here, so the wave has to be
    // decided before anything starts -- and `up` never joins a new one.
    const picked = await pickProfile(values.state, positionals[1]);
    if (typeof picked === "string") {
      console.error(picked);
      return 1;
    }
    return runHere(picked.controlUrl);
  }

  if (daemon) {
    if (command === "status") {
      // Live like `wave up`, because that is what the numbers here are: a
      // path, an RTT and a handshake age only say something while they move.
      // Watched on this connection rather than a second one -- nothing is
      // asked of the daemon afterwards, so nothing can be mistaken for the
      // answer to it.
      if (isLive()) {
        await daemon.watch((status: Status) => paint(renderStatus(status, WATCH_HINT)));
        await untilInterrupted();
        daemon.close();
        process.stdout.write("\n");
        return 0;
      }

      const response = await daemon.request({ command: "status" });
      daemon.close();
      if (response.type !== "status") {
        console.error(response.type === "error" ? response.message : "unexpected answer");
        return 1;
      }
      // Nobody interrupts a single printed snapshot, so it gets no footer.
      console.log(renderStatus(response.status, null));
      return 0;
    }
    if (command === "down") {
      const response = await daemon.request({ command: "down", controlUrl: positionals[1] });
      daemon.close();
      if (response.type === "error") {
        console.error(response.message);
        return 1;
      }
      console.log("down");
      return 0;
    }
    if (command === "certs") {
      const response = await daemon.request({ command: "certs" });
      daemon.close();
      if (response.type !== "certs") {
        console.error(response.type === "error" ? response.message : "unexpected answer");
        return 1;
      }
      printCertificates(response.certs);
      return 0;
    }

    if (command === "cert") {
      // Certificates need no tunnel, only the enrolment -- but the enrolment
      // belongs to the daemon wherever there is one, keys, files and all.
      const code = await certAttempts(async () => {
        const response = await daemon.request(
          {
            command: "cert",
            controlUrl: values.control,
            names: positionals.length > 1 ? positionals.slice(1) : undefined,
            wildcard: values.wildcard,
            hook: values.hook,
          },
          // Issuance waits for a CA to validate DNS; minutes, not seconds.
          15 * 60 * 1000,
        );
        if (response.type === "certs") return { certs: response.certs };
        if (response.type === "cert-waiting") return { waiting: response.waiting };
        return { error: response.type === "error" ? response.message : "unexpected answer" };
      });
      daemon.close();
      return code;
    }

    if (command === "logout") {
      const url = positionals[1];
      if (!url) {
        // Never a bulk operation: it throws keys away.
        console.error(
          "name the wave to leave: `wave logout <control-server-url>` (`wave profiles` lists them)",
        );
        return 1;
      }
      const response = await daemon.request({ command: "logout", controlUrl: url });
      daemon.close();
      if (response.type === "error") {
        console.error(response.message);
        return 1;
      }
      console.log(`left ${waveLabel(url)}`);
      return 0;
    }
  }

  if (command === "profiles") {
    // Asked of the daemon whenever there is one, because it owns the state
    // this machine actually runs on. Reading the file directly would show an
    // unprivileged caller its own empty state and call it the truth.
    const rows: { label: string; where: string; controlUrl: string }[] = [];
    if (daemon) {
      const response = await daemon.request({ command: "status" });
      daemon.close();
      if (response.type !== "status") {
        console.error(response.type === "error" ? response.message : "unexpected answer");
        return 1;
      }
      for (const profile of response.status.profiles) {
        rows.push({
          label: waveLabel(profile.controlUrl),
          where: profile.interfaceName ?? profile.state,
          controlUrl: profile.controlUrl,
        });
      }
    } else {
      for (const profile of await loadProfiles(values.state)) {
        rows.push({
          label: waveLabel(profile.controlUrl),
          where: profile.nodeId ? profile.interfaceName : "not enrolled",
          controlUrl: profile.controlUrl,
        });
      }
    }

    if (rows.length === 0) {
      console.log("not in any wave yet — `wave login <control-server-url>` joins one");
      return 0;
    }
    const width = Math.max(...rows.map((row) => row.label.length));
    for (const row of rows) {
      console.log(`${row.label.padEnd(width)}  ${row.where.padEnd(12)}  ${row.controlUrl}`);
    }
    return 0;
  }

  if (command === "certs") {
    const { certPaths } = await import("./certs.ts");
    printCertificates(
      (await loadProfiles(values.state)).flatMap((profile) =>
        profile.certs.map((record) => ({
          controlUrl: profile.controlUrl,
          ...record,
          ...certPaths(values.state, record.name),
        })),
      ),
    );
    return 0;
  }

  if (command === "cert") {
    // The positional here is the *name*, not a wave -- so the wave comes from
    // --control, the way it does for a login. Handing the name to the picker
    // would look for a wave called laptop.wave.example.com and find none.
    const { issueCertificate } = await import("./certs.ts");
    const wave = await pickProfile(values.state, values.control);
    if (typeof wave === "string") {
      console.error(wave);
      return 1;
    }
    return certAttempts(async () => {
      try {
        const result = await issueCertificate({
          statePath: values.state,
          profile: wave,
          names: positionals.length > 1 ? positionals.slice(1) : undefined,
          wildcard: values.wildcard,
          hook: values.hook ?? null,
          log,
        });
        return "waiting" in result
          ? { waiting: { name: result.name, records: result.waiting } }
          : { certs: [{ controlUrl: wave.controlUrl, ...result.issued }] };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  const picked = await pickProfile(values.state, positionals[1]);
  if (typeof picked === "string") {
    console.error(picked);
    return 1;
  }
  const state = picked;

  // Darwin names the interface itself, so the state's name is only a label.
  const linkName = resolveInterfaceName(state.interfaceName);

  if (command === "logout") {
    // Tell the control server first, while the keys are still around; failing
    // to reach it must not leave the device half-enrolled locally.
    try {
      await new ControlClient(state).logout();
      log("removed this device from the wave");
    } catch (error) {
      log(`could not reach the control server (${error instanceof Error ? error.message : String(error)})`);
      log("removing the local enrolment anyway");
    }
    await platformLink()
      .remove(linkName)
      .catch(() => {});
    await removeProfile(values.state, state.controlUrl);
    log(`left ${waveLabel(state.controlUrl)}`);
    return 0;
  }

  if (command === "down") {
    // On Linux removing the interface stops the userspace WireGuard process;
    // on Darwin it is the other way round, which is the backend's problem.
    await platformLink().remove(linkName);
    log(`${linkName} is down`);
    return 0;
  }

  if (command === "status") {
    const { WgControl, defaultSocketPath } = await import("./wgctl.ts");
    const control = new WgControl(values.socket ?? defaultSocketPath(linkName));

    // All there is without a daemon: what WireGuard itself knows. No paths and
    // no RTTs -- those live in the magic socket, and that belongs to whichever
    // process runs the tunnel.
    const lines = async (): Promise<string[]> => {
      const device = await control.getDevice();
      const out = [`interface ${linkName} (node ${state.nodeId ?? "unenrolled"}), port ${device.listenPort}`];
      if (device.peers.length === 0) out.push("  no peers");
      for (const peer of device.peers) {
        const handshake = peer.lastHandshakeSeconds
          ? `${Math.round(Date.now() / 1000 - peer.lastHandshakeSeconds)}s ago`
          : "never";
        out.push(
          `  ${peer.allowedIps.join(",")} via ${peer.endpoint ?? "no endpoint"} — handshake ${handshake}`,
        );
      }
      return out;
    };

    if (!isLive()) {
      for (const line of await lines()) console.log(line);
      return 0;
    }

    // The interface can go away under us -- `wave down` in another terminal,
    // or the process that holds the tunnel ending. That is something to show
    // and keep watching, not something to crash on: it may well come back.
    const repaint = async () => {
      const body = await lines().catch((error: unknown) => [
        `${linkName} is not answering (${error instanceof Error ? error.message : String(error)})`,
      ]);
      paint([...body, "", WATCH_HINT].join("\n"));
    };
    await repaint();
    const timer = setInterval(() => void repaint(), 1000);

    await untilInterrupted();
    clearInterval(timer);
    process.stdout.write("\n");
    return 0;
  }

  console.error(`unknown command: ${command}\n\n${usage}`);
  return 1;
}

type CertAttempt = { certs: CertificateStatus[] } | { waiting: CertWaiting } | { error: string };

/** How long to keep asking while somebody creates a record, and how often. */
const MANUAL_DEADLINE_MS = 30 * 60 * 1000;
const MANUAL_INTERVAL_MS = 15_000;

/**
 * Asks until there is a certificate, an error, or the patience runs out.
 *
 * One loop for both ways of asking, because the manual mode is the same on
 * either: the order lives on the server, and every further attempt takes it up
 * where it was rather than starting another one. That is what makes Ctrl-C
 * harmless and `wave cert` repeatable.
 */
async function certAttempts(attempt: () => Promise<CertAttempt>): Promise<number> {
  const deadline = Date.now() + MANUAL_DEADLINE_MS;
  let announced = false;

  for (;;) {
    const result = await attempt();
    if ("error" in result) {
      console.error(result.error);
      return 1;
    }
    if ("certs" in result) {
      printCertificates(result.certs);
      return 0;
    }

    // Said once. Repeating it every fifteen seconds would bury the record
    // itself, which is the one thing on the screen that has to stay readable.
    if (!announced) {
      printRecords(result.waiting);
      announced = true;
    }
    if (Date.now() >= deadline) {
      console.error("Still waiting for the record. Run `wave cert` again once it is live.");
      return 1;
    }
    await Bun.sleep(MANUAL_INTERVAL_MS);
  }
}

/** What somebody has to put in the zone, in the shape a DNS form asks for. */
function printRecords(waiting: CertWaiting): void {
  console.log(`\nThis wave answers dns-01 by hand, so ${waiting.name} needs a record first:\n`);
  for (const record of waiting.records) {
    console.log(`  name   ${record.name}`);
    console.log("  type   TXT");
    console.log(`  value  ${record.value}`);
    console.log("");
  }
  console.log("A short TTL (60s) helps. Nothing else has to be changed, and the record");
  console.log("can go again once the certificate is there.");
  console.log("Waiting... Ctrl-C is safe: `wave cert` takes the same order up again.\n");
}

/** One line per certificate: what it is for, until when, and where it is. */
function printCertificates(certs: CertificateStatus[]): void {
  if (certs.length === 0) {
    console.log("no certificates yet — `wave cert` asks for one");
    return;
  }
  const width = Math.max(...certs.map((cert) => cert.name.length));
  for (const cert of certs) {
    console.log(`${cert.name.padEnd(width)}  until ${cert.notAfter}  ${cert.chainPath}`);
  }
}

process.exit(await main());
