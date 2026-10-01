import { describe, expect, test } from "bun:test";
import { archiveName, channelAccepts, channelOfVersion, compareVersions, ReleaseManifest } from "./update.ts";

describe("compareVersions", () => {
  test("orders the shapes the release process makes", () => {
    const sorted = [
      "0.2.0",
      "0.1.0",
      "0.2.0-insiders.2",
      "0.2.0-develop.10",
      "0.2.0-insiders.10",
      "0.2.0-develop.9",
      "1.0.0",
    ].sort(compareVersions);
    expect(sorted).toEqual([
      "0.1.0",
      "0.2.0-develop.9",
      "0.2.0-develop.10",
      "0.2.0-insiders.2",
      "0.2.0-insiders.10",
      "0.2.0",
      "1.0.0",
    ]);
  });

  test("ignores build metadata, so a local build sits at its release", () => {
    // Otherwise "+local" would have to be a prerelease, and every local build
    // would look older than the release it was made from.
    expect(compareVersions("0.1.0+local", "0.1.0")).toBe(0);
    expect(compareVersions("0.1.1", "0.1.0+local")).toBe(1);
  });

  test("puts what is not a version below everything", () => {
    expect(compareVersions("garbage", "0.0.1")).toBe(-1);
    expect(compareVersions("0.0.1", "garbage")).toBe(1);
    expect(compareVersions("0.0.0-dev", "0.1.0")).toBe(-1);
  });
});

describe("channels", () => {
  test("a version's shape says its channel", () => {
    expect(channelOfVersion("1.2.3")).toBe("stable");
    expect(channelOfVersion("1.2.0-insiders.4")).toBe("insiders");
    expect(channelOfVersion("1.2.0-develop.4")).toBe("develop");
    // Not one the release workflow would let through, so never offered.
    expect(channelOfVersion("1.2.0-rc.1")).toBeNull();
    expect(channelOfVersion("0.0.0-dev")).toBeNull();
  });

  test("each channel takes its own releases and the more stable ones", () => {
    expect(channelAccepts("stable", "stable")).toBe(true);
    expect(channelAccepts("stable", "insiders")).toBe(false);
    expect(channelAccepts("insiders", "stable")).toBe(true);
    expect(channelAccepts("insiders", "develop")).toBe(false);
    expect(channelAccepts("develop", "insiders")).toBe(true);
  });

  test("archives are named the way the build script names them", () => {
    expect(archiveName("linux-amd64")).toBe("wave-linux-amd64.tar.gz");
    expect(archiveName("windows-arm64")).toBe("wave-windows-arm64.zip");
  });
});

describe("ReleaseManifest", () => {
  test("keeps fields it does not know, so a newer manifest still verifies", () => {
    // Signed, like a netmap: a dropped field changes the canonical form.
    const parsed = ReleaseManifest.parse({
      version: "0.2.0",
      channel: "stable",
      archives: [
        { name: "wave-linux-amd64.tar.gz", platform: "linux-amd64", sha256: "a".repeat(64), size: 1 },
      ],
      notes: "from the future",
    });
    expect((parsed as Record<string, unknown>).notes).toBe("from the future");
  });
});
