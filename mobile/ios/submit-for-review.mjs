#!/usr/bin/env node
// Submits a build that is already on App Store Connect (TestFlight) for App
// Review -- for .github/workflows/appstore.yml.
//
//   ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8_BASE64   the API key, as for next-build-number.mjs
//   ASC_APP_ID                                     defaults to wave-mesh's
//   BUILD_NUMBER                                   the build to submit
//   NOTES_DE, NOTES_EN                             "What's New", German and English
//   DRY_RUN                                        "0" submits; anything else only checks
//
// The release type is always MANUAL: when Apple approves, the version waits for
// a person to press the button. Nothing here publishes anything.
//
// A dry run only reads. It says whether the build is there and processed,
// whether its version can take the submission, which edits a real run would
// make and whether anything stands in the way -- and changes nothing on App
// Store Connect, not even the release notes.
//
// Nothing secret is printed; on any failure it exits non-zero.
import { createSign } from "node:crypto";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const API = "https://api.appstoreconnect.apple.com";
const NOTES_LIMIT = 4000;
// The states in which a version still takes edits and a build.
export const EDITABLE = [
  "PREPARE_FOR_SUBMISSION",
  "DEVELOPER_REJECTED",
  "REJECTED",
  "METADATA_REJECTED",
  "INVALID_BINARY",
];
// A version in one of these has been in the store; before the first one,
// App Store Connect takes no "What's New".
const RELEASED = ["READY_FOR_SALE", "REPLACED_WITH_NEW_VERSION", "REMOVED_FROM_SALE", "PROCESSING_FOR_APP_STORE"];

const b64u = (value) => Buffer.from(value).toString("base64url");

export function signToken({ keyId, issuer, p8 }, now = Math.floor(Date.now() / 1000)) {
  const header = b64u(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
  const claims = b64u(JSON.stringify({ iss: issuer, iat: now, exp: now + 600, aud: "appstoreconnect-v1" }));
  const key = Buffer.from(p8, "base64").toString("utf8");
  const signature = createSign("SHA256").update(`${header}.${claims}`).sign({ key, dsaEncoding: "ieee-p1363" });
  return `${header}.${claims}.${b64u(signature)}`;
}

/** Release notes from a workflow input: `\n` written out becomes a line break; empty or too long is an error. */
export function normalizeNotes(value, label) {
  const text = String(value ?? "").replaceAll("\\n", "\n").trim();
  if (!text) throw new Error(`${label} release notes are empty`);
  if (text.length > NOTES_LIMIT) throw new Error(`${label} release notes are ${text.length} characters, the limit is ${NOTES_LIMIT}`);
  return text;
}

/** The one build with this number, as { id, marketingVersion, state, expired, encryption }. */
export function pickBuild(page, number) {
  const included = new Map((page.included ?? []).map((item) => [`${item.type}:${item.id}`, item]));
  const builds = (page.data ?? []).map((build) => {
    const pre = build.relationships?.preReleaseVersion?.data;
    const version = pre ? included.get(`${pre.type}:${pre.id}`) : undefined;
    return {
      id: build.id,
      marketingVersion: version?.attributes?.version,
      platform: version?.attributes?.platform,
      state: build.attributes?.processingState,
      expired: build.attributes?.expired === true,
      encryption: build.attributes?.usesNonExemptEncryption,
    };
  });
  const ios = builds.filter((build) => !build.platform || build.platform === "IOS");
  if (ios.length === 0) throw new Error(`no build ${number} on App Store Connect`);
  if (ios.length > 1) {
    throw new Error(`build number ${number} exists for several versions (${ios.map((b) => b.marketingVersion).join(", ")})`);
  }
  return ios[0];
}

export const stateOf = (version) => version.attributes?.appVersionState ?? version.attributes?.appStoreState;

/** What to do about the App Store version for a marketing version, given every iOS version of the app. */
export function planVersion(versions, marketingVersion) {
  const own = versions.find((version) => version.attributes?.versionString === marketingVersion);
  const other = versions.find(
    (version) => version.attributes?.versionString !== marketingVersion && EDITABLE.includes(stateOf(version)),
  );
  const firstRelease = !versions.some((version) => RELEASED.includes(stateOf(version)));
  if (own) {
    const state = stateOf(own);
    if (!EDITABLE.includes(state)) {
      throw new Error(`version ${marketingVersion} is ${state}; only a version that is still editable takes a submission`);
    }
    return { action: own.attributes?.releaseType === "MANUAL" ? "keep" : "set-manual", id: own.id, state, firstRelease };
  }
  if (other) {
    throw new Error(
      `version ${stateOf(other) ? `${other.attributes.versionString} (${stateOf(other)})` : other.attributes.versionString} is still open on App Store Connect; ` +
        `a second one cannot be created. Submit or remove that one, or submit a build of it.`,
    );
  }
  return { action: "create", firstRelease };
}

/** The localization for a language: the exact locale if there is one, else the first of that language. */
export function pickLocalization(localizations, language, preferred) {
  const own = localizations.filter((item) => item.attributes?.locale?.split("-")[0] === language);
  return own.find((item) => item.attributes?.locale === preferred) ?? own[0];
}

/** What stands between a state of the app's review submissions and a new submission. */
export function planSubmission(submissions) {
  const busy = submissions.find((s) => ["WAITING_FOR_REVIEW", "IN_REVIEW", "UNRESOLVED_ISSUES", "COMPLETING"].includes(s.attributes?.state));
  if (busy) throw new Error(`a submission is already ${busy.attributes.state}`);
  const open = submissions.find((s) => s.attributes?.state === "READY_FOR_REVIEW");
  return open ? { action: "reuse", id: open.id } : { action: "create" };
}

function client(token) {
  return async (method, path, body) => {
    const response = await fetch(path.startsWith("http") ? path : `${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      // not JSON
    }
    if (!response.ok) {
      const detail = (json.errors ?? []).map((e) => e.detail ?? e.title).filter(Boolean).join("; ");
      throw new Error(`App Store Connect answered ${response.status} for ${method} ${path.split("?")[0]}: ${detail || "no detail"}`);
    }
    return json;
  };
}

async function run() {
  const { ASC_KEY_ID: keyId, ASC_ISSUER_ID: issuer, ASC_KEY_P8_BASE64: p8, BUILD_NUMBER: buildNumber } = process.env;
  if (!keyId || !issuer || !p8 || !buildNumber) {
    console.error("ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8_BASE64 and BUILD_NUMBER are required");
    process.exit(2);
  }
  if (!/^[0-9]+$/.test(buildNumber)) throw new Error("BUILD_NUMBER must be a number");
  const appId = process.env.ASC_APP_ID ?? "6819678897";
  const dryRun = process.env.DRY_RUN !== "0";
  const notes = { de: normalizeNotes(process.env.NOTES_DE, "German"), en: normalizeNotes(process.env.NOTES_EN, "English") };
  const asc = client(signToken({ keyId, issuer, p8 }));
  const lines = [];
  const say = (line) => {
    lines.push(line);
    console.log(line);
  };
  say(dryRun ? "Dry run: nothing is changed or submitted." : "Submitting for App Review.");

  // 1. The build.
  const buildPage = await asc(
    "GET",
    `/v1/builds?filter[app]=${appId}&filter[version]=${buildNumber}&include=preReleaseVersion&limit=10`,
  );
  const build = pickBuild(buildPage, buildNumber);
  if (build.state !== "VALID") throw new Error(`build ${buildNumber} is ${build.state}, not VALID: it is still processing or was refused`);
  if (build.expired) throw new Error(`build ${buildNumber} has expired`);
  if (!build.marketingVersion) throw new Error(`build ${buildNumber} has no version`);
  say(`Build ${buildNumber} of version ${build.marketingVersion} is processed (VALID).`);
  if (build.encryption === null || build.encryption === undefined) {
    say("Warning: the build has no export compliance answer yet; App Store Connect may ask for one.");
  }

  // Whether a submission can be made at all is found out before anything is changed.
  const states = "READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES,COMPLETING";
  const submissions = await asc("GET", `/v1/apps/${appId}/reviewSubmissions?filter[platform]=IOS&filter[state]=${states}&limit=20`);
  const submission = planSubmission(submissions.data ?? []);

  // 2. The App Store version.
  const versionPage = await asc("GET", `/v1/apps/${appId}/appStoreVersions?filter[platform]=IOS&limit=50`);
  const plan = planVersion(versionPage.data ?? [], build.marketingVersion);
  let versionId = plan.id;
  if (plan.action === "create") {
    say(`Version ${build.marketingVersion} does not exist yet; ${dryRun ? "a real run would create" : "creating"} it with release type MANUAL.`);
    if (!dryRun) {
      const created = await asc("POST", "/v1/appStoreVersions", {
        data: {
          type: "appStoreVersions",
          attributes: { platform: "IOS", versionString: build.marketingVersion, releaseType: "MANUAL" },
          relationships: { app: { data: { type: "apps", id: appId } } },
        },
      });
      versionId = created.data.id;
    }
  } else if (plan.action === "set-manual") {
    say(`Version ${build.marketingVersion} (${plan.state}) exists; ${dryRun ? "a real run would set" : "setting"} its release type to MANUAL.`);
    if (!dryRun) {
      await asc("PATCH", `/v1/appStoreVersions/${versionId}`, {
        data: { type: "appStoreVersions", id: versionId, attributes: { releaseType: "MANUAL" } },
      });
    }
  } else {
    say(`Version ${build.marketingVersion} (${plan.state}) exists with release type MANUAL.`);
  }

  // 3. The build on that version.
  say(`${dryRun ? "A real run would attach" : "Attaching"} build ${buildNumber} to version ${build.marketingVersion}.`);
  if (!dryRun) {
    await asc("PATCH", `/v1/appStoreVersions/${versionId}/relationships/build`, {
      data: { type: "builds", id: build.id },
    });
  }

  // 4. "What's New", German and English.
  if (plan.firstRelease) {
    say("The app has no released version yet: App Store Connect takes no \"What's New\" for a first release, so the notes are not set.");
  } else if (!versionId) {
    say("A real run would set the German and English \"What's New\" on the new version.");
  } else {
    const locPage = await asc("GET", `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations?limit=50`);
    const localizations = locPage.data ?? [];
    for (const [language, preferred] of [["de", "de-DE"], ["en", "en-US"]]) {
      const found = pickLocalization(localizations, language, preferred);
      const verb = found ? "set" : "add";
      say(`${dryRun ? `A real run would ${verb}` : `${verb === "set" ? "Setting" : "Adding"}`} the ${language} "What's New" (${notes[language].length} characters${found ? `, locale ${found.attributes.locale}` : `, locale ${preferred}`}).`);
      if (dryRun) continue;
      if (found) {
        await asc("PATCH", `/v1/appStoreVersionLocalizations/${found.id}`, {
          data: { type: "appStoreVersionLocalizations", id: found.id, attributes: { whatsNew: notes[language] } },
        });
      } else {
        await asc("POST", "/v1/appStoreVersionLocalizations", {
          data: {
            type: "appStoreVersionLocalizations",
            attributes: { locale: preferred, whatsNew: notes[language] },
            relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: versionId } } },
          },
        });
      }
    }
  }

  // 5. The submission.
  if (dryRun) {
    say(`A real run would ${submission.action === "reuse" ? "reuse the open" : "create a"} review submission and submit it. Release type: MANUAL.`);
    say("Dry run done: nothing was changed.");
  } else {
    let id = submission.id;
    if (submission.action === "create") {
      const created = await asc("POST", "/v1/reviewSubmissions", {
        data: {
          type: "reviewSubmissions",
          attributes: { platform: "IOS" },
          relationships: { app: { data: { type: "apps", id: appId } } },
        },
      });
      id = created.data.id;
    }
    await asc("POST", "/v1/reviewSubmissionItems", {
      data: {
        type: "reviewSubmissionItems",
        relationships: {
          reviewSubmission: { data: { type: "reviewSubmissions", id } },
          appStoreVersion: { data: { type: "appStoreVersions", id: versionId } },
        },
      },
    });
    await asc("PATCH", `/v1/reviewSubmissions/${id}`, {
      data: { type: "reviewSubmissions", id, attributes: { submitted: true } },
    });
    say(`Build ${buildNumber} (version ${build.marketingVersion}) is submitted for review. Release type MANUAL: after approval it waits for you to release it.`);
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### wave-mesh App Store submission${dryRun ? " (dry run)" : ""}\n\n${lines.map((line) => `- ${line}`).join("\n")}\n`,
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
