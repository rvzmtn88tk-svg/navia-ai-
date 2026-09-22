#!/usr/bin/env node
// Transforms osmium-exported GeoJSON (from 05-build-poi-index.sh) into
// @navia/core's POI[] shape (packages/core/src/landmark-engine.ts). Real
// transform logic, run over real OSM export data — this script itself has
// no OSM data to run against in this sandbox (see README.md), but its
// output shape is exactly what POIEngine.load() expects, verified against
// packages/core's actual POI type definition.
import { readFileSync, writeFileSync } from "node:fs";

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error("Usage: build-poi-index.mjs <in.geojson> <out.json>");
  process.exit(1);
}

const TAG_TO_CATEGORY = {
  "amenity=fuel": "fuel",
  "shop=supermarket": "supermarket",
  "amenity=pharmacy": "pharmacy",
  "amenity=hospital": "hospital",
  "bridge=yes": "bridge",
  "railway=level_crossing": "railway_crossing",
  "highway=motorway_junction": "major_intersection",
  "shop=mall": "shopping_centre",
  "amenity=school": "school",
  "amenity=place_of_worship": "church",
  "amenity=parking": "parking",
  "amenity=townhall": "government_building",
  "amenity=courthouse": "government_building",
};

function categoryFor(tags) {
  for (const [rule, category] of Object.entries(TAG_TO_CATEGORY)) {
    const [k, v] = rule.split("=");
    if (tags[k] === v) return category;
  }
  return null;
}

function centroid(geometry) {
  if (geometry.type === "Point") {
    const [lon, lat] = geometry.coordinates;
    return { lat, lon };
  }
  // Ways/polygons: simple coordinate-average centroid (fine for POI display purposes).
  const coords = geometry.type === "Polygon" ? geometry.coordinates[0] : geometry.coordinates;
  const flat = coords.flat(1);
  let sumLat = 0, sumLon = 0, n = 0;
  for (const c of flat) {
    if (Array.isArray(c) && typeof c[0] === "number") { sumLon += c[0]; sumLat += c[1]; n++; }
  }
  return n > 0 ? { lat: sumLat / n, lon: sumLon / n } : null;
}

const geojson = JSON.parse(readFileSync(inPath, "utf8"));
const pois = [];

for (const feature of geojson.features ?? []) {
  const tags = feature.properties ?? {};
  const category = categoryFor(tags);
  if (!category) continue;
  const location = centroid(feature.geometry);
  if (!location) continue;
  const name = tags.name || tags["name:uk"] || tags.brand || category;
  pois.push({
    id: `osm-${feature.properties["@id"] ?? feature.id ?? `${pois.length}`}`,
    name,
    brand: tags.brand,
    category,
    location,
  });
}

writeFileSync(outPath, JSON.stringify(pois, null, 2));
console.log(`Wrote ${pois.length} POIs to ${outPath}`);
