/* Commute-time engine. Runs off the main thread so dragging the pin stays smooth.
 *
 * For every cell of a 120 m grid it answers: how long does it take to get from
 * here to the office? Three passes:
 *
 *   1. walk field   Dijkstra across walkable grid cells from the office, so
 *                   "20 minutes on foot" follows the land instead of swimming
 *                   the East River.
 *   2. transit      Dijkstra across the *reversed* subway graph, seeded with the
 *                   walk time from each station to the office. Reversing it is
 *                   what makes the wait for the first train land at the home end
 *                   of the trip, which is where a commuter actually waits.
 *   3. spread out   the walk field again, this time also seeded with every
 *                   station at its total time-to-office, capped by how far
 *                   someone is willing to walk to their home station.
 *
 * Distances are whole seconds, so both grid passes use a bucket queue
 * (Dial's algorithm) rather than a binary heap.
 */

'use strict';

const INF = 0x7fffffff;

let mask = null; // Uint8Array bitset, 1 = walkable
let geo = null; // grid geometry
let graph = null; // transit graph
let stationCell = null; // Int32Array, station -> grid cell index (snapped to land)

// Scratch buffers, allocated once and reused across solves.
let dist = null;
let walkSince = null;
let viaStation = null;
let bucketHead = null;
// Queue entries live in an append-only pool. Re-pointing a per-cell "next"
// field instead would let one bucket's chain splice into another's when a cell
// is improved after being queued, which can close a cycle and hang the loop.
let poolCell = null;
let poolNext = null;
let poolSize = 0;

function isWalkable(i) {
  return (mask[i >> 3] >> (i & 7)) & 1;
}

function cellOf(lat, lon) {
  const r = Math.floor((lat - geo.lat0) / geo.dLat);
  const c = Math.floor((lon - geo.lon0) / geo.dLon);
  if (r < 0 || r >= geo.rows || c < 0 || c >= geo.cols) return -1;
  return r * geo.cols + c;
}

/** Nearest walkable cell, searching outward in rings. */
function snapToLand(lat, lon, maxRings) {
  const r0 = Math.floor((lat - geo.lat0) / geo.dLat);
  const c0 = Math.floor((lon - geo.lon0) / geo.dLon);
  for (let ring = 0; ring <= maxRings; ring++) {
    for (let dr = -ring; dr <= ring; dr++) {
      for (let dc = -ring; dc <= ring; dc++) {
        // Only the shell of each ring is new.
        if (ring > 0 && Math.abs(dr) !== ring && Math.abs(dc) !== ring) continue;
        const r = r0 + dr;
        const c = c0 + dc;
        if (r < 0 || r >= geo.rows || c < 0 || c >= geo.cols) continue;
        const i = r * geo.cols + c;
        if (isWalkable(i)) return i;
      }
    }
  }
  return -1;
}

function decodeBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function init(dataBase) {
  const [maskRes, graphRes] = await Promise.all([
    fetch(dataBase + 'landmask.json'),
    fetch(dataBase + 'transit-graph.json'),
  ]);
  if (!maskRes.ok) throw new Error('could not load landmask.json (' + maskRes.status + ')');
  if (!graphRes.ok) throw new Error('could not load transit-graph.json (' + graphRes.status + ')');

  const maskJson = await maskRes.json();
  graph = await graphRes.json();

  geo = {
    lat0: maskJson.lat0,
    lon0: maskJson.lon0,
    dLat: maskJson.dLat,
    dLon: maskJson.dLon,
    rows: maskJson.rows,
    cols: maskJson.cols,
    cellMetres: maskJson.cellMetres,
    mPerDegLat: maskJson.metresPerDegLat,
    mPerDegLon: maskJson.metresPerDegLon,
  };
  mask = decodeBase64(maskJson.mask);

  const n = geo.rows * geo.cols;
  dist = new Int32Array(n);
  walkSince = new Int32Array(n);
  viaStation = new Int32Array(n);
  poolCell = new Int32Array(n * 2);
  poolNext = new Int32Array(n * 2);

  stationCell = new Int32Array(graph.stations.length);
  for (let s = 0; s < graph.stations.length; s++) {
    stationCell[s] = snapToLand(graph.stations[s].y, graph.stations[s].x, 8);
  }

  return {
    windows: graph.windows.map((w) => ({ key: w.key, label: w.label })),
    stations: graph.stations.map((s) => ({ name: s.n, lat: s.y, lon: s.x, routes: s.r })),
    rows: geo.rows,
    cols: geo.cols,
    lat0: geo.lat0,
    lon0: geo.lon0,
    dLat: geo.dLat,
    dLon: geo.dLon,
    cellMetres: geo.cellMetres,
    feed: {
      start: graph.feed_start_date,
      end: graph.feed_end_date,
      version: graph.feed_version,
    },
  };
}

/* ---------------------------------------------------------------- grid walk */

/** Step costs in seconds for the 8 neighbours, given a walking speed. */
function stepCosts(metresPerSecond) {
  const ns = geo.dLat * geo.mPerDegLat;
  const ew = geo.dLon * geo.mPerDegLon;
  const diag = Math.sqrt(ns * ns + ew * ew);
  const s = (m) => Math.max(1, Math.round(m / metresPerSecond));
  return { ns: s(ns), ew: s(ew), diag: s(diag) };
}

/**
 * Multi-source Dijkstra over walkable cells using a bucket queue.
 * `dist`, `walkSince` and `viaStation` are expected to be primed by the caller;
 * `seeds` lists cell indices already holding their final starting distance.
 */
function spreadWalk(seeds, limit, maxWalkSecs, speed) {
  const { ns, ew, diag } = stepCosts(speed);
  const cols = geo.cols;
  const rows = geo.rows;
  const nBuckets = limit + Math.max(ns, ew, diag) + 2;

  if (!bucketHead || bucketHead.length < nBuckets) bucketHead = new Int32Array(nBuckets);
  bucketHead.fill(-1, 0, nBuckets);

  const cellCount = rows * cols;
  if (!poolCell || poolCell.length < cellCount * 2) {
    poolCell = new Int32Array(cellCount * 2);
    poolNext = new Int32Array(cellCount * 2);
  }
  poolSize = 0;

  const enqueue = (cell, d) => {
    if (poolSize === poolCell.length) {
      const biggerCell = new Int32Array(poolSize * 2);
      const biggerNext = new Int32Array(poolSize * 2);
      biggerCell.set(poolCell);
      biggerNext.set(poolNext);
      poolCell = biggerCell;
      poolNext = biggerNext;
    }
    poolCell[poolSize] = cell;
    poolNext[poolSize] = bucketHead[d];
    bucketHead[d] = poolSize;
    poolSize++;
  };

  let minBucket = nBuckets;
  for (let k = 0; k < seeds.length; k++) {
    const cell = seeds[k];
    const d = dist[cell];
    if (d > limit) continue;
    enqueue(cell, d);
    if (d < minBucket) minBucket = d;
  }

  for (let d = minBucket; d < nBuckets; d++) {
    let entry = bucketHead[d];
    while (entry !== -1) {
      const cell = poolCell[entry];
      const next = poolNext[entry];
      entry = next;
      if (dist[cell] !== d) continue; // stale: improved after being queued

      const r = (cell / cols) | 0;
      const c = cell - r * cols;
      const ws = walkSince[cell];
      const via = viaStation[cell];

      for (let dr = -1; dr <= 1; dr++) {
        const nr = r + dr;
        if (nr < 0 || nr >= rows) continue;
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nc = c + dc;
          if (nc < 0 || nc >= cols) continue;
          const ni = nr * cols + nc;
          if (!isWalkable(ni)) continue;

          const step = dr === 0 ? ew : dc === 0 ? ns : diag;
          const nd = d + step;
          if (nd > limit || nd >= dist[ni]) continue;
          const nws = ws + step;
          if (nws > maxWalkSecs) continue; // too far from the last station

          dist[ni] = nd;
          walkSince[ni] = nws;
          viaStation[ni] = via;
          enqueue(ni, nd);
        }
      }
    }
  }
}

/* ------------------------------------------------------------- transit graph */

/** Reversed adjacency for one time window, built lazily and cached. */
const adjCache = new Map();

function reverseAdjacency(windowKey) {
  const cached = adjCache.get(windowKey);
  if (cached) return cached;

  const window = graph.windows.find((w) => w.key === windowKey);
  if (!window) throw new Error('unknown time window: ' + windowKey);

  const nSt = graph.stations.length;
  const nNodes = nSt + window.nodes.length;

  // Count first, then fill: a flat CSR beats an array of arrays here.
  const counts = new Int32Array(nNodes);
  const bump = (v) => counts[v]++;

  for (const [a, b] of window.edges) bump(nSt + b);
  for (let i = 0; i < window.nodes.length; i++) {
    bump(nSt + i); // board: station -> route node
    bump(window.nodes[i][0]); // alight: route node -> station
  }
  for (const [a, b] of graph.transfers) {
    bump(b);
    bump(a);
  }

  const offset = new Int32Array(nNodes + 1);
  for (let i = 0; i < nNodes; i++) offset[i + 1] = offset[i] + counts[i];
  const total = offset[nNodes];
  const from = new Int32Array(total);
  const cost = new Int32Array(total);
  const cursor = offset.slice(0, nNodes);

  const add = (u, v, c) => {
    const p = cursor[v]++;
    from[p] = u;
    cost[p] = c;
  };

  for (const [a, b, secs] of window.edges) add(nSt + a, nSt + b, secs);
  for (let i = 0; i < window.nodes.length; i++) {
    const station = window.nodes[i][0];
    const half = graph.stations[station].t >> 1;
    add(station, nSt + i, window.wait[i] + half); // board costs the wait
    add(nSt + i, station, half); // alight costs the walk up to the mezzanine
  }
  for (const [a, b, secs] of graph.transfers) {
    add(a, b, secs);
    add(b, a, secs);
  }

  const adj = { offset, from, cost, nSt, nNodes, nodes: window.nodes };
  adjCache.set(windowKey, adj);
  return adj;
}

/** Binary heap keyed on distance; small enough that a plain array is fine. */
function transitTimes(windowKey, seedDist, limit) {
  const adj = reverseAdjacency(windowKey);
  const { offset, from, cost, nSt, nNodes } = adj;

  const d = new Int32Array(nNodes).fill(INF);
  const heapNode = [];
  const heapDist = [];

  const push = (node, value) => {
    let i = heapNode.length;
    heapNode.push(node);
    heapDist.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heapDist[parent] <= heapDist[i]) break;
      [heapDist[parent], heapDist[i]] = [heapDist[i], heapDist[parent]];
      [heapNode[parent], heapNode[i]] = [heapNode[i], heapNode[parent]];
      i = parent;
    }
  };

  const pop = () => {
    const topNode = heapNode[0];
    const topDist = heapDist[0];
    const lastNode = heapNode.pop();
    const lastDist = heapDist.pop();
    if (heapNode.length) {
      heapNode[0] = lastNode;
      heapDist[0] = lastDist;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let small = i;
        if (l < heapDist.length && heapDist[l] < heapDist[small]) small = l;
        if (r < heapDist.length && heapDist[r] < heapDist[small]) small = r;
        if (small === i) break;
        [heapDist[small], heapDist[i]] = [heapDist[i], heapDist[small]];
        [heapNode[small], heapNode[i]] = [heapNode[i], heapNode[small]];
        i = small;
      }
    }
    return [topNode, topDist];
  };

  for (let s = 0; s < nSt; s++) {
    if (seedDist[s] < d[s]) {
      d[s] = seedDist[s];
      push(s, seedDist[s]);
    }
  }

  while (heapNode.length) {
    const [v, dv] = pop();
    if (dv > d[v]) continue;
    const end = offset[v + 1];
    for (let p = offset[v]; p < end; p++) {
      const u = from[p];
      const nd = dv + cost[p];
      if (nd < d[u] && nd <= limit) {
        d[u] = nd;
        push(u, nd);
      }
    }
  }

  return d.subarray(0, nSt);
}

/* -------------------------------------------------------------------- solve */

function solve(req) {
  const t0 = Date.now();
  const budget = Math.round(req.budgetMinutes * 60);
  const maxWalk = Math.round(req.maxWalkMinutes * 60);
  const speed = (req.walkKph * 1000) / 3600 / req.detour;

  const origin = snapToLand(req.lat, req.lon, 25);
  if (origin < 0) {
    return { error: 'That address is outside the five boroughs, so there is no grid to walk on.' };
  }

  const n = geo.rows * geo.cols;
  dist.fill(INF);
  viaStation.fill(-1);
  // A large negative "walk so far" exempts walking straight from the office
  // from the max-walk cap: a 40 minute walk home is a real 40 minute commute.
  walkSince.fill(0);
  dist[origin] = 0;
  walkSince[origin] = -1000000;

  spreadWalk([origin], budget, maxWalk, speed);
  const walkOnlyReached = countReached(budget);

  let usedStations = 0;
  const stationMinutes = new Uint8Array(graph.stations.length).fill(255);

  if (req.mode === 'transit') {
    const nSt = graph.stations.length;
    const seed = new Int32Array(nSt).fill(INF);
    for (let s = 0; s < nSt; s++) {
      const cell = stationCell[s];
      if (cell < 0) continue;
      // Walking from the office to its station is capped like any other leg.
      const w = dist[cell];
      if (w <= maxWalk && w < seed[s]) seed[s] = w;
    }

    const stationTimes = transitTimes(req.window, seed, budget);

    const seeds = [];
    for (let s = 0; s < nSt; s++) {
      const cell = stationCell[s];
      if (cell < 0) continue;
      const t = stationTimes[s];
      if (t >= INF || t > budget) continue;
      usedStations++;
      const m = Math.round(t / 60);
      stationMinutes[s] = m > 254 ? 254 : m;
      if (t < dist[cell]) {
        dist[cell] = t;
        walkSince[cell] = 0;
        viaStation[cell] = s;
        seeds.push(cell);
      }
    }

    if (seeds.length) spreadWalk(seeds, budget, maxWalk, speed);
  }

  // Pack to minutes for transfer; 255 means "not within the budget".
  const out = new Uint8Array(n);
  let reached = 0;
  for (let i = 0; i < n; i++) {
    const d = dist[i];
    if (d >= INF || d > budget) {
      out[i] = 255;
    } else {
      const m = Math.round(d / 60);
      out[i] = m > 254 ? 254 : m;
      reached++;
    }
  }

  const via = new Int32Array(viaStation);
  const cellArea = (geo.cellMetres * geo.cellMetres) / 1e6; // km^2

  return {
    minutes: out,
    via,
    stationMinutes,
    rows: geo.rows,
    cols: geo.cols,
    origin,
    stats: {
      reachedCells: reached,
      areaKm2: reached * cellArea,
      walkOnlyAreaKm2: walkOnlyReached * cellArea,
      stationsInRange: usedStations,
      elapsedMs: Date.now() - t0,
    },
  };
}

function countReached(budget) {
  let count = 0;
  for (let i = 0; i < dist.length; i++) if (dist[i] <= budget) count++;
  return count;
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === 'init') {
      const info = await init(msg.dataBase);
      self.postMessage({ type: 'ready', id: msg.id, info });
    } else if (msg.type === 'solve') {
      const result = solve(msg.request);
      if (result.error) {
        self.postMessage({ type: 'error', id: msg.id, message: result.error });
      } else {
        self.postMessage({ type: 'result', id: msg.id, result }, [
          result.minutes.buffer,
          result.via.buffer,
          result.stationMinutes.buffer,
        ]);
      }
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: String((err && err.message) || err) });
  }
};
