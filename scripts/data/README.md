# NAVIA offline data pipeline (Kyiv + Kyiv Oblast)

Implements `DATA_PIPELINE.md` / master-spec section 12 ("OFFLINE ROUTING"):
OSM PBF → clip Kyiv+Oblast → routing graph → address index → POI index →
vector map tiles → package → `offline/metadata.json`.

**Status: authored, not executed.** This sandbox's outbound network only
reaches package registries (npm/pip/etc.) — it cannot reach Geofabrik/OSM
data mirrors, so step 1 (`01-download-osm.sh`) cannot run here, and nothing
downstream of it has real data to operate on. Run this on a machine with
normal internet access. See `../../LIMITATIONS.md`.

## Prerequisites

- [`osmium-tool`](https://osmcode.org/osmium-tool/) (`osmium extract`, `osmium tags-filter`) — OSM extraction/filtering.
- [Valhalla](https://github.com/valhalla/valhalla) built with `valhalla_build_tiles` / `valhalla_build_config` — routing graph.
- [Tippecanoe](https://github.com/felt/tippecanoe) or [Planetiler](https://github.com/onthegomap/planetiler) — vector map tiles (MapLibre-compatible MBTiles).
- Node.js 20+ — POI/address indexing and metadata generation (uses only the Node stdlib + `@navia/core`'s types, no extra install needed).
- `jq`, `sha256sum` (coreutils) — metadata/checksum generation.

## Running the full pipeline

```bash
./run-all.sh
```

Or run each numbered step individually — each is idempotent given its
inputs and safe to re-run. Steps write into `./build/` (gitignored; nothing
under `build/` should ever be committed — DATA_PIPELINE.md: "Do not commit
large generated map binaries to git").

| Script | Spec step | Produces |
|---|---|---|
| `01-download-osm.sh` | obtain current Ukraine OSM PBF | `build/ukraine-latest.osm.pbf` |
| `02-clip-region.sh` | clip Kyiv/oblast bounding polygon | `build/kyiv-oblast.osm.pbf` |
| `03-build-vector-tiles.sh` | build vector-map assets | `build/offline/maps/tiles.mbtiles` |
| `04-build-routing-graph.sh` | build Valhalla routing tiles | `build/offline/routing/` |
| `05-build-poi-index.sh` | build local POI index | `build/offline/poi/index.json` |
| `06-build-address-index.sh` | build local address index | `build/offline/geocoder/index.json` |
| `07-checksum-and-metadata.sh` | checksums + `metadata.json` | `build/offline/metadata.json` |
| `08-package.sh` | package for the mobile app | `build/navia-kyiv-oblast-<version>.tar.gz` |

`kyiv-oblast.poly` is the clip boundary (Osmium polygon filter format), a
real approximate bounding polygon around Kyiv city + Kyiv Oblast.

## License / attribution

OSM data is © OpenStreetMap contributors, ODbL. Respect Geofabrik's and any
other provider's usage policy (rate limits, attribution requirements) — see
each script's header comment.
