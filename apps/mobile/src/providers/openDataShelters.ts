// Shelters from the official open data of Kyiv-oblast communities
// (data.gov.ua, national "protective structures" dataset standard), built by
// scripts/data/build-kyiv-oblast-shelters.mjs and shipped with the app, so
// they work without network. Only real published coordinates are used.
import { searchByRadius, type LatLon } from "@navia/core";
import type { NearbyPlace } from "./NearbyPlacesProvider";

type Bundle = {
  generatedAt: string;
  sources: { publisher: string; modified: string; count: number; url: string }[];
  shelters: { id: string; name: string; address: string; lat: number; lon: number; publisher: string }[];
};

let bundle: Bundle | null = null;
function load(): Bundle {
  bundle ??= require("../../assets/data/kyiv-oblast-shelters.json") as Bundle;
  return bundle;
}

let asPlaces: (Omit<NearbyPlace, "distanceM"> & { category: "shelter" })[] | null = null;
function places() {
  if (asPlaces) return asPlaces;
  const b = load();
  asPlaces = b.shelters.map((s) => ({
    id: s.id,
    name: s.name,
    category: "shelter" as const,
    location: { lat: s.lat, lon: s.lon },
    ...(s.address ? { address: s.address } : {}),
    source: "data.gov.ua" as const,
    origin: "offline" as const,
    sourceDetail: `${s.publisher} · відкриті дані станом на ${b.generatedAt}`,
  }));
  return asPlaces;
}

/** Community shelters strictly within `radiusM` of `center`. */
export function bundledShelters(center: LatLon, radiusM: number): NearbyPlace[] {
  return searchByRadius(places(), center, radiusM);
}

export function bundledSheltersInfo(): { count: number; datasets: number; generatedAt: string } {
  const b = load();
  return { count: b.shelters.length, datasets: b.sources.length, generatedAt: b.generatedAt };
}
