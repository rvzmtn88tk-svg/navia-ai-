// "Київ + Київська область" offline package: the real implementation of
// @navia/core's OfflineMapManager. Downloads (1) map tiles, glyphs and sprites
// through MapLibre offline packs — the whole oblast at full detail (z6–14,
// the source's max zoom: streets, names, buildings, places), Kyiv as its own
// pack (kept from the first package version) — (2) the offline search
// directory (settlements of the oblast, streets and named places of Kyiv) and
// (3) the places for offline category search. Progress and size come from
// MapLibre / the real downloads. "ready" is reported only after verification:
// the packs complete and the directory built.
import MapLibreGL from "@maplibre/maplibre-react-native";
import { formatPackageLabel, type OfflineMapManager, type OfflinePackageMetadata, type OfflinePackageStatus } from "@navia/core";
import { config } from "../config";
import { tileTemplate } from "../providers/vectorTiles";
import { downloadOfflinePlaces, offlinePlacesMeta, offlinePlacesWithin, removeOfflinePlaces, type Bbox } from "./offlinePlaces";
import { buildGazetteer, removeGazetteer } from "./offlineGazetteer";

/** `weight`: share of the map download (by tile count), for an even progress bar. */
type PackSpec = { name: string; bounds: [[number, number], [number, number]]; minZoom: number; maxZoom: number; weight: number };

export const KYIV_OBLAST_BBOX: Bbox = { south: 49.18, west: 29.26, north: 51.55, east: 32.16 };
export const KYIV_CITY_BBOX: Bbox = { south: 50.21, west: 30.24, north: 50.59, east: 30.83 };
const toBounds = (b: Bbox): [[number, number], [number, number]] => [[b.east, b.north], [b.west, b.south]];

export const REGION_PACKS: PackSpec[] = [
  { name: "navia-region-kyiv-city", bounds: toBounds(KYIV_CITY_BBOX), minZoom: 10, maxZoom: 14, weight: 0.04 },
  // z14 over the whole oblast: ≈30 500 tiles, ≈110 MB more. z12 alone (the first
  // version) drew roads without names, buildings or places outside Kyiv.
  { name: "navia-region-kyiv-oblast-z14", bounds: toBounds(KYIV_OBLAST_BBOX), minZoom: 6, maxZoom: 14, weight: 0.96 },
];
/** The first version's oblast pack (z6–12); its tiles are reused, the pack is removed after the upgrade. */
const OLD_OBLAST_PACK = "navia-region-kyiv-oblast";
/** MapLibre refuses packs above 6 000 tiles by default. */
const TILE_LIMIT = 60_000;
export const REGION_LABEL = "Київ + область";

export type RegionProgress = {
  phase: "map" | "directory" | "places" | "verify" | "done" | "error";
  /** 0..1 over the whole package. */
  progress: number;
  mapBytes: number;
  resourcesDone: number;
  resourcesTotal: number;
  placesDone: number;
  placesTotal: number;
  /** Category being downloaded now, and how many sources failed so far. */
  placesCategory?: string;
  placesFailed?: number;
  /** Search directory: tiles read so far. */
  directoryDone?: number;
  directoryTotal?: number;
  message?: string;
};

const MAP_SHARE = 0.8;
const DIRECTORY_SHARE = 0.1;

type StoredMeta = {
  downloadedAt: string; mapBytes: number; mapResources: number; placesBytes: number; placesCounts: Record<string, number>; failed: string[]; verifiedAt: string | null; mapVersion: string;
  /** The tile URL template the packs were downloaded with (the map is pinned to it offline). */
  mapTemplate?: string;
  /** Search directory entries by kind. */
  directoryCounts?: Record<string, number>;
  directoryBytes?: number;
};
const META_KEY = "navia.offline.region.v1";

type KV = { getItemAsync(key: string): Promise<string | null>; setItemAsync(key: string, value: string): Promise<void>; removeItemAsync?(key: string): Promise<void> };
function storage(): KV | null {
  try { return (require("expo-sqlite/kv-store") as { default: KV }).default; } catch { return null; }
}

type PackStatus = { state: number; percentage: number; completedResourceCount: number; completedResourceSize: number; requiredResourceCount: number };

async function packStatus(name: string): Promise<PackStatus | null> {
  const pack = await MapLibreGL.OfflineManager.getPack(name).catch(() => null);
  if (!pack) return null;
  return (await pack.status().catch(() => null)) as PackStatus | null;
}

function complete(st: PackStatus | null): boolean {
  return !!st && (st.state === MapLibreGL.OfflinePackDownloadState.Complete || (st.percentage >= 100 && st.completedResourceCount >= st.requiredResourceCount && st.requiredResourceCount > 0));
}

const versionOf = (template: string | null): string => template?.match(/planet\/([^/]+)\//)?.[1] ?? "openfreemap";

/** The tile template stored with the package (older packages: rebuilt from the version). */
export async function packageTileTemplate(): Promise<string | null> {
  const raw = await storage()?.getItemAsync(META_KEY).catch(() => null);
  if (!raw) return null;
  const meta = JSON.parse(raw) as StoredMeta;
  if (!meta.verifiedAt) return null;
  if (meta.mapTemplate) return meta.mapTemplate;
  return /^\d{8}_/.test(meta.mapVersion) ? `https://tiles.openfreemap.org/planet/${meta.mapVersion}/{z}/{x}/{y}.pbf` : null;
}

class MapLibreRegionManager implements OfflineMapManager {
  private status: OfflinePackageStatus = { state: "not_downloaded" };
  private downloading = false;

  getStatus(): OfflinePackageStatus {
    return this.status;
  }

  /** Re-reads the package from disk and verifies the packs are complete. */
  async refresh(): Promise<OfflinePackageStatus> {
    if (this.downloading) return this.status;
    const raw = await storage()?.getItemAsync(META_KEY).catch(() => null);
    if (!raw) { this.status = { state: "not_downloaded" }; return this.status; }
    const meta = JSON.parse(raw) as StoredMeta;
    const statuses = await Promise.all(REGION_PACKS.map((p) => packStatus(p.name)));
    if ((!statuses.every(complete) || !meta.directoryCounts) && meta.verifiedAt && complete(await packStatus(OLD_OBLAST_PACK))) {
      // A package from the first version: works, but only roads outside Kyiv.
      this.status = { state: "unavailable", reason: "Доступне оновлення: детальна карта всієї області (вулиці, будинки, заклади) і пошук без інтернету. Натисніть «Скачати» — докачається тільки нове." };
      return this.status;
    }
    if (!statuses.every(complete) || !meta.verifiedAt || !meta.directoryCounts) {
      this.status = { state: "unavailable", reason: "Пакет завантажено не повністю — натисніть «Скачати», завантаження продовжиться." };
      return this.status;
    }
    this.status = { state: "ready", metadata: toMetadata(meta), label: formatPackageLabel(toMetadata(meta), REGION_LABEL) };
    return this.status;
  }

  async details(): Promise<StoredMeta | null> {
    const raw = await storage()?.getItemAsync(META_KEY).catch(() => null);
    return raw ? JSON.parse(raw) as StoredMeta : null;
  }

  /** OfflineMapManager.download: progress 0..1. */
  async download(onProgress?: (progress0to1: number) => void): Promise<OfflinePackageStatus> {
    return this.downloadWithDetails((p) => onProgress?.(p.progress));
  }

  async downloadWithDetails(onProgress: (p: RegionProgress) => void): Promise<OfflinePackageStatus> {
    if (this.downloading) throw new Error("already downloading");
    this.downloading = true;
    const report: RegionProgress = { phase: "map", progress: 0, mapBytes: 0, resourcesDone: 0, resourcesTotal: 0, placesDone: 0, placesTotal: 1 };
    const emit = () => onProgress({ ...report });
    try {
      // Offline data must survive; MapLibre keeps packs out of its evictable cache.
      MapLibreGL.OfflineManager.setTileCountLimit(TILE_LIMIT);
      const template = await tileTemplate();
      const done: Record<string, PackStatus> = {};
      for (const spec of REGION_PACKS) {
        const existing = await packStatus(spec.name);
        if (complete(existing)) { done[spec.name] = existing!; continue; }
        // An interrupted download (app closed, phone locked) is resumed, not
        // thrown away and started from zero.
        const onProgress = (_pack: unknown, st: PackStatus) => {
          done[spec.name] = st;
          const all = Object.values(done);
          report.mapBytes = all.reduce((a, s) => a + (s.completedResourceSize ?? 0), 0);
          report.resourcesDone = all.reduce((a, s) => a + (s.completedResourceCount ?? 0), 0);
          report.resourcesTotal = all.reduce((a, s) => a + (s.requiredResourceCount ?? 0), 0);
          report.progress = MAP_SHARE * REGION_PACKS.reduce((a, p) => a + p.weight * (p.name === spec.name ? (st.percentage ?? 0) / 100 : complete(done[p.name] ?? null) ? 1 : 0), 0);
          emit();
        };
        await new Promise<void>((resolve, reject) => {
          const progress = (pack: unknown, st: PackStatus) => { onProgress(pack, st); if (complete(st)) resolve(); };
          const error = (_pack: unknown, err: { message?: string }) => reject(new Error(err?.message ?? "offline pack error"));
          if (existing) {
            void MapLibreGL.OfflineManager.getPack(spec.name)
              .then(async (pack) => {
                if (!pack) throw new Error("offline pack vanished");
                await MapLibreGL.OfflineManager.subscribe(spec.name, progress, error);
                await pack.resume();
              })
              .catch(reject);
          } else {
            void MapLibreGL.OfflineManager.createPack(
              { name: spec.name, styleURL: config.mapStyleUrl, bounds: spec.bounds, minZoom: spec.minZoom, maxZoom: spec.maxZoom },
              progress, error,
            ).catch(reject);
          }
        });
        MapLibreGL.OfflineManager.unsubscribe(spec.name);
      }

      // The first version's z6–12 pack: every tile of it is in the new pack.
      if (await MapLibreGL.OfflineManager.getPack(OLD_OBLAST_PACK).catch(() => null)) await MapLibreGL.OfflineManager.deletePack(OLD_OBLAST_PACK).catch(() => {});

      report.phase = "directory";
      report.progress = MAP_SHARE;
      emit();
      const directory = await buildGazetteer(KYIV_OBLAST_BBOX, KYIV_CITY_BBOX, (p) => {
        report.directoryDone = p.done;
        report.directoryTotal = p.total;
        report.progress = MAP_SHARE + DIRECTORY_SHARE * (p.done / Math.max(1, p.total));
        emit();
      });

      report.phase = "places";
      emit();
      const places = await downloadOfflinePlaces(KYIV_OBLAST_BBOX, (p) => {
        report.placesDone = p.done;
        report.placesTotal = p.total;
        report.placesCategory = p.category;
        report.placesFailed = p.failed.length;
        report.progress = MAP_SHARE + DIRECTORY_SHARE + (0.99 - MAP_SHARE - DIRECTORY_SHARE) * (p.done / p.total);
        emit();
      }, { fallback: directory.pois, fallbackLabel: "з карти, лише Київ" });

      report.phase = "verify";
      report.progress = 0.99;
      emit();
      const statuses = await Promise.all(REGION_PACKS.map((p) => packStatus(p.name)));
      // Ready = the map packs are complete on the phone. Places for search are
      // a separate part: saved as far as the sources answered, gaps listed.
      const packsOk = statuses.every(complete);
      const probe = await offlinePlacesWithin("shelter", { lat: 50.4501, lon: 30.5234 }, 2000);
      const verified = packsOk;
      if (probe.length === 0) places.failed.push("перевірка: укриття в центрі Києва не знайдено офлайн");
      const meta: StoredMeta = {
        downloadedAt: new Date().toISOString().slice(0, 10),
        mapBytes: statuses.reduce((a, s) => a + (s?.completedResourceSize ?? 0), 0),
        mapResources: statuses.reduce((a, s) => a + (s?.completedResourceCount ?? 0), 0),
        placesBytes: places.bytes + directory.meta.bytes,
        placesCounts: places.counts,
        failed: places.failed,
        verifiedAt: verified ? new Date().toISOString() : null,
        mapVersion: versionOf(template),
        mapTemplate: template,
        directoryCounts: directory.meta.counts,
        directoryBytes: directory.meta.bytes,
      };
      await storage()?.setItemAsync(META_KEY, JSON.stringify(meta));
      report.phase = verified ? "done" : "error";
      report.progress = verified ? 1 : report.progress;
      report.message = verified ? undefined : "Карта завантажилась не повністю — натисніть ще раз, завантаження продовжиться.";
      emit();
      this.downloading = false;
      return this.refresh();
    } catch (e) {
      report.phase = "error";
      report.message = (e as Error).message;
      emit();
      this.downloading = false;
      this.status = { state: "unavailable", reason: (e as Error).message };
      return this.status;
    }
  }

  async remove(): Promise<void> {
    for (const name of [...REGION_PACKS.map((p) => p.name), OLD_OBLAST_PACK]) await MapLibreGL.OfflineManager.deletePack(name).catch(() => {});
    await removeOfflinePlaces();
    await removeGazetteer();
    await storage()?.removeItemAsync?.(META_KEY).catch(() => {});
    this.status = { state: "not_downloaded" };
  }
}

function toMetadata(m: StoredMeta): OfflinePackageMetadata {
  return {
    bboxMinLat: KYIV_OBLAST_BBOX.south, bboxMinLon: KYIV_OBLAST_BBOX.west, bboxMaxLat: KYIV_OBLAST_BBOX.north, bboxMaxLon: KYIV_OBLAST_BBOX.east,
    osmSourceDate: m.mapVersion.slice(0, 8), dataVersion: m.downloadedAt, graphVersion: "онлайн-маршрутизація (офлайн-маршрути ще не підтримуються)",
    mapVersion: m.mapVersion, poiVersion: m.downloadedAt, checksum: "перевірено за станом пакетів MapLibre", sizeBytes: m.mapBytes + m.placesBytes,
  };
}

export const regionPackage = new MapLibreRegionManager();

/** For the offline places module: is a verified package on the phone? */
export async function hasOfflinePlaces(): Promise<boolean> {
  return (await offlinePlacesMeta()) != null;
}
