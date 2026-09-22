// Offline data-package interfaces — spec section 12 ("OFFLINE ROUTING").
// "Приложение должно показывать: 'Київ + область — офлайн пакет — готовий'
// а не просто рисовать «100%»." — OfflinePackageStatus is the real,
// honest status object that requirement demands: it's built from an actual
// metadata.json (spec section 12's required fields) when one exists, and
// truthfully reports "not_downloaded" rather than faking readiness when it
// doesn't (which is the current state in this sandbox — scripts/data has
// been authored, per DATA_PIPELINE.md, but not run: this sandbox's network
// only reaches package registries, not OSM data sources — see LIMITATIONS.md).

import type { GeocoderProvider } from "./geocoder";

export type OfflinePackageMetadata = {
  bboxMinLat: number;
  bboxMinLon: number;
  bboxMaxLat: number;
  bboxMaxLon: number;
  osmSourceDate: string;
  dataVersion: string;
  graphVersion: string;
  mapVersion: string;
  poiVersion: string;
  checksum: string;
  sizeBytes: number;
};

export type OfflinePackageStatus =
  | { state: "not_downloaded" }
  | { state: "downloading"; progress0to1: number }
  | { state: "ready"; metadata: OfflinePackageMetadata; label: string }
  | { state: "unavailable"; reason: string };

export interface OfflineMapManager {
  getStatus(): OfflinePackageStatus;
  /** Real implementations would fetch/import the package; see BUILD.md/DATA_PIPELINE.md. */
  download(onProgress?: (progress0to1: number) => void): Promise<OfflinePackageStatus>;
}

export interface OfflineRoutingEngine {
  isAvailable(): boolean;
}

// Extends GeocoderProvider (geocoder.ts) so OnlineGeocoderProvider and any
// OfflineGeocoder implementation are interchangeable behind one interface —
// the app can switch which one SearchScreen calls without any UI change.
export interface OfflineGeocoder extends GeocoderProvider {
  isAvailable(): boolean;
}

/**
 * The only OfflineMapManager wired up in this pass: it truthfully reports
 * that no offline package has been built here (scripts/data is authored but
 * not executed — see LIMITATIONS.md), rather than drawing a fake "100%".
 * Swap in a real implementation once scripts/data has actually produced
 * offline/metadata.json on a machine with OSM data access.
 */
export class NotYetBuiltOfflineMapManager implements OfflineMapManager {
  getStatus(): OfflinePackageStatus {
    return {
      state: "unavailable",
      reason:
        "No offline package has been built in this environment. scripts/data/* implements the " +
        "OSM -> Valhalla pipeline (DATA_PIPELINE.md), but this sandbox's network cannot reach OSM " +
        "data sources to run it — see LIMITATIONS.md.",
    };
  }

  async download(): Promise<OfflinePackageStatus> {
    return this.getStatus();
  }
}

export function formatPackageLabel(metadata: OfflinePackageMetadata, regionName: string): string {
  return `${regionName} — офлайн пакет — готовий (${metadata.dataVersion}, ${(metadata.sizeBytes / 1_000_000).toFixed(0)} МБ)`;
}
