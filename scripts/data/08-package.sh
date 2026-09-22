#!/usr/bin/env bash
# Step 8: package offline/{maps,routing,poi,geocoder,metadata.json} for the
# mobile app — a single signed/versioned archive the app imports (spec
# section 12: "The app should import a signed/versioned package"). Signing
# itself (step beyond this script) should use your organization's real code-
# signing key; this only produces the archive + its own sha256 to sign.
set -euo pipefail
cd "$(dirname "$0")"

OUT_DIR="build/offline"
METADATA="$OUT_DIR/metadata.json"

if [ ! -f "$METADATA" ]; then
  echo "Missing $METADATA — run 07-checksum-and-metadata.sh first." >&2
  exit 1
fi

VERSION=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$METADATA','utf8')).dataVersion)")
ARCHIVE="build/navia-kyiv-oblast-$VERSION.tar.gz"

tar -czf "$ARCHIVE" -C build offline
sha256sum "$ARCHIVE" > "$ARCHIVE.sha256"

echo "Packaged: $ARCHIVE"
echo "Checksum: $(cat "$ARCHIVE.sha256")"
echo
echo "Next (not part of this script): sign $ARCHIVE with your release key," \
     "then publish it wherever OfflineMapManager.download() fetches from" \
     "(see apps/mobile/.env.example's NAVIA_VALHALLA_BASE_URL and friends)."
