// Shelters from the official open data of Kyiv-oblast communities
// (data.gov.ua, national "protective structures" dataset standard), built by
// scripts/data/build-kyiv-oblast-shelters.mjs and shipped with the app, so
// they work without network. Only real published coordinates are used.
import { haversineMeters, searchByRadius, type LatLon } from "@navia/core";
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

/** A community's shelters lie within its territory (≤ ~50 km across in
 * Kyiv oblast). Points far from the rest of their publisher's list were
 * geocoded to a same-named village elsewhere (e.g. Кагарлицька громада's
 * «Новосілки» placed north of Kyiv, 85 km away) — never offer those. */
const MAX_FROM_COMMUNITY_M = 50_000;
export function plausibleShelters<S extends { lat: number; lon: number; publisher: string }>(list: S[]): S[] {
  const byPublisher = new Map<string, S[]>();
  for (const s of list) byPublisher.set(s.publisher, [...(byPublisher.get(s.publisher) ?? []), s]);
  const median = (v: number[]) => { const a = [...v].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]!; };
  const out: S[] = [];
  for (const group of byPublisher.values()) {
    const c = { lat: median(group.map((s) => s.lat)), lon: median(group.map((s) => s.lon)) };
    for (const s of group) if (group.length < 3 || haversineMeters(c, { lat: s.lat, lon: s.lon }) <= MAX_FROM_COMMUNITY_M) out.push(s);
  }
  return out;
}

let asPlaces: (Omit<NearbyPlace, "distanceM"> & { category: "shelter" })[] | null = null;
function places() {
  if (asPlaces) return asPlaces;
  const b = load();
  asPlaces = plausibleShelters(b.shelters).map((s) => ({
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
