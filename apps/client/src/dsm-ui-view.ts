import { type Locale, type Messages, messagesFor } from "@wave/i18n";
import {
  type ConnectFailure,
  type ProfileStatus,
  pathKind,
  pathWords,
  profileKeyOf,
  profileName,
  readNotice,
  type Status,
  tunnelWords,
} from "@wave/ipc";

/**
 * What the page in DSM shows: the page itself, and the part of it that is
 * the daemon's status, drawn here on the NAS and swapped in by the page.
 *
 * Drawn on the server rather than in the browser because the words are
 * already here -- the catalogue below, `pathWords()`, the notices -- and a
 * second copy of them in JavaScript would be the place a language goes
 * missing. The page's own script does three things: fetch DSM's token, ask
 * for this fragment, and send the three actions. Nothing it shows is
 * assembled in the browser.
 */

const en = {
  subtitle: "on this DiskStation",
  waves: "Waves",
  devices: "Devices",
  join: "Join a wave",
  controlUrl: "Control server",
  joinHint:
    "The address of the wave's control server. Approving this DiskStation happens in your browser, signed in to that server.",
  signIn: "Sign in",
  signingIn: "Signing in…",
  connect: "Connect",
  disconnect: "Disconnect",
  approve: "Approve in the browser",
  approveHint: "Open the link, sign in and approve this DiskStation. This page notices by itself.",
  loading: "Asking the wave service…",
  noWave: "This DiskStation is not in a wave yet. Join one below.",
  noDevicesYet: "The devices show once a wave is connected.",
  alone: "No other device in this wave yet.",
  notConnected: "not connected",
  failed: "could not connect",
  services: (count: number) => (count === 1 ? "1 service" : `${count} services`),
  noDaemon:
    "The wave service is not set up on this DiskStation yet. It needs root once: over SSH with sudo /var/packages/wave/scripts/setup, or as a task in the Task Scheduler that runs the same script as root.",
  denied:
    "This page may not talk to the wave service. Run the setup once more (sudo /var/packages/wave/scripts/setup) -- only a setup from this version on lets the page in.",
  unreachable: "The wave service does not answer. Is it running? (systemctl status wave)",
  notSignedIn: "Your DSM session could not be confirmed. Open wave again from DSM's main menu.",
  notAdmin: "Only administrators of this DiskStation can manage wave.",
  notAControlUrl: (typed: string) => `“${typed}” is not the address of a control server.`,
  stale: "Lost touch with the wave service -- this is how things stood before.",
  version: (version: string) => `wave ${version}`,
} satisfies Messages;

const de: typeof en = {
  subtitle: "auf dieser DiskStation",
  waves: "Waves",
  devices: "Geräte",
  join: "Einem Wave beitreten",
  controlUrl: "Control-Server",
  joinHint:
    "Die Adresse des Control-Servers des Waves. Freigegeben wird die DiskStation danach in deinem Browser, angemeldet an diesem Server.",
  signIn: "Anmelden",
  signingIn: "Melde an…",
  connect: "Verbinden",
  disconnect: "Trennen",
  approve: "Im Browser freigeben",
  approveHint: "Öffne den Link, melde dich an und gib die DiskStation frei. Diese Seite merkt es von selbst.",
  loading: "Frage den wave-Dienst…",
  noWave: "Diese DiskStation ist noch in keinem Wave. Tritt unten einem bei.",
  noDevicesYet: "Die Geräte erscheinen, sobald ein Wave verbunden ist.",
  alone: "Noch kein anderes Gerät in diesem Wave.",
  notConnected: "nicht verbunden",
  failed: "Verbindung gescheitert",
  services: (count) => (count === 1 ? "1 Dienst" : `${count} Dienste`),
  noDaemon:
    "Der wave-Dienst ist auf dieser DiskStation noch nicht eingerichtet. Dafür braucht es einmal root: per SSH mit sudo /var/packages/wave/scripts/setup, oder als Aufgabe im Aufgabenplaner, die dasselbe Skript als root ausführt.",
  denied:
    "Diese Seite darf nicht mit dem wave-Dienst sprechen. Führe das Setup noch einmal aus (sudo /var/packages/wave/scripts/setup) -- erst ein Setup ab dieser Version lässt die Seite herein.",
  unreachable: "Der wave-Dienst antwortet nicht. Läuft er? (systemctl status wave)",
  notSignedIn:
    "Deine DSM-Sitzung ließ sich nicht bestätigen. Öffne wave noch einmal aus dem Hauptmenü von DSM.",
  notAdmin: "Nur Administratoren dieser DiskStation können wave verwalten.",
  notAControlUrl: (typed) => `„${typed}“ ist keine Adresse eines Control-Servers.`,
  stale: "Keine Verbindung zum wave-Dienst -- so stand es zuletzt.",
  version: (version) => `wave ${version}`,
};

export type UiText = typeof en;
export const uiText = (locale: Locale): UiText => messagesFor({ en, de }, locale);

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Everything that came from a server or a person goes through here before it is HTML. */
export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);

/**
 * A link only to http and https. The addresses come from a control server, and
 * a `javascript:` URL in an href would run on DSM's origin with the
 * administrator's session -- the one thing this page must never hand out.
 */
export function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

const link = (url: string, text: string, className: string): string => {
  const href = safeHref(url);
  const label = escapeHtml(text);
  return href
    ? `<a class="${className}" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`
    : `<span class="${className}">${label}</span>`;
};

/** The same words as the tray's window: the path, and the RTT only where there is a path to time. */
function describePath(peer: ProfileStatus["peers"][number], locale: Locale): string {
  const { kind, text } = pathWords(peer, locale);
  if (kind === "loose" || kind === "idle" || kind === "none") return text;
  return peer.rttMs === null ? text : `${text} · ${Math.round(peer.rttMs)} ms`;
}

function waveDetail(profile: ProfileStatus, locale: Locale): string {
  const text = uiText(locale);
  if (profile.state === "up") {
    return profile.self ? `${profile.self.ipv4} · ${profile.self.dnsName}` : (profile.dnsSuffix ?? "");
  }
  if (profile.state === "waiting-for-approval") return tunnelWords(locale).waitingInBrowser;
  if (profile.state === "starting") return readNotice(profile, locale) ?? tunnelWords(locale).connecting;
  // A raw reason from deeper down, shown as it came.
  if (profile.state === "failed") return profile.message ?? text.failed;
  return text.notConnected;
}

function waveRow(profile: ProfileStatus, locale: Locale): string {
  const text = uiText(locale);
  const busy = profile.state === "starting" || profile.state === "waiting-for-approval";
  const on = profile.state === "up";
  const dot = on ? "on" : busy ? "busy" : profile.state === "failed" ? "error" : "off";
  // Down is always offered while something is going on: a wave waiting for an
  // approval nobody will give is ended the same way as a connected one.
  const action = on || busy ? "down" : "up";
  const button = `<button type="button" class="btn secondary" data-action="${action}" data-id="${escapeHtml(
    profileKeyOf(profile),
  )}">${escapeHtml(action === "down" ? text.disconnect : text.connect)}</button>`;

  const approval =
    profile.state === "waiting-for-approval" && profile.authUrl
      ? `<div class="approve">${link(profile.authUrl, text.approve, "btn primary")}<p class="hint">${escapeHtml(
          text.approveHint,
        )}</p></div>`
      : "";

  return `<li class="wave"><div class="row"><span class="dot ${dot}"></span><div class="grow"><div class="name">${escapeHtml(
    profileName(profile),
  )}</div><div class="meta${profile.state === "failed" ? " error-text" : ""}">${escapeHtml(
    waveDetail(profile, locale),
  )}</div></div>${button}</div>${approval}</li>`;
}

function machineRows(profiles: ProfileStatus[], locale: Locale): string {
  const text = uiText(locale);
  // The wave is named on the row only once there are two -- the same short
  // hostname could otherwise mean two machines. The tray does the same.
  const named = profiles.length > 1;
  return profiles
    .flatMap((profile) =>
      profile.peers.map((peer) => {
        const online = pathKind(peer) !== "none";
        const meta = [peer.ipv4, describePath(peer, locale), named ? profileName(profile) : null]
          .filter(Boolean)
          .join(" · ");
        const services = peer.services.length
          ? `<div class="count">${escapeHtml(text.services(peer.services.length))}</div><ul class="services">${peer.services
              .map(
                (service) =>
                  `<li>${link(service.url, service.dnsName, "service")}<span class="mono">${escapeHtml(service.ipv4)}</span></li>`,
              )
              .join("")}</ul>`
          : "";
        return `<li class="machine"><div class="row"><span class="dot ${online ? "on" : "off"}"></span><div class="grow"><div class="name">${escapeHtml(
          peer.hostname,
        )} <span class="mono soft">${escapeHtml(peer.dnsName)}</span></div><div class="meta">${escapeHtml(
          meta,
        )}</div>${services}</div></div></li>`;
      }),
    )
    .join("");
}

/** The daemon's status as the two cards the page swaps in. */
export function statusFragment(status: Status, locale: Locale): string {
  const text = uiText(locale);
  const profiles = status.profiles;
  const up = profiles.filter((profile) => profile.state === "up");

  const waves = profiles.length
    ? `<ul class="list">${profiles.map((profile) => waveRow(profile, locale)).join("")}</ul>`
    : `<p class="empty">${escapeHtml(text.noWave)}</p>`;

  const machines = machineRows(up, locale);
  const devices = machines
    ? `<ul class="list">${machines}</ul>`
    : `<p class="empty">${escapeHtml(up.length ? text.alone : text.noDevicesYet)}</p>`;

  const version = status.daemon?.version;
  return `<section class="card"><h2 class="section">${escapeHtml(text.waves)}</h2>${waves}</section><section class="card"><h2 class="section">${escapeHtml(
    text.devices,
  )}</h2>${devices}</section>${version ? `<p class="version">${escapeHtml(text.version(version))}</p>` : ""}`;
}

/** Why there is no status to show, in words that say what to do about it. */
export function unreachableFragment(reason: ConnectFailure, locale: Locale): string {
  const text = uiText(locale);
  const said = reason === "no-daemon" ? text.noDaemon : reason === "denied" ? text.denied : text.unreachable;
  return `<div class="alert">${escapeHtml(said)}</div>`;
}

/** JSON inside a <script>: a `</script>` in a string must not end the element. */
const scriptJson = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c");

/**
 * The page. Self-contained -- no font, script or style from anywhere else: a
 * NAS is often not on the internet, and the page runs on DSM's origin, where
 * nothing foreign belongs. The script carries the nonce the response's CSP
 * names, so nothing that slipped into the markup could run.
 */
export function page(locale: Locale, nonce: string): string {
  const text = uiText(locale);
  const client = { stale: text.stale, signIn: text.signIn, signingIn: text.signingIn };
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>wave</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<header><span class="mark">wave<span class="accent">mesh</span></span><span class="sub">${escapeHtml(text.subtitle)}</span></header>
<main>
<div id="error" class="alert" hidden></div>
<div id="status" aria-live="polite"><p class="empty">${escapeHtml(text.loading)}</p></div>
<section class="card">
<h2 class="section">${escapeHtml(text.join)}</h2>
<form id="login">
<label for="url">${escapeHtml(text.controlUrl)}</label>
<div class="inline"><input id="url" name="controlUrl" type="text" inputmode="url" autocomplete="url" placeholder="https://wave.example.com" required><button class="btn primary" type="submit">${escapeHtml(
    text.signIn,
  )}</button></div>
<p class="hint">${escapeHtml(text.joinHint)}</p>
</form>
</section>
</main>
<script nonce="${nonce}">const TEXT = ${scriptJson(client)};
${SCRIPT}</script>
</body>
</html>
`;
}

/**
 * The palette of the web app (DESIGN.md): paper, navy, slate, and petrol as
 * the one accent; red only for what someone has to fix, amber only for
 * "on its way", as on the tray's mark.
 */
const STYLE = `
:root{--paper:#fffdf8;--ink:#1a1a1a;--navy:#0f2744;--slate:#7c8b9a;--accent:#0f6e6e;--accent-strong:#0b5757;--line:#0f274414;--red:#dc2626;--amber:#d99a14}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:0.9375rem/1.6 Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{display:flex;align-items:baseline;gap:.75rem;padding:1rem 1.5rem;border-bottom:1px solid #0f27441a}
.mark{font:600 1.25rem "Space Grotesk",Inter,system-ui,sans-serif;letter-spacing:-.01em;color:var(--navy)}
.accent{color:var(--accent)}
.sub{color:var(--slate);font-size:.875rem}
main{max-width:46rem;margin:0 auto;padding:1.5rem 1rem 3rem;display:grid;gap:1rem}
#status{display:grid;gap:1rem}
.card{background:#fff;border:1px solid var(--line);border-radius:.75rem;box-shadow:0 1px 3px #0f27440f;padding:1rem 1.25rem}
.section{margin:0 0 .5rem;padding-bottom:.5rem;border-bottom:1px solid #0f27440f;font-size:.75rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--slate)}
.list{list-style:none;margin:0;padding:0}
.list>li{padding:.625rem 0;border-bottom:1px solid var(--line)}
.list>li:last-child{border-bottom:0}
.row{display:flex;align-items:flex-start;gap:.75rem}
.grow{flex:1;min-width:0}
.name{color:var(--navy);font-weight:500;overflow-wrap:anywhere}
.meta{color:var(--slate);font-size:.8125rem;overflow-wrap:anywhere}
.error-text{color:var(--red)}
.mono{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;font-size:.8125rem}
.soft{color:var(--slate);font-weight:400}
.dot{flex:none;width:8px;height:8px;margin-top:.45rem;border-radius:50%;background:var(--slate);opacity:.5}
.dot.on{background:var(--accent);opacity:1;box-shadow:0 0 0 3px #0f6e6e1f}
.dot.busy{background:var(--amber);opacity:1}
.dot.error{background:var(--red);opacity:1}
.count{margin-top:.25rem;font-size:.75rem;color:var(--accent)}
.services{list-style:none;margin:.25rem 0 0;padding:0 0 0 .75rem;border-left:2px solid #0f6e6e26}
.services li{display:flex;flex-wrap:wrap;gap:.5rem;align-items:baseline;padding:.125rem 0}
.service{color:var(--accent);text-decoration:underline;text-decoration-color:#0f6e6e4d;text-underline-offset:2px;overflow-wrap:anywhere}
.approve{margin:.75rem 0 0 1.25rem}
.hint{color:var(--slate);font-size:.8125rem;margin:.5rem 0 0}
.empty{color:var(--slate);margin:.25rem 0}
.version{color:var(--slate);font-size:.75rem;text-align:right;margin:0}
.btn{display:inline-block;font:inherit;font-size:.875rem;font-weight:500;border-radius:.5rem;padding:.4rem .9rem;cursor:pointer;text-decoration:none;white-space:nowrap}
.btn.primary{background:var(--accent);color:#fff;border:1px solid var(--accent)}
.btn.primary:hover{background:var(--accent-strong)}
.btn.secondary{background:transparent;color:var(--navy);border:1px solid #0f274426}
.btn.secondary:hover{background:#0f274408}
.btn:disabled{opacity:.6;cursor:default}
.btn:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
label{display:block;color:var(--navy);font-size:.875rem;font-weight:500;margin-bottom:.25rem}
.inline{display:flex;gap:.5rem;flex-wrap:wrap}
input{flex:1;min-width:12rem;font:inherit;padding:.4rem .75rem;border:1px solid #0f27441f;border-radius:.5rem;background:#fff;color:var(--ink)}
.alert{background:#dc26260f;border:1px solid #dc262626;color:var(--red);border-radius:.5rem;padding:.75rem 1rem}
`;

/**
 * The page's behaviour. DSM guards its CGIs with a token next to the session
 * cookie, and hands it to the page's own origin at /webman/login.cgi -- the
 * way Tailscale's package gets it. Every request carries it in X-SYNO-TOKEN,
 * which is also what keeps another site's form from posting here.
 */
const SCRIPT = `
const status = document.getElementById("status");
const error = document.getElementById("error");
const form = document.getElementById("login");
let token = null;
let busy = false;

function say(message) {
  error.textContent = message || "";
  error.hidden = !message;
}

async function synoToken() {
  const response = await fetch("/webman/login.cgi", { credentials: "same-origin" });
  const body = await response.json();
  return body.SynoToken || "";
}

async function api(path, body) {
  if (token === null) token = await synoToken().catch(() => "");
  const headers = { "X-SYNO-TOKEN": token };
  if (body) headers["Content-Type"] = "application/json";
  const response = await fetch("api/" + path, {
    method: body ? "POST" : "GET",
    credentials: "same-origin",
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const answer = await response.json().catch(() => ({ error: TEXT.stale }));
  // A token that has gone stale with the DSM session: fetch a new one next time.
  if (response.status === 401) token = null;
  return answer;
}

function show(answer) {
  if (answer.html !== undefined) status.innerHTML = answer.html;
  say(answer.error);
}

async function refresh() {
  if (busy) return;
  try {
    show(await api("view"));
  } catch {
    say(TEXT.stale);
  }
}

status.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  button.disabled = true;
  busy = true;
  try {
    show(await api(button.dataset.action, { id: button.dataset.id }));
  } catch {
    say(TEXT.stale);
  } finally {
    busy = false;
    button.disabled = false;
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = form.querySelector("button");
  const input = form.querySelector("input");
  button.disabled = true;
  button.textContent = TEXT.signingIn;
  busy = true;
  try {
    const answer = await api("login", { controlUrl: input.value });
    show(answer);
    if (!answer.error) input.value = "";
  } catch {
    say(TEXT.stale);
  } finally {
    busy = false;
    button.disabled = false;
    button.textContent = TEXT.signIn;
  }
});

// A hidden tab asks nobody: every request here starts a process on the NAS.
setInterval(() => { if (!document.hidden) refresh(); }, 3000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
refresh();
`;
