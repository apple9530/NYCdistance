#!/usr/bin/env python3
"""Extract drawable subway line geometry from the GTFS feed.

shapes.txt holds one polyline per service pattern, and there are hundreds of
them per route once you count every short-turn and late-night variant. For a map
overlay we want a handful per route that between them touch every station the
route serves, so patterns are picked greedily: start with the one covering the
most stations, then keep adding whichever pattern brings the most new ones.

Output is a GeoJSON FeatureCollection carrying the MTA's own route colours.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import math
import os
import sys
import zipfile
from collections import defaultdict

MAX_PATTERNS_PER_ROUTE = 4
MIN_NEW_STATIONS = 3
SIMPLIFY_METRES = 15.0


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


def read_table(zf: zipfile.ZipFile, name: str) -> list[dict]:
    with zf.open(name) as fh:
        return list(csv.DictReader(io.TextIOWrapper(fh, encoding="utf-8-sig", newline="")))


def simplify(points: list[tuple[float, float]], tolerance_m: float) -> list[list[float]]:
    """Ramer-Douglas-Peucker on (lat, lon), tolerance in metres."""
    if len(points) < 3:
        return [[round(lon, 5), round(lat, 5)] for lat, lon in points]

    lat_scale = 111_132.0
    lon_scale = 111_320.0 * math.cos(math.radians(points[0][0]))
    tol_sq = tolerance_m * tolerance_m

    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]

    while stack:
        first, last = stack.pop()
        ax, ay = points[first][1] * lon_scale, points[first][0] * lat_scale
        bx, by = points[last][1] * lon_scale, points[last][0] * lat_scale
        dx, dy = bx - ax, by - ay
        len_sq = dx * dx + dy * dy

        worst = 0.0
        index = -1
        for i in range(first + 1, last):
            px, py = points[i][1] * lon_scale, points[i][0] * lat_scale
            t = ((px - ax) * dx + (py - ay) * dy) / len_sq if len_sq else 0.0
            t = max(0.0, min(1.0, t))
            cx, cy = ax + t * dx, ay + t * dy
            sq = (px - cx) ** 2 + (py - cy) ** 2
            if sq > worst:
                worst, index = sq, i

        if worst > tol_sq and index > 0:
            keep[index] = True
            stack.append((first, index))
            stack.append((index, last))

    return [[round(points[i][1], 5), round(points[i][0], 5)] for i in range(len(points)) if keep[i]]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--feed", default="build/cache/gtfs_subway.zip")
    ap.add_argument("--out", default="web/data/subway-lines.json")
    args = ap.parse_args()

    if not os.path.exists(args.feed):
        log(f"{args.feed} not found -- run build_transit_graph.py first")
        return 1

    with zipfile.ZipFile(args.feed) as zf:
        routes = read_table(zf, "routes.txt")
        trips = read_table(zf, "trips.txt")
        stops = read_table(zf, "stops.txt")
        shape_rows = read_table(zf, "shapes.txt")
        with zf.open("stop_times.txt") as fh:
            stop_times = list(csv.DictReader(io.TextIOWrapper(fh, encoding="utf-8-sig", newline="")))

    parent_of: dict[str, str] = {}
    for s in stops:
        if s.get("location_type") == "1":
            parent_of[s["stop_id"]] = s["stop_id"]
        else:
            parent_of[s["stop_id"]] = s.get("parent_station") or s["stop_id"]

    shapes: dict[str, list[tuple[int, float, float]]] = defaultdict(list)
    for row in shape_rows:
        shapes[row["shape_id"]].append(
            (
                int(row["shape_pt_sequence"]),
                float(row["shape_pt_lat"]),
                float(row["shape_pt_lon"]),
            )
        )
    for points in shapes.values():
        points.sort()
    log(f"{len(shapes)} shapes in the feed")

    # One representative trip per shape is enough to know which stations it serves.
    trip_shape: dict[str, str] = {}
    trip_route: dict[str, str] = {}
    shape_trip_count: dict[str, int] = defaultdict(int)
    for t in trips:
        trip_shape[t["trip_id"]] = t["shape_id"]
        trip_route[t["trip_id"]] = t["route_id"]
        shape_trip_count[t["shape_id"]] += 1

    shape_stations: dict[str, set[str]] = defaultdict(set)
    for st in stop_times:
        shape = trip_shape.get(st["trip_id"])
        if shape:
            station = parent_of.get(st["stop_id"])
            if station:
                shape_stations[shape].add(station)

    route_shapes: dict[str, set[str]] = defaultdict(set)
    for trip_id, shape in trip_shape.items():
        route_shapes[trip_route[trip_id]].add(shape)

    features = []
    for route in routes:
        route_id = route["route_id"]
        candidates = [s for s in route_shapes.get(route_id, set()) if s in shapes]
        if not candidates:
            continue

        covered: set[str] = set()
        chosen: list[str] = []
        for _ in range(MAX_PATTERNS_PER_ROUTE):
            best = None
            best_gain = 0
            for shape in candidates:
                if shape in chosen:
                    continue
                gain = len(shape_stations[shape] - covered)
                # Break ties toward the pattern that actually runs more often.
                if gain > best_gain or (
                    gain == best_gain
                    and best is not None
                    and shape_trip_count[shape] > shape_trip_count[best]
                    and gain > 0
                ):
                    best, best_gain = shape, gain
            if best is None or (chosen and best_gain < MIN_NEW_STATIONS):
                break
            chosen.append(best)
            covered |= shape_stations[best]

        color = "#" + (route.get("route_color") or "6d6e71")
        text = "#" + (route.get("route_text_color") or "ffffff")
        name = route.get("route_short_name") or route_id

        for shape in chosen:
            coords = simplify([(lat, lon) for _seq, lat, lon in shapes[shape]], SIMPLIFY_METRES)
            if len(coords) < 2:
                continue
            features.append(
                {
                    "type": "Feature",
                    "properties": {
                        "route": name,
                        "route_id": route_id,
                        "long_name": route.get("route_long_name", ""),
                        "color": color,
                        "text": text,
                    },
                    "geometry": {"type": "LineString", "coordinates": coords},
                }
            )

        log(f"  {name}: {len(chosen)} pattern(s), {len(covered)} stations")

    out = {"type": "FeatureCollection", "features": features}
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    log(f"wrote {args.out} ({os.path.getsize(args.out) / 1e6:.2f} MB, {len(features)} lines)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
