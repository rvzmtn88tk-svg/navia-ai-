// NAVIA map look: the detailed OpenFreeMap "liberty" style recoloured into
// the brand palette (navy, teal water and parks, warm orange for major roads)
// so the map is recognisably NAVIA, not a generic web map. Day and night use
// the same data and layer set; only colours change.

type Layer = { id: string; type: string; paint?: Record<string, unknown>; layout?: Record<string, unknown> };
type Style = { layers: Layer[]; [key: string]: unknown };

type MapPalette = {
  background: string; residential: string; green: string; wood: string; water: string; waterLabel: string;
  building: string; building3d: string; building3dTall: string; roadMinor: string; roadMinorCasing: string; roadMid: string; roadMidCasing: string;
  roadMajor: string; roadMajorCasing: string; motorway: string; motorwayCasing: string; path: string; rail: string;
  label: string; labelHalo: string; poiLabel: string; boundary: string; special: string;
};

// "Lunar" day: cool moon-grey ground, grey-teal greenery, periwinkle
// arteries and warm motorways. Teal is reserved for the route.
const DAY: MapPalette = {
  background: "#E7ECF2", residential: "#E1E7EE", green: "#D3E4E2", wood: "#C8DDDA", water: "#9CCBDA", waterLabel: "#0E4A5C",
  building: "#D5DDE7", building3d: "#C8D1DD", building3dTall: "#AEBBCB", roadMinor: "#FFFFFF", roadMinorCasing: "#C3CEDA", roadMid: "#FFFFFF", roadMidCasing: "#8C9FB4",
  roadMajor: "#C7D5EC", roadMajorCasing: "#6C88AE", motorway: "#FFC58A", motorwayCasing: "#C9712A", path: "#A4B3C3", rail: "#96A5B6",
  label: "#0F2238", labelHalo: "#EEF2F7", poiLabel: "#3B4E64", boundary: "#8190A6", special: "#DEE5EC",
};

// "Deep Space" night: near-black navy like the sky, streets as faint star
// trails, arteries in steel blue, motorways muted amber. No green; bright
// teal is reserved for the route so it can never be confused with a road.
const NIGHT: MapPalette = {
  background: "#050A14", residential: "#070E1B", green: "#07161C", wood: "#081A20", water: "#0A1C33", waterLabel: "#5FC9D6",
  building: "#0B1526", building3d: "#1B2D4D", building3dTall: "#2A4270", roadMinor: "#1C2E4C", roadMinorCasing: "#050A14", roadMid: "#2A4674", roadMidCasing: "#050A14",
  roadMajor: "#335F8F", roadMajorCasing: "#050A14", motorway: "#9C6638", motorwayCasing: "#1A0E06", path: "#1D2C44", rail: "#27374F",
  label: "#8FA6C0", labelHalo: "#050A14", poiLabel: "#6F86A2", boundary: "#34507A", special: "#08101E",
};

function set(layer: Layer, key: string, value: unknown): void {
  layer.paint = { ...(layer.paint ?? {}), [key]: value };
}

function recolor(layer: Layer, p: MapPalette): void {
  const id = layer.id;
  if (layer.type === "background") return set(layer, "background-color", p.background);
  if (layer.type === "raster") return set(layer, "raster-opacity", 0);
  if (layer.type === "fill") {
    if (id === "water") return set(layer, "fill-color", p.water);
    if (id === "park" || id.startsWith("landcover_grass") || id === "landuse_pitch" || id === "landuse_cemetery") { set(layer, "fill-color", p.green); set(layer, "fill-opacity", 1); return; }
    if (id.startsWith("landcover_wood")) { set(layer, "fill-color", p.wood); set(layer, "fill-opacity", 1); return; }
    if (id === "landuse_residential") return set(layer, "fill-color", p.residential);
    if (id === "building") { set(layer, "fill-color", p.building); set(layer, "fill-outline-color", p.building3d); return; }
    if (id.startsWith("landuse_") || id.startsWith("aeroway") || id.startsWith("landcover_")) return set(layer, "fill-color", p.special);
    return;
  }
  if (layer.type === "fill-extrusion") {
    // Solid blocks with a light top and darker walls read as crisp volumes;
    // the base style's 0.8 opacity blended them into the ground ("blurry").
    set(layer, "fill-extrusion-color", ["interpolate", ["linear"], ["coalesce", ["get", "render_height"], 0], 0, p.building3d, 60, p.building3dTall]);
    set(layer, "fill-extrusion-opacity", 0.95);
    set(layer, "fill-extrusion-vertical-gradient", true);
    return;
  }
  if (layer.type === "line") {
    const casing = id.endsWith("_casing");
    if (id.startsWith("waterway")) return set(layer, "line-color", p.water);
    if (id.includes("motorway")) return set(layer, "line-color", casing ? p.motorwayCasing : p.motorway);
    if (id.includes("trunk_primary")) return set(layer, "line-color", casing ? p.roadMajorCasing : p.roadMajor);
    if (id.includes("secondary_tertiary")) return set(layer, "line-color", casing ? p.roadMidCasing : p.roadMid);
    if (id.includes("minor") || id.includes("street") || id.includes("link") || id.includes("service")) return set(layer, "line-color", casing ? p.roadMinorCasing : p.roadMinor);
    if (id.includes("path") || id.includes("pedestrian")) return set(layer, "line-color", p.path);
    if (id.includes("rail")) return set(layer, "line-color", p.rail);
    if (id.startsWith("boundary")) return set(layer, "line-color", p.boundary);
    if (id === "park_outline") return set(layer, "line-color", p.wood);
    return;
  }
  if (layer.type === "symbol" && layer.layout && "text-field" in layer.layout) {
    const water = id.startsWith("water");
    const poi = id.startsWith("poi");
    // Muted POI icons: the brand colours on the map stay NAVIA's.
    if (poi && "icon-image" in layer.layout) set(layer, "icon-opacity", 0.7);
    set(layer, "text-color", water ? p.waterLabel : poi ? p.poiLabel : p.label);
    set(layer, "text-halo-color", p.labelHalo);
  }
}

export function naviaStyle(base: Style, night: boolean): Style {
  const palette = night ? NIGHT : DAY;
  const style: Style = JSON.parse(JSON.stringify(base));
  for (const layer of style.layers) recolor(layer, palette);
  return style;
}
