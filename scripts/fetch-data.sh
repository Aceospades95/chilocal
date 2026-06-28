#!/usr/bin/env bash
# Download the most accurate, current Chicago boundary GeoJSON from the
# official City of Chicago Data Portal into site/data/.
#
# The app works without this (it ships simplified samples and can fall back to
# the live portal), but running this bakes full-resolution official boundaries
# in for fast, offline, self-hosted serving.
#
# Usage:  ./scripts/fetch-data.sh
set -euo pipefail

DATA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/site/data"
mkdir -p "$DATA_DIR"

# dataset id -> output file  (source dataset IDs verified against the portal)
download () {
  local id="$1" out="$2" path="$DATA_DIR/$2"
  echo "→ $out"
  # Primary: SODA GeoJSON endpoint (returns a clean FeatureCollection)
  if curl -fsSL "https://data.cityofchicago.org/resource/${id}.geojson?\$limit=100000" -o "$path.tmp" \
     || curl -fsSL "https://data.cityofchicago.org/api/geospatial/${id}?method=export&format=GeoJSON" -o "$path.tmp"; then
    if grep -q '"FeatureCollection"' "$path.tmp"; then
      mv "$path.tmp" "$path"
      echo "   saved $(wc -c < "$path" | tr -d ' ') bytes"
    else
      echo "   ERROR: unexpected response; keeping existing file" >&2
      rm -f "$path.tmp"; return 1
    fi
  else
    echo "   ERROR: download failed" >&2
    rm -f "$path.tmp"; return 1
  fi
}

echo "Fetching Chicago boundaries → $DATA_DIR"
download "igwz-8jzy" "community-areas.geojson"   # Boundaries - Community Areas (official, 77)
download "y6yq-dbs2" "neighborhoods.geojson"     # Boundaries - Neighborhoods (approximate, 98)
echo "Done."
