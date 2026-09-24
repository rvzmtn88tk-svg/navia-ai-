// Map layer styles. Standard uses OpenFreeMap (no key). Satellite needs a
// MapTiler key. Terrain uses MapTiler Outdoor when a key exists, otherwise the
// standard style plus hillshading from the open AWS Terrain Tiles dataset.
import { useEffect, useState } from "react";
import { config } from "../config";
import type { MapLayer } from "../settings/AppSettings";

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

const terrainCache = new Map<string, string>();

async function hillshadeStyle(baseUrl: string, dark: boolean): Promise<string> {
  const cached = terrainCache.get(baseUrl);
  if (cached) return cached;
  const response = await fetch(baseUrl);
  if (!response.ok) throw new Error(`style HTTP ${response.status}`);
  const style = await response.json() as { sources: Record<string, unknown>; layers: { id: string; type: string }[] };
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
  style.layers.splice(firstSymbol < 0 ? style.layers.length : firstSymbol, 0, hillshade as { id: string; type: string });
  const json = JSON.stringify(style);
  terrainCache.set(baseUrl, json);
  return json;
}

export function useMapStyle(layer: MapLayer, dark: boolean, retryKey = 0): ResolvedStyle {
  const [resolved, setResolved] = useState<ResolvedStyle>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    const standard = dark ? config.mapStyleDarkUrl : config.mapStyleUrl;
    if (layer === "standard") { setResolved({ status: "ready", style: standard }); return; }
    if (layer === "satellite") {
      setResolved(config.mapTilerKey ? { status: "ready", style: mapTilerStyle("hybrid") } : { status: "unavailable", reason: "needsKey" });
      return;
    }
    if (config.mapTilerKey) { setResolved({ status: "ready", style: mapTilerStyle(dark ? "outdoor-v2-dark" : "outdoor-v2") }); return; }
    setResolved({ status: "loading" });
    hillshadeStyle(standard, dark)
      .then((style) => { if (!cancelled) setResolved({ status: "ready", style }); })
      .catch(() => { if (!cancelled) setResolved({ status: "unavailable", reason: "network" }); });
    return () => { cancelled = true; };
  }, [layer, dark, retryKey]);
  return resolved;
}
