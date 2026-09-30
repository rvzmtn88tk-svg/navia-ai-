// Building blocks for the evaluation suites. They describe the BEHAVIOUR a
// correct co-pilot shows (which kind of tool, which constraint, whether it
// proposes or changes nothing, whether it asks) — never the wording of the
// answer, so a scenario passes for any phrasing that behaves correctly.

import type { Scenario, TurnSpec, ToolCall } from "../scenarios";
import type { WorldOptions } from "../world";

export const SEARCH = ["search_along_route", "search_near"];
export const ACTIONS = ["add_stop", "set_destination", "switch_route", "reorder_stops", "remove_stop", "set_route_preferences"];

const n = (v: unknown) => (typeof v === "number" ? v : NaN);
const catsOf = (c: ToolCall) => (Array.isArray(c.input.categories) ? (c.input.categories as string[]) : []);
const namesOf = (c: ToolCall) => (Array.isArray(c.input.name_variants) ? (c.input.name_variants as string[]) : []);
const searches = (calls: ToolCall[]) => calls.filter((c) => SEARCH.includes(c.tool));

/** Searched for any of these categories (or a brand matching `brand`). */
export function searchedFor(categories: string[], brand?: RegExp): TurnSpec["expectCall"] {
  return {
    description: `searched for ${categories.join("|")}${brand ? ` or ${brand}` : ""}`,
    test: (calls) => searches(calls).some((c) => catsOf(c).some((x) => categories.includes(x)) || (brand != null && namesOf(c).some((x) => brand.test(x)))),
  };
}

export function detourAtMost(min: number, categories?: string[]): TurnSpec["expectCall"] {
  return {
    description: `search with max_detour_minutes <= ${min}${categories ? ` for ${categories.join("|")}` : ""}`,
    test: (calls) => calls.some((c) => c.tool === "search_along_route" && n(c.input.max_detour_minutes) <= min && (!categories || catsOf(c).some((x) => categories.includes(x)))),
  };
}

export function aheadWindowAround(minutes: number, slack = 0): TurnSpec["expectCall"] {
  return {
    description: `an ahead-minutes window that contains ${minutes}`,
    test: (calls) => calls.some((c) => {
      if (c.tool !== "search_along_route") return false;
      const lo = Number.isFinite(n(c.input.ahead_min_minutes)) ? n(c.input.ahead_min_minutes) : 0;
      const hi = Number.isFinite(n(c.input.ahead_max_minutes)) ? n(c.input.ahead_max_minutes) : Infinity;
      return lo <= minutes + slack && hi >= minutes - slack && (lo > 0 || hi < Infinity);
    }),
  };
}

export function rangeGiven(maxKm: number): TurnSpec["expectCall"] {
  return {
    description: `vehicle_range_km <= ${maxKm} or ahead_max_km <= ${maxKm}`,
    test: (calls) => calls.some((c) => c.tool === "search_along_route" && (n(c.input.vehicle_range_km) <= maxKm || n(c.input.ahead_max_km) <= maxKm)),
  };
}

export function both(a: TurnSpec["expectCall"], b: TurnSpec["expectCall"]): TurnSpec["expectCall"] {
  return { description: `${a!.description} AND ${b!.description}`, test: (c) => a!.test(c) && b!.test(c) };
}

/** Find places of a kind: search, nothing proposed or changed. */
export function find(categories: string[], extra: Partial<TurnSpec> = {}, brand?: RegExp): Partial<TurnSpec> {
  return { expectAnyTool: SEARCH, expectCall: searchedFor(categories, brand), expectPending: null, forbidTools: ACTIONS, maxWords: 55, ...extra };
}

/** A question answered without changing the trip. */
export function info(extra: Partial<TurnSpec> = {}): Partial<TurnSpec> {
  return { expectPending: null, forbidTools: ACTIONS, maxWords: 55, ...extra };
}

/** A trip change that must be proposed (and not executed yet). */
export function proposes(tool: string, extra: Partial<TurnSpec> = {}): Partial<TurnSpec> {
  return { expectPending: tool, ...extra };
}

/** The driver should be asked one question; nothing changes. */
export function clarifies(extra: Partial<TurnSpec> = {}): Partial<TurnSpec> {
  return { asksClarification: true, expectPending: null, forbidTools: ACTIONS, ...extra };
}

export function one(id: string, category: Scenario["category"], user: string, spec: Partial<TurnSpec>, world: WorldOptions = {}): Scenario {
  return { id, category, title: user, world, turns: [{ user, ...spec }] };
}

export function dialog(id: string, category: Scenario["category"], title: string, turns: TurnSpec[], world: WorldOptions = {}, extra: Partial<Scenario> = {}): Scenario {
  return { id, category, title, world, turns, ...extra };
}
