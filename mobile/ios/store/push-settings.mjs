#!/usr/bin/env node
// The settings around the listing: price (free), where the app is sold and
// the age rating. Safe to run again -- a price schedule and an availability
// replace what was there, the age rating is updated in place.
//
//   the API key as in asc.mjs (App Manager role)
//
// Not here: the privacy answers, which App Store Connect has no API for.
import { readFileSync } from "node:fs";
import { api, appId } from "./asc.mjs";

const listing = JSON.parse(readFileSync(new URL("./listing.json", import.meta.url), "utf8"));
const excluded = new Set(listing.excludedTerritories ?? []);

// Free everywhere: the free price point of the base territory, which App
// Store Connect carries over to every other one.
const points = await api("GET", `/v1/apps/${appId}/appPricePoints?filter[territory]=USA&limit=200`);
const free = points.data.find((p) => Number(p.attributes.customerPrice) === 0);
if (!free) throw new Error("no free price point for USA");
await api("POST", "/v1/appPriceSchedules", {
  data: {
    type: "appPriceSchedules",
    relationships: {
      app: { data: { type: "apps", id: appId } },
      baseTerritory: { data: { type: "territories", id: "USA" } },
      manualPrices: { data: [{ type: "appPrices", id: "${free}" }] },
    },
  },
  included: [
    {
      type: "appPrices",
      id: "${free}",
      attributes: { startDate: null },
      relationships: { appPricePoint: { data: { type: "appPricePoints", id: free.id } } },
    },
  ],
});
console.log("price    free");

// Every territory but the excluded ones, and new ones as Apple adds them.
const territories = [];
for (let next = "/v1/territories?limit=200"; next; ) {
  const page = await api("GET", next);
  territories.push(...page.data.map((t) => t.id));
  next = page.links?.next ? new URL(page.links.next).pathname + new URL(page.links.next).search : null;
}
const entries = territories.map((id) => ({
  type: "territoryAvailabilities",
  id: `\${${id}}`,
  attributes: { available: !excluded.has(id) },
  relationships: { territory: { data: { type: "territories", id } } },
}));
await api("POST", "/v2/appAvailabilities", {
  data: {
    type: "appAvailabilities",
    attributes: { availableInNewTerritories: true },
    relationships: {
      app: { data: { type: "apps", id: appId } },
      territoryAvailabilities: { data: entries.map(({ type, id }) => ({ type, id })) },
    },
  },
  included: entries,
});
console.log(`sold in  ${territories.length - excluded.size} of ${territories.length} (not ${[...excluded].join(", ")})`);

// Age rating: nothing in the app that any question asks about, which is 4+.
const infos = await api("GET", `/v1/apps/${appId}/appInfos`);
const info = infos.data.find((i) => (i.attributes.appStoreState ?? i.attributes.state) !== "READY_FOR_SALE") ?? infos.data[0];
const declaration = (await api("GET", `/v1/appInfos/${info.id}/ageRatingDeclaration`)).data;
const answers = {};
for (const [key, value] of Object.entries(declaration.attributes)) {
  if (/Override|kidsAgeBand|gracRating|developerAgeRatingInfoUrl/.test(key)) continue;
  answers[key] = value;
}
const frequency = [
  "alcoholTobaccoOrDrugUseOrReferences",
  "contests",
  "gamblingSimulated",
  "gunsOrOtherWeapons",
  "medicalOrTreatmentInformation",
  "profanityOrCrudeHumor",
  "sexualContentGraphicAndNudity",
  "sexualContentOrNudity",
  "horrorOrFearThemes",
  "matureOrSuggestiveThemes",
  "violenceCartoonOrFantasy",
  "violenceRealisticProlongedGraphicOrSadistic",
  "violenceRealistic",
];
for (const key of Object.keys(answers)) answers[key] = frequency.includes(key) ? "NONE" : false;
await api("PATCH", `/v1/ageRatingDeclarations/${declaration.id}`, {
  data: { type: "ageRatingDeclarations", id: declaration.id, attributes: answers },
});
const rated = (await api("GET", `/v1/appInfos/${info.id}`)).data.attributes.appStoreAgeRating;
console.log(`age      ${rated ?? "(computed on submission)"}`);
