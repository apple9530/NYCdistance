/* Contour tests: node web/tests/contour.test.mjs
 *
 * Ring nesting is the part that is easy to get quietly wrong -- a flipped
 * winding turns the city-sized isochrone into a hole and exports a park.
 */

import { isochronePolygons, ringAreaKm2, limitVertices } from '../js/contour.js';

const geo = { lat0: 40.5, lon0: -74.0, dLat: 0.001, dLon: 0.001, rows: 60, cols: 60 };

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`ok    ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail ? ' -- ' + detail : ''}`);
  }
}

/** Build a grid where `fn(r, c)` decides whether a cell is reachable. */
function grid(fn) {
  const out = new Uint8Array(geo.rows * geo.cols).fill(255);
  for (let r = 0; r < geo.rows; r++) {
    for (let c = 0; c < geo.cols; c++) {
      if (fn(r, c)) out[r * geo.cols + c] = 10;
    }
  }
  return out;
}

const inBox = (r, c, r0, r1, c0, c1) => r >= r0 && r <= r1 && c >= c0 && c <= c1;
const opts = { minAreaKm2: 0.0001, toleranceCells: 0.4 };

/* 1. One solid block. */
{
  const polys = isochronePolygons(grid((r, c) => inBox(r, c, 10, 40, 10, 40)), geo, 20, opts);
  check('solid block yields one polygon', polys.length === 1, `got ${polys.length}`);
  check('solid block has no holes', polys[0]?.holes.length === 0);
  // 31 x 31 cells, ~111 m per 0.001 deg lat and ~84 m per 0.001 deg lon here.
  const area = polys[0]?.areaKm2 ?? 0;
  check('solid block area is about 9 km2', area > 7 && area < 12, `got ${area.toFixed(2)}`);
}

/* 2. Block with a hole punched out. */
{
  const polys = isochronePolygons(
    grid((r, c) => inBox(r, c, 10, 40, 10, 40) && !inBox(r, c, 20, 30, 20, 30)),
    geo,
    20,
    opts
  );
  check('holed block yields one polygon', polys.length === 1, `got ${polys.length}`);
  check('holed block records the hole', polys[0]?.holes.length === 1, `got ${polys[0]?.holes.length}`);
  const outerArea = polys[0]?.areaKm2 ?? 0;
  const holeArea = polys[0]?.holes[0] ? ringAreaKm2(polys[0].holes[0]) : 0;
  check('hole is smaller than the block', holeArea > 0 && holeArea < outerArea);
}

/* 3. Two separate blobs. */
{
  const polys = isochronePolygons(
    grid((r, c) => inBox(r, c, 5, 15, 5, 15) || inBox(r, c, 35, 50, 35, 50)),
    geo,
    20,
    opts
  );
  check('two blobs yield two polygons', polys.length === 2, `got ${polys.length}`);
  check('polygons are sorted largest first', (polys[0]?.areaKm2 ?? 0) >= (polys[1]?.areaKm2 ?? 0));
}

/* 4. An island inside a hole is solid ground again, not a hole. */
{
  const polys = isochronePolygons(
    grid(
      (r, c) =>
        (inBox(r, c, 5, 50, 5, 50) && !inBox(r, c, 15, 40, 15, 40)) || inBox(r, c, 25, 32, 25, 32)
    ),
    geo,
    20,
    opts
  );
  check('island inside a hole is its own polygon', polys.length === 2, `got ${polys.length}`);
  check('the ring-shaped polygon keeps its hole', polys[0]?.holes.length === 1);
  check('the island has no hole', polys[1]?.holes.length === 0);
}

/* 5. Nothing reachable. */
{
  const polys = isochronePolygons(grid(() => false), geo, 20, opts);
  check('an empty grid yields no polygons', polys.length === 0, `got ${polys.length}`);
}

/* 6. GeoJSON winding: exterior counter-clockwise, holes clockwise. */
{
  const polys = isochronePolygons(
    grid((r, c) => inBox(r, c, 10, 40, 10, 40) && !inBox(r, c, 20, 30, 20, 30)),
    geo,
    20,
    opts
  );
  const signed = (ring) => {
    let sum = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      sum += (ring[i][1] - ring[j][1]) * (ring[i][0] + ring[j][0]);
    }
    return -sum / 2;
  };
  check('exterior ring winds counter-clockwise', signed(polys[0].outer) > 0);
  check('hole ring winds clockwise', signed(polys[0].holes[0]) < 0);
}

/* 7. Vertex reduction for hand-traced boundaries. */
{
  const polys = isochronePolygons(grid((r, c) => (r - 25) ** 2 + (c - 25) ** 2 < 400), geo, 20, opts);
  const ring = polys[0].outer;
  const reduced = limitVertices(ring, 20, 40.5);
  check('vertex limit is respected', reduced.length <= 21, `got ${reduced.length}`);
  check('reduced ring still closes', reduced.length > 3);
  const shrink = ringAreaKm2(reduced) / ringAreaKm2(ring);
  check('reduced ring keeps most of the area', shrink > 0.75 && shrink < 1.25, `ratio ${shrink.toFixed(2)}`);
}

console.log();
if (failures) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('all contour checks passed');
