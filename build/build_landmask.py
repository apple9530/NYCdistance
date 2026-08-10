#!/usr/bin/env python3
"""Rasterise NYC into a walkable/not-walkable bitmask.

The routing engine spreads walking across this grid instead of drawing
straight lines, which is what stops it from walking across the East River.
A cell is walkable when its centre falls inside a borough boundary and
outside the hand-drawn water overrides.

Output is one JSON file holding the grid geometry plus a base64 bitset,
one bit per cell, row 0 at the southern edge.
"""

from __future__ import annotations

import argparse
import base64
import json
import math
import os
import sys
import urllib.request

from shapely.geometry import shape, Point
from shapely.ops import unary_union
from shapely.prepared import prep

BOROUGHS_URL = (
    "https://raw.githubusercontent.com/codeforgermany/click_that_hood/main/"
    "public/data/new-york-city-boroughs.geojson"
)

# Points that must survive the rasterisation, so a bad water override or a
# too-coarse grid fails the build instead of silently deleting a neighbourhood.
MUST_BE_LAND = {
    "Times Sq": (40.7580, -73.9855),
    "Broad Channel": (40.6080, -73.8160),
    "Hamilton Beach": (40.6570, -73.8360),
    "Howard Beach": (40.6575, -73.8425),
    "Rockaway Park": (40.5800, -73.8360),
    "Far Rockaway": (40.6000, -73.7550),
    "Canarsie": (40.6410, -73.9020),
    "Mill Basin": (40.6120, -73.9070),
    "Marine Park": (40.6000, -73.9300),
    "Floyd Bennett Field": (40.5900, -73.8880),
    "Bergen Beach": (40.6220, -73.9000),
    "JFK Airport": (40.6413, -73.7781),
    "City Island": (40.8470, -73.7870),
    "Riverdale": (40.8900, -73.9120),
    "Tottenville": (40.5120, -74.2460),
    "Astoria": (40.7644, -73.9235),
    "Coney Island": (40.5760, -73.9800),
}

MUST_BE_WATER = {
    "East River (midtown)": (40.7530, -73.9620),
    "Hudson (midtown)": (40.7600, -74.0100),
    "Upper Bay": (40.6600, -74.0400),
    "Jamaica Bay (centre)": (40.6150, -73.8500),
    "Jamaica Bay (Grassy Bay)": (40.6180, -73.7980),
    "Newtown Creek mouth": (40.7360, -73.9640),
    "Long Island Sound": (40.8600, -73.7600),
}


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


def fetch(path: str, url: str) -> None:
    if os.path.exists(path):
        log(f"using cached {path}")
        return
    log(f"downloading {url}")
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with urllib.request.urlopen(url, timeout=180) as resp, open(path, "wb") as out:
        out.write(resp.read())


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--boroughs", default="build/cache/nyc-boroughs.geojson")
    ap.add_argument("--url", default=BOROUGHS_URL)
    ap.add_argument("--water", default="build/water_overrides.geojson")
    ap.add_argument("--out", default="web/data/landmask.json")
    ap.add_argument("--cell-metres", type=float, default=120.0)
    args = ap.parse_args()

    fetch(args.boroughs, args.url)

    with open(args.boroughs) as fh:
        boroughs = json.load(fh)
    land = unary_union([shape(f["geometry"]) for f in boroughs["features"]]).buffer(0)

    if os.path.exists(args.water):
        with open(args.water) as fh:
            water = json.load(fh)
        cutouts = [shape(f["geometry"]) for f in water.get("features", [])]
        if cutouts:
            land = land.difference(unary_union(cutouts).buffer(0))
            log(f"subtracted {len(cutouts)} water override polygons")

    min_lon, min_lat, max_lon, max_lat = land.bounds
    # Pad slightly so shoreline cells are not clipped by the bounding box.
    pad = 0.01
    min_lon, max_lon = min_lon - pad, max_lon + pad
    min_lat, max_lat = min_lat - pad, max_lat + pad

    mid_lat = (min_lat + max_lat) / 2.0
    m_per_deg_lat = 111_132.0
    m_per_deg_lon = 111_320.0 * math.cos(math.radians(mid_lat))

    d_lat = args.cell_metres / m_per_deg_lat
    d_lon = args.cell_metres / m_per_deg_lon
    rows = int(math.ceil((max_lat - min_lat) / d_lat))
    cols = int(math.ceil((max_lon - min_lon) / d_lon))
    log(f"grid {cols} x {rows} = {cols * rows:,} cells at {args.cell_metres:.0f} m")

    prepared = prep(land)
    bits = bytearray((rows * cols + 7) // 8)
    walkable = 0
    for r in range(rows):
        lat = min_lat + (r + 0.5) * d_lat
        base = r * cols
        for c in range(cols):
            lon = min_lon + (c + 0.5) * d_lon
            if prepared.contains(Point(lon, lat)):
                i = base + c
                bits[i >> 3] |= 1 << (i & 7)
                walkable += 1
    log(f"{walkable:,} walkable cells ({100.0 * walkable / (rows * cols):.1f}%)")

    def cell_of(lat: float, lon: float) -> tuple[int, int]:
        return (
            int((lat - min_lat) / d_lat),
            int((lon - min_lon) / d_lon),
        )

    def is_set(r: int, c: int) -> bool:
        if not (0 <= r < rows and 0 <= c < cols):
            return False
        i = r * cols + c
        return bool(bits[i >> 3] & (1 << (i & 7)))

    failures = []
    for name, (lat, lon) in MUST_BE_LAND.items():
        r, c = cell_of(lat, lon)
        if not is_set(r, c):
            failures.append(f"expected land but got water: {name}")
    for name, (lat, lon) in MUST_BE_WATER.items():
        r, c = cell_of(lat, lon)
        if is_set(r, c):
            failures.append(f"expected water but got land: {name}")

    for f in failures:
        log(f"  CHECK FAILED  {f}")
    if failures:
        log(f"{len(failures)} land mask checks failed -- fix water_overrides.geojson")
        return 1
    log(f"all {len(MUST_BE_LAND) + len(MUST_BE_WATER)} land mask checks passed")

    out = {
        "lat0": min_lat,
        "lon0": min_lon,
        "dLat": d_lat,
        "dLon": d_lon,
        "rows": rows,
        "cols": cols,
        "cellMetres": args.cell_metres,
        "metresPerDegLat": m_per_deg_lat,
        "metresPerDegLon": m_per_deg_lon,
        "mask": base64.b64encode(bytes(bits)).decode("ascii"),
    }
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    log(f"wrote {args.out} ({os.path.getsize(args.out) / 1e6:.2f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
