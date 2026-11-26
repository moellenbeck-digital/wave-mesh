// The pure parts of the two store scripts: what they read out of the stores'
// answers and what they decide from it. The calls themselves are not tested
// here -- they need real accounts; the workflows' dry run is where they meet
// the real API.
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { highestVersionCode, parseArgs, signJwt, trackBody } from "../../mobile/android/play.mjs";
import {
  normalizeNotes,
  pickBuild,
  pickLocalization,
  planSubmission,
  planVersion,
  signToken,
} from "../../mobile/ios/submit-for-review.mjs";

describe("play.mjs", () => {
  test("the highest versionCode over bundles, apks and every track release", () => {
    expect(
      highestVersionCode({
        bundles: [{ versionCode: 3 }, { versionCode: 7 }],
        apks: [{ versionCode: 2 }],
        tracks: [{ track: "internal", releases: [{ versionCodes: ["5", "9"] }, { versionCodes: ["4"] }] }, { track: "production" }],
      }),
    ).toBe(9);
  });

  test("nothing at all is 0, not an error", () => {
    expect(highestVersionCode()).toBe(0);
    expect(highestVersionCode({ bundles: [], tracks: [{ releases: [{}] }] })).toBe(0);
  });

  test("the track body carries one versionCode, as a string", () => {
    expect(trackBody("internal", 12)).toEqual({
      track: "internal",
      releases: [{ versionCodes: ["12"], status: "completed" }],
    });
  });

  test("a track other than internal or production is refused", () => {
    expect(() => trackBody("beta", 1)).toThrow();
    expect(() => trackBody("alpha", 1)).toThrow();
  });

  test("arguments", () => {
    expect(parseArgs(["upload", "--bundle", "a.aab", "--track", "internal"])).toEqual({
      command: "upload",
      options: { bundle: "a.aab", track: "internal" },
    });
    expect(() => parseArgs(["upload", "--bundle"])).toThrow();
  });

  test("the service account JWT has three parts and the scope", () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const jwt = signJwt({ client_email: "x@y.iam.gserviceaccount.com", private_key: privateKey }, 1000);
    const [, claims] = jwt.split(".");
    expect(jwt.split(".")).toHaveLength(3);
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toMatchObject({
      iss: "x@y.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/androidpublisher",
      iat: 1000,
      exp: 1600,
    });
  });
});

const version = (versionString, state, releaseType = "MANUAL") => ({
  id: `v-${versionString}`,
  attributes: { versionString, appVersionState: state, releaseType },
});

describe("submit-for-review.mjs", () => {
  test("the build is found with its marketing version", () => {
    const page = {
      data: [
        {
          id: "b1",
          attributes: { processingState: "VALID", expired: false, usesNonExemptEncryption: false },
          relationships: { preReleaseVersion: { data: { type: "preReleaseVersions", id: "p1" } } },
        },
      ],
      included: [{ type: "preReleaseVersions", id: "p1", attributes: { version: "0.8.0", platform: "IOS" } }],
    };
    expect(pickBuild(page, "12")).toEqual({
      id: "b1",
      marketingVersion: "0.8.0",
      platform: "IOS",
      state: "VALID",
      expired: false,
      encryption: false,
    });
  });

  test("no build, or a number that is ambiguous, is an error", () => {
    expect(() => pickBuild({ data: [] }, "12")).toThrow(/no build 12/);
    const twice = {
      data: ["b1", "b2"].map((id, i) => ({
        id,
        attributes: { processingState: "VALID" },
        relationships: { preReleaseVersion: { data: { type: "preReleaseVersions", id: `p${i}` } } },
      })),
      included: ["0.8.0", "0.9.0"].map((v, i) => ({ type: "preReleaseVersions", id: `p${i}`, attributes: { version: v, platform: "IOS" } })),
    };
    expect(() => pickBuild(twice, "12")).toThrow(/several versions/);
  });

  test("an editable version is kept, or set to manual", () => {
    expect(planVersion([version("0.8.0", "PREPARE_FOR_SUBMISSION")], "0.8.0")).toMatchObject({ action: "keep" });
    expect(planVersion([version("0.8.0", "PREPARE_FOR_SUBMISSION", "AFTER_APPROVAL")], "0.8.0")).toMatchObject({
      action: "set-manual",
      id: "v-0.8.0",
    });
  });

  test("a version that is already in review or released takes no submission", () => {
    expect(() => planVersion([version("0.8.0", "WAITING_FOR_REVIEW")], "0.8.0")).toThrow(/WAITING_FOR_REVIEW/);
    expect(() => planVersion([version("0.8.0", "READY_FOR_SALE")], "0.8.0")).toThrow(/READY_FOR_SALE/);
  });

  test("a new version is created, unless another one is still open", () => {
    expect(planVersion([version("0.7.0", "READY_FOR_SALE")], "0.8.0")).toEqual({ action: "create", firstRelease: false });
    expect(() => planVersion([version("0.7.0", "PREPARE_FOR_SUBMISSION")], "0.8.0")).toThrow(/still open/);
  });

  test("no released version before: a first release", () => {
    expect(planVersion([], "0.8.0")).toEqual({ action: "create", firstRelease: true });
  });

  test("the localization of a language: the preferred locale first", () => {
    const list = [
      { id: "1", attributes: { locale: "en-GB" } },
      { id: "2", attributes: { locale: "en-US" } },
      { id: "3", attributes: { locale: "de-DE" } },
    ];
    expect(pickLocalization(list, "en", "en-US").id).toBe("2");
    expect(pickLocalization(list, "de", "de-DE").id).toBe("3");
    expect(pickLocalization(list.slice(0, 1), "en", "en-US").id).toBe("1");
    expect(pickLocalization(list.slice(0, 2), "de", "de-DE")).toBeUndefined();
  });

  test("a submission already under review blocks, an open one is reused", () => {
    expect(planSubmission([])).toEqual({ action: "create" });
    expect(planSubmission([{ id: "s1", attributes: { state: "READY_FOR_REVIEW" } }])).toEqual({ action: "reuse", id: "s1" });
    expect(() => planSubmission([{ id: "s2", attributes: { state: "IN_REVIEW" } }])).toThrow(/IN_REVIEW/);
  });

  test("release notes: written-out line breaks, trimmed, never empty, limited", () => {
    expect(normalizeNotes("  Neu\\nBesser ", "German")).toBe("Neu\nBesser");
    expect(() => normalizeNotes("  ", "German")).toThrow(/empty/);
    expect(() => normalizeNotes("x".repeat(4001), "English")).toThrow(/4000/);
    expect(normalizeNotes("x".repeat(4000), "English")).toHaveLength(4000);
  });

  test("the ES256 token has three parts", () => {
    const { privateKey } = generateKeyPairSync("ec", {
      namedCurve: "P-256",
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const token = signToken({ keyId: "K", issuer: "I", p8: Buffer.from(privateKey).toString("base64") }, 1000);
    const [header, claims] = token.split(".");
    expect(token.split(".")).toHaveLength(3);
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toMatchObject({ alg: "ES256", kid: "K" });
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toMatchObject({ iss: "I", aud: "appstoreconnect-v1" });
  });
});
