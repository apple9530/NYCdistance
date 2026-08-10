#!/usr/bin/env bash
# Rebuild both data files from upstream sources, then check the result.
set -euo pipefail
cd "$(dirname "$0")/.."

python3 build/build_transit_graph.py "$@"
python3 build/build_landmask.py
python3 build/build_subway_lines.py
python3 build/validate_graph.py

echo
ls -lh web/data/
