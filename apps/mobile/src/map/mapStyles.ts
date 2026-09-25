// Map layer styles. Standard uses OpenFreeMap (no key) recoloured to NAVIA.
// Satellite needs a MapTiler key. Terrain uses MapTiler Outdoor when a key
// exists, otherwise the OpenTopoMap topographic raster (contours, shading,
// elevation) — hillshade alone is invisible on flat Ukrainian terrain.
import { useEffect, useState } from "react";
import { config } from "../config";
import type { MapLayer } from "../settings/AppSettings";
import { naviaStyle } from "./naviaStyle";

export type ResolvedStyle =
  | { status: "ready"; style: string }
  | { status: "loading" }
  | { status: "unavailable"; reason: "needsKey" | "network" };

const TERRARIUM_TILES = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";

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
async function satelliteHybrid(): Promise<string> {
  const cached = styleCache.get("satellite");
  if (cached) return cached;
  const base = await baseStyle();
  const layers = (base.layers as { id: string; type: string; layout?: Record<string, unknown>; paint?: Record<string, unknown> }[])
    .filter((l) => (l.type === "line" && /road|highway|motorway|trunk|primary|secondary|tertiary|minor|street|bridge|tunnel/.test(l.id) && !/casing/.test(l.id)) || (l.type === "symbol" && l.layout && "text-field" in l.layout))
    .map((l) => l.type === "line"
      ? { ...l, paint: { ...(l.paint ?? {}), "line-color": "#FFE9B8", "line-opacity": 0.55 } }
      : { ...l, paint: { ...(l.paint ?? {}), "text-color": "#FFFFFF", "text-halo-color": "#0A1220", "text-halo-width": 1.4 } });
  const style = {
    ...base,
    sources: {
      ...base.sources,
      "navia-imagery": { type: "raster", tiles: [ESRI_IMAGERY], tileSize: 256, maxzoom: 19, attribution: "Esri, Maxar, Earthstar Geographics" },
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": "#0A1220" } },
      { id: "navia-imagery", type: "raster", source: "navia-imagery" },
      ...layers,
    ],
  };
  const json = JSON.stringify(style);
  styleCache.set("satellite", json);
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

async function baseStyle(): Promise<StyleJson> {
  // The detailed "liberty" style is the base for both day and night. Kept on
  // the phone so the map (with an offline package) works without network.
  try {
    const response = await fetch(config.mapStyleUrl);
    if (!response.ok) throw new Error(`style HTTP ${response.status}`);
    const text = await response.text();
    void kv()?.setItemAsync(BASE_STYLE_KEY, text).catch(() => {});
    return JSON.parse(text) as StyleJson;
  } catch (error) {
    const saved = await kv()?.getItemAsync(BASE_STYLE_KEY).catch(() => null);
    if (saved) return JSON.parse(saved) as StyleJson;
    throw error;
  }
}

/** NAVIA-coloured standard map, optionally with hillshading for terrain. */
async function brandedStyle(dark: boolean, relief: boolean, flat: boolean): Promise<string> {
  const key = `${dark ? "night" : "day"}:${relief ? "relief" : "plain"}:${flat ? "2d" : "3d"}`;
  const cached = styleCache.get(key);
  if (cached) return cached;
  const style = naviaStyle(await baseStyle() as never, dark) as unknown as StyleJson;
  // Navigation: flat buildings, so 3D blocks never hide the route.
  if (flat) style.layers = style.layers.filter((layer) => layer.type !== "fill-extrusion");
  if (relief) {
    style.sources["navia-dem"] = { type: "raster-dem", tiles: [TERRARIUM_TILES], tileSize: 256, maxzoom: 14, encoding: "terrarium" };
    const firstSymbol = style.layers.findIndex((layer) => layer.type === "symbol");
    const hillshade = {
      id: "navia-hillshade", type: "hillshade", source: "navia-dem",
      paint: {
        "hillshade-exaggeration": dark ? 0.35 : 0.5,
        "hillshade-shadow-color": dark ? "#000000" : "#4A5A67",
        "hillshade-highlight-color": dark ? "#2A3A4F" : "#FFFFFF",
        "hillshade-accent-color": dark ? "#0A111C" : "#5D6B7C",
      },
    };
    style.layers.splice(firstSymbol < 0 ? style.layers.length : firstSymbol, 0, hillshade);
  }
  const json = JSON.stringify(style);
  styleCache.set(key, json);
  return json;
}

/** OpenTopoMap raster (CC-BY-SA), dimmed at night. Attribution: Sources screen. */
function topoStyle(dark: boolean): string {
  return JSON.stringify({
    version: 8,
    name: "navia-topo",
    sources: {
      topo: {
        type: "raster",
        tiles: ["a", "b", "c"].map((s) => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`),
        tileSize: 256,
        maxzoom: 17,
        attribution: "© OpenTopoMap (CC-BY-SA), © OpenStreetMap contributors",
      },
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": dark ? "#0A1220" : "#E4E9EC" } },
      { id: "topo", type: "raster", source: "topo", paint: dark
        ? { "raster-brightness-max": 0.62, "raster-brightness-min": 0.04, "raster-saturation": -0.35, "raster-contrast": 0.1 }
        : { "raster-saturation": -0.1 } },
    ],
  });
}

/** `flat`: no 3D buildings; `relief3d`: hillshade relief (3D navigation). */
export function useMapStyle(layer: MapLayer, dark: boolean, retryKey = 0, flat = false, relief3d = false): ResolvedStyle {
  const [resolved, setResolved] = useState<ResolvedStyle>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    if (layer === "satellite") {
      if (config.mapTilerKey) { setResolved({ status: "ready", style: mapTilerStyle("hybrid") }); return; }
      setResolved((prev) => (prev.status === "ready" ? prev : { status: "loading" }));
      satelliteHybrid()
        .then((style) => { if (!cancelled) setResolved({ status: "ready", style }); })
        // No vector base (offline): imagery alone is still a satellite map.
        .catch(() => { if (!cancelled) setResolved({ status: "ready", style: JSON.stringify({ version: 8, sources: { img: { type: "raster", tiles: [ESRI_IMAGERY], tileSize: 256, maxzoom: 19 } }, layers: [{ id: "img", type: "raster", source: "img" }] }) }); });
      return () => { cancelled = true; };
    }
    if (layer === "terrain") {
      setResolved({ status: "ready", style: config.mapTilerKey ? mapTilerStyle(dark ? "outdoor-v2-dark" : "outdoor-v2") : topoStyle(dark) });
      return;
    }
    setResolved((prev) => (prev.status === "ready" ? prev : { status: "loading" }));
    brandedStyle(dark, relief3d, flat)
      .then((style) => { if (!cancelled) setResolved({ status: "ready", style }); })
      // Network trouble: fall back to the plain hosted style rather than no map.
      .catch(() => { if (!cancelled) setResolved({ status: "ready", style: dark ? config.mapStyleDarkUrl : config.mapStyleUrl }); });
    return () => { cancelled = true; };
  }, [layer, dark, retryKey, flat, relief3d]);
  return resolved;
}
