#!/usr/bin/env node
// Puts the screenshots from screenshots.sh into the version being prepared,
// replacing what is there for the same language and size.
//
//   node upload-screenshots.mjs [dir]    default: ./screenshots (en/iphone, de/ipad, ...)
//
// The API key as in asc.mjs (App Manager role).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { api, editableVersion } from "./asc.mjs";

const dir = process.argv[2] ?? new URL("./screenshots", import.meta.url).pathname;
// Language folder -> App Store locale; device folder -> the size App Store Connect files it under.
const LOCALES = { en: "en-US", de: "de-DE" };
const DISPLAY = { iphone: "APP_IPHONE_67", ipad: "APP_IPAD_PRO_3GEN_129" };

const version = await editableVersion();
const localizations = (await api("GET", `/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`)).data;

for (const [folder, locale] of Object.entries(LOCALES)) {
  const localization = localizations.find((l) => l.attributes.locale === locale);
  if (!localization) throw new Error(`no texts for ${locale} yet: run push-listing.mjs first`);
  const sets = (await api("GET", `/v1/appStoreVersionLocalizations/${localization.id}/appScreenshotSets`)).data;

  for (const [device, displayType] of Object.entries(DISPLAY)) {
    const source = join(dir, folder, device);
    if (!existsSync(source)) continue;
    const files = readdirSync(source).filter((f) => f.endsWith(".png")).sort();

    // A set per size; emptied first, so a second run does not add a second copy.
    let set = sets.find((s) => s.attributes.screenshotDisplayType === displayType);
    if (set) {
      const old = (await api("GET", `/v1/appScreenshotSets/${set.id}/appScreenshots`)).data;
      for (const shot of old) await api("DELETE", `/v1/appScreenshots/${shot.id}`);
    } else {
      set = (
        await api("POST", "/v1/appScreenshotSets", {
          data: {
            type: "appScreenshotSets",
            attributes: { screenshotDisplayType: displayType },
            relationships: { appStoreVersionLocalization: { data: { type: "appStoreVersionLocalizations", id: localization.id } } },
          },
        })
      ).data;
    }

    for (const file of files) {
      const bytes = readFileSync(join(source, file));
      // Reserve, upload the parts Apple asks for, then commit with the checksum.
      const reserved = (
        await api("POST", "/v1/appScreenshots", {
          data: {
            type: "appScreenshots",
            attributes: { fileName: basename(file), fileSize: bytes.length },
            relationships: { appScreenshotSet: { data: { type: "appScreenshotSets", id: set.id } } },
          },
        })
      ).data;
      for (const op of reserved.attributes.uploadOperations) {
        const headers = Object.fromEntries(op.requestHeaders.map((h) => [h.name, h.value]));
        const part = bytes.subarray(op.offset, op.offset + op.length);
        const response = await fetch(op.url, { method: op.method, headers, body: part });
        if (!response.ok) throw new Error(`upload of ${file}: ${response.status}`);
      }
      await api("PATCH", `/v1/appScreenshots/${reserved.id}`, {
        data: {
          type: "appScreenshots",
          id: reserved.id,
          attributes: { uploaded: true, sourceFileChecksum: createHash("md5").update(bytes).digest("hex") },
        },
      });
    }
    console.log(`${locale} ${displayType}: ${files.length}`);
  }
}
