#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { systemLocale } from "@wave/i18n/system";
import {
  type CertificateStatus,
  type CertWaiting,
  DAEMON_CLOSED,
  DaemonClient,
  DEFAULT_SOCKET_PATH,
  type Notice,
  PLATFORM,
  profileKeyOf,
  profileName,
  profileStatusFromSnapshot,
  readNotice,
  type Status,
  type UpdateStatus,
  VERSION,
  waveLabel,
} from "@wave/ipc";
import { UpdateChannel } from "@wave/proto";
import { ControlClient } from "./api.ts";
import { DEFAULT_MTU, resolveInterfaceName, up } from "./engine.ts";
import { platformLink } from "./link-platform.ts";
import { locale, setLocale, t } from "./messages.ts";
import { paint, renderStatus, shouldWatch } from "./render.ts";
import { isAbort } from "./retry.ts";
import {
  ambiguity,
  defaultStatePath,
  loadProfiles,
  matchProfiles,
  normaliseControlUrl,
  type Profile,
  profileKey,
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
    dsm: { type: "boolean", default: false },
    "no-dsm": { type: "boolean", default: false },
    binary: { type: "string" },
    "auth-key": { type: "string", default: process.env.WAVE_AUTH_KEY ?? "" },
    wildcard: { type: "boolean", default: false },
    "new-wave": { type: "boolean", default: false },
    channel: { type: "string" },
    "auto-update": { type: "string" },
    "wg-socket": { type: "string" },
    help: { type: "boolean", default: false },
  },
});

const command = positionals[0] ?? "help";

// Once, before anything is said -- except for the daemon. It runs from this
// same binary, and systemd hands services the LANG of /etc/locale.conf: set
// here, the few texts it shares with the CLI (a missing wireguard-go) would
// reach the journal in whatever language the machine was installed in. The
// tray picks its own, from the session it belongs to.
if (command !== "daemon") setLocale(systemLocale());

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

/**
 * How long `up` and `login` wait on the daemon. Enrolment waits for a person
 * at a browser and for a control server that may not be up yet, and neither
 * has an end of its own: Ctrl-C is how a person ends it. A shorter timeout
 * here would report "the daemon did not answer" over a daemon that is busy
 * doing exactly what it was asked. (The largest delay a timer takes.)
 */
const ENROL_WAIT_MS = 2 ** 31 - 1;

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

const usage = t().usage(defaultStatePath(), DEFAULT_SOCKET_PATH, DEFAULT_MTU);

/**
 * --dsm and --no-dsm for `wave cert`: undefined leaves it to detection, which
 * is what a renewal does as well.
 */
function dsmChoice(): boolean | undefined {
  if (values["no-dsm"]) return false;
  return values.dsm ? true : undefined;
}

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
      if (!parsed.success) return t().channelFlag(UpdateChannel.options.join(", "));
      flags.channel = parsed.data;
    }
  }
  const auto = values["auto-update"];
  if (auto !== undefined) {
    if (auto !== "on" && auto !== "off") return t().autoUpdateFlag;
    flags.autoUpdate = auto === "on";
  }
  return flags;
}

/** The update state as a few lines, for `wave version` and `wave update`. */
function describeUpdate(update: UpdateStatus): string[] {
  const m = t();
  const lines: string[] = [m.autoUpdateLine(update.autoUpdate, update.wish)];
  for (const entry of update.channels) {
    lines.push(m.channelOffers(waveLabel(entry.controlUrl), entry.channel, entry.offered.join(", ")));
  }
  if (update.available) {
    const when =
      update.state === "scheduled" && update.scheduledAt
        ? m.installingAt(update.scheduledAt)
        : update.state === "installing"
          ? m.installingNow
          : m.updateInstallsNow;
    lines.push(m.updateAvailable(update.available, when));
  } else {
    lines.push(m.upToDate);
  }
  const said = readNotice(update, locale());
  if (said) lines.push(said);
  return lines;
}

/** A refusal from the daemon, in this person's language when it sent a code. */
const said = (response: { message: string; notice?: Notice | null }): string =>
  readNotice(response, locale()) ?? response.message;

/** Watching changes nothing, so Ctrl-C must not promise that it does. */
const WATCH_HINT = t().watchHint;

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
    void daemon.request({ command: "up", controlUrl }, ENROL_WAIT_MS).then((response) => {
      if (response.type === "error") resolve(said(response));
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
  console.log(anyUp ? t().detachedUp : t().detachedNothing);
  return 0;
}

/**
 * Which wave a command without a daemon should act on. Doing several at once is
 * the daemon's job; here one is picked and named by its server, so nobody is
 * left guessing which wave just went down.
 */
async function pickProfile(statePath: string, wanted?: string): Promise<Profile | string> {
  const profiles = await loadProfiles(statePath);
  if (profiles.length === 0) return t().notEnrolled;

  if (wanted) {
    const found = matchProfiles(profiles, wanted);
    if (found.length === 0) return t().noSuchWave(wanted);
    if (found.length > 1) return readNotice({ notice: ambiguity(wanted, found) }, locale()) ?? wanted;
    return found[0] as Profile;
  }
  const only = profiles[0];
  if (profiles.length === 1 && only) return only;
  return t().severalWaves(profiles.length, profiles.map((p) => waveLabel(p.controlUrl)).join(", "));
}

/**
 * Runs the tunnel in this process and paints it until interrupted. Used when
 * there is no daemon -- by `up` for a wave already joined, and by `login` for
 * one being joined now.
 */
async function runHere(controlUrl: string, authKey?: string): Promise<number> {
  // Enrolment retries a control server that is not there for as long as it
  // takes, so Ctrl-C has to be able to end it. Once, though: a second one
  // falls through to the default, for a start that is past the point where
  // it can be taken back.
  const cancel = new AbortController();
  const interrupt = () => cancel.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let tunnel: Awaited<ReturnType<typeof up>>;
  try {
    tunnel = await up({
      statePath: values.state,
      controlUrl,
      authKey,
      signal: cancel.signal,
      socketPath: values.socket,
      interfaceName: values.interface,
      listenPort: values.port ? Number(values.port) : undefined,
      mtu: Number(values.mtu),
      stunServers: parseStunServers(values.stun),
      dns: !values["no-dns"],
      log,
    });
  } catch (error) {
    if (!isAbort(error)) throw error;
    if (process.stdout.isTTY) process.stdout.write("\n");
    return 0;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }

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
      binaryPath: values.binary,
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
      console.error(t().socketDenied(values.daemon, command));
      return 1;
    } else if (attempt.reason === "unreachable") {
      console.error(t().socketSilent(values.daemon));
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
    if (!info) console.log(t().serviceOlder);
    else if (info.version !== VERSION) console.log(t().serviceRuns(info.version));
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
      console.error(t().updateNeedsService);
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
      console.log(t().installedRestarting);
      return 0;
    }
    if (response.type === "error") {
      console.error(said(response));
      return 1;
    }
    if (response.type !== "update") {
      console.error(t().unexpectedAnswer);
      return 1;
    }
    const answer = readNotice(response, locale());
    if (answer) console.log(answer);
    for (const line of describeUpdate(response.update)) console.log(line);
    return 0;
  }

  if (command === "login") {
    // The server is the argument, not a setting: a device joins a wave by
    // naming it, and may name several.
    const typed = positionals[1] ?? values.control;
    if (!typed) {
      console.error(t().nameTheServer);
      return 1;
    }
    // Refused here rather than stored: an address that is not one becomes an
    // enrolment that can never come up and sits in the list looking real.
    const url = normaliseControlUrl(typed);
    if (!url) {
      console.error(t().notAControlUrl(typed));
      return 1;
    }
    // A further wave at a server this device is already in needs the daemon:
    // it is the one that keeps several enrolments apart.
    if (!daemon && values["new-wave"]) {
      console.error(t().newWaveNeedsDaemon);
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
      {
        command: "login",
        controlUrl: url,
        authKey: values["auth-key"] || undefined,
        newWave: values["new-wave"] || undefined,
      },
      ENROL_WAIT_MS,
    );
    stream?.close();
    daemon.close();
    if (response.type !== "status") {
      if (process.stdout.isTTY) process.stdout.write("\n");
      console.error(response.type === "error" ? said(response) : t().unexpectedAnswer);
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
        console.error(response.type === "error" ? said(response) : t().unexpectedAnswer);
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
        console.error(said(response));
        return 1;
      }
      console.log(t().down);
      return 0;
    }
    if (command === "certs") {
      const response = await daemon.request({ command: "certs" });
      daemon.close();
      if (response.type !== "certs") {
        console.error(response.type === "error" ? said(response) : t().unexpectedAnswer);
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
            dsm: dsmChoice(),
          },
          // Issuance waits for a CA to validate DNS; minutes, not seconds.
          15 * 60 * 1000,
        );
        if (response.type === "certs") return { certs: response.certs };
        if (response.type === "cert-waiting") return { waiting: response.waiting };
        return { error: response.type === "error" ? said(response) : t().unexpectedAnswer };
      });
      daemon.close();
      return code;
    }

    if (command === "logout") {
      const url = positionals[1];
      if (!url) {
        // Never a bulk operation: it throws keys away.
        console.error(t().nameTheWaveToLeave);
        return 1;
      }
      const response = await daemon.request({ command: "logout", controlUrl: url });
      daemon.close();
      if (response.type === "error") {
        console.error(said(response));
        return 1;
      }
      console.log(t().left(waveLabel(url)));
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
        console.error(response.type === "error" ? said(response) : t().unexpectedAnswer);
        return 1;
      }
      for (const profile of response.status.profiles) {
        rows.push({
          // The wave's own name: with several at one server, its host would
          // name them all alike. That name is also what `up`, `down` and
          // `logout` take.
          label: profileName(profile),
          where: profile.interfaceName ?? profile.state,
          controlUrl: profileKeyOf(profile),
        });
      }
    } else {
      for (const profile of await loadProfiles(values.state)) {
        rows.push({
          label: profile.label ?? waveLabel(profile.controlUrl),
          where: profile.nodeId ? profile.interfaceName : t().notEnrolledRow,
          controlUrl: profileKey(profile),
        });
      }
    }

    if (rows.length === 0) {
      console.log(t().notEnrolled);
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
          dsm: dsmChoice(),
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
      const m = t();
      const out = [m.wgInterface(linkName, state.nodeId ?? null, device.listenPort)];
      if (device.peers.length === 0) out.push(m.wgNoPeers);
      for (const peer of device.peers) {
        const handshake = peer.lastHandshakeSeconds
          ? m.wgAgo(Math.round(Date.now() / 1000 - peer.lastHandshakeSeconds))
          : m.wgNever;
        out.push(m.wgPeer(peer.allowedIps.join(","), peer.endpoint ?? null, handshake));
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
        t().wgSilent(linkName, error instanceof Error ? error.message : String(error)),
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

  console.error(t().unknownCommand(command, usage));
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
      console.error(t().stillWaiting);
      return 1;
    }
    await Bun.sleep(MANUAL_INTERVAL_MS);
  }
}

/** What somebody has to put in the zone, in the shape a DNS form asks for. */
function printRecords(waiting: CertWaiting): void {
  console.log(t().recordsIntro(waiting.name));
  for (const record of waiting.records) {
    console.log(`  name   ${record.name}`);
    console.log("  type   TXT");
    console.log(`  value  ${record.value}`);
    console.log("");
  }
  console.log(t().recordsOutro);
}

/** One line per certificate: what it is for, until when, and where it is. */
function printCertificates(certs: CertificateStatus[]): void {
  if (certs.length === 0) {
    console.log(t().noCertificates);
    return;
  }
  const width = Math.max(...certs.map((cert) => cert.name.length));
  for (const cert of certs) {
    console.log(`${cert.name.padEnd(width)}  ${t().certUntil(cert.notAfter)}  ${cert.chainPath}`);
  }
}

process.exit(await main());
