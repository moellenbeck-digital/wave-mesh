#!/usr/bin/env bun
/**
 * Writes dist/manifest.json: the signed statement of what a release is (D13).
 *
 *   WAVE_RELEASE_SIGNING_KEY=… bun scripts/release-manifest.ts [dist]
 *
 * Version and channel come from the root package.json -- the same place the
 * workflow checks the tag against -- and each archive in dist/ is hashed. A
 * device installs nothing whose manifest does not verify against a key it was
 * built with, so a release without this file is one no device will take.
 *
 * Without the key this fails rather than writing an unsigned file: a manifest
 * nobody can verify is not a smaller version of a signed one, it is noise.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { signRelease, verifyRelease } from "../packages/crypto/src/index.ts";
import {
  channelOfVersion,
  MANIFEST_ASSET,
  ReleaseManifest,
  SignedRelease,
} from "../packages/proto/src/index.ts";

const dist = process.argv[2] ?? "dist";
const key = process.env.WAVE_RELEASE_SIGNING_KEY?.trim();
if (!key) {
  console.error("WAVE_RELEASE_SIGNING_KEY is not set; refusing to write an unsigned manifest.");
  process.exit(1);
}

const version: string = JSON.parse(readFileSync("package.json", "utf8")).version;
const channel = channelOfVersion(version);
if (!channel) {
  console.error(`${version} is not a release version (X.Y.Z, X.Y.0-insiders.N, X.Y.0-develop.N)`);
  process.exit(1);
}

const ARCHIVE = /^wave-([a-z]+-[a-z0-9]+)\.(tar\.gz|zip)$/;
const archives = readdirSync(dist)
  .map((name) => ({ name, match: ARCHIVE.exec(name) }))
  .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
  .sort((a, b) => a.name.localeCompare(b.name))
  .map(({ name, match }) => {
    const path = join(dist, name);
    return {
      name,
      platform: match[1] as string,
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
      size: statSync(path).size,
    };
  });
if (archives.length === 0) {
  console.error(`no archives in ${dist}; run scripts/build-clients.sh --package first`);
  process.exit(1);
}

const manifest = ReleaseManifest.parse({ version, channel, archives });
const signed = SignedRelease.parse({ manifest, ...signRelease(manifest, key) });

// Checked against the list the binaries carry, so a secret that drifted from
// RELEASE_PUBLIC_KEYS fails here, at the tag, and not on every device later.
if (!verifyRelease(signed.manifest, signed.signature, signed.keyId)) {
  console.error(
    `the signing key (${signed.keyId}) is not in RELEASE_PUBLIC_KEYS; ` +
      "no device would accept this release",
  );
  process.exit(1);
}

writeFileSync(join(dist, MANIFEST_ASSET), `${JSON.stringify(signed, null, 2)}\n`);
console.log(`${join(dist, MANIFEST_ASSET)}: ${version} (${channel}), ${archives.length} archives`);
