#!/usr/bin/env python3
"""Sanity check the generated transit graph against known commutes.

Runs the same reverse Dijkstra the browser runs (times are *to* the target
station, including the wait for the first train) and compares a handful of
well known trips against hand-checked ranges. Station-to-station only -- the
walking half of the model is exercised in the app, not here.
"""

from __future__ import annotations

import heapq
import json
import sys

GRAPH = "web/data/transit-graph.json"

# (from, to, window, low_minutes, high_minutes) -- ranges are deliberately
# generous; they catch a broken graph, not a two-minute modelling difference.
CASES = [
    ("Times Sq-42 St", "Grand Central-42 St", "am_rush", 2, 9),
    ("96 St", "Times Sq-42 St", "am_rush", 8, 20),
    ("Jackson Hts-Roosevelt Av", "Times Sq-42 St", "am_rush", 15, 30),
    ("Bedford Av", "14 St-Union Sq", "am_rush", 6, 16),
    ("Borough Hall", "Fulton St", "am_rush", 3, 12),
    ("Coney Island-Stillwell Av", "Times Sq-42 St", "am_rush", 45, 75),
    ("Flushing-Main St", "Grand Central-42 St", "am_rush", 22, 40),
    ("Bay Ridge-95 St", "Times Sq-42 St", "am_rush", 35, 60),
    ("161 St-Yankee Stadium", "Times Sq-42 St", "am_rush", 12, 28),
    ("Astoria-Ditmars Blvd", "Times Sq-42 St", "am_rush", 18, 35),
    ("Inwood-207 St", "Times Sq-42 St", "am_rush", 30, 50),
    ("Jamaica Center-Parsons/Archer", "Times Sq-42 St", "am_rush", 30, 55),
    # The same trip should be slower when trains are rarer.
    ("Astoria-Ditmars Blvd", "Times Sq-42 St", "late_night", 22, 50),
]


def build_adjacency(graph: dict, window_key: str):
    """Reverse adjacency: incoming[v] = [(u, cost)] for edge u -> v of cost."""
    stations = graph["stations"]
    n_st = len(stations)
    window = next(w for w in graph["windows"] if w["key"] == window_key)
    nodes = window["nodes"]
    n_total = n_st + len(nodes)

    incoming = [[] for _ in range(n_total)]

    def add(u: int, v: int, cost: int) -> None:
        incoming[v].append((u, cost))

    for a, b, secs in window["edges"]:
        add(n_st + a, n_st + b, secs)

    for i, (station, _route, _dir) in enumerate(nodes):
        half = stations[station]["t"] // 2
        add(station, n_st + i, window["wait"][i] + half)  # board
        add(n_st + i, station, half)  # alight

    for a, b, secs in graph["transfers"]:
        add(a, b, secs)
        add(b, a, secs)

    return incoming, n_st, n_total


def reverse_times(graph: dict, window_key: str, target: int) -> list[float]:
    """Shortest time from every node to `target`, over the reversed graph."""
    incoming, n_st, n_total = build_adjacency(graph, window_key)

    # Transpose: to relax "u -> v", walk incoming[v] while settling v.
    dist = [float("inf")] * n_total
    dist[target] = 0.0
    pq = [(0.0, target)]
    while pq:
        d, v = heapq.heappop(pq)
        if d > dist[v]:
            continue
        for u, cost in incoming[v]:
            nd = d + cost
            if nd < dist[u]:
                dist[u] = nd
                heapq.heappush(pq, (nd, u))
    return dist[:n_st]


def main() -> int:
    with open(GRAPH) as fh:
        graph = json.load(fh)

    by_name = {}
    for i, s in enumerate(graph["stations"]):
        by_name.setdefault(s["n"], []).append(i)

    cache: dict[tuple[str, int], list[float]] = {}
    failures = 0

    for origin, dest, window, low, high in CASES:
        if origin not in by_name or dest not in by_name:
            print(f"SKIP  {origin} -> {dest}: station name not in feed")
            failures += 1
            continue

        best = float("inf")
        for target in by_name[dest]:
            key = (window, target)
            if key not in cache:
                cache[key] = reverse_times(graph, window, target)
            times = cache[key]
            for src in by_name[origin]:
                best = min(best, times[src])

        minutes = best / 60.0
        ok = low <= minutes <= high
        failures += 0 if ok else 1
        flag = "ok  " if ok else "FAIL"
        print(f"{flag}  {origin} -> {dest} [{window}]: {minutes:.1f} min (expected {low}-{high})")

    print()
    if failures:
        print(f"{failures} case(s) outside the expected range")
        return 1
    print(f"all {len(CASES)} cases within range")
    return 0


if __name__ == "__main__":
    sys.exit(main())
