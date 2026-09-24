import type { IconName } from "../components/Icon";
import type { StringKey } from "../i18n";
import type { NearbyPlace, NearbyPlaceCategory } from "../providers/NearbyPlacesProvider";

/** Home-screen category chips, in display order. */
export type ChipCategory = "shelter" | "resilience" | "fuel" | "charger" | "pharmacy" | "hospital" | "atm" | "water" | "food";

export const CHIP_CATEGORIES: ChipCategory[] = ["shelter", "resilience", "fuel", "charger", "pharmacy", "hospital", "atm", "water", "food"];

type Meta = { icon: IconName; label: StringKey; color: string };

// Category colours are map-marker identity colours (fixed across themes so a
// shelter pin always looks like a shelter pin); UI chrome still uses tokens.
export const CATEGORY_META: Record<NearbyPlaceCategory, Meta> = {
  shelter: { icon: "shelter", label: "category.shelter", color: "#D2363C" },
  resilience: { icon: "resilience", label: "category.resilience", color: "#E08A00" },
  fuel: { icon: "fuel", label: "category.fuel", color: "#2F6FDB" },
  charger: { icon: "charger", label: "category.charger", color: "#12806C" },
  pharmacy: { icon: "pharmacy", label: "category.pharmacy", color: "#15925A" },
  hospital: { icon: "hospital", label: "category.hospital", color: "#C2385A" },
  atm: { icon: "atm", label: "category.atm", color: "#16798C" },
  water: { icon: "water", label: "category.water", color: "#2D86C4" },
  food: { icon: "food", label: "category.food", color: "#D0662B" },
  shop: { icon: "shop", label: "category.shop", color: "#6A55C8" },
  transport: { icon: "transport", label: "category.transport", color: "#5B4FBD" },
  police: { icon: "shield", label: "category.other", color: "#3E5C9A" },
  fire: { icon: "alert", label: "category.other", color: "#C24136" },
  parking: { icon: "car", label: "category.other", color: "#5B7180" },
  toilets: { icon: "pin", label: "category.other", color: "#5B7180" },
  other: { icon: "pin", label: "category.other", color: "#5B7180" },
};

export function placesFor(category: ChipCategory, places: NearbyPlace[]): NearbyPlace[] {
  return places.filter((p) => p.category === category).sort((a, b) => a.distanceM - b.distanceM);
}

export function nearestShelter(places: NearbyPlace[]): NearbyPlace | null {
  return placesFor("shelter", places)[0] ?? null;
}
