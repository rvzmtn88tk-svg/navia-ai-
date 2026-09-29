// Map layer styles. Standard uses OpenFreeMap (no key) recoloured to NAVIA.
// Satellite: Esri World Imagery (MapTiler hybrid with a key) with relief
// shading from real elevation data, NAVIA roads/labels and 3D buildings.
// Terrain: the NAVIA map with strong relief shading from the same elevation
// data (MapTiler Outdoor with a key). Depth cues used everywhere:
// - hillshade from the AWS/Mapzen Terrain Tiles DEM (terrarium encoding);
// - a directional light, so extruded building walls facing away from it are
//   darker than the lit ones (the style's `light`);
// - building heights from OpenStreetMap (`render_height`).
// MapLibre Native (6.x) has no 3D terrain mesh and no sky layer; the haze
// towards the horizon in 3D is drawn over the map (map/HorizonHaze.tsx).
import { useEffect, useState } from "react";
import { config } from "../config";
import type { MapLayer } from "../settings/AppSettings";
import { naviaStyle } from "./naviaStyle";
import { tileTemplate } from "../providers/vectorTiles";

export type ResolvedStyle =
  | { status: "ready"; style: string }
  | { status: "loading" }
  | { status: "unavailable"; reason: "needsKey" | "network" };

const TERRARIUM_TILES = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const DEM_SOURCE = { type: "raster-dem", tiles: [TERRARIUM_TILES], tileSize: 256, maxzoom: 14, encoding: "terrarium", attribution: "Terrain Tiles: Mapzen / AWS Open Data" };

type AnyLayer = { id: string; type: string; source?: string; "source-layer"?: string; minzoom?: number; filter?: unknown; layout?: Record<string, unknown>; paint?: Record<string, unknown> };

/** Benchmark only (perf/bench.ts): "none" drops relief shading, 3D buildings
 * and light, to measure what they cost. */
let depth: "full" | "none" = "full";
export function setBenchDepth(d: "full" | "none"): void {
  depth = d;
  styleCache.clear();
}

/** Sun from the south-west, a little above the horizon: walls facing it are
 * lit, the others darker — buildings read as volumes, not flat blocks. */
function sunLight(dark: boolean): Record<string, unknown> {
  return { anchor: "map", color: dark ? "#9FB6D9" : "#FFF6E8", intensity: dark ? 0.3 : 0.5, position: [1.4, 225, 40] };
}

/**
 * Relief shading from elevation data: `strength` 0..1. From city zoom only:
 * every new elevation tile is shaded on the render thread (~100 ms each on an
 * iPhone 17 Pro); over the country-wide view, and while zooming back from it,
 * that cost 10–40 fps. Below RELIEF_MINZOOM no elevation tiles load at all.
 */
const RELIEF_MINZOOM = 11;
function hillshadeLayer(dark: boolean, strength: number, overImagery = false): AnyLayer {
  return {
    id: "navia-hillshade", type: "hillshade", source: "navia-dem", minzoom: RELIEF_MINZOOM,
    paint: {
      "hillshade-exaggeration": strength,
      "hillshade-illumination-direction": 315,
      "hillshade-illumination-anchor": "map",
      // Night: the dark ground cannot get much darker, so the relief is
      // carried by moonlit slopes (a steel-blue highlight).
      "hillshade-shadow-color": overImagery ? "rgba(0, 0, 0, 0.55)" : dark ? "#000000" : "#3E4E5E",
      "hillshade-highlight-color": overImagery ? "rgba(255, 255, 255, 0.18)" : dark ? "#6B8CC4" : "#FFFFFF",
      "hillshade-accent-color": overImagery ? "rgba(0, 0, 0, 0.2)" : dark ? "#02060C" : "#56687C",
    },
  };
}

/** Under the roads and buildings, over land and water fills. */
function reliefIndex(layers: AnyLayer[]): number {
  const i = layers.findIndex((l) => l.type === "fill-extrusion" || l.id === "building" || (l.type === "line" && /tunnel|road|highway|bridge|transportation|railway/.test(l.id)));
  if (i >= 0) return i;
  const sym = layers.findIndex((l) => l.type === "symbol");
  return sym < 0 ? layers.length : sym;
}

/** Every layer works without a key now (satellite falls back to Esri World Imagery). */
export function layerAvailable(_layer: MapLayer): boolean {
  return true;
}

const ESRI_IMAGERY = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

/**
 * Satellite without a key: Esri World Imagery raster + NAVIA roads and labels
 * from the vector style on top (hybrid). Esri's terms require attribution and,
 * for production, an ArcGIS/MapTiler key — this is the test source.
 */
async function satelliteHybrid(flat = false): Promise<string> {
  const key = `satellite:${flat ? "2d" : "3d"}:${depth}`;
  const cached = styleCache.get(key);
  if (cached) return cached;
  const base = await baseStyle();
  const baseLayers = base.layers as AnyLayer[];
  const layers = baseLayers
    .filter((l) => (l.type === "line" && /road|highway|motorway|trunk|primary|secondary|tertiary|minor|street|bridge|tunnel/.test(l.id) && !/casing/.test(l.id)) || (l.type === "symbol" && l.layout && "text-field" in l.layout))
    .map((l) => l.type === "line"
      ? { ...l, paint: { ...(l.paint ?? {}), "line-color": "#FFE9B8", "line-opacity": 0.55 } }
      : { ...l, paint: { ...(l.paint ?? {}), "text-color": "#FFFFFF", "text-halo-color": "#0A1220", "text-halo-width": 1.4 } });
  // 3D buildings over the photo from zoom 15: real heights, warm stone
  // colour, lit by the sun — the photo's roofs show through a little.
  const extrusion = flat || depth === "none" ? [] : baseLayers.filter((l) => l.type === "fill-extrusion").map((l) => ({
    ...l,
    paint: {
      ...(l.paint ?? {}),
      "fill-extrusion-color": ["interpolate", ["linear"], ["coalesce", ["get", "render_height"], 0], 0, "#CFC8BD", 40, "#E6E1D8", 120, "#F4F1EC"],
      "fill-extrusion-opacity": 0.82,
      "fill-extrusion-vertical-gradient": true,
    },
  }));
  const style = {
    ...base,
    light: sunLight(false),
    sources: {
      ...base.sources,
      "navia-imagery": { type: "raster", tiles: [ESRI_IMAGERY], tileSize: 256, maxzoom: 19, attribution: "Esri, Maxar, Earthstar Geographics" },
      "navia-dem": DEM_SOURCE,
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": "#0A1220" } },
      // A touch of contrast and saturation: the raw mosaic looks washed out.
      { id: "navia-imagery", type: "raster", source: "navia-imagery", paint: { "raster-contrast": 0.08, "raster-saturation": 0.08, "raster-fade-duration": 150 } },
      ...(depth === "none" ? [] : [hillshadeLayer(false, 0.45, true)]),
      ...layers.filter((l) => l.type === "line"),
      ...extrusion,
      ...layers.filter((l) => l.type === "symbol"),
    ],
  };
  const json = JSON.stringify(style);
  styleCache.set(key, json);
  return json;
}

function mapTilerStyle(name: string): string {
  return `https://api.maptiler.com/maps/${name}/style.json?key=${encodeURIComponent(config.mapTilerKey ?? "")}`;
}

const styleCache = new Map<string, string>();

type StyleJson = { sources: Record<string, unknown>; layers: { id: string; type: string }[] };

const BASE_STYLE_KEY = "navia.style.base.v1";
type KV = { getItemAsync(key: string): Promise<string | null>; setItemAsync(key: string, value: string): Promise<void> };
function kv(): KV | null {
  try { return (require("expo-sqlite/kv-store") as { default: KV }).default; } catch { return null; }
}

const STYLE_TIMEOUT_MS = 6000;
let onlineBaseText: string | null = null;

/** The base style and whether it came from the network now (false: the copy kept on the phone). */
async function baseStyleWithState(): Promise<{ style: StyleJson; online: boolean }> {
  // The detailed "liberty" style is the base for both day and night. Kept on
  // the phone so the map (with an offline package) works without network.
  if (onlineBaseText) return { style: JSON.parse(onlineBaseText) as StyleJson, online: true };
  const controller = new AbortController();
  // A network that answers nothing (weak signal, captive Wi-Fi) must not
  // keep the map blank for a minute: fall back to the kept copy quickly.
  const timer = setTimeout(() => controller.abort(), STYLE_TIMEOUT_MS);
  try {
    const response = await fetch(config.mapStyleUrl, { signal: controller.signal });
    if (!response.ok) throw new Error(`style HTTP ${response.status}`);
    const text = await response.text();
    void kv()?.setItemAsync(BASE_STYLE_KEY, text).catch(() => {});
    onlineBaseText = text;
    return { style: JSON.parse(text) as StyleJson, online: true };
  } catch (error) {
    const saved = await kv()?.getItemAsync(BASE_STYLE_KEY).catch(() => null);
    if (saved) return { style: JSON.parse(saved) as StyleJson, online: false };
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function baseStyle(): Promise<StyleJson> {
  return (await baseStyleWithState()).style;
}

let pinOnline: Promise<string | null> | null = null;
/**
 * The tile version to draw. Offline packs hold the tiles of the version they
 * were downloaded with; OpenFreeMap publishes a new version every few weeks
 * and the live TileJSON then points at tiles the phone does not have. So with
 * an offline package the map is pinned to the package's version: always
 * without network, and online while the server still serves that version
 * (then losing the network mid-drive changes nothing). null = live version.
 */
async function pinnedTemplate(online: boolean): Promise<string | null> {
  const { packageTileTemplate } = require("../offline/regionPackage") as typeof import("../offline/regionPackage");
  const template = await packageTileTemplate().catch(() => null);
  if (!template) return null;
  if (!online) return template;
  pinOnline ??= (async () => {
    const live = await tileTemplate().catch(() => null);
    if (!live || live === template) return template;
    const probe = template.replace("{z}", "14").replace("{x}", "9571").replace("{y}", "5544");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const served = await fetch(probe, { signal: controller.signal }).then((r) => r.ok).catch(() => false).finally(() => clearTimeout(timer));
    return served ? template : null;
  })();
  return pinOnline;
}

/** After a new offline package: re-check which tile version to draw. */
export function resetMapStyleCache(): void {
  pinOnline = null;
  styleCache.clear();
}

function pinTiles(style: StyleJson, template: string): void {
  const source = style.sources.openmaptiles as { type?: string; url?: string } | undefined;
  if (!source || source.type !== "vector") return;
  style.sources.openmaptiles = { type: "vector", tiles: [template], minzoom: 0, maxzoom: 14, attribution: "© OpenFreeMap © OpenMapTiles © OpenStreetMap contributors" };
}

/** NAVIA-coloured standard map, optionally with hillshading for terrain. */
async function brandedStyle(dark: boolean, relief: boolean, flat: boolean): Promise<string> {
  const base = await baseStyleWithState();
  const pin = await pinnedTemplate(base.online);
  const key = `${dark ? "night" : "day"}:${relief ? "relief" : "plain"}:${flat ? "2d" : "3d"}:${pin ?? "live"}:${depth}`;
  const cached = styleCache.get(key);
  if (cached) return cached;
  const style = naviaStyle(base.style as never, dark) as unknown as StyleJson;
  if (pin) pinTiles(style, pin);
  // Navigation: flat buildings, so 3D blocks never hide the route.
  if (flat) style.layers = style.layers.filter((layer) => layer.type !== "fill-extrusion");
  if (depth === "none") style.layers = style.layers.filter((layer) => layer.type !== "fill-extrusion");
  else {
    (style as { light?: unknown }).light = sunLight(dark);
    // Relief: for the Terrain layer and 3D navigation only. The standard map's
    // faint relief (strength 0.3) was barely visible and cost the whole app's
    // smoothness (measured: 60 fps without it, 10–41 with it after zooming).
    if (relief) {
      style.sources["navia-dem"] = DEM_SOURCE;
      style.layers.splice(reliefIndex(style.layers as AnyLayer[]), 0, hillshadeLayer(dark, 1));
    }
  }
  const json = JSON.stringify(style);
  styleCache.set(key, json);
  return json;
}

/** `flat`: no 3D buildings; `relief3d`: hillshade relief (3D navigation). */
export function useMapStyle(layer: MapLayer, dark: boolean, retryKey = 0, flat = false, relief3d = false): ResolvedStyle {
  const [resolved, setResolved] = useState<ResolvedStyle>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    if (layer === "satellite") {
      if (config.mapTilerKey) { setResolved({ status: "ready", style: mapTilerStyle("hybrid") }); return; }
      setResolved((prev) => (prev.status === "ready" ? prev : { status: "loading" }));
      satelliteHybrid(flat)
        .then((style) => { if (!cancelled) setResolved({ status: "ready", style }); })
        // No vector base (offline): imagery alone is still a satellite map.
        .catch(() => { if (!cancelled) setResolved({ status: "ready", style: JSON.stringify({ version: 8, sources: { img: { type: "raster", tiles: [ESRI_IMAGERY], tileSize: 256, maxzoom: 19 } }, layers: [{ id: "img", type: "raster", source: "img" }] }) }); });
      return () => { cancelled = true; };
    }
    if (layer === "terrain" && config.mapTilerKey) {
      setResolved({ status: "ready", style: mapTilerStyle(dark ? "outdoor-v2-dark" : "outdoor-v2") });
      return;
    }
    setResolved((prev) => (prev.status === "ready" ? prev : { status: "loading" }));
    brandedStyle(dark, layer === "terrain" || relief3d, flat)
      .then((style) => { if (!cancelled) setResolved({ status: "ready", style }); })
      // Network trouble: fall back to the plain hosted style rather than no map.
      .catch(() => { if (!cancelled) setResolved({ status: "ready", style: dark ? config.mapStyleDarkUrl : config.mapStyleUrl }); });
    return () => { cancelled = true; };
  }, [layer, dark, retryKey, flat, relief3d]);
  return resolved;
}
