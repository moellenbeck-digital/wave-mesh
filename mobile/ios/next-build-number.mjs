#!/usr/bin/env node
// Prints the next free build number for the app on App Store Connect.
//
// The highest build number App Store Connect knows, plus one -- across every
// upload, whoever made it: a Mac, a teammate's Xcode or CI. A counter of our
// own (the CI run number) would collide with the first manual upload, and
// App Store Connect refuses a number it has seen for the same version.
//
//   ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8_BASE64   the API key, as for upload.sh
//   ASC_APP_ID                                     defaults to wave-mesh's
//
// Nothing secret is printed; on any failure it exits non-zero rather than
// guessing a number.
import { createSign } from "node:crypto";

const appId = process.env.ASC_APP_ID ?? "6819678897";
const { ASC_KEY_ID: keyId, ASC_ISSUER_ID: issuer, ASC_KEY_P8_BASE64: p8 } = process.env;
if (!keyId || !issuer || !p8) {
  console.error("ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_P8_BASE64 are required");
  process.exit(2);
}

const b64u = (value) => Buffer.from(value).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const header = b64u(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
const claims = b64u(JSON.stringify({ iss: issuer, iat: now, exp: now + 600, aud: "appstoreconnect-v1" }));
const key = Buffer.from(p8, "base64").toString("utf8");
const signature = createSign("SHA256").update(`${header}.${claims}`).sign({ key, dsaEncoding: "ieee-p1363" });
const token = `${header}.${claims}.${b64u(signature)}`;

let highest = 0;
let url = `https://api.appstoreconnect.apple.com/v1/builds?filter[app]=${appId}&fields[builds]=version&limit=200`;
while (url) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    console.error(`App Store Connect answered ${response.status}`);
    process.exit(1);
  }
  const page = await response.json();
  for (const build of page.data ?? []) {
    const number = Number.parseInt(build.attributes?.version ?? "", 10);
    if (Number.isFinite(number) && number > highest) highest = number;
  }
  url = page.links?.next ?? null;
}
console.log(String(highest + 1));
