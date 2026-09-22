#!/usr/bin/env bash
# Step 3: build vector-map assets (MapLibre-compatible MBTiles) with
# Planetiler, from the clipped extract. Requires 02-clip-region.sh's output.
set -euo pipefail
cd "$(dirname "$0")"

SRC="build/kyiv-oblast.osm.pbf"
OUT_DIR="build/offline/maps"
OUT="$OUT_DIR/tiles.mbtiles"

if [ ! -f "$SRC" ]; then
  echo "Missing $SRC — run 02-clip-region.sh first." >&2
  exit 1
fi

command -v planetiler >/dev/null || { echo "planetiler not found — see README.md prerequisites." >&2; exit 1; }

mkdir -p "$OUT_DIR"
planetiler --osm-path="$SRC" --output="$OUT" --download=false --area=kyiv-oblast
echo "Vector tiles written to $OUT"
