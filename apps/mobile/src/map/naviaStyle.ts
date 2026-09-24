// NAVIA map look: the detailed OpenFreeMap "liberty" style recoloured into
// the brand palette (navy, teal water and parks, warm orange for major roads)
// so the map is recognisably NAVIA, not a generic web map. Day and night use
// the same data and layer set; only colours change.

type Layer = { id: string; type: string; paint?: Record<string, unknown>; layout?: Record<string, unknown> };
type Style = { layers: Layer[]; [key: string]: unknown };

type MapPalette = {
  background: string; residential: string; green: string; wood: string; water: string; waterLabel: string;
  building: string; building3d: string; roadMinor: string; roadMinorCasing: string; roadMid: string; roadMidCasing: string;
  roadMajor: string; roadMajorCasing: string; motorway: string; motorwayCasing: string; path: string; rail: string;
  label: string; labelHalo: string; poiLabel: string; boundary: string; special: string;
};

// Day: teal-tinted slate ground, bold teal water, orange arteries with navy
// casing. Deliberately far from the white/grey/yellow look of consumer maps.
const DAY: MapPalette = {
  background: "#D9E4E6", residential: "#D2DEE1", green: "#AFD8C6", wood: "#9ACDB8", water: "#3DB5B0", waterLabel: "#0B4F55",
  building: "#C4D2D7", building3d: "#B5C5CB", roadMinor: "#F4F8F9", roadMinorCasing: "#A9BCC4", roadMid: "#FFFFFF", roadMidCasing: "#6F8796",
  roadMajor: "#FFB067", roadMajorCasing: "#1B3346", motorway: "#F5822F", motorwayCasing: "#10263A", path: "#8FA5B1", rail: "#7D909C",
  label: "#0F2436", labelHalo: "#E6EEF0", poiLabel: "#2F4A5C", boundary: "#5E7686", special: "#CFDCDF",
};

// Night: deep NAVIA navy, glowing teal water, amber arteries.
const NIGHT: MapPalette = {
  background: "#07101C", residential: "#0B1626", green: "#0C3430", wood: "#0E3B35", water: "#0F5560", waterLabel: "#6FD6D2",
  building: "#13213A", building3d: "#1A2C48", roadMinor: "#1C2D46", roadMinorCasing: "#07101C", roadMid: "#2B4262", roadMidCasing: "#07101C",
  roadMajor: "#C8692B", roadMajorCasing: "#07101C", motorway: "#F28A3D", motorwayCasing: "#1B0F06", path: "#2E4460", rail: "#34465E",
  label: "#B6C7D8", labelHalo: "#07101C", poiLabel: "#8BA0B6", boundary: "#4A6282", special: "#0F1A2B",
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
  if (layer.type === "fill-extrusion") return set(layer, "fill-extrusion-color", p.building3d);
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
