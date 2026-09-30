// Offline fallback for the most common co-pilot request — "find <kind of
// place> on the way (within N minutes)" — used ONLY when the LLM is not
// available (no backend configured, driver consent off, backend down). The
// primary path understands requests with the LLM; this is a deliberately
// small keyword parser so that a driver without the smart mode still gets a
// real, tool-computed answer instead of "I can only talk about GPS".
//
// It never guesses: it runs the same search_along_route / search_near tools
// and phrases only their results.

import type { LandmarkCategory } from "../landmark-engine";

export type LocalPlaceIntent = {
  tool: "search_along_route" | "search_near";
  input: Record<string, unknown>;
  label: string;
};

// Stems cover Ukrainian and Russian spellings.
const CATEGORY_STEMS: [RegExp, LandmarkCategory, string][] = [
  [/заправ|азс|пальн|бензин|дизел|топлив/i, "fuel", "заправку"],
  [/зарядк|зарядн|електрозаряд|электрозаряд/i, "ev_charging", "зарядку"],
  [/паркінг|парковк|паркування|припаркув|припарков/i, "parking", "парковку"],
  [/макдональд|mcdonald|фастфуд|фаст-фуд|kfc|бургер/i, "fast_food", "фастфуд"],
  [/кав[аиуі]|кофе|кафе|coffee/i, "cafe", "каву"],
  [/ресторан|поїсти|поесть|їсти|голод|перекус|обід|обед|вечер[яю]|ужин/i, "restaurant", "ресторан"],
  [/аптек/i, "pharmacy", "аптеку"],
  [/туалет|вбиральн/i, "toilets", "туалет"],
  [/банкомат/i, "atm", "банкомат"],
];

const BRANDS: [RegExp, string[]][] = [
  [/макдональд|mcdonald/i, ["McDonald's", "Макдональдз"]],
  [/kfc|кфс/i, ["KFC"]],
  [/\bwog\b|вог\b/i, ["WOG"]],
  [/окко|okko/i, ["OKKO", "ОККО"]],
  [/socar|сокар/i, ["SOCAR"]],
];

export function parseLocalPlaceIntent(text: string): LocalPlaceIntent | null {
  const found = CATEGORY_STEMS.find(([re]) => re.test(text));
  if (!found) return null;
  const [, category, label] = found;
  const brand = BRANDS.find(([re]) => re.test(text))?.[1];
  const nearDestination = /(біля|возле|около|коло|поруч з|рядом с).{0,20}(місц|пункт|призначен|назначен|кінц)/i.test(text) || category === "parking";
  if (nearDestination) {
    return { tool: "search_near", input: { anchor: "destination", categories: [category], ...(brand ? { name_variants: brand } : {}), limit: 2 }, label };
  }
  const input: Record<string, unknown> = { categories: [category], limit: 2 };
  if (brand) input.name_variants = brand;
  const detour = /(?:не більше|не больше|максимум|до)\s*(\d{1,2})\s*(?:хв|хвилин|мин)/i.exec(text);
  if (detour) input.max_detour_minutes = Number(detour[1]);
  const range = /(\d{1,3})\s*(?:км|кілометр|километр)\s*(?:пальн|бензин|топлив|запас|ходу)/i.exec(text) ?? /(?:залишилось|осталось|лишилось)\D{0,20}(\d{1,3})\s*(?:км|кілометр|километр)/i.exec(text);
  if (range && category === "fuel") input.vehicle_range_km = Number(range[1]);
  if (/відчинен|открыт|працю/i.test(text)) input.open_now_only = true;
  return { tool: "search_along_route", input, label };
}

type Row = Record<string, unknown>;

const sideWord = (side: unknown) => (side === "right" ? "праворуч" : side === "left" ? "ліворуч" : "");

/** Phrase a tool result as one or two short Ukrainian sentences, using only its fields. */
export function phraseLocalPlaceResult(intent: LocalPlaceIntent, content: Row, isError: boolean): string {
  if (isError) {
    return content.error === "place_search_unavailable" || content.error === "place_search_failed"
      ? "Пошук місць зараз недоступний."
      : content.error === "no_active_route" ? "Немає активного маршруту, щоб шукати по дорозі." : "Не вдалося виконати пошук.";
  }
  const results = (content.results as Row[] | undefined) ?? [];
  if (results.length === 0) return `Не знайдено: ${intent.label} ${intent.tool === "search_near" ? "поблизу місця призначення" : "по дорозі"}.`;
  const parts = results.slice(0, 2).map((r) => {
    if (intent.tool === "search_near") return `${String(r.name)} за ${String(r.distance_m)} метрів`;
    const side = sideWord(r.side);
    const detour = typeof r.detour_min === "number" ? (r.detour_min < 1 ? ", майже без гаку" : `, гак близько ${Math.round(r.detour_min)} хв`) : "";
    const closed = r.open_now === false ? ", зараз зачинено" : "";
    const reach = r.reachable === false ? ", може не вистачити пального" : "";
    return `${String(r.name)}${side ? ` ${side}` : ""} через ${String(r.ahead_km)} км${detour}${closed}${reach}`;
  });
  return `${parts.join("; ")}.`;
}
