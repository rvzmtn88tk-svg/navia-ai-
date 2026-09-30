// Localization from what the driver sees ("вижу Фору, а за ней перекрёсток",
// "метро, напротив Дніпро-М") while GNSS is lost or unreliable.
//
// The language model turns the driver's words into a structured description
// (objects + relations); this module does everything that must not be
// guessed: finds matching real map features in the area where the car can
// be, checks the relations and the side of the road, merges candidates that
// are the same place, scores them against the engine's estimate, and says
// whether the match is unique — or which question best separates the
// candidates. It never invents a place: every candidate is built from map
// features passed in (OpenStreetMap data from the map tiles).

import { haversineMeters, initialBearing } from "./geodesy";
import type { LatLon } from "./types";

/** A map feature (OpenMapTiles `poi` layer: class / subclass / name). */
export type MapFeature = { id: string; cls: string; sub: string | null; name: string | null; location: LatLon };

/** What the driver can name. `junction` comes from the road network, the rest from map features. */
export const LANDMARK_CATEGORIES = [
  "metro", "rail_station", "bus_stop", "tram_stop", "fuel", "supermarket", "convenience", "shop", "pharmacy",
  "bank", "atm", "church", "school", "kindergarten", "hospital", "cafe", "restaurant", "fast_food", "parking",
  "post", "mall", "hotel", "junction",
] as const;
export type SeenCategory = (typeof LANDMARK_CATEGORIES)[number];

/** Categories the map data cannot show (asked for → "no data", never a guess). */
export const UNSUPPORTED_CATEGORIES = ["traffic_signals", "traffic_sign", "bridge", "billboard"] as const;

export type DescribedObject = {
  category?: SeenCategory | (typeof UNSUPPORTED_CATEGORIES)[number];
  /** Spellings of the name/brand in any language ("Фора", "Fora"). */
  name_variants?: string[];
  /** Side of the road relative to the direction of travel. */
  side?: "left" | "right" | "ahead" | "behind";
  /** Relation to object `of` (default: the first object). */
  relation?: "near" | "opposite" | "after" | "before" | "at_junction";
  of?: number;
};

export type LocateRequest = {
  objects: DescribedObject[];
  /** The engine's estimate and its uncertainty (σ, metres). */
  estimate: { location: LatLon; sigmaM: number; headingDeg?: number | null };
  /** Active route geometry (search corridor, direction of travel, "on route"). */
  route?: LatLon[] | null;
  features: MapFeature[];
  junctions?: LatLon[];
};

export type LocateMatch = { object: number; name: string | null; category: string; distanceM: number };

export type LocateCandidate = {
  id: string;
  /** Where the driver is believed to be if this candidate is right (never shown to the model). */
  location: LatLon;
  score: number;
  matched: LocateMatch[];
  /** Objects of the description this place does not have. */
  missing: number[];
  contradictions: string[];
  distanceFromEstimateM: number;
  onRoute: boolean;
  /** Metres along the route from its start (when on route). */
  routeProgressM: number | null;
  farFromEstimate: boolean;
  /** Notable things right next to this place (for questions and confirmation). */
  nearby: { category: SeenCategory; name: string | null; distanceM: number }[];
  side: "left" | "right" | null;
};

export type DistinguishingHint =
  | { kind: "side"; options: { candidate: string; side: "left" | "right" }[] }
  | { kind: "nearby"; category: SeenCategory; present_at: string[]; absent_at: string[] }
  | { kind: "name"; options: { candidate: string; name: string }[] };

export type LocateResult = {
  status: "unique" | "ambiguous" | "none" | "unsupported";
  candidates: LocateCandidate[];
  searchedRadiusM: number;
  hint: DistinguishingHint | null;
  /** Categories asked for that the map data does not contain. */
  unsupported: string[];
};

const NEAR_M = 150;
const OPPOSITE_M = 150;
const SEQUENCE_M = 400;
const JUNCTION_M = 70;
const SAME_PLACE_M = 120;
const SAME_NAMED_PLACE_M = 400;
/** Stations spread over several entrances/platforms; two shops of one brand are two places. */
const MULTI_ENTRANCE = new Set(["metro", "rail_station", "bus_stop", "tram_stop"]);
const ON_ROUTE_M = 60;

export function searchRadiusM(sigmaM: number): number {
  return Math.min(3000, Math.max(300, 3 * sigmaM));
}

// ——— categories ———

const SHOP_CLASSES = new Set(["shop", "grocery", "clothing_store", "alcohol_shop", "bakery", "butcher", "beer", "ice_cream", "jewelry", "music", "furniture", "garden", "hardware", "doityourself", "car", "bicycle", "books", "gift", "toys", "shoes", "mobile_phone", "electronics", "florist", "optician"]);

export function featureCategories(f: Pick<MapFeature, "cls" | "sub">): SeenCategory[] {
  const out: SeenCategory[] = [];
  const { cls, sub } = f;
  if (sub === "subway_entrance" || (cls === "railway" && sub === "subway")) out.push("metro");
  if (cls === "railway" && (sub === "station" || sub === "halt")) out.push("rail_station");
  if (sub === "bus_stop" || cls === "bus") out.push("bus_stop");
  if (sub === "tram_stop") out.push("tram_stop");
  if (cls === "fuel" && sub !== "charging_station") out.push("fuel");
  if (sub === "supermarket") out.push("supermarket");
  if (sub === "convenience") out.push("convenience");
  if (SHOP_CLASSES.has(cls) || cls === "shop" || sub === "supermarket" || sub === "convenience" || sub === "doityourself" || sub === "hardware") out.push("shop");
  if (cls === "pharmacy" || sub === "pharmacy" || sub === "chemist") out.push("pharmacy");
  if (cls === "bank") out.push("bank");
  if (cls === "atm") out.push("atm");
  if (cls === "place_of_worship") out.push("church");
  if (sub === "school") out.push("school");
  if (sub === "kindergarten") out.push("kindergarten");
  if (cls === "hospital") out.push("hospital");
  if (cls === "cafe") out.push("cafe");
  if (cls === "restaurant") out.push("restaurant");
  if (cls === "fast_food") out.push("fast_food");
  if (cls === "parking" && sub !== "bicycle_parking") out.push("parking");
  if (sub === "post_office") out.push("post");
  if (sub === "mall" || sub === "department_store") out.push("mall");
  if (cls === "lodging" && sub === "hotel") out.push("hotel");
  return out;
}

// ——— names: any language, typos, partial ———

const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", ґ: "g", д: "d", е: "e", є: "e", ё: "e", ж: "zh", з: "z", и: "i", і: "i", ї: "i", й: "i",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch",
  ш: "sh", щ: "sch", ъ: "", ы: "i", ь: "", э: "e", ю: "iu", я: "ia", "'": "", "’": "", "ʼ": "",
};

/** Lower-case Latin key: "Дніпро-М" / "Днипро М" / "Dnipro-M" → "dnipro m". */
export function nameKey(s: string): string {
  const lower = s.toLowerCase().replace(/[«»"“”„]/g, " ");
  let out = "";
  for (const ch of lower) out += TRANSLIT[ch] ?? ch;
  return out
    .replace(/kh/g, "h").replace(/y/g, "i").replace(/j/g, "i").replace(/w/g, "v")
    .replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function bigrams(s: string): string[] {
  const t = s.replace(/ /g, "");
  const out: string[] = [];
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  return out;
}

function dice(a: string, b: string): number {
  const x = bigrams(a), y = bigrams(b);
  if (x.length === 0 || y.length === 0) return a === b ? 1 : 0;
  const pool = new Map<string, number>();
  for (const g of y) pool.set(g, (pool.get(g) ?? 0) + 1);
  let hit = 0;
  for (const g of x) { const n = pool.get(g) ?? 0; if (n > 0) { hit++; pool.set(g, n - 1); } }
  return (2 * hit) / (x.length + y.length);
}

/** 0..1: how well a spoken name matches a map name (1 = same, ≥ 0.55 = accepted). */
export function nameMatch(spoken: string, mapName: string): number {
  const a = nameKey(spoken), b = nameKey(mapName);
  if (!a || !b) return 0;
  if (a === b) return 1;
  // Whole-word containment: "Dnipro M" in "Фірмовий магазин Dnipro-M".
  const words = ` ${b} `;
  if (a.length >= 3 && words.includes(` ${a} `)) return 0.95;
  const bw = b.split(" ");
  // Compare with every run of as many words as spoken.
  const n = a.split(" ").length;
  // Typo tolerance only for words that start the same, and stricter for short
  // ones: "IKEA" must not match "Bike Point", "Фора" not "Платформа".
  const fuzzy = (x: string, y: string) => {
    if (x[0] !== y[0]) return 0;
    const d = dice(x, y);
    return x.replace(/ /g, "").length <= 5 ? (d >= 0.75 ? d : 0) : d;
  };
  let best = fuzzy(a, b);
  for (let i = 0; i + n <= bw.length; i++) best = Math.max(best, fuzzy(a, bw.slice(i, i + n).join(" ")));
  return best;
}

const NAME_OK = 0.55;

// ——— geometry helpers ———

type Vec = { e: number; n: number };
function toLocal(origin: LatLon, p: LatLon): Vec {
  const k = Math.cos((origin.lat * Math.PI) / 180);
  return { e: (p.lon - origin.lon) * 111_320 * k, n: (p.lat - origin.lat) * 110_540 };
}

function nearestOnRoute(route: LatLon[], p: LatLon): { distanceM: number; progressM: number; bearing: number } | null {
  if (route.length < 2) return null;
  let best: { distanceM: number; progressM: number; bearing: number } | null = null;
  let along = 0;
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1]!, b = route[i]!;
    const ab = toLocal(a, b), ap = toLocal(a, p);
    const len2 = ab.e * ab.e + ab.n * ab.n;
    const segLen = Math.sqrt(len2);
    const t = len2 > 0 ? Math.max(0, Math.min(1, (ap.e * ab.e + ap.n * ab.n) / len2)) : 0;
    const d = Math.hypot(ap.e - t * ab.e, ap.n - t * ab.n);
    if (!best || d < best.distanceM) best = { distanceM: d, progressM: along + t * segLen, bearing: initialBearing(a, b) };
    along += segLen;
  }
  return best;
}

/** Signed position of `p` relative to a travel direction through `at`: along (+ ahead) and across (+ right). */
function relative(at: LatLon, bearingDeg: number, p: LatLon): { along: number; across: number } {
  const v = toLocal(at, p);
  const r = (bearingDeg * Math.PI) / 180;
  const dir = { e: Math.sin(r), n: Math.cos(r) };
  return { along: v.e * dir.e + v.n * dir.n, across: v.e * dir.n - v.n * dir.e };
}

// ——— the search ———

type Hit = { f: MapFeature | null; loc: LatLon; nameScore: number; category: string };

function matchesObject(o: DescribedObject, f: MapFeature): number {
  const cats = featureCategories(f);
  if (o.category && o.category !== "junction" && !cats.includes(o.category as SeenCategory)) {
    // A named brand is enough on its own ("Дніпро-М" without a category).
    if (!(o.name_variants?.length)) return 0;
  }
  if (o.name_variants?.length) {
    if (!f.name) return 0;
    const s = Math.max(...o.name_variants.map((v) => nameMatch(v, f.name!)));
    return s >= NAME_OK ? s : 0;
  }
  return o.category ? 1 : 0;
}

function hitsFor(o: DescribedObject, features: MapFeature[], junctions: LatLon[]): Hit[] {
  if (o.category === "junction") return junctions.map((j) => ({ f: null, loc: j, nameScore: 1, category: "junction" }));
  const out: Hit[] = [];
  for (const f of features) {
    const s = matchesObject(o, f);
    if (s > 0) out.push({ f, loc: f.location, nameScore: s, category: o.category ?? featureCategories(f)[0] ?? f.cls });
  }
  return out;
}

function relationHolds(rel: DescribedObject["relation"], ref: LatLon, p: LatLon, bearing: number | null): boolean {
  const d = haversineMeters(ref, p);
  switch (rel ?? "near") {
    case "near": return d <= NEAR_M;
    case "opposite": return d <= OPPOSITE_M;
    case "at_junction": return d <= JUNCTION_M;
    case "after":
    case "before": {
      if (bearing == null) return d <= SEQUENCE_M;
      const r = relative(ref, bearing, p);
      const ahead = rel === "after" ? r.along : -r.along;
      return ahead >= 10 && ahead <= SEQUENCE_M && Math.abs(r.across) <= NEAR_M;
    }
  }
}

/** Finds where the driver can be, from a structured description of what they see. */
export function locateByDescription(req: LocateRequest): LocateResult {
  const radius = searchRadiusM(req.estimate.sigmaM);
  const unsupported = req.objects.filter((o) => (UNSUPPORTED_CATEGORIES as readonly string[]).includes(o.category ?? "")).map((o) => o.category!);
  const objects = req.objects.filter((o) => !(UNSUPPORTED_CATEGORIES as readonly string[]).includes(o.category ?? ""));
  if (objects.length === 0) return { status: unsupported.length ? "unsupported" : "none", candidates: [], searchedRadiusM: radius, hint: null, unsupported };

  const route = req.route && req.route.length >= 2 ? req.route : null;
  const inArea = (p: LatLon) => {
    const d = haversineMeters(req.estimate.location, p);
    if (d <= radius) return true;
    // The route corridor a bit further out: the estimate is along the route.
    if (route && d <= radius * 1.5) { const n = nearestOnRoute(route, p); return !!n && n.distanceM <= 150; }
    return false;
  };
  const features = req.features.filter((f) => inArea(f.location));
  const junctions = (req.junctions ?? []).filter(inArea);
  const sigmaEff = Math.max(req.estimate.sigmaM, 150);

  const anchorObj = objects[0]!;
  const anchors = hitsFor(anchorObj, features, junctions);
  const raw: LocateCandidate[] = [];
  for (const a of anchors) {
    const onR = route ? nearestOnRoute(route, a.loc) : null;
    const bearing = onR && onR.distanceM <= 200 ? onR.bearing : req.estimate.headingDeg ?? null;
    const matched: LocateMatch[] = [{ object: 0, name: a.f?.name ?? null, category: a.category, distanceM: 0 }];
    const chosen: Hit[] = [a];
    const missing: number[] = [];
    let nameScore = a.nameScore;
    for (let i = 1; i < objects.length; i++) {
      const o = objects[i]!;
      const ref = chosen[Math.min(o.of ?? 0, chosen.length - 1)]!;
      const options = hitsFor(o, features, junctions)
        .filter((h) => h.f?.id !== a.f?.id || h.f == null)
        .filter((h) => relationHolds(o.relation, ref.loc, h.loc, bearing))
        .sort((x, y) => y.nameScore - x.nameScore || haversineMeters(ref.loc, x.loc) - haversineMeters(ref.loc, y.loc));
      const h = options[0];
      if (!h) { missing.push(i); chosen.push(ref); continue; }
      chosen.push(h);
      nameScore += h.nameScore;
      matched.push({ object: i, name: h.f?.name ?? null, category: h.category, distanceM: Math.round(haversineMeters(ref.loc, h.loc)) });
    }
    // The driver is next to what they see: the anchor's position (route-snapped when on route).
    const location = a.loc;
    const dEst = haversineMeters(req.estimate.location, location);
    const side = bearing != null ? (relative(onR && onR.distanceM <= 200 ? routePoint(route!, onR.progressM) : req.estimate.location, bearing, location).across >= 0 ? "right" : "left") : null;
    const contradictions: string[] = [];
    if (anchorObj.side && (anchorObj.side === "left" || anchorObj.side === "right") && side && anchorObj.side !== side) contradictions.push(`described on the ${anchorObj.side}, map has it on the ${side}`);
    const prior = Math.exp(-0.5 * (dEst / sigmaEff) ** 2);
    const completeness = (objects.length - missing.length) / objects.length;
    const onRoute = !!onR && onR.distanceM <= ON_ROUTE_M;
    const score = prior * (nameScore / objects.length) * completeness ** 2 * (contradictions.length ? 0.25 : 1) * (onRoute ? 1.5 : 1);
    raw.push({
      id: "", location, score, matched, missing, contradictions, distanceFromEstimateM: Math.round(dEst), onRoute,
      routeProgressM: onR ? Math.round(onR.progressM) : null, farFromEstimate: dEst > 3 * sigmaEff,
      nearby: nearbyNotable(location, features), side,
    });
  }

  // One place, one candidate: two entrances of the same metro, a shop in two tile buffers.
  raw.sort((x, y) => y.score - x.score);
  const places: LocateCandidate[] = [];
  const anchorName = (c: LocateCandidate) => c.matched[0]?.name ?? null;
  // Same place: close together, or the same named anchor (two entrances of one metro station).
  const same = (p: LocateCandidate, c: LocateCandidate) => {
    const d = haversineMeters(p.location, c.location);
    return d <= SAME_PLACE_M || (MULTI_ENTRANCE.has(p.matched[0]?.category ?? "") && !!anchorName(p) && anchorName(p) === anchorName(c) && d <= SAME_NAMED_PLACE_M);
  };
  for (const c of raw) {
    const p = places.find((x) => same(x, c));
    if (!p) { places.push({ ...c }); continue; }
    // One place on both sides of the road (metro entrances): the side tells nothing.
    if (p.side && c.side && p.side !== c.side && anchorName(p) === anchorName(c)) p.side = null;
  }
  const full = places.filter((c) => c.missing.length === 0);
  const pool = (full.length ? full : places).slice(0, 5).map((c, i) => ({ ...c, id: `l${i + 1}` }));

  if (pool.length === 0) return { status: "none", candidates: [], searchedRadiusM: radius, hint: null, unsupported };
  const complete = full.length > 0;
  const top = pool[0]!, second = pool[1];
  const clear = complete && top.contradictions.length === 0 && (!second || top.score >= 4 * second.score);
  if (clear) return { status: "unique", candidates: pool, searchedRadiusM: radius, hint: null, unsupported };
  return { status: complete ? "ambiguous" : "none", candidates: pool, searchedRadiusM: radius, hint: complete ? distinguish(pool.slice(0, 3)) : null, unsupported };
}

function routePoint(route: LatLon[], progressM: number): LatLon {
  let along = 0;
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1]!, b = route[i]!;
    const seg = haversineMeters(a, b);
    if (along + seg >= progressM) {
      const t = seg > 0 ? (progressM - along) / seg : 0;
      return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
    }
    along += seg;
  }
  return route[route.length - 1]!;
}

const NOTABLE: SeenCategory[] = ["metro", "fuel", "supermarket", "pharmacy", "bank", "church", "bus_stop", "school", "mall", "hospital", "post"];

function nearbyNotable(at: LatLon, features: MapFeature[]): LocateCandidate["nearby"] {
  const out: LocateCandidate["nearby"] = [];
  for (const f of features) {
    const d = haversineMeters(at, f.location);
    if (d > NEAR_M) continue;
    const cat = featureCategories(f).find((c) => NOTABLE.includes(c));
    if (cat && !out.some((o) => o.category === cat && o.name === f.name)) out.push({ category: cat, name: f.name, distanceM: Math.round(d) });
  }
  return out.sort((a, b) => a.distanceM - b.distanceM).slice(0, 8);
}

/** The single observation that best splits the top candidates (the code chooses; the model phrases it). */
export function distinguish(cands: LocateCandidate[]): DistinguishingHint | null {
  if (cands.length < 2) return null;
  const sides = cands.map((c) => c.side);
  if (sides.every((s) => s != null) && new Set(sides).size > 1) {
    return { kind: "side", options: cands.map((c) => ({ candidate: c.id, side: c.side! })) };
  }
  // Different names of what the driver saw (two metro stations): a sign answers it at a glance.
  const names = cands.map((c) => c.matched.find((m) => m.name)?.name ?? null);
  if (names.every((n) => n) && new Set(names).size === names.length) return { kind: "name", options: cands.map((c, i) => ({ candidate: c.id, name: names[i]! })) };
  // A notable neighbour present at some candidates and not at others; the most even split wins.
  let best: { cat: SeenCategory; present: string[]; absent: string[]; balance: number } | null = null;
  for (const cat of NOTABLE) {
    const present = cands.filter((c) => c.nearby.some((n) => n.category === cat)).map((c) => c.id);
    if (present.length === 0 || present.length === cands.length) continue;
    const balance = Math.abs(present.length - cands.length / 2);
    if (!best || balance < best.balance) best = { cat, present, absent: cands.map((c) => c.id).filter((id) => !present.includes(id)), balance };
  }
  if (best) return { kind: "nearby", category: best.cat, present_at: best.present, absent_at: best.absent };
  return null;
}

// ——— junctions from road lines ———

/** Road junctions: vertices where roads meet with at least three road ends/branches. */
export function junctionsFromRoads(roads: { points: LatLon[] }[]): LatLon[] {
  const degree = new Map<string, { n: number; p: LatLon; lines: Set<number> }>();
  const key = (p: LatLon) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
  roads.forEach((r, li) => {
    r.points.forEach((p, i) => {
      const k = key(p);
      const e = degree.get(k) ?? { n: 0, p, lines: new Set<number>() };
      e.n += i === 0 || i === r.points.length - 1 ? 1 : 2;
      e.lines.add(li);
      degree.set(k, e);
    });
  });
  const out: LatLon[] = [];
  for (const e of degree.values()) if (e.lines.size >= 2 && e.n >= 3 && !out.some((o) => haversineMeters(o, e.p) < 25)) out.push(e.p);
  return out;
}
