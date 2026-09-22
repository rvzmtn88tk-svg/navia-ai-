#!/usr/bin/env bash
# Step 1 (DATA_PIPELINE.md): obtain a current Ukraine OSM PBF from a
# legitimate OSM data provider (Geofabrik). NOT RUNNABLE in this sandbox —
# its network only reaches package registries, not download.geofabrik.de.
# Run on a machine with normal internet access. See README.md.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build

SOURCE_URL="https://download.geofabrik.de/europe/ukraine-latest.osm.pbf"
DEST="build/ukraine-latest.osm.pbf"

echo "Downloading $SOURCE_URL -> $DEST"
echo "(Geofabrik terms: https://download.geofabrik.de/europe/ukraine.html — attribute © OpenStreetMap contributors, ODbL.)"
curl -fL --progress-bar -o "$DEST.tmp" "$SOURCE_URL"
mv "$DEST.tmp" "$DEST"

echo "OSM source date (Last-Modified header, for metadata.json):"
curl -fsI "$SOURCE_URL" | grep -i '^last-modified:' | tee build/osm-source-date.txt

echo "Done: $DEST"
