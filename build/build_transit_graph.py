#!/usr/bin/env python3
"""Turn the MTA static GTFS feed into a compact routing graph for the browser.

The output is a route-direction graph, not a raw copy of the feed:

  station node   one per parent station (a whole complex, e.g. "Times Sq-42 St")
  route node     one per (station, route, direction) -- e.g. the uptown 2 platform

  ride edge      route node -> route node, median run time between consecutive
                 stops of that route/direction inside the time window
  board edge     station -> route node, costs (headway / 2) + half the station's
                 in-complex transfer time
  alight edge    route node -> station, costs half the in-complex transfer time
  transfer edge  station -> station, for the out-of-complex walking transfers
                 that the feed lists in transfers.txt

Boarding and alighting each paying half of the station's transfer time means a
same-complex transfer costs exactly the feed's min_transfer_time plus the wait
for the next train, while entering from the street costs only half of it.

Everything is recomputed per time-of-day window, so the late-night graph really
does have the late-night's slower headways and different service patterns.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import math
import os
import statistics
import sys
import urllib.request
import zipfile
from collections import Counter, defaultdict

FEED_URL = "https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip"

# (key, label, service_id, start_hour, end_hour) -- hours are decimal hours past
# midnight of the service day.
WINDOWS = [
    ("am_rush", "Weekday AM rush (7-10am)", "Weekday", 7.0, 10.0),
    ("midday", "Weekday midday (11am-3pm)", "Weekday", 11.0, 15.0),
    ("pm_rush", "Weekday PM rush (4-7pm)", "Weekday", 16.0, 19.0),
    ("evening", "Weekday evening (8-11pm)", "Weekday", 20.0, 23.0),
    # NYCT's service day runs roughly 00:00-26:15, so overnight trains are
    # listed as 00:xx rather than 24:xx. The handful of 24:00+ trips duplicate
    # the small hours of the following morning and are excluded by
    # detect_midnight_convention().
    ("late_night", "Weekday late night (12:30-5am)", "Weekday", 0.5, 5.0),
    ("weekend", "Saturday daytime (11am-6pm)", "Saturday", 11.0, 18.0),
]

DEFAULT_TRANSFER_TIME = 180  # seconds, when the feed does not say
MAX_WAIT = 900  # cap the modelled wait at 15 min even for very rare service
MIN_RUN_TIME = 20  # seconds; guards against zero-length stop pairs in the feed


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


def parse_gtfs_time(value: str) -> int | None:
    """GTFS times run past 24:00:00 for trips after midnight."""
    parts = value.strip().split(":")
    if len(parts) != 3:
        return None
    try:
        h, m, s = (int(p) for p in parts)
    except ValueError:
        return None
    return h * 3600 + m * 60 + s


def fetch_feed(path: str, url: str) -> None:
    if os.path.exists(path):
        log(f"using cached feed at {path}")
        return
    log(f"downloading {url}")
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with urllib.request.urlopen(url, timeout=180) as resp, open(path, "wb") as out:
        out.write(resp.read())
    log(f"saved {os.path.getsize(path) / 1e6:.1f} MB")


def read_table(zf: zipfile.ZipFile, name: str) -> list[dict]:
    with zf.open(name) as fh:
        text = io.TextIOWrapper(fh, encoding="utf-8-sig", newline="")
        return list(csv.DictReader(text))


def load_feed(zip_path: str) -> dict:
    with zipfile.ZipFile(zip_path) as zf:
        names = set(zf.namelist())
        feed = {
            "stops": read_table(zf, "stops.txt"),
            "routes": read_table(zf, "routes.txt"),
            "trips": read_table(zf, "trips.txt"),
            "transfers": read_table(zf, "transfers.txt") if "transfers.txt" in names else [],
            "calendar": read_table(zf, "calendar.txt") if "calendar.txt" in names else [],
            "feed_info": read_table(zf, "feed_info.txt") if "feed_info.txt" in names else [],
        }
        with zf.open("stop_times.txt") as fh:
            text = io.TextIOWrapper(fh, encoding="utf-8-sig", newline="")
            feed["stop_times"] = list(csv.DictReader(text))
    return feed


def build_stations(stops: list[dict]) -> tuple[list[dict], dict[str, int]]:
    """Parent stations become nodes; platform stop_ids map onto their parent."""
    stations: list[dict] = []
    by_stop_id: dict[str, int] = {}

    for s in stops:
        if s.get("location_type") == "1":
            idx = len(stations)
            stations.append(
                {
                    "gtfs_id": s["stop_id"],
                    "name": s["stop_name"],
                    "lat": round(float(s["stop_lat"]), 6),
                    "lon": round(float(s["stop_lon"]), 6),
                    "routes": set(),
                }
            )
            by_stop_id[s["stop_id"]] = idx

    for s in stops:
        if s.get("location_type") == "1":
            continue
        parent = s.get("parent_station") or ""
        if parent in by_stop_id:
            by_stop_id[s["stop_id"]] = by_stop_id[parent]
        else:
            # Standalone stop with no parent -- make it its own station.
            idx = len(stations)
            stations.append(
                {
                    "gtfs_id": s["stop_id"],
                    "name": s["stop_name"],
                    "lat": round(float(s["stop_lat"]), 6),
                    "lon": round(float(s["stop_lon"]), 6),
                    "routes": set(),
                }
            )
            by_stop_id[s["stop_id"]] = idx

    return stations, by_stop_id


def direction_of(stop_id: str, fallback: str) -> str:
    """NYCT encodes direction as an N/S suffix on the platform stop_id."""
    if stop_id.endswith("N"):
        return "N"
    if stop_id.endswith("S"):
        return "S"
    return "N" if fallback in ("", "0") else "S"


def detect_midnight_convention(trip_starts: list[int]) -> bool:
    """True when the feed also lists post-midnight trips as 24:00+ times.

    NYCT publishes some early-morning trips as 00:xx and the tail of the same
    service day as 24:xx / 25:xx.  Counting both against a single late-night
    window would double the apparent frequency, so we detect it and prefer the
    24:00+ form when it is well populated.
    """
    early = sum(1 for t in trip_starts if t < 5 * 3600)
    late = sum(1 for t in trip_starts if t >= 24 * 3600)
    return late > 0 and early > 0


def build_window(
    key: str,
    label: str,
    service_id: str,
    start_h: float,
    end_h: float,
    trips_by_service: dict[str, list[dict]],
    stop_times_by_trip: dict[str, list[dict]],
    stop_to_station: dict[str, int],
    route_index: dict[str, int],
    dual_midnight: bool,
) -> dict | None:
    start = int(start_h * 3600)
    end = int(end_h * 3600)
    span_hours = (end - start) / 3600.0

    trips = trips_by_service.get(service_id, [])
    if not trips:
        log(f"  {key}: no trips for service '{service_id}', skipping")
        return None

    # node key -> index, where a node is (station, route, direction)
    node_index: dict[tuple[int, int, str], int] = {}
    node_list: list[tuple[int, int, str]] = []
    departures: dict[int, int] = defaultdict(int)
    run_times: dict[tuple[int, int], list[int]] = defaultdict(list)

    def node_id(station: int, route: int, direction: str) -> int:
        k = (station, route, direction)
        idx = node_index.get(k)
        if idx is None:
            idx = len(node_list)
            node_index[k] = idx
            node_list.append(k)
        return idx

    for trip in trips:
        seq = stop_times_by_trip.get(trip["trip_id"])
        if not seq or len(seq) < 2:
            continue
        route = route_index.get(trip["route_id"])
        if route is None:
            continue
        direction = direction_of(seq[0]["stop_id"], trip.get("direction_id", ""))

        prev_node = None
        prev_dep = None
        for st in seq:
            station = stop_to_station.get(st["stop_id"])
            if station is None:
                continue
            dep = parse_gtfs_time(st["departure_time"] or st["arrival_time"])
            arr = parse_gtfs_time(st["arrival_time"] or st["departure_time"])
            if dep is None or arr is None:
                continue

            # A stop counts toward this window when the train departs inside it.
            # When the feed uses both midnight conventions, only trust the 24:00+
            # form for windows that start after midnight.
            in_window = start <= dep < end
            if not in_window and not dual_midnight:
                wrapped = dep % 86400
                in_window = start <= wrapped < end or start <= wrapped + 86400 < end

            node = node_id(station, route, direction)
            if in_window:
                departures[node] += 1

            if prev_node is not None and prev_dep is not None:
                run = arr - prev_dep
                if 0 < run < 3600 and (start <= prev_dep < end):
                    run_times[(prev_node, node)].append(run)
            prev_node = node
            prev_dep = dep

    if not departures:
        log(f"  {key}: no service inside the window, skipping")
        return None

    # Keep only nodes that actually see a train in this window, plus any node
    # needed as an endpoint of a surviving ride edge.
    edges: list[tuple[int, int, int]] = []
    for (a, b), samples in run_times.items():
        if departures.get(a, 0) == 0:
            continue
        secs = int(round(statistics.median(samples)))
        edges.append((a, b, max(MIN_RUN_TIME, secs)))

    live = {a for a, _, _ in edges} | {b for _, b, _ in edges}
    live |= {n for n, c in departures.items() if c > 0}

    remap: dict[int, int] = {}
    kept_nodes: list[tuple[int, int, str]] = []
    for old in sorted(live):
        remap[old] = len(kept_nodes)
        kept_nodes.append(node_list[old])

    out_edges = [[remap[a], remap[b], t] for a, b, t in edges if a in remap and b in remap]

    # Waiting is modelled on the *combined* frequency of every service leaving
    # the same platform toward the same next station -- someone at Fulton St
    # heading uptown takes the first of the 4 or 5, they do not wait out one
    # route's headway. Routes that diverge immediately keep their own headway.
    next_station: dict[int, int] = {}
    for a, b, _t in edges:
        station_b = node_list[b][0]
        # A route's next stop is the same on every trip in the window, so the
        # first edge out of the node settles it.
        next_station.setdefault(a, station_b)

    group_departures: dict[tuple[int, str, int], int] = defaultdict(int)
    for old in live:
        station, _route, direction = node_list[old]
        group_departures[(station, direction, next_station.get(old, -1))] += departures.get(
            old, 0
        )

    waits: list[int] = []
    for old in sorted(live):
        station, _route, direction = node_list[old]
        count = group_departures.get((station, direction, next_station.get(old, -1)), 0)
        if count <= 0:
            waits.append(MAX_WAIT)
            continue
        headway = span_hours * 3600.0 / count
        waits.append(int(min(MAX_WAIT, max(30, round(headway / 2.0)))))

    nodes = [[station, route, 0 if d == "N" else 1] for station, route, d in kept_nodes]

    typical = statistics.median(waits) if waits else 0
    log(
        f"  {key}: {len(nodes)} route nodes, {len(out_edges)} ride edges, "
        f"median wait {typical / 60:.1f} min"
    )

    return {
        "key": key,
        "label": label,
        "nodes": nodes,
        "wait": waits,
        "edges": out_edges,
    }


def build_transfers(
    transfers: list[dict], stop_to_station: dict[str, int], n_stations: int
) -> tuple[list[int], list[list[int]]]:
    """Return per-station in-complex transfer times and cross-complex edges."""
    in_complex = [DEFAULT_TRANSFER_TIME] * n_stations
    cross: dict[tuple[int, int], int] = {}

    for t in transfers:
        a = stop_to_station.get(t["from_stop_id"])
        b = stop_to_station.get(t["to_stop_id"])
        if a is None or b is None:
            continue
        try:
            secs = int(float(t.get("min_transfer_time") or DEFAULT_TRANSFER_TIME))
        except ValueError:
            secs = DEFAULT_TRANSFER_TIME
        if a == b:
            in_complex[a] = max(0, secs)
        else:
            key = (a, b)
            if key not in cross or secs < cross[key]:
                cross[key] = secs

    # A cross-complex transfer already pays half the in-complex time on the way
    # out and half on the way in, so subtract those to avoid double counting.
    edges = []
    for (a, b), secs in cross.items():
        adjusted = secs - in_complex[a] // 2 - in_complex[b] // 2
        edges.append([a, b, max(30, int(adjusted))])

    return in_complex, edges


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--feed", default="build/cache/gtfs_subway.zip", help="local feed path")
    ap.add_argument("--url", default=FEED_URL)
    ap.add_argument("--out", default="web/data/transit-graph.json")
    ap.add_argument("--refresh", action="store_true", help="re-download even if cached")
    args = ap.parse_args()

    if args.refresh and os.path.exists(args.feed):
        os.remove(args.feed)
    fetch_feed(args.feed, args.url)

    log("reading feed")
    feed = load_feed(args.feed)

    stations, stop_to_station = build_stations(feed["stops"])
    log(f"{len(stations)} stations")

    routes = []
    route_index: dict[str, int] = {}
    for r in feed["routes"]:
        route_index[r["route_id"]] = len(routes)
        routes.append(
            {
                "id": r["route_id"],
                "name": r.get("route_short_name") or r["route_id"],
                "color": "#" + (r.get("route_color") or "6d6e71"),
                "text": "#" + (r.get("route_text_color") or "ffffff"),
            }
        )

    stop_times_by_trip: dict[str, list[dict]] = defaultdict(list)
    for st in feed["stop_times"]:
        stop_times_by_trip[st["trip_id"]].append(st)
    for seq in stop_times_by_trip.values():
        seq.sort(key=lambda s: int(s["stop_sequence"]))
    log(f"{len(stop_times_by_trip)} trips with stop times")

    trips_by_service: dict[str, list[dict]] = defaultdict(list)
    for t in feed["trips"]:
        trips_by_service[t["service_id"]].append(t)

    # Which routes serve which station, for the station tooltips.
    for trip in feed["trips"]:
        route = route_index.get(trip["route_id"])
        if route is None:
            continue
        for st in stop_times_by_trip.get(trip["trip_id"], []):
            station = stop_to_station.get(st["stop_id"])
            if station is not None:
                stations[station]["routes"].add(routes[route]["name"])

    weekday_starts = [
        parse_gtfs_time(stop_times_by_trip[t["trip_id"]][0]["departure_time"])
        for t in trips_by_service.get("Weekday", [])
        if stop_times_by_trip.get(t["trip_id"])
    ]
    weekday_starts = [t for t in weekday_starts if t is not None]
    dual_midnight = detect_midnight_convention(weekday_starts)
    log(f"feed uses both midnight conventions: {dual_midnight}")

    in_complex, transfer_edges = build_transfers(
        feed["transfers"], stop_to_station, len(stations)
    )
    log(f"{len(transfer_edges)} out-of-complex transfer edges")

    windows = []
    for key, label, service, start_h, end_h in WINDOWS:
        win = build_window(
            key,
            label,
            service,
            start_h,
            end_h,
            trips_by_service,
            stop_times_by_trip,
            stop_to_station,
            route_index,
            dual_midnight,
        )
        if win:
            windows.append(win)

    feed_info = feed["feed_info"][0] if feed["feed_info"] else {}
    served: set[int] = set()
    for w in windows:
        for station, _, _ in w["nodes"]:
            served.add(station)
    log(f"{len(served)} stations have service in at least one window")

    out = {
        "generated_from": os.path.basename(args.feed),
        "feed_start_date": feed_info.get("feed_start_date", ""),
        "feed_end_date": feed_info.get("feed_end_date", ""),
        "feed_version": feed_info.get("feed_version", ""),
        "routes": routes,
        "stations": [
            {
                "n": s["name"],
                "y": s["lat"],
                "x": s["lon"],
                "r": sorted(s["routes"]),
                "t": in_complex[i],
            }
            for i, s in enumerate(stations)
        ],
        "transfers": transfer_edges,
        "windows": windows,
    }

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    log(f"wrote {args.out} ({os.path.getsize(args.out) / 1e6:.2f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
