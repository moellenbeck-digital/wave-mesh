import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { buildAuthorizationHeader, generateKeyPair, signRelease } from "@wave/crypto";
import type { ServerMessage, UpdateChannel } from "@wave/proto";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.ts";
import { createProviders } from "../src/auth/providers.ts";
import { nodes } from "../src/db/schema.ts";
import { parseUpdateChannels } from "../src/env.ts";
import { ReleaseFeed } from "../src/updates/releases.ts";
import { CookieJar, createTestDb, createWaveAs, type TestDb, testConfig, testSigningKey } from "./helpers.ts";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
});

afterAll(() => testDb.close());

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

const API = "https://api.github.test";
const STORAGE = "https://objects.github.test";
const REPO = "acme/wave";

interface FakeRelease {
  tag: string;
  manifest?: unknown;
  /** Archive name to its bytes. */
  archives: Record<string, string>;
}

/**
 * Just enough of GitHub: the release list, the asset route that redirects to
 * storage, and the storage that serves the bytes. It writes down every
 * request, so a test can see where the token went.
 */
function fakeGithub(releases: FakeRelease[]) {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const bytes = new Map<number, string>();
  let nextId = 1;

  const listing = () =>
    releases.map((release) => {
      const assets: Array<{ id: number; name: string }> = [];
      if (release.manifest !== undefined) {
        const id = nextId++;
        bytes.set(id, JSON.stringify(release.manifest));
        assets.push({ id, name: "manifest.json" });
      }
      for (const [name, content] of Object.entries(release.archives)) {
        const id = nextId++;
        bytes.set(id, content);
        assets.push({ id, name });
      }
      return { tag_name: release.tag, draft: false, assets };
    });

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    requests.push({ url, authorization: headers.get("authorization") });
    if (url === `${API}/repos/${REPO}/releases?per_page=50`) return Response.json(listing());
    const asset = /\/releases\/assets\/(\d+)$/.exec(url);
    if (asset && url.startsWith(API)) {
      return new Response(null, { status: 302, headers: { location: `${STORAGE}/${asset[1]}` } });
    }
    if (url.startsWith(STORAGE)) {
      const content = bytes.get(Number(url.slice(STORAGE.length + 1)));
      return content === undefined ? new Response("gone", { status: 404 }) : new Response(content);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  return { fetch: fetchImpl, requests };
}

const releaseKey = generateKeyPair("ed25519");

/** A release as the release job makes it: archives, hashed, under a signed manifest. */
function release(
  version: string,
  options: { key?: ReturnType<typeof generateKeyPair>; channel?: UpdateChannel; claim?: string } = {},
): FakeRelease {
  const content = `wave ${version} for linux-amd64`;
  const name = "wave-linux-amd64.tar.gz";
  const channel =
    options.channel ??
    (version.includes("-insiders.") ? "insiders" : version.includes("-develop.") ? "develop" : "stable");
  const manifest = {
    version: options.claim ?? version,
    channel,
    archives: [
      {
        name,
        platform: "linux-amd64",
        sha256: createHash("sha256").update(content).digest("hex"),
        size: Buffer.byteLength(content),
      },
    ],
  };
  return {
    tag: `v${version}`,
    manifest: { manifest, ...signRelease(manifest, (options.key ?? releaseKey).privateKey) },
    archives: { [name]: content },
  };
}

function feed(
  releases: FakeRelease[],
  channels: UpdateChannel[] = ["stable", "insiders"],
  token = "secret-token",
) {
  const github = fakeGithub(releases);
  const logs: string[] = [];
  const releasesFeed = new ReleaseFeed({
    repo: REPO,
    token,
    channels,
    trusted: [releaseKey.publicKey],
    fetch: github.fetch,
    apiBase: API,
    log: (message) => logs.push(message),
  });
  return { feed: releasesFeed, github, logs };
}

describe("WAVE_UPDATE_CHANNELS", () => {
  test("is a list, the first entry the default, duplicates folded", () => {
    expect(parseUpdateChannels("insiders, stable,insiders")).toEqual(["insiders", "stable"]);
    expect(testConfig().updates.channels).toEqual(["stable"]);
    expect(testConfig({ WAVE_UPDATE_CHANNELS: "insiders,stable" }).updates.channels).toEqual([
      "insiders",
      "stable",
    ]);
  });

  test("refuses a name that is not a channel, rather than never updating", () => {
    expect(() => parseUpdateChannels("stable,beta")).toThrow(/beta/);
    expect(() => parseUpdateChannels(" , ")).toThrow();
  });
});

describe("the release feed", () => {
  test("gives a device its wish where the server offers it, and the default otherwise", () => {
    const { feed: releases } = feed([], ["insiders", "stable"]);
    expect(releases.assign("stable")).toBe("stable");
    expect(releases.assign("develop")).toBe("insiders");
    expect(releases.assign(null)).toBe("insiders");
  });

  test("finds the newest release each offered channel takes", async () => {
    const { feed: releases } = feed([
      release("0.1.0"),
      release("0.2.0-insiders.1"),
      release("0.2.0-develop.3"),
      release("0.0.9"),
    ]);
    await releases.refresh();
    expect(releases.offerFor("stable").offer?.manifest.version).toBe("0.1.0");
    expect(releases.offerFor("insiders").offer?.manifest.version).toBe("0.2.0-insiders.1");
    // Not offered here, so the default instead -- never develop.
    const fallback = releases.offerFor("develop");
    expect(fallback.channel).toBe("stable");
    expect(fallback.channels).toEqual(["stable", "insiders"]);
    expect(fallback.offer?.manifest.version).toBe("0.1.0");
  });

  test("insiders also takes a stable that is newer than every insiders build", async () => {
    const { feed: releases } = feed([release("0.2.0"), release("0.2.0-insiders.4")]);
    await releases.refresh();
    expect(releases.offerFor("insiders").offer?.manifest.version).toBe("0.2.0");
  });

  test("passes over a manifest signed with a key nobody trusts", async () => {
    const { feed: releases, logs } = feed([
      release("0.3.0", { key: generateKeyPair("ed25519") }),
      release("0.2.0"),
    ]);
    await releases.refresh();
    expect(releases.offerFor("stable").offer?.manifest.version).toBe("0.2.0");
    expect(logs.join("\n")).toMatch(/v0\.3\.0 is not offered: .*not signed/);
  });

  test("passes over a manifest that claims another version than its tag", async () => {
    const { feed: releases, logs } = feed([release("0.3.0", { claim: "0.9.0" }), release("0.2.0")]);
    await releases.refresh();
    expect(releases.offerFor("stable").offer?.manifest.version).toBe("0.2.0");
    expect(logs.join("\n")).toMatch(/manifest says 0\.9\.0/);
  });

  test("passes over a manifest whose channel is not its tag's", async () => {
    // A develop build relabelled as stable is exactly what the signed channel prevents.
    const { feed: releases } = feed([release("0.3.0", { channel: "develop" }), release("0.2.0")]);
    await releases.refresh();
    expect(releases.offerFor("stable").offer?.manifest.version).toBe("0.2.0");
  });

  test("tells its listeners when a channel moves, and only then", async () => {
    const list = [release("0.1.0")];
    const { feed: releases } = feed(list);
    let told = 0;
    releases.onChange(() => told++);
    await releases.refresh();
    await releases.refresh();
    expect(told).toBe(1);
  });

  test("follows the storage redirect without the token", async () => {
    const { feed: releases, github } = feed([release("0.2.0")]);
    await releases.refresh();
    const res = await releases.download("0.2.0", "wave-linux-amd64.tar.gz");
    expect(await res?.text()).toBe("wave 0.2.0 for linux-amd64");
    for (const request of github.requests) {
      if (request.url.startsWith(STORAGE)) expect(request.authorization).toBeNull();
      else expect(request.authorization).toBe("Bearer secret-token");
    }
  });

  test("hands out nothing that is not an archive of an offered release", async () => {
    const { feed: releases } = feed([release("0.2.0"), release("0.1.0")]);
    await releases.refresh();
    expect(await releases.download("0.1.0", "wave-linux-amd64.tar.gz")).toBeNull();
    expect(await releases.download("0.2.0", "manifest.json")).toBeNull();
    expect(await releases.download("0.2.0", "../../etc/passwd")).toBeNull();
  });

  test("offers nothing without a token, and asks GitHub nothing", async () => {
    const github = fakeGithub([release("0.2.0")]);
    const logs: string[] = [];
    const releases = new ReleaseFeed({
      repo: REPO,
      channels: ["stable"],
      fetch: github.fetch,
      apiBase: API,
      log: (m) => logs.push(m),
    });
    releases.start();
    await releases.refresh();
    expect(releases.enabled).toBe(false);
    expect(releases.offerFor(null)).toEqual({ channel: "stable", channels: ["stable"], offer: null });
    expect(github.requests).toEqual([]);
    expect(logs.join()).toMatch(/WAVE_GITHUB_TOKEN/);
  });
});

describe("offers over the control socket", () => {
  async function startServer(releases: ReleaseFeed) {
    await testDb.reset();
    const { db } = testDb;
    const config = testConfig();
    const app = createApp({
      db,
      config,
      providers: createProviders(config),
      signingKey: testSigningKey(),
      releases,
    });
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch, websocket: app.websocket });
    cleanup.push(() => server.stop(true));
    return { db, base: `http://127.0.0.1:${server.port}` };
  }

  /** Signs in, makes a wave and enrols one machine into it. */
  async function enrolled(base: string) {
    const jar = new CookieJar();
    const start = await fetch(`${base}/auth/dev/start`, { redirect: "manual" });
    jar.absorb(start);
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    jar.absorb(
      await fetch(`${base}/auth/dev/callback?code=a%40example.com&state=${state}`, {
        headers: { cookie: jar.header() },
        redirect: "manual",
      }),
    );
    await createWaveAs(
      (path, init) => fetch(`${base}${path}`, { ...init, redirect: "manual" }),
      jar,
      "a@example.com",
    );

    const machine = generateKeyPair("ed25519");
    const sign = (method: string, path: string, body = "") =>
      buildAuthorizationHeader({
        machineKey: machine.publicKey,
        machinePrivateKey: machine.privateKey,
        method,
        path,
        body,
      });
    const payload = JSON.stringify({
      machineKey: machine.publicKey,
      nodeKey: generateKeyPair("x25519").publicKey,
      discoKey: generateKeyPair("x25519").publicKey,
      hostname: "laptop",
      os: "linux",
    });
    const pending = (await (
      await fetch(`${base}/v1/machine/register`, {
        method: "POST",
        body: payload,
        headers: {
          "content-type": "application/json",
          authorization: sign("POST", "/v1/machine/register", payload),
        },
      })
    ).json()) as { authUrl: string };
    const form = new FormData();
    form.set("request", new URL(pending.authUrl).searchParams.get("request") ?? "");
    await fetch(`${base}/machine/authorize`, {
      method: "POST",
      body: form,
      headers: { cookie: jar.header() },
    });
    return { sign, jar };
  }

  function connect(base: string, sign: (method: string, path: string) => string) {
    const messages: ServerMessage[] = [];
    const socket = new WebSocket(`${base.replace("http", "ws")}/v1/control`, {
      headers: { authorization: sign("GET", "/v1/control") },
    } as never);
    socket.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data))));
    cleanup.push(() => socket.close());
    return { socket, messages };
  }

  const waitFor = async <T>(predicate: () => T | undefined | false, timeoutMs = 4000): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = predicate();
      if (value) return value;
      if (Date.now() > deadline) throw new Error("timed out");
      await Bun.sleep(20);
    }
  };

  test("answers a hello with the offer for the device's channel, and records what it said", async () => {
    const { feed: releases } = feed([release("0.2.0"), release("0.3.0-insiders.1")]);
    await releases.refresh();
    const { db, base } = await startServer(releases);
    const { sign, jar } = await enrolled(base);

    const { socket, messages } = connect(base, sign);
    await waitFor(() => messages.find((m) => m.type === "netmap"));
    socket.send(
      JSON.stringify({ type: "hello", version: "0.1.0", platform: "linux-amd64", channel: "insiders" }),
    );

    const update = await waitFor(() => messages.find((m) => m.type === "update"));
    expect(update.type === "update" && update.channel).toBe("insiders");
    expect(update.type === "update" && update.offer?.manifest.version).toBe("0.3.0-insiders.1");

    const rows = await db.select().from(nodes).where(eq(nodes.hostname, "laptop"));
    expect(rows[0]?.clientVersion).toBe("0.1.0");
    expect(rows[0]?.clientPlatform).toBe("linux-amd64");
    expect(rows[0]?.updateChannel).toBe("insiders");

    // And the browser sees it in the device list, next to the system.
    const me = (await (await fetch(`${base}/api/me`, { headers: { cookie: jar.header() } })).json()) as {
      waves: { id: string }[];
    };
    const list = (await (
      await fetch(`${base}/api/waves/${me.waves[0]?.id}/nodes`, { headers: { cookie: jar.header() } })
    ).json()) as { nodes: Array<{ clientVersion: string | null; updateChannel: string | null }> };
    expect(list.nodes[0]).toMatchObject({ clientVersion: "0.1.0", updateChannel: "insiders" });
  });

  test("sends nothing to a client that never said hello", async () => {
    const { feed: releases } = feed([release("0.2.0")]);
    const { base } = await startServer(releases);
    const { sign } = await enrolled(base);
    const { messages } = connect(base, sign);
    await waitFor(() => messages.find((m) => m.type === "netmap"));
    await releases.refresh();
    await Bun.sleep(100);
    expect(messages.some((m) => m.type === "update")).toBe(false);
  });

  test("pushes a release found later to every greeted device", async () => {
    const list: FakeRelease[] = [];
    const { feed: releases } = feed(list);
    const { base } = await startServer(releases);
    const { sign } = await enrolled(base);
    const { socket, messages } = connect(base, sign);
    await waitFor(() => messages.find((m) => m.type === "netmap"));
    socket.send(JSON.stringify({ type: "hello", version: "0.1.0", platform: "linux-amd64" }));
    const first = await waitFor(() => messages.find((m) => m.type === "update"));
    expect(first.type === "update" && first.offer).toBeNull();

    list.push(release("0.2.0"));
    await releases.refresh();
    const pushed = await waitFor(() => messages.filter((m) => m.type === "update")[1]);
    expect(pushed.type === "update" && pushed.offer?.manifest.version).toBe("0.2.0");
  });

  test("streams an offered archive to an enrolled device, and to nobody else", async () => {
    const { feed: releases } = feed([release("0.2.0")]);
    await releases.refresh();
    const { base } = await startServer(releases);
    const { sign } = await enrolled(base);
    const path = "/v1/update/0.2.0/wave-linux-amd64.tar.gz";

    const ok = await fetch(`${base}${path}`, { headers: { authorization: sign("GET", path) } });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("wave 0.2.0 for linux-amd64");

    expect((await fetch(`${base}${path}`)).status).toBe(401);
    const stranger = generateKeyPair("ed25519");
    const foreign = buildAuthorizationHeader({
      machineKey: stranger.publicKey,
      machinePrivateKey: stranger.privateKey,
      method: "GET",
      path,
      body: "",
    });
    expect((await fetch(`${base}${path}`, { headers: { authorization: foreign } })).status).toBe(404);

    const other = "/v1/update/0.1.0/wave-linux-amd64.tar.gz";
    expect((await fetch(`${base}${other}`, { headers: { authorization: sign("GET", other) } })).status).toBe(
      404,
    );
  });
});
