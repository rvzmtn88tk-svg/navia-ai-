#!/usr/bin/env node
// Transforms osmium-exported address GeoJSON into a flat searchable index:
// { street, houseNumber, city, lat, lon }[], grouped/sorted for prefix
// search by OfflineGeocoder. Same "no OSM data here to run against, but
// verified output shape" situation as build-poi-index.mjs.
import { readFileSync, writeFileSync } from "node:fs";

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error("Usage: build-address-index.mjs <in.geojson> <out.json>");
  process.exit(1);
}

const geojson = JSON.parse(readFileSync(inPath, "utf8"));
const entries = [];

for (const feature of geojson.features ?? []) {
  const tags = feature.properties ?? {};
  const houseNumber = tags["addr:housenumber"];
  const street = tags["addr:street"];
  if (!houseNumber || !street) continue;
  const geometry = feature.geometry;
  const point = geometry.type === "Point" ? geometry.coordinates : geometry.type === "Polygon" ? geometry.coordinates[0][0] : null;
  if (!point) continue;
  entries.push({
    street,
    houseNumber,
    city: tags["addr:city"] ?? null,
    lat: point[1],
    lon: point[0],
  });
}

entries.sort((a, b) => a.street.localeCompare(b.street, "uk") || a.houseNumber.localeCompare(b.houseNumber, "uk"));

writeFileSync(outPath, JSON.stringify(entries, null, 2));
console.log(`Wrote ${entries.length} address entries to ${outPath}`);
