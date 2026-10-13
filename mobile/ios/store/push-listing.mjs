#!/usr/bin/env node
// Writes listing.json into App Store Connect: the version being prepared,
// categories, the texts per language and the details for App Review. Safe to
// run again -- it updates what exists and creates what does not.
//
//   the API key as in asc.mjs (App Manager role)
//   REVIEW_DEMO_PASSWORD   optional; never printed
//
// Not here: the privacy answers (App Store Connect has no API for them),
// price, availability and age rating (set once, in the browser). Screenshots
// go up with upload-screenshots.mjs.
import { readFileSync } from "node:fs";
import { api, appId, editableVersion } from "./asc.mjs";

const listing = JSON.parse(readFileSync(new URL("./listing.json", import.meta.url), "utf8"));

// The version being prepared. Its number follows the build: the store shows it.
const version = await editableVersion();
await api("PATCH", `/v1/appStoreVersions/${version.id}`, {
  data: { type: "appStoreVersions", id: version.id, attributes: { versionString: listing.version, copyright: listing.copyright } },
});
console.log(`version  ${listing.version}`);

// App-wide information: categories and, per language, name, subtitle, privacy policy.
const infos = await api("GET", `/v1/apps/${appId}/appInfos`);
const info = infos.data.find((i) => (i.attributes.appStoreState ?? i.attributes.state) !== "READY_FOR_SALE") ?? infos.data[0];
await api("PATCH", `/v1/appInfos/${info.id}`, {
  data: {
    type: "appInfos",
    id: info.id,
    relationships: {
      primaryCategory: { data: { type: "appCategories", id: listing.primaryCategory } },
      secondaryCategory: { data: { type: "appCategories", id: listing.secondaryCategory } },
    },
  },
});
console.log(`category ${listing.primaryCategory}, ${listing.secondaryCategory}`);

const infoLocs = (await api("GET", `/v1/appInfos/${info.id}/appInfoLocalizations`)).data;
const versionLocs = (await api("GET", `/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`)).data;
for (const [locale, text] of Object.entries(listing.localizations)) {
  const infoAttributes = { name: text.name, subtitle: text.subtitle, privacyPolicyUrl: text.privacyPolicyUrl };
  const existingInfo = infoLocs.find((l) => l.attributes.locale === locale);
  if (existingInfo) {
    await api("PATCH", `/v1/appInfoLocalizations/${existingInfo.id}`, {
      data: { type: "appInfoLocalizations", id: existingInfo.id, attributes: infoAttributes },
    });
  } else {
    await api("POST", "/v1/appInfoLocalizations", {
      data: {
        type: "appInfoLocalizations",
        attributes: { locale, ...infoAttributes },
        relationships: { appInfo: { data: { type: "appInfos", id: info.id } } },
      },
    });
  }
  const versionAttributes = {
    description: text.description,
    keywords: text.keywords,
    promotionalText: text.promotionalText,
    supportUrl: text.supportUrl,
    marketingUrl: text.marketingUrl,
  };
  const existingVersion = versionLocs.find((l) => l.attributes.locale === locale);
  if (existingVersion) {
    await api("PATCH", `/v1/appStoreVersionLocalizations/${existingVersion.id}`, {
      data: { type: "appStoreVersionLocalizations", id: existingVersion.id, attributes: versionAttributes },
    });
  } else {
    await api("POST", "/v1/appStoreVersionLocalizations", {
      data: {
        type: "appStoreVersionLocalizations",
        attributes: { locale, ...versionAttributes },
        relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: version.id } } },
      },
    });
  }
  console.log(`texts    ${locale}`);
}

// For App Review: who to call, how to sign in, what to try.
const { review } = listing;
const reviewAttributes = {
  contactFirstName: review.contactFirstName,
  contactLastName: review.contactLastName,
  contactEmail: review.contactEmail,
  contactPhone: review.contactPhone,
  demoAccountRequired: review.demoAccountRequired,
  demoAccountName: review.demoAccountName,
  notes: review.notes,
  ...(process.env.REVIEW_DEMO_PASSWORD ? { demoAccountPassword: process.env.REVIEW_DEMO_PASSWORD } : {}),
};
const existingReview = await api("GET", `/v1/appStoreVersions/${version.id}/appStoreReviewDetail`).catch(() => null);
if (existingReview?.data) {
  await api("PATCH", `/v1/appStoreReviewDetails/${existingReview.data.id}`, {
    data: { type: "appStoreReviewDetails", id: existingReview.data.id, attributes: reviewAttributes },
  });
} else {
  await api("POST", "/v1/appStoreReviewDetails", {
    data: {
      type: "appStoreReviewDetails",
      attributes: reviewAttributes,
      relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: version.id } } },
    },
  });
}
console.log(`review   ${review.demoAccountName}${process.env.REVIEW_DEMO_PASSWORD ? " (password set)" : " (password unchanged)"}`);
