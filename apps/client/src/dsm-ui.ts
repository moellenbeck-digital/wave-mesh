import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { type Locale, requestLocale } from "@wave/i18n";
import {
  type ConnectFailure,
  DaemonClient,
  DEFAULT_SOCKET_PATH,
  type Response as Reply,
  type Request,
  readNotice,
  type Status,
} from "@wave/ipc";
import { page, statusFragment, uiText, unreachableFragment } from "./dsm-ui-view.ts";
import { normaliseControlUrl } from "./state.ts";

/**
 * `wave dsm-ui`: the package's page in DSM, run as a CGI.
 *
 * DSM links the package's `ui/` folder to /webman/3rdparty/wave/ and runs
 * `index.cgi` there on DSM's own origin, as the package's user, for every
 * request -- the arrangement Tailscale's package uses. The CGI is this binary;
 * it starts, answers one request from its environment and stdin, and ends.
 * Nothing here holds state: the daemon has it all, and the page asks again.
 *
 * Who may use it is DSM's to say. A request without DSM's token is turned
 * away before anything else happens, and with one, DSM's own authenticate.cgi
 * names the signed-in account -- which then has to be an administrator. The
 * daemon runs as root and a sign-in puts this NAS into somebody's network;
 * that is not a decision for every account that can open DSM.
 */

/** The parts of a CGI request this page reads. */
export interface CgiRequest {
  method: string;
  /** PATH_INFO: what follows index.cgi, e.g. "/api/view". */
  path: string;
  /** SCRIPT_NAME: index.cgi itself, for the one redirect. */
  scriptName: string;
  synoToken: string | null;
  secFetchSite: string | null;
  contentType: string | null;
  acceptLanguage: string | null;
  cookie: string | null;
  body: string;
}

export function cgiRequest(env: Record<string, string | undefined>, body = ""): CgiRequest {
  const query = new URLSearchParams(env.QUERY_STRING ?? "");
  return {
    method: (env.REQUEST_METHOD ?? "GET").toUpperCase(),
    path: env.PATH_INFO ?? "",
    scriptName: env.SCRIPT_NAME ?? "/webman/3rdparty/wave/index.cgi",
    // DSM accepts the token as a header or in the query; the page sends the header.
    synoToken: env.HTTP_X_SYNO_TOKEN || query.get("SynoToken") || null,
    secFetchSite: env.HTTP_SEC_FETCH_SITE ?? null,
    contentType: env.CONTENT_TYPE ?? null,
    acceptLanguage: env.HTTP_ACCEPT_LANGUAGE ?? null,
    cookie: env.HTTP_COOKIE ?? null,
    body,
  };
}

export interface CgiResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const REASONS: Record<number, string> = {
  200: "OK",
  302: "Found",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  415: "Unsupported Media Type",
};

/** The response as a CGI writes it: a Status header, the rest, a blank line, the body. */
export function cgiOutput(response: CgiResponse): string {
  const lines = [`Status: ${response.status} ${REASONS[response.status] ?? ""}`.trim()];
  for (const [name, value] of Object.entries(response.headers)) lines.push(`${name}: ${value}`);
  return `${lines.join("\r\n")}\r\n\r\n${response.body}`;
}

/** What the handler needs from the daemon: one request at a time on one connection. */
export interface DaemonLink {
  request(request: Request, timeoutMs?: number): Promise<Reply>;
  close(): void;
}

export type Connect = () => Promise<{ ok: true; client: DaemonLink } | { ok: false; reason: ConnectFailure }>;

export interface UiDeps {
  /** The signed-in DSM account, or null when DSM does not confirm one. */
  authenticate(): Promise<string | null>;
  isAdmin(user: string): boolean;
  connect: Connect;
  sleep?: (ms: number) => Promise<void>;
  nonce?: () => string;
}

/**
 * How long a sign-in waits for the daemon to name the approval link.
 *
 * Not for the approval itself -- that waits for a person, for minutes, and a
 * CGI cannot hold a request that long. The daemon carries the enrolment on
 * after the connection closes (it never cancelled on a client going away), so
 * the request only has to stay until the link is there to show; the page's
 * polling takes it from there.
 */
const LOGIN_WAIT_MS = 10_000;
/** The same for up and down: long enough for "down", which is quick; "up" may wait for a person. */
const ACTION_WAIT_MS = 3_000;
const POLL_MS = 250;

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

const json = (status: number, body: unknown): CgiResponse => ({
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", ...NO_STORE },
  body: JSON.stringify(body),
});

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function handle(request: CgiRequest, deps: UiDeps): Promise<CgiResponse> {
  const locale = requestLocale({ cookie: request.cookie, acceptLanguage: request.acceptLanguage });
  const text = uiText(locale);

  // The page's links are relative ("api/view"), which only resolve under the
  // trailing slash. DSM's menu opens it with one; a hand-typed URL may not.
  if (request.path === "") {
    return { status: 302, headers: { Location: `${request.scriptName}/`, ...NO_STORE }, body: "" };
  }

  if (request.path === "/") {
    if (request.method !== "GET" && request.method !== "HEAD") return json(405, { error: "method" });
    const nonce = deps.nonce?.() ?? randomBytes(16).toString("base64");
    return {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        // Only what the page itself brings, and only on DSM's origin. The page
        // shows names a control server chose; escaped, they cannot become
        // markup, and if one ever did, this keeps it from running.
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'`,
        "Referrer-Policy": "no-referrer",
        ...NO_STORE,
      },
      // The page itself holds nothing: every word on it is the same for anyone,
      // and what the daemon knows only comes through the API below.
      body: request.method === "HEAD" ? "" : page(locale, nonce),
    };
  }

  const action = /^\/api\/(view|login|up|down)$/.exec(request.path)?.[1];
  if (!action) return json(404, { error: "not-found" });

  // DSM's token first: without it, authenticate.cgi is not even asked.
  if (!request.synoToken) return json(401, { error: text.notSignedIn });
  const user = await deps.authenticate();
  if (!user) return json(401, { error: text.notSignedIn });
  if (!deps.isAdmin(user)) return json(403, { error: text.notAdmin });

  if (action === "view") {
    if (request.method !== "GET") return json(405, { error: "method" });
    return json(200, { html: await view(deps.connect, locale) });
  }

  // Changes only by POST, only as JSON and only from DSM's own pages. DSM's
  // token is the real guard; a form on another site can send neither the
  // header nor this content type without a preflight it would not pass.
  if (request.method !== "POST") return json(405, { error: "method" });
  if (!request.contentType?.toLowerCase().startsWith("application/json")) return json(415, { error: "json" });
  if (request.secFetchSite && request.secFetchSite !== "same-origin")
    return json(403, { error: "cross-site" });

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(request.body || "{}");
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return json(400, { error: "json" });
  }

  const sleep = deps.sleep ?? delay;

  if (action === "login") {
    const typed = typeof body.controlUrl === "string" ? body.controlUrl : "";
    // Refused here rather than stored, as `wave login` does: an address that is
    // not one becomes an enrolment that can never come up.
    const controlUrl = normaliseControlUrl(typed);
    if (!controlUrl) return json(400, { error: text.notAControlUrl(typed.trim()) });
    return json(
      200,
      await act(deps.connect, { command: "login", controlUrl }, locale, sleep, LOGIN_WAIT_MS, (status) =>
        // Something to show: the link, the end, or the daemon saying why it
        // waits -- a server it cannot reach is retried for as long as anyone
        // likes, and that is better said now than after the whole wait.
        status.profiles.some(
          (profile) =>
            profile.controlUrl === controlUrl &&
            (profile.authUrl !== null ||
              profile.state === "up" ||
              profile.state === "failed" ||
              !!profile.notice),
        ),
      ),
    );
  }

  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return json(400, { error: "id" });
  return json(
    200,
    await act(
      deps.connect,
      { command: action as "up" | "down", controlUrl: id },
      locale,
      sleep,
      ACTION_WAIT_MS,
    ),
  );
}

async function statusOf(client: DaemonLink): Promise<Status | null> {
  const response = await client.request({ command: "status" }, 5_000);
  return response.type === "status" ? response.status : null;
}

async function view(connect: Connect, locale: Locale): Promise<string> {
  const attempt = await connect();
  if (!attempt.ok) return unreachableFragment(attempt.reason, locale);
  try {
    const status = await statusOf(attempt.client);
    return status ? statusFragment(status, locale) : unreachableFragment("unreachable", locale);
  } finally {
    attempt.client.close();
  }
}

/**
 * Sends one command and answers with the status once there is something to
 * show -- or once the wait is up, whichever is first.
 *
 * Two connections, because one cannot both wait for an answer and ask for the
 * status: the client hands every reply to the oldest pending request, so a
 * status asked for on the same connection would be taken for the answer to
 * the command (the same reason `wave login` opens a second one).
 */
async function act(
  connect: Connect,
  command: Request,
  locale: Locale,
  sleep: (ms: number) => Promise<void>,
  waitMs: number,
  done: (status: Status) => boolean = () => false,
): Promise<{ html: string; error?: string }> {
  const sender = await connect();
  if (!sender.ok) return { html: unreachableFragment(sender.reason, locale) };
  const watcher = await connect();
  if (!watcher.ok) {
    sender.client.close();
    return { html: unreachableFragment(watcher.reason, locale) };
  }

  const reply: { response?: Reply } = {};
  void sender.client.request(command, 2 ** 31 - 1).then((response) => {
    reply.response = response;
  });

  try {
    let status: Status | null = null;
    for (let waited = 0; ; waited += POLL_MS) {
      await sleep(POLL_MS);
      if (reply.response?.type === "error") {
        // A refusal is the answer, in the reader's language where it came as a code.
        const current = await statusOf(watcher.client);
        return {
          html: current ? statusFragment(current, locale) : unreachableFragment("unreachable", locale),
          error: readNotice(reply.response, locale) ?? reply.response.message,
        };
      }
      status = reply.response?.type === "status" ? reply.response.status : await statusOf(watcher.client);
      if (reply.response || (status && done(status)) || waited >= waitMs) break;
    }
    return { html: status ? statusFragment(status, locale) : unreachableFragment("unreachable", locale) };
  } finally {
    // Closing does not stop what was asked: the daemon carries an enrolment on
    // without anyone listening, and the page's next poll shows where it got.
    sender.client.close();
    watcher.client.close();
  }
}

/** Where DSM keeps the CGI that names the account behind a request's session. */
export const AUTHENTICATE_CGI = "/usr/syno/synoman/webman/modules/authenticate.cgi";

/**
 * Asks DSM who is signed in. authenticate.cgi reads the same CGI environment
 * this process was given -- the session cookie and the token -- and prints
 * the account's name, or fails. Tailscale's package asks it the same way.
 */
async function authenticateWithDsm(): Promise<string | null> {
  try {
    const proc = Bun.spawn([AUTHENTICATE_CGI], { env: process.env, stdout: "pipe", stderr: "ignore" });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const user = out.trim();
    // One plain account name or nothing: anything else is not an answer to trust.
    return code === 0 && /^[^\s:/]+$/.test(user) ? user : null;
  } catch {
    return null;
  }
}

/** Whether an account is in DSM's `administrators` group, from the group database. */
export function isAdministrator(user: string, groupFile = "/etc/group"): boolean {
  try {
    for (const line of readFileSync(groupFile, "utf8").split("\n")) {
      const [name, , , members] = line.split(":");
      if (name === "administrators") return (members ?? "").split(",").includes(user);
    }
  } catch {
    // No group database: nobody is an administrator.
  }
  return false;
}

/** Runs one request from the CGI environment and writes the answer to stdout. */
export async function runDsmUi(env: Record<string, string | undefined> = process.env): Promise<void> {
  const length = Number(env.CONTENT_LENGTH ?? 0);
  const body = length > 0 ? (await Bun.stdin.text()).slice(0, length) : "";
  const response = await handle(cgiRequest(env, body), {
    authenticate: authenticateWithDsm,
    isAdmin: (user) => isAdministrator(user),
    connect: () => DaemonClient.open(env.WAVE_SOCKET ?? DEFAULT_SOCKET_PATH),
  });
  await Bun.write(Bun.stdout, cgiOutput(response));
}
