// App Store Connect's API, as the store scripts here use it.
//
//   ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8_BASE64   an API key with the App Manager role
//   ASC_APP_ID                                     defaults to wave-mesh's
//
// A token per request: an upload of many screenshots outlasts one token.
import { createSign } from "node:crypto";

export const appId = process.env.ASC_APP_ID ?? "6819678897";
const { ASC_KEY_ID: keyId, ASC_ISSUER_ID: issuer, ASC_KEY_P8_BASE64: p8 } = process.env;
if (!keyId || !issuer || !p8) {
  console.error("ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_P8_BASE64 are required");
  process.exit(2);
}

const b64u = (value) => Buffer.from(value).toString("base64url");
function token() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64u(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
  const claims = b64u(JSON.stringify({ iss: issuer, iat: now, exp: now + 600, aud: "appstoreconnect-v1" }));
  const key = Buffer.from(p8, "base64").toString("utf8");
  const signature = createSign("SHA256").update(`${header}.${claims}`).sign({ key, dsaEncoding: "ieee-p1363" });
  return `${header}.${claims}.${b64u(signature)}`;
}

/** One request; a refusal throws with Apple's own words, never with the token. */
export async function api(method, path, body) {
  const response = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    let detail = text;
    try {
      detail = JSON.parse(text).errors?.map((e) => e.detail).join("; ") ?? text;
    } catch {}
    throw new Error(`${method} ${path}: ${response.status} ${detail}`);
  }
  return text ? JSON.parse(text) : null;
}

/** The iOS version still being prepared, or one Apple sent back. */
export async function editableVersion() {
  const states = "PREPARE_FOR_SUBMISSION,DEVELOPER_REJECTED,REJECTED,METADATA_REJECTED";
  const versions = await api("GET", `/v1/apps/${appId}/appStoreVersions?filter[platform]=IOS&filter[appStoreState]=${states}`);
  const version = versions.data[0];
  if (!version) throw new Error("no editable App Store version");
  return version;
}
