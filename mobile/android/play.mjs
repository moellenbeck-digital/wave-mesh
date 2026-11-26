#!/usr/bin/env node
// Talks to the Google Play Developer API for .github/workflows/play.yml.
//
//   node play.mjs next-version-code
//       Prints the next free versionCode: the highest one Play knows (every
//       uploaded bundle and every track release, whoever uploaded it), plus one.
//       The same reasoning as ios/next-build-number.mjs: a counter of our own
//       would collide with the first upload made by hand, and Play refuses a
//       versionCode it has seen.
//
//   node play.mjs upload --bundle app-release.aab --track internal|production --version-code N
//       Uploads the bundle in one edit, puts it on the track and commits.
//       It refuses a bundle whose versionCode is not the one the build was
//       given, so a stale AAB can never ride on a fresh number.
//
//   PLAY_SERVICE_ACCOUNT_FILE   path of the service account's JSON key (a temporary file)
//   PLAY_PACKAGE_NAME           the application id
//
// No dependencies: Node's own crypto signs the token and its own fetch calls
// the API. Nothing secret is printed -- on a failure, only the HTTP status and
// the message Google gives.
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
const UPLOAD_API = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
export const TRACKS = ["internal", "production"];

const b64u = (value) => Buffer.from(value).toString("base64url");

/** The highest versionCode in whatever the edit lists; 0 when there is none. */
export function highestVersionCode({ bundles = [], apks = [], tracks = [] } = {}) {
  let highest = 0;
  const see = (value) => {
    const number = Number.parseInt(String(value ?? ""), 10);
    if (Number.isFinite(number) && number > highest) highest = number;
  };
  for (const bundle of bundles) see(bundle?.versionCode);
  for (const apk of apks) see(apk?.versionCode);
  for (const track of tracks) {
    for (const release of track?.releases ?? []) {
      for (const code of release?.versionCodes ?? []) see(code);
    }
  }
  return highest;
}

/** The body that puts one versionCode on a track. */
export function trackBody(track, versionCode, status = "completed") {
  if (!TRACKS.includes(track)) throw new Error(`track must be one of ${TRACKS.join(", ")}`);
  return { track, releases: [{ versionCodes: [String(versionCode)], status }] };
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i];
    if (!name?.startsWith("--") || rest[i + 1] === undefined) throw new Error(`bad argument: ${name}`);
    options[name.slice(2)] = rest[i + 1];
  }
  return { command, options };
}

/** A signed service-account JWT, ready to be exchanged for an access token. */
export function signJwt(account, now = Math.floor(Date.now() / 1000)) {
  const header = b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64u(
    JSON.stringify({
      iss: account.client_email,
      scope: SCOPE,
      aud: account.token_uri ?? "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 600,
    }),
  );
  const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(account.private_key);
  return `${header}.${claims}.${b64u(signature)}`;
}

async function accessToken(file) {
  const account = JSON.parse(readFileSync(file, "utf8"));
  if (!account.client_email || !account.private_key) {
    throw new Error("the service account file has no client_email or private_key");
  }
  const response = await fetch(account.token_uri ?? "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: signJwt(account),
    }),
  });
  if (!response.ok) throw new Error(`Google's token endpoint answered ${response.status}`);
  return (await response.json()).access_token;
}

async function call(token, method, url, { body, raw, contentType } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": contentType ?? "application/json" } : {}),
    },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await response.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    // not JSON; the status says enough
  }
  if (!response.ok) {
    throw new Error(`Google Play answered ${response.status} for ${method} ${new URL(url).pathname.split("/").slice(-2).join("/")}: ${json.error?.message ?? "no message"}`);
  }
  return json;
}

function config() {
  const file = process.env.PLAY_SERVICE_ACCOUNT_FILE;
  const pkg = process.env.PLAY_PACKAGE_NAME;
  if (!file || !pkg) {
    console.error("PLAY_SERVICE_ACCOUNT_FILE and PLAY_PACKAGE_NAME are required");
    process.exit(2);
  }
  return { file, pkg };
}

async function listVersionCodes(token, base, edit) {
  const get = (path) => call(token, "GET", `${base}/edits/${edit}/${path}`);
  // apks is the legacy listing; an app that only ever had bundles may get an
  // error for it, and that is not a reason to stop.
  const [bundles, apks, tracks] = await Promise.all([
    get("bundles"),
    get("apks").catch(() => ({})),
    get("tracks"),
  ]);
  return highestVersionCode({ bundles: bundles.bundles, apks: apks.apks, tracks: tracks.tracks });
}

async function nextVersionCode() {
  const { file, pkg } = config();
  const token = await accessToken(file);
  const base = `${API}/${pkg}`;
  // An edit is the API's only way to look; it is thrown away without a commit.
  const edit = (await call(token, "POST", `${base}/edits`, { body: {} })).id;
  try {
    const highest = await listVersionCodes(token, base, edit);
    if (highest === 0) {
      throw new Error(
        "Play knows no version of this app yet. The first one has to be uploaded by hand in the Play Console.",
      );
    }
    console.log(String(highest + 1));
  } finally {
    await call(token, "DELETE", `${base}/edits/${edit}`).catch(() => {});
  }
}

async function upload({ bundle, track, "version-code": versionCode, status }) {
  if (!bundle || !track || !versionCode) throw new Error("--bundle, --track and --version-code are required");
  const body = trackBody(track, versionCode, status ?? "completed");
  const { file, pkg } = config();
  const token = await accessToken(file);
  const base = `${API}/${pkg}`;
  const edit = (await call(token, "POST", `${base}/edits`, { body: {} })).id;
  try {
    const uploaded = await call(token, "POST", `${UPLOAD_API}/${pkg}/edits/${edit}/bundles?uploadType=media`, {
      raw: readFileSync(bundle),
      body: true,
      contentType: "application/octet-stream",
    });
    if (String(uploaded.versionCode) !== String(versionCode)) {
      throw new Error(`the bundle has versionCode ${uploaded.versionCode}, the build was given ${versionCode}`);
    }
    await call(token, "PUT", `${base}/edits/${edit}/tracks/${track}`, { body });
    await call(token, "POST", `${base}/edits/${edit}:commit`);
  } catch (error) {
    await call(token, "DELETE", `${base}/edits/${edit}`).catch(() => {});
    throw error;
  }
  console.log(`versionCode ${versionCode} is on the ${track} track`);
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === "next-version-code") return nextVersionCode();
  if (command === "upload") return upload(options);
  console.error("usage: play.mjs next-version-code | upload --bundle f --track t --version-code n");
  process.exit(2);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
