/* Address lookup.
 *
 * NYC Planning's GeoSearch is the primary: it is free, needs no key, is CORS
 * friendly and knows New York addresses better than anything general purpose.
 * Nominatim is the fallback for the cases GeoSearch misses (landmark names,
 * "Google-style" queries). Everything degrades to clicking the map.
 */

'use strict';

const GEOSEARCH = 'https://geosearch.planninglabs.nyc/v2';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

const NYC_BOUNDS = { minLat: 40.47, maxLat: 40.94, minLon: -74.28, maxLon: -73.68 };

function inNYC(lat, lon) {
  return (
    lat >= NYC_BOUNDS.minLat &&
    lat <= NYC_BOUNDS.maxLat &&
    lon >= NYC_BOUNDS.minLon &&
    lon <= NYC_BOUNDS.maxLon
  );
}

async function fetchJSON(url, signal) {
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

function fromGeoSearch(json) {
  return (json.features || [])
    .filter((f) => f.geometry && f.geometry.coordinates)
    .map((f) => ({
      label: f.properties.label || f.properties.name,
      lat: f.geometry.coordinates[1],
      lon: f.geometry.coordinates[0],
      source: 'NYC GeoSearch',
    }))
    .filter((r) => inNYC(r.lat, r.lon));
}

function fromNominatim(json) {
  return (json || [])
    .map((r) => ({
      label: r.display_name,
      lat: parseFloat(r.lat),
      lon: parseFloat(r.lon),
      source: 'OpenStreetMap',
    }))
    .filter((r) => inNYC(r.lat, r.lon));
}

/** Autocomplete as the user types. Returns [] rather than throwing. */
export async function suggest(text, signal) {
  if (!text || text.trim().length < 3) return [];
  try {
    const url = `${GEOSEARCH}/autocomplete?text=${encodeURIComponent(text)}`;
    return fromGeoSearch(await fetchJSON(url, signal)).slice(0, 6);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    return [];
  }
}

/** Full search, used when the user submits. Throws with a readable message. */
export async function search(text, signal) {
  const errors = [];

  try {
    const url = `${GEOSEARCH}/search?text=${encodeURIComponent(text)}&size=5`;
    const results = fromGeoSearch(await fetchJSON(url, signal));
    if (results.length) return results;
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    errors.push(`GeoSearch: ${err.message}`);
  }

  try {
    const viewbox = `${NYC_BOUNDS.minLon},${NYC_BOUNDS.maxLat},${NYC_BOUNDS.maxLon},${NYC_BOUNDS.minLat}`;
    const url =
      `${NOMINATIM}?format=json&limit=5&countrycodes=us&bounded=1` +
      `&viewbox=${viewbox}&q=${encodeURIComponent(text)}`;
    const results = fromNominatim(await fetchJSON(url, signal));
    if (results.length) return results;
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    errors.push(`OpenStreetMap: ${err.message}`);
  }

  if (errors.length) {
    throw new Error(
      `Could not reach an address service (${errors.join('; ')}). ` +
        'You can still click the map to drop the pin.'
    );
  }
  throw new Error('No New York City match for that address. Try adding the borough, or click the map.');
}

/** Best-effort street address for a dropped pin. */
export async function reverse(lat, lon, signal) {
  try {
    const url = `${GEOSEARCH}/reverse?point.lat=${lat}&point.lon=${lon}&size=1`;
    const results = fromGeoSearch(await fetchJSON(url, signal));
    if (results.length) return results[0].label;
  } catch (err) {
    if (err.name === 'AbortError') throw err;
  }
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}
