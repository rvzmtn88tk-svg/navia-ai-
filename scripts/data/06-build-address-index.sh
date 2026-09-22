#!/usr/bin/env bash
# Step 6: build the local address index (streets + house numbers) backing
# OfflineGeocoder. Filters addressed ways/nodes with osmium, transforms with
# build-address-index.mjs.
set -euo pipefail
cd "$(dirname "$0")"

SRC="build/kyiv-oblast.osm.pbf"
FILTERED="build/kyiv-oblast-addr.osm.pbf"
GEOJSON="build/kyiv-oblast-addr.geojson"
OUT_DIR="build/offline/geocoder"

if [ ! -f "$SRC" ]; then
  echo "Missing $SRC — run 02-clip-region.sh first." >&2
  exit 1
fi
command -v osmium >/dev/null || { echo "osmium-tool not found — see README.md prerequisites." >&2; exit 1; }

osmium tags-filter "$SRC" addr:housenumber -o "$FILTERED" --overwrite
osmium export "$FILTERED" -o "$GEOJSON" --overwrite

mkdir -p "$OUT_DIR"
node build-address-index.mjs "$GEOJSON" "$OUT_DIR/index.json"
echo "Address index written to $OUT_DIR/index.json"
