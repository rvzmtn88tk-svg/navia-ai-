#!/usr/bin/env bash
# Step 2: clip Kyiv + Kyiv Oblast from the full Ukraine extract, using
# osmium-tool and kyiv-oblast.poly (a real approximate bounding polygon —
# see README.md). Requires 01-download-osm.sh's output.
set -euo pipefail
cd "$(dirname "$0")"

SRC="build/ukraine-latest.osm.pbf"
OUT="build/kyiv-oblast.osm.pbf"

if [ ! -f "$SRC" ]; then
  echo "Missing $SRC — run 01-download-osm.sh first." >&2
  exit 1
fi

command -v osmium >/dev/null || { echo "osmium-tool not found — see README.md prerequisites." >&2; exit 1; }

osmium extract --polygon kyiv-oblast.poly "$SRC" -o "$OUT" --overwrite
echo "Clipped region written to $OUT"
osmium fileinfo "$OUT"
