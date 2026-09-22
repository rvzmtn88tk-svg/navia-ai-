#!/usr/bin/env bash
# Step 5: build the local POI index (spec section 15's categories: fuel,
# supermarket, pharmacy, hospital, bridge, railway crossing, major
# intersection, shopping centre, school, church, parking, government
# building, recognizable landmark). Filters the clipped extract to tagged
# POI nodes/ways with osmium, then transforms to @navia/core's POI shape
# with build-poi-index.mjs.
set -euo pipefail
cd "$(dirname "$0")"

SRC="build/kyiv-oblast.osm.pbf"
FILTERED="build/kyiv-oblast-poi.osm.pbf"
GEOJSON="build/kyiv-oblast-poi.geojson"
OUT_DIR="build/offline/poi"

if [ ! -f "$SRC" ]; then
  echo "Missing $SRC — run 02-clip-region.sh first." >&2
  exit 1
fi
command -v osmium >/dev/null || { echo "osmium-tool not found — see README.md prerequisites." >&2; exit 1; }

# Tag filter covering spec section 15's category list.
osmium tags-filter "$SRC" \
  amenity=fuel amenity=pharmacy amenity=hospital amenity=school \
  amenity=place_of_worship amenity=parking amenity=townhall amenity=courthouse \
  shop=supermarket shop=mall \
  railway=level_crossing \
  bridge=yes \
  highway=motorway_junction \
  -o "$FILTERED" --overwrite

osmium export "$FILTERED" -o "$GEOJSON" --overwrite

mkdir -p "$OUT_DIR"
node build-poi-index.mjs "$GEOJSON" "$OUT_DIR/index.json"
echo "POI index written to $OUT_DIR/index.json"
