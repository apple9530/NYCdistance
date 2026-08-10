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

/* ------------------------------------------------------- the firm directory */

let firmsPromise = null;

export function loadFirms(url = 'data/law-firms.json') {
  if (!firmsPromise) {
    firmsPromise = fetch(url)
      .then((res) => (res.ok ? res.json() : { firms: [] }))
      .then((json) =>
        (json.firms || []).map((firm) => ({
          ...firm,
          haystack: [firm.name, firm.short, ...(firm.aka || []), firm.address]
            .filter(Boolean)
            .map((s) => s.toLowerCase()),
        }))
      )
      .catch(() => []);
  }
  return firmsPromise;
}

/** Words a person is likely to type, ignoring the connective noise in firm names. */
function tokens(text) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9&']+/)
    .filter((w) => w && w !== 'and' && w !== 'the');
}

export async function searchFirms(text, limit = 6) {
  const query = text.trim().toLowerCase();
  if (query.length < 2) return [];
  const firms = await loadFirms();
  const words = tokens(query);
  if (!words.length) return [];

  const scored = [];
  for (const firm of firms) {
    let score = 0;
    for (const field of firm.haystack) {
      const fieldWords = tokens(field);
      for (const word of words) {
        // Matching the start of a name beats matching the middle of an address.
        if (field.startsWith(word)) score += 12;
        else if (fieldWords.some((fw) => fw.startsWith(word))) score += 6;
        else if (field.includes(word)) score += 2;
      }
    }
    if (!score) continue;
    // A short, exact-ish nickname ("Cleary") should outrank a long partial match.
    if (firm.short.toLowerCase() === query || firm.name.toLowerCase() === query) score += 40;
    scored.push({
      label: firm.name,
      detail: firm.address,
      lat: firm.lat,
      lon: firm.lon,
      address: firm.address,
      kind: 'firm',
      source: 'Law firm office',
      score,
    });
  }

  scored.sort((a, b) => b.score - a.score || a.label.length - b.label.length);
  return scored.slice(0, limit);
}

/* ---------------------------------------------------------------- addresses */

/** Autocomplete as the user types: firms first, then matching addresses. */
export async function suggest(text, signal) {
  const query = (text || '').trim();
  if (query.length < 2) return [];

  const firms = await searchFirms(query, 6);

  let addresses = [];
  if (query.length >= 3) {
    try {
      const url = `${GEOSEARCH}/autocomplete?text=${encodeURIComponent(query)}`;
      addresses = fromGeoSearch(await fetchJSON(url, signal)).map((r) => ({
        ...r,
        detail: '',
        kind: 'address',
      }));
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      addresses = [];
    }
  }

  // Keep room for addresses even when the firm list is eager to fill the panel.
  return [...firms.slice(0, addresses.length ? 5 : 8), ...addresses].slice(0, 9);
}

/**
 * Sharpen a firm's stored coordinates by geocoding its address. The directory
 * is hand-maintained, so the address string is the thing worth trusting; the
 * stored point is only there for when the geocoder cannot be reached.
 */
export async function resolveFirm(firm, signal) {
  try {
    const url = `${GEOSEARCH}/search?text=${encodeURIComponent(firm.address)}&size=1`;
    const results = fromGeoSearch(await fetchJSON(url, signal));
    if (results.length) {
      return { lat: results[0].lat, lon: results[0].lon, precise: true };
    }
  } catch (err) {
    if (err.name === 'AbortError') throw err;
  }
  return { lat: firm.lat, lon: firm.lon, precise: false };
}

/** Full search, used when the user submits. Throws with a readable message. */
export async function search(text, signal) {
  const errors = [];

  const firms = await searchFirms(text, 5);
  if (firms.length) return firms;

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
