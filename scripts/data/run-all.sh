#!/usr/bin/env bash
# Runs the full pipeline in order. See README.md — step 1 needs real
# internet access this sandbox doesn't have, so this hasn't been executed
# end-to-end here.
set -euo pipefail
cd "$(dirname "$0")"

for step in 01-download-osm.sh 02-clip-region.sh 03-build-vector-tiles.sh \
            04-build-routing-graph.sh 05-build-poi-index.sh 06-build-address-index.sh \
            07-checksum-and-metadata.sh 08-package.sh; do
  echo "=== $step ==="
  ./"$step"
done

echo "=== Done ==="
