// Route landmarks: what the driver can SEE at each turn. Picked once when the
// route is built (online), then used for voice prompts, the maneuver card, the
// co-pilot and — most importantly — guidance without GPS ("after the OKKO
// fuel station turn right", "at the traffic lights turn left").
// Pure functions; unit-tested. Network code lives in RouteLandmarksProvider.

import type { LatLon } from "@navia/core";

export type LandmarkKind =
  | "traffic_signals" | "rail_crossing" | "bridge" | "roundabout"
  | "fuel" | "pharmacy" | "supermarket" | "shop" | "mall" | "church" | "school" | "hospital"
  | "bank" | "cafe" | "bus_stop" | "post" | "monument" | "police" | "other";

export type RawLandmark = { id: string; kind: LandmarkKind; name: string | null; location: LatLon };

/** A landmark projected onto the route. */
export type RouteLandmark = RawLandmark & {
  /** Metres from the route start to the landmark's projection. */
  alongM: number;
  /** Metres from the route line (lateral). */
  offsetM: number;
  side: "left" | "right" | "on";
};

/** Where a step's landmark is relative to the turn. */
export type StepLandmark = {
  landmark: RouteLandmark;
  /** before = you pass it, then turn; at = at the turn; after = you see it right after turning. */
  relation: "before" | "at" | "after";
};

// ——— Geometry ———

const R = 6371000;
const rad = (d: number) => d * Math.PI / 180;

function toXY(p: LatLon, origin: LatLon): { x: number; y: number } {
  return { x: rad(p.lon - origin.lon) * Math.cos(rad(origin.lat)) * R, y: rad(p.lat - origin.lat) * R };
}

export function cumulative(geometry: LatLon[]): number[] {
  const out = [0];
  for (let i = 1; i < geometry.length; i++) {
    const a = toXY(geometry[i - 1]!, geometry[i - 1]!);
    const b = toXY(geometry[i]!, geometry[i - 1]!);
    out.push(out[i - 1]! + Math.hypot(b.x - a.x, b.y - a.y));
  }
  return out;
}

/** Projects a point onto the polyline: distance along, lateral offset and side. */
export function project(point: LatLon, geometry: LatLon[], cum = cumulative(geometry)): { alongM: number; offsetM: number; side: "left" | "right" | "on" } {
  let best = { alongM: 0, offsetM: Infinity, side: "on" as "left" | "right" | "on" };
  for (let i = 1; i < geometry.length; i++) {
    const origin = geometry[i - 1]!;
    const b = toXY(geometry[i]!, origin);
    const p = toXY(point, origin);
    const len2 = b.x * b.x + b.y * b.y;
    const t = len2 > 0 ? Math.max(0, Math.min(1, (p.x * b.x + p.y * b.y) / len2)) : 0;
    const dx = p.x - t * b.x, dy = p.y - t * b.y;
    const d = Math.hypot(dx, dy);
    if (d < best.offsetM) {
      const cross = b.x * p.y - b.y * p.x;
      best = { alongM: cum[i - 1]! + t * Math.sqrt(len2), offsetM: d, side: d < 4 ? "on" : cross > 0 ? "left" : "right" };
    }
  }
  return best;
}

/** Keeps landmarks within `maxOffsetM` of the route, ordered along it. */
export function alongRoute(raw: RawLandmark[], geometry: LatLon[], maxOffsetM = 45): RouteLandmark[] {
  if (geometry.length < 2) return [];
  const cum = cumulative(geometry);
  return raw
    .map((l) => ({ ...l, ...project(l.location, geometry, cum) }))
    .filter((l) => l.offsetM <= (l.kind === "traffic_signals" || l.kind === "rail_crossing" ? 20 : maxOffsetM))
    .sort((a, b) => a.alongM - b.alongM);
}

// ——— Choosing one landmark per turn ———

const KIND_SCORE: Record<LandmarkKind, number> = {
  traffic_signals: 10, rail_crossing: 9, fuel: 8, bridge: 8, roundabout: 6, supermarket: 7, mall: 7, church: 7, pharmacy: 6,
  hospital: 6, school: 5, bank: 4, shop: 4, post: 4, police: 5, monument: 5, cafe: 3, bus_stop: 3, other: 2,
};

/** Best visible landmark for a turn at `turnAlongM`. Signals/crossings must be at the turn itself. */
export function landmarkForTurn(landmarks: RouteLandmark[], turnAlongM: number): StepLandmark | null {
  let best: { s: StepLandmark; score: number } | null = null;
  for (const l of landmarks) {
    const delta = l.alongM - turnAlongM;
    const exact = l.kind === "traffic_signals" || l.kind === "rail_crossing" || l.kind === "roundabout";
    if (exact ? Math.abs(delta) > 25 : delta < -90 || delta > 70) continue;
    // Nameless shops/cafés are useless as a cue.
    if (!exact && !l.name && ["shop", "cafe", "bank", "other", "post"].includes(l.kind)) continue;
    const relation: StepLandmark["relation"] = Math.abs(delta) <= 20 ? "at" : delta < 0 ? "before" : "after";
    const score = KIND_SCORE[l.kind] * 10 - Math.abs(delta) / 3 - l.offsetM / 5 + (l.name ? 4 : 0) + (relation === "at" ? 6 : 0);
    if (!best || score > best.score) best = { s: { landmark: l, relation }, score };
  }
  return best?.s ?? null;
}

// ——— Words ———

type Forms = { gen: string; acc: string; en: string };

function quoted(name: string | null): string {
  return name ? ` «${name}»` : "";
}

/** Ukrainian genitive ("після …", "біля …") and accusative ("побачите …") forms. */
export function landmarkForms(l: RawLandmark): Forms {
  const q = quoted(l.name);
  const en = l.name ? ` ${l.name}` : "";
  switch (l.kind) {
    case "traffic_signals": return { gen: "світлофора", acc: "світлофор", en: "the traffic lights" };
    case "rail_crossing": return { gen: "залізничного переїзду", acc: "залізничний переїзд", en: "the railway crossing" };
    case "bridge": return { gen: `мосту${l.name ? ` ${l.name}` : ""}`, acc: `міст${l.name ? ` ${l.name}` : ""}`, en: `the bridge${en}` };
    case "roundabout": return { gen: "кругового руху", acc: "круговий рух", en: "the roundabout" };
    case "fuel": return { gen: `АЗС${q}`, acc: `АЗС${q}`, en: `the${en} fuel station` };
    case "pharmacy": return { gen: `аптеки${q}`, acc: `аптеку${q}`, en: `the${en} pharmacy` };
    case "supermarket": return { gen: `супермаркету${q}`, acc: `супермаркет${q}`, en: `the${en} supermarket` };
    case "mall": return { gen: `ТЦ${q}`, acc: `ТЦ${q}`, en: `the${en} mall` };
    case "shop": return { gen: `магазину${q}`, acc: `магазин${q}`, en: `the${en} shop` };
    case "church": return { gen: "церкви", acc: "церкву", en: "the church" };
    case "school": return { gen: "школи", acc: "школу", en: "the school" };
    case "hospital": return { gen: "лікарні", acc: "лікарню", en: "the hospital" };
    case "bank": return { gen: `банку${q}`, acc: `банк${q}`, en: `the${en} bank` };
    case "cafe": return { gen: `кафе${q}`, acc: `кафе${q}`, en: `the${en} café` };
    case "bus_stop": return { gen: `зупинки${q}`, acc: `зупинку${q}`, en: `the${en} bus stop` };
    case "post": return { gen: `відділення${q}`, acc: `відділення${q}`, en: `the${en} post office` };
    case "police": return { gen: "поліції", acc: "відділок поліції", en: "the police station" };
    case "monument": return { gen: `пам'ятника${l.name ? ` «${l.name}»` : ""}`, acc: `пам'ятник${l.name ? ` «${l.name}»` : ""}`, en: `the${en} monument` };
    default: return { gen: l.name ? `«${l.name}»` : "орієнтира", acc: l.name ? `«${l.name}»` : "орієнтир", en: l.name ?? "the landmark" };
  }
}

/** Short cue shown on the maneuver card: "на світлофорі", "після АЗС «ОККО»". */
export function landmarkCue(s: StepLandmark, lang: "uk" | "en"): string {
  const f = landmarkForms(s.landmark);
  if (lang === "en") {
    if (s.landmark.kind === "traffic_signals" && s.relation !== "after") return "at the traffic lights";
    return s.relation === "before" ? `after ${f.en}` : s.relation === "at" ? `at ${f.en}` : `${f.en} right after the turn`;
  }
  if (s.landmark.kind === "traffic_signals" && s.relation !== "after") return "на світлофорі";
  if (s.relation === "before") return `після ${f.gen}`;
  if (s.relation === "at") return `біля ${f.gen}`;
  return `одразу після повороту — ${f.acc}`;
}

/** Spoken insertion before the action: ", на світлофорі," / ", після АЗС «ОККО»,". Empty for "after". */
export function landmarkLead(s: StepLandmark | null | undefined, lang: "uk" | "en"): string {
  if (!s || s.relation === "after") return "";
  return landmarkCue(s, lang);
}

/** Spoken confirmation after the action: "Після повороту побачите аптеку «Подорожник»." */
export function landmarkConfirmation(s: StepLandmark | null | undefined, lang: "uk" | "en"): string {
  if (!s || s.relation !== "after") return "";
  const f = landmarkForms(s.landmark);
  return lang === "uk" ? `Після повороту побачите ${f.acc}.` : `After the turn you'll see ${f.en}.`;
}

/** The landmarks just behind and just ahead of a position along the route. */
export function landmarksAround(landmarks: RouteLandmark[], progressM: number): { behind: RouteLandmark | null; ahead: RouteLandmark | null } {
  let behind: RouteLandmark | null = null;
  let ahead: RouteLandmark | null = null;
  for (const l of landmarks) {
    if (!l.name && ["shop", "cafe", "bank", "other", "post", "bus_stop"].includes(l.kind)) continue;
    if (l.alongM <= progressM) behind = l;
    else { ahead = l; break; }
  }
  return { behind, ahead };
}

/** Names of things a driver will not notice (parcel lockers, ATMs, terminals). */
export const INVISIBLE_NAME = /поштомат|parcel|банкомат|\batm\b|термінал|terminal|пункт видачі/i;

/** Classifies OSM tags into a landmark kind, or null when not a useful cue. */
export function landmarkKind(tags: Record<string, string>): LandmarkKind | null {
  if (INVISIBLE_NAME.test(tags.name ?? "") || tags.amenity === "parcel_locker" || tags.memorial === "plaque") return null;
  if (tags.highway === "traffic_signals") return "traffic_signals";
  if (tags.railway === "level_crossing" || tags.railway === "crossing") return "rail_crossing";
  if (tags.bridge && tags.bridge !== "no" && tags.name) return "bridge";
  if (tags.junction === "roundabout") return "roundabout";
  if (tags.amenity === "fuel") return "fuel";
  if (tags.amenity === "pharmacy" || tags.shop === "chemist") return "pharmacy";
  if (tags.shop === "supermarket") return "supermarket";
  if (tags.shop === "mall" || tags.shop === "department_store") return "mall";
  if (tags.amenity === "place_of_worship") return "church";
  if (tags.amenity === "school") return "school";
  if (tags.amenity === "hospital" || tags.amenity === "clinic") return "hospital";
  if (tags.amenity === "bank") return "bank";
  if (tags.amenity === "police") return "police";
  if (tags.amenity === "post_office") return "post";
  if (tags.amenity === "cafe" || tags.amenity === "restaurant" || tags.amenity === "fast_food") return "cafe";
  if (tags.highway === "bus_stop" || tags.public_transport === "platform") return tags.name ? "bus_stop" : null;
  if (tags.historic === "monument" || (tags.historic === "memorial" && /statue|war_memorial|obelisk|stele|sculpture/.test(tags.memorial ?? ""))) return "monument";
  if (tags.shop) return "shop";
  return null;
}
