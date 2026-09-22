#!/usr/bin/env bash
# Step 7: generate checksums + metadata.json (spec section 12's required
# fields: bbox, OSM source date, data/graph/map/POI version, checksum,
# size), matching @navia/core's OfflinePackageMetadata type exactly
# (packages/core/src/offline-manager.ts) so the app can parse it directly.
set -euo pipefail
cd "$(dirname "$0")"

OUT_DIR="build/offline"
VERSION="${NAVIA_DATA_VERSION:-$(date +%Y.%m.%d)}"

for required in "$OUT_DIR/maps/tiles.mbtiles" "$OUT_DIR/routing" "$OUT_DIR/poi/index.json" "$OUT_DIR/geocoder/index.json"; do
  if [ ! -e "$required" ]; then
    echo "Missing $required — run steps 3-6 first." >&2
    exit 1
  fi
done

SIZE_BYTES=$(du -sb "$OUT_DIR" | cut -f1)
OSM_DATE=$(cat build/osm-source-date.txt 2>/dev/null | sed 's/^[Ll]ast-[Mm]odified: //' | tr -d '\r' || echo "unknown")

# Checksum over every file except metadata.json itself (which embeds this checksum).
CHECKSUM=$(find "$OUT_DIR" -type f ! -name metadata.json -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)

cat > "$OUT_DIR/metadata.json" <<JSON
{
  "bboxMinLat": 49.9,
  "bboxMinLon": 29.2,
  "bboxMaxLat": 51.6,
  "bboxMaxLon": 32.2,
  "osmSourceDate": "$OSM_DATE",
  "dataVersion": "$VERSION",
  "graphVersion": "$VERSION",
  "mapVersion": "$VERSION",
  "poiVersion": "$VERSION",
  "checksum": "sha256:$CHECKSUM",
  "sizeBytes": $SIZE_BYTES
}
JSON

echo "Wrote $OUT_DIR/metadata.json"
cat "$OUT_DIR/metadata.json"
