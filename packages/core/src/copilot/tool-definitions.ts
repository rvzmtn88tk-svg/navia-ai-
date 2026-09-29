// Tool schemas the co-pilot model sees. The backend sends exactly this list
// (in this order — a stable order keeps the provider's prompt cache warm);
// the app executes the calls in tool-executor.ts.
//
// Design rules:
// - Tools take and return ids (p1, s1, r1), never coordinates: the model
//   cannot fabricate a location, and fewer tokens cross the wire.
// - Every numeric fact in a tool result is computed deterministically by
//   route-geometry.ts / RoutingProvider / PlaceSearchProvider.

import type { LandmarkCategory } from "../landmark-engine";

export type ToolDefinition = {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
};

/** Categories the model may search for (the trip-service subset of LandmarkCategory). */
export const SEARCHABLE_CATEGORIES: LandmarkCategory[] = [
  "fuel", "ev_charging", "restaurant", "cafe", "fast_food", "parking", "supermarket",
  "pharmacy", "hospital", "toilets", "hotel", "atm", "car_wash", "car_repair", "shopping_centre",
];

const categoriesProp = {
  type: "array",
  items: { type: "string", enum: SEARCHABLE_CATEGORIES },
  description: "Place categories to match (any of them). Coffee → cafe; burgers/McDonald's/KFC → fast_food; a sit-down meal → restaurant.",
};

const nameVariantsProp = {
  type: "array",
  items: { type: "string" },
  description: "Name or brand spellings to match (any of them), e.g. [\"McDonald's\", \"Макдональдз\"] or [\"WOG\", \"ОККО\", \"OKKO\"]. Omit for any place in the category.",
};

export const COPILOT_TOOLS: ToolDefinition[] = [
  {
    name: "search_along_route",
    description:
      "Find places ahead on the active route. Returns up to `limit` places sorted by detour, each with how far ahead it is (km and minutes, from the routing engine's timings), the extra driving time to stop there (detour_min, routed or estimated), side of the road, and open_now when opening hours are known. Use for anything 'on the way'.",
    input_schema: {
      type: "object",
      properties: {
        categories: categoriesProp,
        name_variants: nameVariantsProp,
        ahead_min_minutes: { type: "number", minimum: 0, description: "Only places reached at least this many minutes from now." },
        ahead_max_minutes: { type: "number", minimum: 0, description: "Only places reached within this many minutes from now." },
        ahead_max_km: { type: "number", minimum: 0, description: "Only places within this many km ahead along the route." },
        max_detour_minutes: { type: "number", minimum: 0, description: "Drop places whose detour exceeds this." },
        vehicle_range_km: { type: "number", minimum: 0, description: "Remaining driving range (e.g. fuel or battery). Results get reachable=true/false with a safety reserve." },
        open_now_only: { type: "boolean", description: "Drop places known to be closed now (unknown hours are kept and marked)." },
        limit: { type: "integer", minimum: 1, maximum: 5, description: "Default 3." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "search_near",
    description:
      "Find places around a point: the destination, the current position, or a place id from an earlier result. Returns distance from that point (and walking minutes when anchored at the destination). Use for 'parking near the destination', 'a pharmacy nearby'.",
    input_schema: {
      type: "object",
      properties: {
        anchor: { type: "string", enum: ["destination", "current_position", "place"], description: "Point to search around." },
        place_id: { type: "string", description: "Required when anchor is 'place'." },
        categories: categoriesProp,
        name_variants: nameVariantsProp,
        radius_m: { type: "integer", minimum: 50, maximum: 5000, description: "Default 800." },
        open_now_only: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 5, description: "Default 3." },
      },
      required: ["anchor"],
      additionalProperties: false,
    },
  },
  {
    name: "get_route_overview",
    description:
      "Details of the active route: provider, total/remaining distance and time, arrival time, stops, applied and unsupported road preferences, the main roads ahead with their lengths, and the next maneuvers (distances withheld when position confidence is low).",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "compare_routes",
    description:
      "Ask the routing engine for alternative routes from the current position to the destination (keeping stops and preferences). Returns each alternative's id, time and distance, the difference versus the active route, and the main roads it uses. Times are the engine's estimates, not live traffic.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_traffic_ahead",
    description: "Live traffic delays ahead on the active route, if a traffic data source is connected. Returns available=false with a reason otherwise.",
    input_schema: {
      type: "object",
      properties: { ahead_max_km: { type: "number", minimum: 0, description: "How far ahead to check. Default: whole remaining route." } },
      additionalProperties: false,
    },
  },
  {
    name: "find_destination",
    description:
      "Resolve a destination the driver named: a saved place (home, work) or a free-text address/place search. Returns candidate ids with labels and straight-line distance from the current position. Use before set_destination.",
    input_schema: {
      type: "object",
      properties: {
        saved_place: { type: "string", enum: ["home", "work"] },
        query: { type: "string", description: "Address or place name as the driver said it (Ukrainian/Russian/Latin all fine)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "check_landmark",
    description:
      "The driver says they see a named place ('I see a WOG — is that my turn?'). Checks the map for matching places ahead on the route and whether one is an unambiguous match; returns confirmed / ambiguous / no_match with distance and the maneuver after it.",
    input_schema: {
      type: "object",
      properties: { name_variants: nameVariantsProp },
      required: ["name_variants"],
      additionalProperties: false,
    },
  },
  {
    name: "get_landmarks_ahead",
    description:
      "Recognisable places along the route ahead, grouped by the upcoming maneuvers: for each of the next maneuvers, which named places are just before, at or just after it (side of road, metres from the turn), plus notable places on the way. Use for 'what landmarks are on the way', 'how will I recognise the turn', or when GPS is unreliable and the driver needs visual cues.",
    input_schema: {
      type: "object",
      properties: {
        maneuvers: { type: "integer", minimum: 1, maximum: 5, description: "How many upcoming maneuvers to describe. Default 3." },
        ahead_max_km: { type: "number", minimum: 0.2, maximum: 50, description: "Look this far ahead. Default 5." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "add_stop",
    description:
      "Add a place from an earlier result as an intermediate stop and reroute. Requires the driver's confirmation: the first call returns awaiting_user_confirmation with the time impact; call again after the driver says yes.",
    input_schema: {
      type: "object",
      properties: { place_id: { type: "string" } },
      required: ["place_id"],
      additionalProperties: false,
    },
  },
  {
    name: "remove_stop",
    description: "Remove an intermediate stop (id from trip_state stops) and reroute. Runs immediately.",
    input_schema: {
      type: "object",
      properties: { stop_id: { type: "string" } },
      required: ["stop_id"],
      additionalProperties: false,
    },
  },
  {
    name: "set_destination",
    description:
      "Replace the destination with a place/candidate id and reroute (existing stops are cleared unless keep_stops is true). Requires the driver's confirmation like add_stop.",
    input_schema: {
      type: "object",
      properties: { place_id: { type: "string" }, keep_stops: { type: "boolean" } },
      required: ["place_id"],
      additionalProperties: false,
    },
  },
  {
    name: "set_route_preferences",
    description:
      "Change road-type avoidance and reroute: true to avoid, false to allow again, omit to leave unchanged. Returns which preferences the routing engine applied or cannot support, and the time change.",
    input_schema: {
      type: "object",
      properties: {
        avoid_unpaved: { type: "boolean", description: "Unpaved roads and tracks — the closest supported proxy for 'bad roads'." },
        avoid_tolls: { type: "boolean" },
        avoid_highways: { type: "boolean" },
        avoid_ferries: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "switch_route",
    description: "Switch to an alternative route id from compare_routes. Requires the driver's confirmation like add_stop.",
    input_schema: {
      type: "object",
      properties: { route_id: { type: "string" } },
      required: ["route_id"],
      additionalProperties: false,
    },
  },
  {
    name: "cancel_pending_action",
    description: "Discard the action awaiting confirmation (the driver said no or changed their mind).",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
];

export type CopilotToolName =
  | "search_along_route" | "search_near" | "get_route_overview" | "compare_routes" | "get_traffic_ahead"
  | "find_destination" | "check_landmark" | "get_landmarks_ahead" | "add_stop" | "remove_stop" | "set_destination"
  | "set_route_preferences" | "switch_route" | "cancel_pending_action";

/** Actions that only execute after the driver confirms in a later turn (or taps Confirm). */
export const CONFIRMATION_REQUIRED_TOOLS: ReadonlySet<string> = new Set(["add_stop", "set_destination", "switch_route"]);
