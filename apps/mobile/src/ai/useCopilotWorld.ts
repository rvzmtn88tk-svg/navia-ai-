// Assembles the co-pilot's view of the world from NAVIA's live stores: GPS
// and position mode from the engine, the alert, the trip and its landmarks,
// and nearby places with distance and direction from the user.
import { useEffect, useMemo, useState } from "react";
import { initialBearing, haversineMeters, nearestFirst, type LatLon, type RouteStep } from "@navia/core";
import { useNaviaStore } from "../engine/naviaController";
import { useNearbyStore } from "../store/nearbyStore";
import { useRouteIntel } from "../store/routeIntelStore";
import { useTripStore } from "../store/tripStore";
import { useAppSettings } from "../settings/AppSettings";
import { useT, type StringKey } from "../i18n";
import { landmarkConfirmation, landmarkCue, landmarksAround, type LandmarkKind } from "../navigation/landmarks";
import { actionWords, type StepLike } from "../voice/guidance";
import { cachedStreet, streetAt } from "../providers/streetAt";
import { gnssTrendReasons } from "../engine/gnssWords";
import type { CopilotWorld, PlaceKind, WorldLandmark, WorldPlace } from "./copilotBrain";
import { worldGps } from "./worldGps";

const KIND_LABEL_UK: Record<LandmarkKind, string> = {
  traffic_signals: "світлофор", rail_crossing: "залізничний переїзд", bridge: "міст", roundabout: "круговий рух", fuel: "АЗС", pharmacy: "аптека",
  supermarket: "супермаркет", shop: "магазин", mall: "ТЦ", church: "церква", school: "школа", hospital: "лікарня", bank: "банк", cafe: "кафе",
  bus_stop: "зупинка", post: "пошта", monument: "пам'ятник", police: "поліція", other: "орієнтир",
};

const PLACE_LABEL_UK: Record<PlaceKind, string> = {
  shelter: "укриття", resilience: "пункт незламності", fuel: "АЗС", charger: "зарядна станція", pharmacy: "аптека", hospital: "медзаклад",
  atm: "банк", water: "питна вода", food: "кафе", shop: "магазин",
};

const KNOWN_KINDS = new Set(["uav", "fpv", "recon", "kab", "cruise_missile", "ballistic_missile", "missile", "aircraft"]);

function landmarkName(kind: LandmarkKind, name: string | null): string {
  return name ? name : KIND_LABEL_UK[kind];
}

export function useCopilotWorld(): CopilotWorld {
  const { t, lang } = useT();
  const { displayName } = useAppSettings();
  const state = useNaviaStore((s) => s.state);
  const route = useNaviaStore((s) => s.route);
  const fix = useNaviaStore((s) => s.currentFix);
  const alert = useNaviaStore((s) => s.alert);
  const threat = useNaviaStore((s) => s.airThreatSummary);
  const byCategory = useNearbyStore((s) => s.byCategory);
  const intel = useRouteIntel();
  const trip = useTripStore();

  // Where the user is: GNSS / estimated position from the engine, else the last fix.
  const here: LatLon | null = state.position?.position ?? (fix ? { lat: fix.lat, lon: fix.lon } : null);
  const [street, setStreet] = useState(() => (here ? cachedStreet(here) : null));
  useEffect(() => {
    if (!here || state.gnss !== "NORMAL") return;
    let alive = true;
    void streetAt(here).then((r) => { if (alive && r) setStreet(r); });
    return () => { alive = false; };
  }, [here?.lat.toFixed(3), here?.lon.toFixed(3), state.gnss]); // eslint-disable-line react-hooks/exhaustive-deps

  return useMemo<CopilotWorld>(() => {
    const now = Date.now();
    const places: CopilotWorld["places"] = {};
    const placeStates: NonNullable<CopilotWorld["placeStates"]> = {};
    const placeGaps: NonNullable<CopilotWorld["placeGaps"]> = {};
    for (const [kind, entry] of Object.entries(byCategory) as [PlaceKind, { state: "idle" | "loading" | "ready" | "error"; unavailable?: string[] }][]) {
      placeStates[kind] = entry.state;
      if (entry.unavailable?.length) placeGaps[kind] = entry.unavailable;
    }
    for (const [kind, entry] of Object.entries(byCategory) as [PlaceKind, { places: { id: string; name: string; location: LatLon; address?: string; openingHours?: string }[] }][]) {
      // Nearest to the user NOW (the one shared nearest-first search), then 12.
      const ranked = here ? nearestFirst(entry.places.map((p) => ({ ...p, category: kind })), here, { limit: 12 }) : entry.places.slice(0, 12);
      places[kind] = ranked.map<WorldPlace>((p) => ({
        id: p.id, name: p.name, kind, location: p.location,
        distanceM: here ? haversineMeters(here, p.location) : 0,
        ...(here ? { bearingDeg: initialBearing(here, p.location) } : {}),
        ...(p.address ? { address: p.address } : {}),
        ...(p.openingHours ? { hours: p.openingHours } : {}),
      })).sort((a, b) => a.distanceM - b.distanceM);
    }

    const landmarks: WorldLandmark[] = [
      ...intel.along.map((l) => ({ name: landmarkName(l.kind, l.name), kindLabel: KIND_LABEL_UK[l.kind], location: l.location, onRoute: true, alongM: l.alongM })),
      ...Object.values(places).flat().filter((p) => p.name).map((p) => ({ name: p.name, kindLabel: PLACE_LABEL_UK[p.kind], location: p.location, onRoute: false })),
    ];

    let routeInfo: CopilotWorld["route"];
    if (route && trip.destination) {
      const next = state.nextStep as RouteStep | null;
      const cue = next ? intel.byStep[next.id] : undefined;
      const idx = next ? route.steps.findIndex((s) => s.id === next.id) : -1;
      const following = idx >= 0 ? route.steps[idx + 1] : undefined;
      const around = landmarksAround(intel.along, state.routeProgressM);
      routeInfo = {
        destination: trip.destination,
        mode: trip.mode,
        remainingM: state.routeRemainingM,
        etaS: state.etaSeconds ?? null,
        offRoute: state.offRoute,
        landmarkCount: intel.along.length,
        ...(next ? { next: {
          ...actionWords(next as StepLike, lang),
          distanceM: state.nextStepDistanceM ?? null,
          ...(cue ? { cue: landmarkCue(cue, lang) } : {}),
          ...(cue && landmarkConfirmation(cue, lang) ? { confirm: landmarkConfirmation(cue, lang) } : {}),
        } } : {}),
        ...(following ? { then: actionWords(following as StepLike, lang).action } : {}),
        ...(around.behind ? { behind: landmarkName(around.behind.kind, around.behind.name) } : {}),
        ...(around.ahead ? { ahead: landmarkName(around.ahead.kind, around.ahead.name) } : {}),
      };
    }

    const sameRegion = threat && alert && threat.region === alert.region;
    const kindsText = sameRegion ? threat.threatKinds.map((k) => t((KNOWN_KINDS.has(k) ? `alert.kind.${k}` : "alert.kind.other") as StringKey)).join(", ") : undefined;

    return {
      lang,
      now,
      ...(displayName ? { userName: displayName } : {}),
      gps: worldGps(state, {
        hasPosition: !!here,
        fixAccuracyM: fix?.accuracyM ?? null,
        ...(state.gnssTrend?.level === "degrading" ? { trendText: gnssTrendReasons(state.gnssTrend, t) } : {}),
      }),
      ...(street || alert?.locationLabel ? { here: { ...(street?.street ? { street: street.street } : {}), ...(street?.area || alert?.locationLabel ? { area: street?.area ?? alert?.locationLabel } : {}) } } : {}),
      ...(alert ? { alert: {
        active: alert.active,
        ...(alert.scope ? { scope: alert.scope } : {}),
        ...(alert.level ? { level: alert.level } : {}),
        ...(alert.reasons?.length ? { reasons: alert.reasons } : {}),
        ...(alert.since ? { since: alert.since } : {}),
        ...(alert.otherDistrictsActive ? { otherDistricts: alert.otherDistrictsActive } : {}),
        ...(alert.locationLabel ? { area: alert.locationLabel } : {}),
      } } : {}),
      ...(sameRegion ? { regional: { state: threat.state, ...(kindsText ? { kindsText } : {}) } } : {}),
      ...(routeInfo ? { route: routeInfo } : {}),
      places,
      placeStates,
      placeGaps,
      landmarks,
      remote: false,
    };
  }, [alert, byCategory, displayName, fix?.accuracyM, here?.lat, here?.lon, intel, lang, route, state, street, t, threat, trip.destination, trip.mode]); // eslint-disable-line react-hooks/exhaustive-deps
}
