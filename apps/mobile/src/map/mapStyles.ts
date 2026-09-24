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

export function layerAvailable(layer: MapLayer): boolean {
  return layer !== "satellite" || !!config.mapTilerKey;
}

function mapTilerStyle(name: string): string {
  return `https://api.maptiler.com/maps/${name}/style.json?key=${encodeURIComponent(config.mapTilerKey ?? "")}`;
}

const styleCache = new Map<string, string>();

type StyleJson = { sources: Record<string, unknown>; layers: { id: string; type: string }[] };

async function baseStyle(): Promise<StyleJson> {
  // The detailed "liberty" style is the base for both day and night.
  const response = await fetch(config.mapStyleUrl);
  if (!response.ok) throw new Error(`style HTTP ${response.status}`);
  return await response.json() as StyleJson;
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

export function useMapStyle(layer: MapLayer, dark: boolean, retryKey = 0, flat = false): ResolvedStyle {
  const [resolved, setResolved] = useState<ResolvedStyle>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    if (layer === "satellite") {
      setResolved(config.mapTilerKey ? { status: "ready", style: mapTilerStyle("hybrid") } : { status: "unavailable", reason: "needsKey" });
      return;
    }
    if (layer === "terrain") {
      setResolved({ status: "ready", style: config.mapTilerKey ? mapTilerStyle(dark ? "outdoor-v2-dark" : "outdoor-v2") : topoStyle(dark) });
      return;
    }
    setResolved((prev) => (prev.status === "ready" ? prev : { status: "loading" }));
    brandedStyle(dark, false, flat)
      .then((style) => { if (!cancelled) setResolved({ status: "ready", style }); })
      // Network trouble: fall back to the plain hosted style rather than no map.
      .catch(() => { if (!cancelled) setResolved({ status: "ready", style: dark ? config.mapStyleDarkUrl : config.mapStyleUrl }); });
    return () => { cancelled = true; };
  }, [layer, dark, retryKey, flat]);
  return resolved;
}
