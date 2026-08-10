/* Turning the travel-time grid into polygons.
 *
 * Marching squares over the "reachable within T minutes" mask gives a set of
 * line segments; those get stitched into closed rings, holes get matched to the
 * ring that contains them, and the result is simplified. The same rings are
 * used for the isochrone outlines on the map and for every export format.
 */

'use strict';

/** Grid geometry helpers -- sample points sit at cell centres. */
export function makeProjector(geo) {
  return {
    lat: (row) => geo.lat0 + (row + 0.5) * geo.dLat,
    lon: (col) => geo.lon0 + (col + 0.5) * geo.dLon,
  };
}

/**
 * Marching squares on a binary "inside" test.
 * Returns rings in fractional grid coordinates {r, c}, oriented so that the
 * inside of the shape is on the left, which makes outer rings and holes wind
 * in opposite directions.
 */
export function traceRings(minutes, rows, cols, threshold) {
  const inside = (r, c) => {
    if (r < 0 || r >= rows || c < 0 || c >= cols) return false;
    return minutes[r * cols + c] <= threshold;
  };

  // Each segment runs between edge midpoints of the square whose corners are
  // the four sample points (r,c), (r,c+1), (r+1,c), (r+1,c+1).
  const segStart = new Map();
  const key = (p) => p.r.toFixed(1) + ',' + p.c.toFixed(1);

  const addSegment = (a, b) => {
    const k = key(a);
    let list = segStart.get(k);
    if (!list) {
      list = [];
      segStart.set(k, list);
    }
    list.push({ a, b });
  };

  for (let r = -1; r < rows; r++) {
    for (let c = -1; c < cols; c++) {
      const bl = inside(r, c);
      const br = inside(r, c + 1);
      const tl = inside(r + 1, c);
      const tr = inside(r + 1, c + 1);

      const code = (bl ? 1 : 0) | (br ? 2 : 0) | (tr ? 4 : 0) | (tl ? 8 : 0);
      if (code === 0 || code === 15) continue;

      // Edge midpoints.
      const bottom = { r: r + 0.0, c: c + 0.5 };
      const right = { r: r + 0.5, c: c + 1.0 };
      const top = { r: r + 1.0, c: c + 0.5 };
      const left = { r: r + 0.5, c: c + 0.0 };

      switch (code) {
        case 1: addSegment(left, bottom); break;
        case 2: addSegment(bottom, right); break;
        case 3: addSegment(left, right); break;
        case 4: addSegment(right, top); break;
        case 5: // saddle: keep the two diagonal corners connected
          addSegment(left, top);
          addSegment(right, bottom);
          break;
        case 6: addSegment(bottom, top); break;
        case 7: addSegment(left, top); break;
        case 8: addSegment(top, left); break;
        case 9: addSegment(top, bottom); break;
        case 10: // the other saddle
          addSegment(top, right);
          addSegment(bottom, left);
          break;
        case 11: addSegment(top, right); break;
        case 12: addSegment(right, left); break;
        case 13: addSegment(right, bottom); break;
        case 14: addSegment(bottom, left); break;
      }
    }
  }

  // Stitch segments head-to-tail into closed rings.
  const rings = [];
  for (const [, list] of segStart) {
    for (const seg of list) {
      if (seg.used) continue;
      const ring = [seg.a];
      let current = seg;
      current.used = true;

      for (let guard = 0; guard < 4 * rows * cols; guard++) {
        ring.push(current.b);
        const nextList = segStart.get(key(current.b));
        if (!nextList) break;
        const next = nextList.find((s) => !s.used);
        if (!next) break;
        next.used = true;
        current = next;
        if (key(current.b) === key(ring[0])) {
          ring.push(current.b);
          break;
        }
      }

      if (ring.length > 3) rings.push(ring);
    }
  }

  return rings;
}

/** Signed area of a [lat, lon] ring; positive means counter-clockwise. */
function signedArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[i][1] - ring[j][1]) * (ring[i][0] + ring[j][0]);
  }
  return -sum / 2;
}

/** Ray casting on a [lat, lon] ring. */
function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [aLat, aLon] = ring[i];
    const [bLat, bLon] = ring[j];
    if (
      aLat > pt[0] !== bLat > pt[0] &&
      pt[1] < ((bLon - aLon) * (pt[0] - aLat)) / (bLat - aLat) + aLon
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function ensureWinding(ring, wantCounterClockwise) {
  const ccw = signedArea(ring) > 0;
  return ccw === wantCounterClockwise ? ring : ring.slice().reverse();
}

/** Ramer-Douglas-Peucker on [lat, lon] pairs, tolerance in degrees of latitude. */
function simplifyLatLng(points, tolerance, lonScale) {
  if (points.length < 3) return points.slice();

  const sqTol = tolerance * tolerance;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxSq = 0;
    let index = -1;

    const ax = points[first][1] * lonScale;
    const ay = points[first][0];
    const bx = points[last][1] * lonScale;
    const by = points[last][0];
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;

    for (let i = first + 1; i < last; i++) {
      const px = points[i][1] * lonScale;
      const py = points[i][0];
      let t = lenSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
      t = Math.max(0, Math.min(1, t));
      const cx = ax + t * dx;
      const cy = ay + t * dy;
      const sq = (px - cx) * (px - cx) + (py - cy) * (py - cy);
      if (sq > maxSq) {
        maxSq = sq;
        index = i;
      }
    }

    if (maxSq > sqTol && index > 0) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  const out = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/** Approximate area of a lat/lng ring in square kilometres. */
export function ringAreaKm2(ring) {
  if (ring.length < 3) return 0;
  const latMean = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const kx = 111.32 * Math.cos((latMean * Math.PI) / 180);
  const ky = 110.57;
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][1] * kx) * (ring[i][0] * ky) - (ring[i][1] * kx) * (ring[j][0] * ky);
  }
  return Math.abs(sum / 2);
}

/**
 * Build simplified lat/lng polygons for one threshold.
 * Returns [{ outer: [[lat,lon],...], holes: [[[lat,lon],...]], areaKm2 }]
 * sorted largest first.
 */
export function isochronePolygons(minutes, geo, threshold, options = {}) {
  const { rows, cols } = geo;
  const minAreaKm2 = options.minAreaKm2 ?? 0.05;
  const toleranceCells = options.toleranceCells ?? 0.9;

  const project = makeProjector(geo);
  const rings = traceRings(minutes, rows, cols, threshold);
  if (!rings.length) return [];

  const lonScale = Math.cos((geo.lat0 * Math.PI) / 180);
  const tolerance = toleranceCells * geo.dLat;

  const candidates = [];
  for (const ring of rings) {
    const latLng = ring.map((p) => [project.lat(p.r - 0.5), project.lon(p.c - 0.5)]);
    const simplified = simplifyLatLng(latLng, tolerance, lonScale);
    if (simplified.length < 4) continue;
    const areaKm2 = ringAreaKm2(simplified);
    if (areaKm2 < minAreaKm2) continue;
    candidates.push({ ring: simplified, areaKm2 });
  }

  // Nesting depth decides what is a hole, rather than winding direction: the
  // marching-squares orientation is easy to get backwards, containment is not.
  // A ring inside an odd number of other rings is a hole.
  for (const candidate of candidates) {
    candidate.containers = candidates.filter(
      (other) => other !== candidate && pointInRing(candidate.ring[0], other.ring)
    );
    candidate.isHole = candidate.containers.length % 2 === 1;
  }

  const polygons = candidates
    .filter((c) => !c.isHole)
    .map((c) => ({
      outer: ensureWinding(c.ring, true),
      holes: [],
      areaKm2: c.areaKm2,
      source: c,
    }));

  for (const candidate of candidates) {
    if (!candidate.isHole) continue;
    // The hole belongs to the smallest solid ring that contains it.
    let best = null;
    for (const poly of polygons) {
      if (candidate.containers.includes(poly.source)) {
        if (!best || poly.areaKm2 < best.areaKm2) best = poly;
      }
    }
    if (best) best.holes.push(ensureWinding(candidate.ring, false));
  }

  polygons.sort((a, b) => b.areaKm2 - a.areaKm2);
  for (const p of polygons) delete p.source;
  return polygons;
}

/**
 * Reduce a ring to at most `maxPoints` vertices by loosening the tolerance
 * until it fits. Used for hand-drawn-boundary tools that cap vertex counts.
 */
export function limitVertices(ring, maxPoints, lat) {
  if (ring.length <= maxPoints) return ring.slice();

  const lonScale = Math.cos((lat * Math.PI) / 180);

  // Binary search for the *smallest* tolerance that fits the budget. Ratcheting
  // the tolerance upward instead overshoots badly on a shape like this one, and
  // overshooting is how a whole borough-long peninsula gets shaved off.
  let low = 0;
  let high = 0.5; // degrees; larger than the city
  let best = null;
  for (let i = 0; i < 40; i++) {
    const mid = (low + high) / 2;
    const candidate = simplifyLatLng(ring, mid, lonScale);
    if (candidate.length <= maxPoints) {
      best = candidate;
      high = mid;
    } else {
      low = mid;
    }
    if (high - low < 1e-7) break;
  }

  if (!best) {
    // Nothing fit: keep evenly spaced vertices as a last resort.
    const step = ring.length / maxPoints;
    best = [];
    for (let i = 0; i < maxPoints; i++) best.push(ring[Math.floor(i * step)]);
    best.push(best[0]);
  }

  return best;
}

/**
 * How well a simplified ring stands in for the real reachable area, measured on
 * the grid it came from: the share of reachable cells it covers, and the share
 * of its own area that was never reachable.
 */
export function boundaryFidelity(ring, minutes, geo, threshold) {
  const project = makeProjector(geo);
  let reachable = 0;
  let covered = 0;
  let inside = 0;

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const [lat, lon] of ring) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }

  for (let r = 0; r < geo.rows; r++) {
    const lat = project.lat(r);
    const rowBase = r * geo.cols;
    const latInside = lat >= minLat && lat <= maxLat;
    for (let c = 0; c < geo.cols; c++) {
      const isReachable = minutes[rowBase + c] <= threshold;
      if (isReachable) reachable++;
      if (!latInside && !isReachable) continue;
      const lon = project.lon(c);
      if (lon < minLon || lon > maxLon) continue;
      if (!pointInRing([lat, lon], ring)) continue;
      inside++;
      if (isReachable) covered++;
    }
  }

  return {
    coverage: reachable ? covered / reachable : 0,
    overspill: inside ? (inside - covered) / inside : 0,
  };
}
