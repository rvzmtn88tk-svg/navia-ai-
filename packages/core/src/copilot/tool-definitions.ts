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
import { LANDMARK_CATEGORIES as SEEN_CATEGORIES, UNSUPPORTED_CATEGORIES } from "../landmark-localizer";

const LOCATE_CATEGORIES = [...SEEN_CATEGORIES, ...UNSUPPORTED_CATEGORIES];

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
        exclude_place_ids: { type: "array", items: { type: "string" }, description: "Places the driver rejected ('not this one') — left out of the results." },
        beyond_place_id: { type: "string", description: "Only places further along the route than this place ('the next one after it')." },
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
        exclude_place_ids: { type: "array", items: { type: "string" }, description: "Places the driver rejected — left out of the results." },
        limit: { type: "integer", minimum: 1, maximum: 5, description: "Default 3." },
      },
      required: ["anchor"],
      additionalProperties: false,
    },
  },
  {
    name: "get_place_details",
    description:
      "Everything known about one place id from an earlier result: name, brand, category, cuisine, opening hours and open_now, where it is relative to the route (km and minutes ahead, side, distance from the road), the routed time the stop would add to the trip, straight-line distance from the car and from the destination, and whether it is already a stop. Use for 'how much time would we lose', 'is it open', 'which side is it on'.",
    input_schema: {
      type: "object",
      properties: { place_id: { type: "string" } },
      required: ["place_id"],
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
    name: "locate_by_description",
    description:
      "Where is the driver, from what they describe seeing, when GPS is lost, unreliable or they feel lost ('I see a Fora and a junction after it', 'metro, and opposite it a Dnipro-M'). Put each thing they mention in objects (the first is what they are next to), with relations between them and the side of the road if they said it. The code searches REAL map data (OpenStreetMap) in the area where the car can be and along the route, checks the relations, and returns: unique (one place — when it is near the estimate the navigator is placed there at once: position_fixed, undo with undo_position_fix), ambiguous (several — with a hint: the one observation that separates them), none (nothing matches — ask for something else; never guess), or unsupported (the map has no data for that kind of thing). Candidates carry ids l1, l2…",
    input_schema: {
      type: "object",
      properties: {
        objects: {
          type: "array", minItems: 1, maxItems: 3,
          items: {
            type: "object",
            properties: {
              category: { type: "string", enum: [...LOCATE_CATEGORIES], description: "What kind of thing. junction = a road junction/intersection. traffic_signals, traffic_sign, bridge, billboard are not in the map data (they come back as unsupported)." },
              name_variants: { type: "array", items: { type: "string" }, maxItems: 6, description: "Name/brand as said plus spellings in Ukrainian, Russian and Latin ('Днипро-М', 'Дніпро-М', 'Dnipro-M'). Omit when no name was said ('some metro, don't know which')." },
              side: { type: "string", enum: ["left", "right", "ahead", "behind"], description: "Side of the road relative to the direction of travel, only if the driver said it." },
              relation: { type: "string", enum: ["near", "opposite", "after", "before", "at_junction"], description: "Relation to object `of`: opposite = across the road; after/before = further/earlier in the direction of travel." },
              of: { type: "integer", minimum: 0, maximum: 2, description: "Index of the object this relation refers to (default 0)." },
            },
            additionalProperties: false,
          },
        },
      },
      required: ["objects"],
      additionalProperties: false,
    },
  },
  {
    name: "confirm_position",
    description:
      "Place the navigator at a location candidate (l1…) from locate_by_description: guidance then continues from there. Only for a UNIQUE candidate, or when the driver confirmed this exact place in their CURRENT message (answered the distinguishing question, said 'yes, I'm there'). Refused otherwise — ask the hint question first. Returns the next maneuver from that point. Undo with undo_position_fix.",
    input_schema: {
      type: "object",
      properties: {
        candidate_id: { type: "string", description: "l1, l2… from the latest locate_by_description." },
        driver_confirmed: { type: "boolean", description: "true only if the driver's CURRENT message confirms this exact place." },
      },
      required: ["candidate_id"],
      additionalProperties: false,
    },
  },
  {
    name: "report_driver_observation",
    description:
      "The driver tells how the car is moving while GPS is not placing it: standing ('стою в пробці'), moving again, their speed ('їду 40'), a turn they just made ('повернув праворуч'), being on a bridge or in a tunnel. The navigator uses it as evidence (stops advancing, takes the speed, places the car after the matching route turn or on the route's bridge/tunnel). Returns whether it was applied and why not.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["stopped", "moving", "speed", "turned", "on_bridge", "in_tunnel"] },
        speed_kmh: { type: "number", minimum: 1, maximum: 200, description: "For kind=speed." },
        direction: { type: "string", enum: ["left", "right", "around"], description: "For kind=turned." },
      },
      required: ["kind"],
      additionalProperties: false,
    },
  },
  {
    name: "undo_position_fix",
    description: "Undo the last confirm_position ('no, I'm not there', 'that was the wrong shop'): the navigator returns to its previous estimate.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "where_am_i",
    description:
      "Where the driver is now, from NAVIA's position estimate: street and district (reverse geocoding), notable named places right next to them (map data), how the position is known (GPS / estimated) and its uncertainty in metres, and whether they are on the active route. For 'where am I', 'what street is this', 'what's around'. Never give coordinates.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_safety_info",
    description:
      "Air-alert status for the driver's area and the nearest known shelters (official open data and OpenStreetMap), with distances from NAVIA's position estimate and how uncertain that estimate is. Shelters get place ids usable with set_destination. Informational only: never call a place or route safe.",
    input_schema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 5, description: "How many shelters. Default 3." } }, additionalProperties: false },
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
      "Add a place from an earlier result as an intermediate stop and reroute. Requires the driver's confirmation: the first call returns awaiting_user_confirmation with the time impact; call again after the driver says yes (or set driver_confirmed_in_this_message when the driver, having heard the impact earlier, now orders it).",
    input_schema: {
      type: "object",
      properties: { place_id: { type: "string" }, driver_confirmed_in_this_message: { type: "boolean", description: "true only if the driver's CURRENT message explicitly orders this exact action (e.g. 'add it', 'yes, the second one', 'go there') AND they already heard its time impact in an earlier answer. Otherwise omit: the call then only proposes and you ask." } },
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
      properties: { place_id: { type: "string" }, keep_stops: { type: "boolean" }, driver_confirmed_in_this_message: { type: "boolean", description: "true only if the driver's CURRENT message explicitly orders this exact action (e.g. 'add it', 'yes, the second one', 'go there') AND they already heard its time impact in an earlier answer. Otherwise omit: the call then only proposes and you ask." } },
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
      properties: { route_id: { type: "string" }, driver_confirmed_in_this_message: { type: "boolean", description: "true only if the driver's CURRENT message explicitly orders this exact action (e.g. 'add it', 'yes, the second one', 'go there') AND they already heard its time impact in an earlier answer. Otherwise omit: the call then only proposes and you ask." } },
      required: ["route_id"],
      additionalProperties: false,
    },
  },
  {
    name: "reorder_stops",
    description: "Visit the trip's stops in a different order (all stop ids from trip_state, in the new order) and reroute. Requires the driver's confirmation like add_stop.",
    input_schema: {
      type: "object",
      properties: { stop_ids: { type: "array", items: { type: "string" }, minItems: 2 } },
      required: ["stop_ids"],
      additionalProperties: false,
    },
  },
  {
    name: "set_reminder",
    description:
      "Remember something the driver wants later ('remind me about coffee in half an hour', 'let's stop somewhere in about an hour'). When it is due, NAVIA brings it up on its own and can look for matching places then. Give after_minutes or after_km. Runs immediately.",
    input_schema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "What to remind about, in the driver's language, short (e.g. 'кава', 'зупинка перепочити')." },
        after_minutes: { type: "number", minimum: 1, maximum: 600 },
        after_km: { type: "number", minimum: 0.5, maximum: 2000 },
        categories: categoriesProp,
      },
      required: ["topic"],
      additionalProperties: false,
    },
  },
  {
    name: "cancel_reminder",
    description: "Drop a reminder (id from trip_state reminders). Runs immediately.",
    input_schema: {
      type: "object",
      properties: { reminder_id: { type: "string" } },
      required: ["reminder_id"],
      additionalProperties: false,
    },
  },
  {
    name: "remember_preference",
    description:
      "Save a lasting preference the driver states about themselves ('I always fill up at OKKO', 'never take toll roads', 'I don't eat meat', 'don't bother me with suggestions'). Only for explicit, general statements — not for one-off requests like 'find an OKKO now'. Runs immediately; the driver can ask to forget it.",
    input_schema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          enum: ["preferred_fuel_brands", "avoided_brands", "preferred_food", "dietary", "max_detour_minutes", "avoid_tolls", "avoid_highways", "avoid_unpaved", "proactive_suggestions", "reply_length"],
        },
        value: {
          description: "Brands/foods: array of strings. max_detour_minutes: number. avoid_*: boolean. proactive_suggestions: 'normal' | 'important_only' | 'off'. reply_length: 'short' | 'normal'. dietary: short text.",
        },
        driver_words: { type: "string", description: "The driver's own words that state the preference (for the record)." },
      },
      required: ["key", "value", "driver_words"],
      additionalProperties: false,
    },
  },
  {
    name: "forget_preference",
    description: "Delete a saved preference (key from trip_state preferences). Runs immediately.",
    input_schema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
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
  | "search_along_route" | "search_near" | "get_place_details" | "get_route_overview" | "compare_routes" | "get_traffic_ahead"
  | "find_destination" | "check_landmark" | "get_landmarks_ahead" | "locate_by_description" | "confirm_position" | "undo_position_fix" | "report_driver_observation" | "get_safety_info" | "where_am_i" | "add_stop" | "remove_stop" | "set_destination"
  | "set_route_preferences" | "switch_route" | "reorder_stops" | "set_reminder" | "cancel_reminder"
  | "remember_preference" | "forget_preference" | "cancel_pending_action";

/**
 * What a tool may do without asking:
 * - read: fetches facts, changes nothing;
 * - safe_action: small, easily reversed change the driver explicitly asked for
 *   (remove a stop they named, a reminder, a preference they stated) — runs at once
 *   and is logged with its undo;
 * - confirm: changes the trip substantially (new stop, new destination, other
 *   route, new stop order) — proposed first, executed only after the driver's yes.
 */
export type ToolPolicy = "read" | "safe_action" | "confirm";

export const TOOL_POLICY: Record<CopilotToolName, ToolPolicy> = {
  search_along_route: "read", search_near: "read", get_place_details: "read", get_route_overview: "read",
  compare_routes: "read", get_traffic_ahead: "read", find_destination: "read", check_landmark: "read", get_landmarks_ahead: "read", locate_by_description: "safe_action", get_safety_info: "read", where_am_i: "read",
  confirm_position: "safe_action", undo_position_fix: "safe_action", report_driver_observation: "safe_action",
  add_stop: "confirm", set_destination: "confirm", switch_route: "confirm", reorder_stops: "confirm",
  remove_stop: "safe_action", set_route_preferences: "safe_action", set_reminder: "safe_action", cancel_reminder: "safe_action",
  remember_preference: "safe_action", forget_preference: "safe_action", cancel_pending_action: "safe_action",
};

/** Actions that only execute after the driver confirms in a later turn (or taps Confirm). */
export const CONFIRMATION_REQUIRED_TOOLS: ReadonlySet<string> = new Set(
  (Object.keys(TOOL_POLICY) as CopilotToolName[]).filter((t) => TOOL_POLICY[t] === "confirm"),
);
