/* Getting the isochrone out of the app and into something else.
 *
 * GeoJSON and KML are the portable formats. The StreetEasy helper exists
 * because their "draw your own boundary" tool is mouse-only: the best we can do
 * is hand over a boundary simplified down to a traceable number of vertices,
 * plus the coordinate list, plus a URL built from a template you can correct if
 * their format ever differs from the one assumed here.
 */

'use strict';

import { limitVertices } from './contour.js';

/** StreetEasy's drawn areas are a single simple polygon -- no holes, no islands. */
export const STREETEASY_MAX_POINTS = 40;

export function toGeoJSON(polygons, meta) {
  return {
    type: 'FeatureCollection',
    properties: meta,
    features: polygons.map((poly, i) => ({
      type: 'Feature',
      properties: {
        name: `${meta.minutes} min from ${meta.address}`,
        minutes: meta.minutes,
        mode: meta.mode,
        window: meta.window,
        area_km2: Number(poly.areaKm2.toFixed(3)),
        part: i + 1,
        parts: polygons.length,
      },
      geometry: {
        type: 'Polygon',
        // GeoJSON is [lon, lat] and wants the exterior ring first.
        coordinates: [ringToLonLat(poly.outer), ...poly.holes.map(ringToLonLat)],
      },
    })),
  };
}

function ringToLonLat(ring) {
  const out = ring.map(([lat, lon]) => [round6(lon), round6(lat)]);
  const first = out[0];
  const last = out[out.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) out.push([first[0], first[1]]);
  return out;
}

function round6(v) {
  return Number(v.toFixed(6));
}

export function toKML(polygons, meta) {
  const esc = (s) =>
    String(s).replace(/[<>&'"]/g, (ch) => `&#${ch.charCodeAt(0)};`);

  const ring = (points) =>
    points.map(([lat, lon]) => `${round6(lon)},${round6(lat)},0`).join(' ');

  const placemarks = polygons
    .map(
      (poly, i) => `    <Placemark>
      <name>${esc(meta.minutes)} min${polygons.length > 1 ? ` (part ${i + 1})` : ''}</name>
      <styleUrl>#isochrone</styleUrl>
      <Polygon>
        <outerBoundaryIs><LinearRing><coordinates>${ring(poly.outer)}</coordinates></LinearRing></outerBoundaryIs>
${poly.holes
  .map(
    (h) =>
      `        <innerBoundaryIs><LinearRing><coordinates>${ring(h)}</coordinates></LinearRing></innerBoundaryIs>`
  )
  .join('\n')}
      </Polygon>
    </Placemark>`
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${esc(meta.minutes)} minutes from ${esc(meta.address)}</name>
    <description>${esc(meta.description)}</description>
    <Style id="isochrone">
      <LineStyle><color>ff6b7825</color><width>2</width></LineStyle>
      <PolyStyle><color>4dd68a2a</color></PolyStyle>
    </Style>
${placemarks}
  </Document>
</kml>
`;
}

/** "lat, lon" per line -- the format most drawing tools accept as a paste. */
export function toCoordinateList(ring) {
  return ring.map(([lat, lon]) => `${lat.toFixed(6)}, ${lon.toFixed(6)}`).join('\n');
}

/**
 * One traceable boundary: a single polygon with its holes dropped and its
 * vertex count cut to something a person can realistically click around a map.
 *
 * A commute shed is usually several disconnected pieces -- without bridges in
 * the walking model, Manhattan and Brooklyn are separate landmasses -- so the
 * caller picks which piece to trace rather than being handed only the biggest.
 */
export function simplifiedBoundary(polygons, maxPoints = STREETEASY_MAX_POINTS, index = 0) {
  const polygon = polygons[index];
  if (!polygon) return null;
  const lat = polygon.outer[0][0];
  return {
    ring: limitVertices(polygon.outer, maxPoints, lat),
    areaKm2: polygon.areaKm2,
    index,
    otherParts: polygons.length - 1,
    droppedHoles: polygon.holes.length,
  };
}

/** Pieces big enough to be worth drawing by hand, largest first. */
export function traceablePieces(polygons, minAreaKm2 = 1) {
  return polygons
    .map((poly, index) => ({ index, areaKm2: poly.areaKm2 }))
    .filter((p) => p.areaKm2 >= minAreaKm2);
}

export const DEFAULT_STREETEASY_TEMPLATE =
  'https://streeteasy.com/for-rent/nyc/polygon:{polygon}';

/**
 * Build a StreetEasy URL from a template.
 * {polygon} -> "lat,lon|lat,lon|..." (URL-encoded)
 * {polygon_lonlat} -> the same with the pair order flipped
 */
export function streetEasyURL(ring, template = DEFAULT_STREETEASY_TEMPLATE) {
  const latLon = ring.map(([lat, lon]) => `${lat.toFixed(5)},${lon.toFixed(5)}`).join('|');
  const lonLat = ring.map(([lat, lon]) => `${lon.toFixed(5)},${lat.toFixed(5)}`).join('|');
  return template
    .replace('{polygon}', encodeURIComponent(latLon))
    .replace('{polygon_lonlat}', encodeURIComponent(lonLat));
}

export function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  // http://localhost has no clipboard API in some browsers.
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  return ok;
}
