#!/usr/bin/env bash
# Step 4: build a Valhalla regional routing graph (spec section 11: "Use
# Valhalla as the primary routing engine"). Requires 02-clip-region.sh's
# output.
set -euo pipefail
cd "$(dirname "$0")"

SRC="build/kyiv-oblast.osm.pbf"
OUT_DIR="build/offline/routing"

if [ ! -f "$SRC" ]; then
  echo "Missing $SRC — run 02-clip-region.sh first." >&2
  exit 1
fi

command -v valhalla_build_config >/dev/null || { echo "Valhalla tools not found — see README.md prerequisites." >&2; exit 1; }

mkdir -p "$OUT_DIR"
valhalla_build_config --mjolnir-tile-dir "$OUT_DIR/tiles" \
  --mjolnir-timezone "$OUT_DIR/timezones.sqlite" \
  --mjolnir-admin "$OUT_DIR/admins.sqlite" \
  > "$OUT_DIR/valhalla.json"

valhalla_build_tiles -c "$OUT_DIR/valhalla.json" "$SRC"

echo "Routing graph written to $OUT_DIR"
