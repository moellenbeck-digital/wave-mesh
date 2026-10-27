import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ConnectFailure, type Request, type Response, Status } from "@wave/ipc";
import {
  type CgiRequest,
  type Connect,
  cgiOutput,
  cgiRequest,
  type DaemonLink,
  handle,
  isAdministrator,
  type UiDeps,
} from "../src/dsm-ui.ts";
import { escapeHtml, safeHref, statusFragment } from "../src/dsm-ui-view.ts";

/**
 * The page in DSM, driven the way DSM drives it: a CGI environment in, a CGI
 * answer out. DSM's sign-in and the daemon are stand-ins; what is checked is
 * who gets turned away, what is shown, and what reaches the daemon.
 */

const SCRIPT = "/webman/3rdparty/wave/index.cgi";

const request = (overrides: Partial<CgiRequest> = {}): CgiRequest => ({
  ...cgiRequest({ SCRIPT_NAME: SCRIPT, HTTP_X_SYNO_TOKEN: "token" }),
  ...overrides,
});

const post = (path: string, body: unknown, overrides: Partial<CgiRequest> = {}): CgiRequest =>
  request({
    method: "POST",
    path,
    contentType: "application/json",
    secFetchSite: "same-origin",
    body: JSON.stringify(body),
    ...overrides,
  });

const status = (profiles: unknown[] = []): Status =>
  Status.parse({ daemon: { version: "0.13.0", platform: "linux-x64" }, profiles });

const UP = {
  id: "https://wave.example.com",
  controlUrl: "https://wave.example.com",
  label: "rl.wave.example.com",
  state: "up",
  self: { hostname: "nas", dnsName: "nas.rl.wave.example.com", ipv4: "10.64.0.7" },
  peers: [
    {
      hostname: "laptop",
      dnsName: "laptop.rl.wave.example.com",
      ipv4: "10.64.0.2",
      ipv6: "fd7a::2",
      via: "192.168.1.20:41641",
      rttMs: 3.4,
      lastHandshakeSecondsAgo: 12,
    },
    {
      hostname: "k3s",
      dnsName: "k3s.rl.wave.example.com",
      ipv4: "10.64.0.9",
      ipv6: "fd7a::9",
      via: "relay",
      rttMs: 21,
      services: [
        {
          name: "grafana",
          dnsName: "grafana.rl.wave.example.com",
          ipv4: "10.64.1.1",
          url: "https://grafana.rl.wave.example.com",
        },
      ],
    },
  ],
};

/**
 * A daemon that answers status with whatever `current` says, and the other
 * commands with what `answers` holds -- or never, which is what `login` does
 * while it waits for a person.
 */
function fakeDaemon(
  current: () => Status,
  answers: Partial<Record<Request["command"], Response>> = {},
  failure?: ConnectFailure,
) {
  const sent: Request[] = [];
  let open = 0;
  let statusCalls = 0;
  const connect: Connect = async () => {
    if (failure) return { ok: false, reason: failure };
    open += 1;
    const client: DaemonLink = {
      request: async (asked) => {
        sent.push(asked);
        if (asked.command === "status") {
          statusCalls += 1;
          return { type: "status", status: current() };
        }
        const answer = answers[asked.command];
        return answer ?? new Promise<Response>(() => {});
      },
      close: () => {
        open -= 1;
      },
    };
    return { ok: true, client };
  };
  return {
    connect,
    sent,
    get open() {
      return open;
    },
    get statusCalls() {
      return statusCalls;
    },
  };
}

const deps = (connect: Connect, overrides: Partial<UiDeps> = {}): UiDeps => ({
  authenticate: async () => "admin",
  isAdmin: (user) => user === "admin",
  connect,
  sleep: async () => {},
  nonce: () => "n0nce",
  ...overrides,
});

const parse = (response: { body: string }): { html?: string; error?: string } => JSON.parse(response.body);

describe("the CGI environment", () => {
  test("is read into a request", () => {
    const parsed = cgiRequest(
      {
        REQUEST_METHOD: "post",
        PATH_INFO: "/api/login",
        SCRIPT_NAME: SCRIPT,
        QUERY_STRING: "SynoToken=abc",
        CONTENT_TYPE: "application/json",
        HTTP_ACCEPT_LANGUAGE: "de-DE,de;q=0.9",
        HTTP_SEC_FETCH_SITE: "same-origin",
      },
      "{}",
    );
    expect(parsed).toMatchObject({
      method: "POST",
      path: "/api/login",
      synoToken: "abc",
      contentType: "application/json",
      secFetchSite: "same-origin",
      body: "{}",
    });
  });

  test("an answer goes out as a Status header, the other headers and the body", () => {
    const out = cgiOutput({ status: 403, headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(out).toBe("Status: 403 Forbidden\r\nContent-Type: application/json\r\n\r\n{}");
  });
});

describe("the page", () => {
  test("is reached under the trailing slash its relative paths need", async () => {
    const response = await handle(request({ path: "" }), deps(fakeDaemon(status).connect));
    expect(response.status).toBe(302);
    expect(response.headers.Location).toBe(`${SCRIPT}/`);
  });

  test("allows only its own script and style, by the nonce of this response", async () => {
    const response = await handle(request({ path: "/" }), deps(fakeDaemon(status).connect));
    expect(response.status).toBe(200);
    expect(response.headers["Content-Security-Policy"]).toContain("script-src 'nonce-n0nce'");
    expect(response.body).toContain('<script nonce="n0nce">');
    // Nothing from anywhere else: a NAS is often offline, and this is DSM's origin.
    expect(response.body).not.toMatch(/(src|href)="https?:/);
  });

  test("speaks the browser's language, and English otherwise", async () => {
    const daemon = fakeDaemon(status);
    const german = await handle(
      request({ path: "/", acceptLanguage: "de-DE,de;q=0.9" }),
      deps(daemon.connect),
    );
    expect(german.body).toContain("Einem Wave beitreten");
    expect(german.body).toContain('<html lang="de">');
    const french = await handle(request({ path: "/", acceptLanguage: "fr-FR" }), deps(daemon.connect));
    expect(french.body).toContain("Join a wave");
  });

  test("asks the daemon nothing, and DSM nothing either", async () => {
    const daemon = fakeDaemon(status);
    let asked = 0;
    const authenticate = async () => {
      asked += 1;
      return "admin";
    };
    await handle(request({ path: "/" }), deps(daemon.connect, { authenticate }));
    expect(asked).toBe(0);
    expect(daemon.sent).toEqual([]);
  });
});

describe("who may use it", () => {
  test("nobody without DSM's token -- DSM is not even asked", async () => {
    let asked = 0;
    const response = await handle(
      request({ path: "/api/view", synoToken: null }),
      deps(fakeDaemon(status).connect, {
        authenticate: async () => {
          asked += 1;
          return "admin";
        },
      }),
    );
    expect(response.status).toBe(401);
    expect(asked).toBe(0);
  });

  test("nobody DSM does not confirm", async () => {
    const daemon = fakeDaemon(status);
    const response = await handle(
      request({ path: "/api/view" }),
      deps(daemon.connect, { authenticate: async () => null }),
    );
    expect(response.status).toBe(401);
    expect(daemon.sent).toEqual([]);
  });

  test("no account that is not an administrator", async () => {
    const daemon = fakeDaemon(status);
    const response = await handle(
      request({ path: "/api/view", acceptLanguage: "de" }),
      deps(daemon.connect, { authenticate: async () => "guest" }),
    );
    expect(response.status).toBe(403);
    expect(parse(response).error).toContain("Administratoren");
    expect(daemon.sent).toEqual([]);
  });

  test("changes only as a JSON POST from DSM's own pages", async () => {
    const daemon = fakeDaemon(status);
    const login = { controlUrl: "wave.example.com" };
    expect((await handle(request({ path: "/api/login" }), deps(daemon.connect))).status).toBe(405);
    expect(
      (
        await handle(
          post("/api/login", login, { contentType: "application/x-www-form-urlencoded" }),
          deps(daemon.connect),
        )
      ).status,
    ).toBe(415);
    expect(
      (await handle(post("/api/login", login, { secFetchSite: "cross-site" }), deps(daemon.connect))).status,
    ).toBe(403);
    expect(daemon.sent).toEqual([]);
  });

  test("an administrator, from /etc/group", () => {
    const dir = mkdtempSync(join(tmpdir(), "wave-dsm-ui-"));
    const groups = join(dir, "group");
    writeFileSync(groups, "users:x:100:robin,guest\nadministrators:x:101:admin,robin\nwave:x:65536:robin\n");
    expect(isAdministrator("robin", groups)).toBe(true);
    expect(isAdministrator("admin", groups)).toBe(true);
    expect(isAdministrator("guest", groups)).toBe(false);
    expect(isAdministrator("robin", join(dir, "missing"))).toBe(false);
  });
});

describe("what it shows", () => {
  test("the waves, the devices in them and what they serve", async () => {
    const daemon = fakeDaemon(() => status([UP]));
    const response = await handle(request({ path: "/api/view" }), deps(daemon.connect));
    expect(response.status).toBe(200);
    const html = parse(response).html ?? "";
    expect(html).toContain("rl.wave.example.com");
    expect(html).toContain("10.64.0.7 · nas.rl.wave.example.com");
    expect(html).toContain("laptop");
    expect(html).toContain("direct 192.168.1.20:41641 · 3 ms");
    expect(html).toContain("via relay · 21 ms");
    expect(html).toContain('href="https://grafana.rl.wave.example.com/"');
    expect(html).toContain('data-action="down" data-id="https://wave.example.com"');
    expect(daemon.open).toBe(0);
  });

  test("the approval link while a wave waits for one", () => {
    const html = statusFragment(
      status([
        {
          controlUrl: "https://wave.example.com",
          state: "waiting-for-approval",
          authUrl: "https://wave.example.com/machine/authorize?id=abc",
        },
      ]),
      "de",
    );
    expect(html).toContain('href="https://wave.example.com/machine/authorize?id=abc"');
    expect(html).toContain("Im Browser freigeben");
    expect(html).toContain('data-action="down"');
  });

  test("says how to set the service up when there is none", async () => {
    const response = await handle(
      request({ path: "/api/view" }),
      deps(fakeDaemon(status, {}, "no-daemon").connect),
    );
    expect(parse(response).html).toContain("sudo /var/packages/wave/scripts/setup");
  });

  test("says the setup has to run again when the socket turns the page away", async () => {
    const response = await handle(
      request({ path: "/api/view", acceptLanguage: "de" }),
      deps(fakeDaemon(status, {}, "denied").connect),
    );
    expect(parse(response).html).toContain("Führe das Setup noch einmal aus");
  });

  test("nothing a control server wrote becomes markup", () => {
    const evil = {
      ...UP,
      label: '<img src=x onerror="alert(1)">',
      peers: [
        {
          hostname: "<script>alert(1)</script>",
          dnsName: "x",
          ipv4: "10.64.0.3",
          ipv6: "",
          services: [{ name: "s", dnsName: "s.example", ipv4: "10.64.1.2", url: "javascript:alert(1)" }],
        },
      ],
    };
    const html = statusFragment(status([evil]), "en");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    // A link only to http and https: a javascript: URL would run with the administrator's session.
    expect(html).not.toContain("javascript:");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("https://a.example/x")).toBe("https://a.example/x");
    expect(escapeHtml(`"'&`)).toBe("&quot;&#39;&amp;");
  });
});

describe("signing in", () => {
  test("hands the daemon the server, waits for the approval link and lets go", async () => {
    let calls = 0;
    const daemon = fakeDaemon(() => {
      calls += 1;
      return calls < 3
        ? status([{ controlUrl: "https://wave.example.com", state: "starting" }])
        : status([
            {
              controlUrl: "https://wave.example.com",
              state: "waiting-for-approval",
              authUrl: "https://wave.example.com/machine/authorize?id=1",
            },
          ]);
    });
    const response = await handle(
      post("/api/login", { controlUrl: " wave.example.com/ " }),
      deps(daemon.connect),
    );
    expect(response.status).toBe(200);
    // Normalised the way `wave login` does it, before anything is stored.
    expect(daemon.sent[0]).toEqual({ command: "login", controlUrl: "https://wave.example.com" });
    expect(parse(response).html).toContain("machine/authorize?id=1");
    // The daemon carries the enrolment on; the page polls from here.
    expect(daemon.open).toBe(0);
  });

  test("gives up waiting after a while, and shows where things stand", async () => {
    const daemon = fakeDaemon(() => status([{ controlUrl: "https://wave.example.com", state: "starting" }]));
    const response = await handle(
      post("/api/login", { controlUrl: "https://wave.example.com" }),
      deps(daemon.connect),
    );
    expect(response.status).toBe(200);
    expect(parse(response).html).toContain("wave.example.com");
    expect(daemon.statusCalls).toBeGreaterThan(10);
    expect(daemon.open).toBe(0);
  });

  test("stops waiting as soon as the daemon says why it cannot get on", async () => {
    const daemon = fakeDaemon(() =>
      status([
        {
          controlUrl: "https://wave.example.com",
          state: "starting",
          message: "waiting for the control server",
          notice: { code: "waiting-for-control", params: { reason: "ECONNREFUSED" } },
        },
      ]),
    );
    await handle(post("/api/login", { controlUrl: "https://wave.example.com" }), deps(daemon.connect));
    expect(daemon.statusCalls).toBe(1);
  });

  test("an address that is not one is refused before the daemon hears of it", async () => {
    const daemon = fakeDaemon(status);
    const response = await handle(post("/api/login", { controlUrl: "ftp://nope" }), deps(daemon.connect));
    expect(response.status).toBe(400);
    expect(parse(response).error).toContain("ftp://nope");
    expect(daemon.sent).toEqual([]);
  });

  test("a refusal from the daemon is said", async () => {
    const daemon = fakeDaemon(status, {
      login: { type: "error", message: "the daemon said no", notice: null },
    });
    const response = await handle(
      post("/api/login", { controlUrl: "https://wave.example.com" }),
      deps(daemon.connect),
    );
    expect(parse(response).error).toBe("the daemon said no");
    expect(parse(response).html).toBeDefined();
  });
});

describe("connecting and disconnecting", () => {
  test("names the wave by its key and answers with the status after", async () => {
    let down = false;
    const daemon = fakeDaemon(
      () => status([{ ...UP, state: down ? "stopped" : "up", peers: down ? [] : UP.peers }]),
      {
        down: { type: "ok" },
      },
    );
    const pending = handle(post("/api/down", { id: "https://wave.example.com" }), deps(daemon.connect));
    down = true;
    const response = await pending;
    expect(daemon.sent[0]).toEqual({ command: "down", controlUrl: "https://wave.example.com" });
    expect(parse(response).html).toContain('data-action="up"');
    expect(daemon.open).toBe(0);
  });

  test("without a wave there is nothing to send", async () => {
    const daemon = fakeDaemon(status);
    const response = await handle(post("/api/up", {}), deps(daemon.connect));
    expect(response.status).toBe(400);
    expect(daemon.sent).toEqual([]);
  });
});
