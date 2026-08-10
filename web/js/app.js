/* Wiring: controls -> worker -> map. */

'use strict';

import { createHeatLayer } from './heatlayer.js';
import { boundaryFidelity, isochronePolygons } from './contour.js';
import * as geocode from './geocode.js';
import {
  DEFAULT_STREETEASY_TEMPLATE,
  copyText,
  download,
  simplifiedBoundary,
  streetEasyURL,
  traceablePieces,
  toCoordinateList,
  toGeoJSON,
  toKML,
} from './export.js';

const BAND_COUNT = 6;
const DEFAULT_CENTER = [40.7305, -73.9782];

const el = (id) => document.getElementById(id);

const dom = {
  address: el('address'),
  suggestions: el('suggestions'),
  budget: el('budget'),
  budgetValue: el('budget-value'),
  window: el('window'),
  windowField: el('window-field'),
  maxWalk: el('max-walk'),
  maxWalkValue: el('max-walk-value'),
  walkSpeed: el('walk-speed'),
  walkSpeedValue: el('walk-speed-value'),
  detour: el('detour'),
  detourValue: el('detour-value'),
  legend: el('legend'),
  legendScale: el('legend-scale'),
  stats: el('stats'),
  status: el('status'),
  readout: el('readout'),
  exportField: el('export-field'),
  feedNote: el('feed-note'),
  panel: el('panel'),
  panelToggle: el('panel-toggle'),
  sePoints: el('se-points'),
  seTemplate: el('se-template'),
  seDetail: el('se-detail'),
  sePiece: el('se-piece'),
  seFidelity: el('se-fidelity'),
  seLink: el('se-link'),
  pinHint: el('pin-hint'),
  dropPin: el('drop-pin'),
  basemap: el('basemap'),
  showSubway: el('show-subway'),
  subwayKey: el('subway-key'),
};

const state = {
  mode: 'transit',
  budget: 45,
  window: 'am_rush',
  maxWalk: 15,
  walkKph: 4.8,
  detour: 1.25,
  boundaryPoints: 60,
  boundaryPiece: 0,
  lat: null,
  lon: null,
  label: '',
  info: null,
  result: null,
  fitPending: false,
  polygons: null,
  boundary: null,
  solveToken: 0,
};

/* ------------------------------------------------------------------- map */

const map = L.map('map', {
  center: DEFAULT_CENTER,
  zoom: 12,
  zoomControl: true,
  preferCanvas: true,
});

map.createPane('contours');
map.getPane('contours').style.zIndex = 450;
map.getPane('contours').style.pointerEvents = 'none';
map.createPane('subway');
map.getPane('subway').style.zIndex = 455;
map.createPane('labels');
map.getPane('labels').style.zIndex = 460;
map.getPane('labels').style.pointerEvents = 'none';

const CARTO_ATTRIB =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, ' +
  '&copy; <a href="https://carto.com/attributions">CARTO</a> | transit data &copy; MTA';

const ESRI_ATTRIB =
  'Imagery &copy; Esri, Maxar, Earthstar Geographics | transit data &copy; MTA';

/* Voyager is the default because it is the closest free basemap to the Google
   look: coloured road classes, parks, water and POI names, rather than the
   near-blank canvas of Positron. (Google's own tiles are not an option here --
   the Maps JavaScript API needs a billable key, and their terms do not allow
   pulling raw tiles into another map library.) */
const BASEMAPS = {
  streets: {
    label: 'Streets',
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png',
    labels: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png',
    attribution: CARTO_ATTRIB,
    subdomains: 'abcd',
  },
  light: {
    label: 'Minimal',
    url: 'https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png',
    labels: 'https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png',
    attribution: CARTO_ATTRIB,
    subdomains: 'abcd',
  },
  dark: {
    label: 'Dark',
    url: 'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png',
    labels: 'https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png',
    attribution: CARTO_ATTRIB,
    subdomains: 'abcd',
  },
  satellite: {
    label: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    labels: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png',
    attribution: ESRI_ATTRIB,
    subdomains: 'abcd',
  },
};

let baseLayer = null;
let labelLayer = null;

function applyBasemap(key) {
  const spec = BASEMAPS[key] || BASEMAPS.streets;
  if (baseLayer) map.removeLayer(baseLayer);
  if (labelLayer) map.removeLayer(labelLayer);

  baseLayer = L.tileLayer(spec.url, {
    attribution: spec.attribution,
    subdomains: spec.subdomains,
    maxZoom: 19,
  }).addTo(map);

  // Street names sit above the heat raster, which matters when you are trying
  // to trace the boundary onto someone else's map.
  labelLayer = L.tileLayer(spec.labels, {
    subdomains: spec.subdomains,
    maxZoom: 19,
    pane: 'labels',
  }).addTo(map);
}

// Handy for debugging from the console.
window.__map = map;

const initialBasemap = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'streets';
dom.basemap.value = initialBasemap;
applyBasemap(initialBasemap);

const HeatLayer = createHeatLayer(L);
const heat = new HeatLayer({ opacity: 1 });
heat.addTo(map);

const contourGroup = L.layerGroup([], { pane: 'contours' }).addTo(map);
const stationGroup = L.layerGroup().addTo(map);
const subwayGroup = L.layerGroup([], { pane: 'subway' });

let subwayLoaded = null;

/** Draw the subway in the MTA's own route colours, above the heat raster. */
async function loadSubwayLines() {
  if (subwayLoaded) return subwayLoaded;
  subwayLoaded = fetch('data/subway-lines.json')
    .then((res) => {
      if (!res.ok) throw new Error(`subway-lines.json (${res.status})`);
      return res.json();
    })
    .then((geojson) => {
      const seen = new Map();
      for (const feature of geojson.features) {
        const { route, color, long_name: longName } = feature.properties;
        const latLngs = feature.geometry.coordinates.map(([lon, lat]) => [lat, lon]);

        // A dark casing under the colour keeps every line legible over both the
        // pale end of the heat ramp and a satellite basemap.
        L.polyline(latLngs, {
          pane: 'subway',
          color: 'rgba(0,0,0,0.45)',
          weight: 5,
          opacity: 0.5,
          interactive: false,
        }).addTo(subwayGroup);

        L.polyline(latLngs, {
          pane: 'subway',
          color,
          weight: 2.5,
          opacity: 0.95,
        })
          .bindTooltip(`${route} — ${longName}`, { sticky: true })
          .addTo(subwayGroup);

        // Express variants (6X, 7X, FX) share their parent's colour, so they
        // ride along on the map but would only clutter the key.
        if (!seen.has(route) && !/^[0-9A-Z]X$/.test(route)) seen.set(route, color);
      }
      renderSubwayKey([...seen.entries()]);
      return true;
    })
    .catch((err) => {
      setStatus(`Could not load the subway map: ${err.message}`, true);
      subwayLoaded = null;
      return false;
    });
  return subwayLoaded;
}

function renderSubwayKey(entries) {
  dom.subwayKey.innerHTML = '';
  entries.sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  for (const [route, color] of entries) {
    const bullet = document.createElement('span');
    bullet.className = 'route-bullet';
    bullet.style.background = color;
    bullet.textContent = route;
    dom.subwayKey.append(bullet);
  }
}

const officeIcon = L.divIcon({
  className: 'office-pin',
  html:
    '<svg width="28" height="36" viewBox="0 0 28 36" aria-hidden="true">' +
    '<path d="M14 0C6.8 0 1 5.8 1 13c0 9.4 11.2 21.5 12 22.4.5.6 1.4.6 2 0C15.8 34.5 27 22.4 27 13 27 5.8 21.2 0 14 0z" ' +
    'fill="#d03b3b" stroke="#fcfcfb" stroke-width="2"/>' +
    '<circle cx="14" cy="13" r="4.5" fill="#fcfcfb"/></svg>',
  iconSize: [28, 36],
  iconAnchor: [14, 36],
});

const officeMarker = L.marker(DEFAULT_CENTER, {
  icon: officeIcon,
  draggable: true,
  keyboard: true,
  title: 'Drag to move the office',
});

officeMarker.on('dragend', async () => {
  const p = officeMarker.getLatLng();
  await setOrigin(p.lat, p.lng, null);
});

// Clicking the map used to move the office, which made every attempt to pan or
// inspect the heatmap a re-solve. Now the pin only moves when you drag it, or
// when you deliberately arm the drop-pin button for a single placement.
let pinArmed = false;

function setPinArmed(armed) {
  pinArmed = armed;
  dom.dropPin.classList.toggle('is-on', armed);
  dom.dropPin.setAttribute('aria-pressed', String(armed));
  dom.dropPin.textContent = armed ? 'Click the map…' : 'Move pin by clicking';
  document.getElementById('map').classList.toggle('is-picking', armed);
}

map.on('click', async (ev) => {
  if (!pinArmed) return;
  setPinArmed(false);
  await setOrigin(ev.latlng.lat, ev.latlng.lng, null);
});

map.on('keydown', (ev) => {
  if (ev.originalEvent.key === 'Escape' && pinArmed) setPinArmed(false);
});

/* ---------------------------------------------------------------- colours */

function readVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

let ramp = [];

function refreshRamp() {
  ramp = ['--t1', '--t2', '--t3', '--t4', '--t5', '--t6'].map((n) => hexToRgb(readVar(n)));
}

refreshRamp();

function rampColor(t) {
  const clamped = Math.max(0, Math.min(1, t));
  const scaled = clamped * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(scaled));
  const f = scaled - i;
  const a = ramp[i];
  const b = ramp[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

function rampCss(t) {
  const [r, g, b] = rampColor(t);
  return `rgb(${r} ${g} ${b})`;
}

function makeColorFor(budget) {
  return (minutes) => {
    if (minutes === 255 || minutes > budget) return [0, 0, 0, 0];
    const t = budget > 0 ? minutes / budget : 0;
    const [r, g, b] = rampColor(t);
    // Soften the last sliver so the edge reads as a fade, not a cliff; the
    // contour line is what marks the boundary precisely.
    const alpha = t > 0.93 ? 210 - (t - 0.93) * 700 : 210;
    return [r, g, b, Math.max(120, Math.round(alpha))];
  };
}

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  refreshRamp();
  if (state.result) render();
});

/* ---------------------------------------------------------------- worker */

const worker = new Worker('js/worker.js');
const pending = new Map();
let nextId = 1;

worker.onmessage = (ev) => {
  const { type, id, info, result, message } = ev.data;
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  if (type === 'error') entry.reject(new Error(message));
  else entry.resolve(type === 'ready' ? info : result);
};

worker.onerror = (err) => {
  setStatus(`The routing engine failed to start: ${err.message}`, true);
};

function ask(type, payload) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ type, id, ...payload });
  });
}

/* ------------------------------------------------------------------- ui */

function setStatus(text, isError = false) {
  dom.status.textContent = text;
  dom.status.classList.toggle('status--error', isError);
}

function formatMinutes(mins) {
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

function bandThresholds(budget) {
  const out = [];
  for (let i = 1; i <= BAND_COUNT; i++) out.push(Math.round((budget * i) / BAND_COUNT));
  return out;
}

function renderLegend(budget) {
  const bounds = bandThresholds(budget);
  dom.legendScale.innerHTML = '';
  let previous = 0;
  bounds.forEach((upper, i) => {
    const li = document.createElement('li');
    const swatch = document.createElement('span');
    swatch.className = 'legend__swatch';
    swatch.style.background = rampCss(i / (BAND_COUNT - 1));
    const label = document.createElement('span');
    label.textContent = `${previous}–${upper} min`;
    li.append(swatch, label);
    dom.legendScale.append(li);
    previous = upper;
  });
  dom.legend.hidden = false;
}

function renderStats(result) {
  const { stats } = result;
  const cityArea = 778; // km2 of land in the five boroughs
  const rows = [
    ['Area you could live in', `${stats.areaKm2.toFixed(1)} km²`],
    ['Share of the city', `${((100 * stats.areaKm2) / cityArea).toFixed(1)}%`],
  ];
  if (state.mode === 'transit') {
    rows.push(['Subway stations in range', String(stats.stationsInRange)]);
    rows.push(['On foot alone', `${stats.walkOnlyAreaKm2.toFixed(1)} km²`]);
  }
  rows.push(['Computed in', `${stats.elapsedMs} ms`]);

  dom.stats.innerHTML = '';
  for (const [term, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dom.stats.append(dt, dd);
  }
}

/* --------------------------------------------------------------- solving */

let solveTimer = null;

function scheduleSolve(delay = 120) {
  clearTimeout(solveTimer);
  solveTimer = setTimeout(solve, delay);
}

async function solve() {
  if (state.lat == null || !state.info) return;
  const token = ++state.solveToken;
  setStatus('Computing…');

  try {
    const result = await ask('solve', {
      request: {
        lat: state.lat,
        lon: state.lon,
        mode: state.mode,
        window: state.window,
        budgetMinutes: state.budget,
        maxWalkMinutes: state.maxWalk,
        walkKph: state.walkKph,
        detour: state.detour,
      },
    });
    if (token !== state.solveToken) return; // a newer request already won
    state.result = result;
    render();
    setStatus(
      `${formatMinutes(state.budget)} from ${state.label || 'the pin'} — ` +
        `${result.stats.areaKm2.toFixed(1)} km² of the city.`
    );
  } catch (err) {
    if (token === state.solveToken) setStatus(err.message, true);
  }
}

function gridGeo() {
  return {
    lat0: state.info.lat0,
    lon0: state.info.lon0,
    dLat: state.info.dLat,
    dLon: state.info.dLon,
    rows: state.info.rows,
    cols: state.info.cols,
  };
}

function render() {
  const result = state.result;
  if (!result) return;

  heat.setData(result.minutes, gridGeo(), makeColorFor(state.budget));
  renderLegend(state.budget);
  renderStats(result);
  dom.exportField.hidden = false;

  // Contours are decoration plus the export geometry, so draw them after the
  // raster has already hit the screen.
  requestAnimationFrame(() => drawContours());
  updateStations();
  updateHash();
}

function drawContours() {
  const result = state.result;
  if (!result) return;
  contourGroup.clearLayers();

  const geo = gridGeo();
  const thresholds = bandThresholds(state.budget);

  thresholds.forEach((minutes, i) => {
    const isEdge = i === thresholds.length - 1;
    // Simplifying hard enough to smooth a band line also lets it cut the corner
    // across a river, so inner bands are drawn tight and only when substantial.
    const polygons = isochronePolygons(result.minutes, geo, minutes, {
      minAreaKm2: isEdge ? 0.04 : 1.0,
      toleranceCells: isEdge ? 0.7 : 0.6,
    });

    if (isEdge) {
      state.polygons = polygons;
      rebuildBoundary();
      // Frame the whole shed the first time a new office is set, but never
      // afterwards -- yanking the view on every slider nudge is maddening.
      if (state.fitPending && polygons.length) {
        state.fitPending = false;
        const bounds = polygons.reduce(
          (acc, p) => acc.extend(L.polygon(p.outer).getBounds()),
          L.latLngBounds(polygons[0].outer)
        );
        map.fitBounds(bounds, { padding: [24, 24], maxZoom: 14 });
      }
    }

    for (const poly of polygons) {
      L.polygon([poly.outer, ...poly.holes], {
        pane: 'contours',
        fill: false,
        color: isEdge ? readVar('--contour-edge') : readVar('--contour'),
        weight: isEdge ? 2 : 1,
        opacity: isEdge ? 0.95 : 0.7,
        interactive: false,
      }).addTo(contourGroup);
    }
  });
}

const STATION_MIN_ZOOM = 13;

function updateStations() {
  stationGroup.clearLayers();
  if (state.mode !== 'transit' || !state.result) return;
  // At city-wide zoom 470 dots read as noise on top of the raster, so they only
  // appear once the map is close enough for them to mean something.
  if (map.getZoom() < STATION_MIN_ZOOM) return;

  const stations = state.info.stations;
  const minutes = state.result.stationMinutes;
  if (!minutes) return;

  for (let i = 0; i < stations.length; i++) {
    const m = minutes[i];
    if (m === 255) continue;
    const s = stations[i];
    L.circleMarker([s.lat, s.lon], {
      radius: 4,
      color: readVar('--surface-1'),
      weight: 1.5,
      fillColor: rampCss(m / state.budget),
      fillOpacity: 1,
    })
      .bindTooltip(
        `<span class="station-tip">${s.name}<em>${s.routes.join(' ')} · ${m} min to the office</em></span>`,
        { direction: 'top' }
      )
      .addTo(stationGroup);
  }
}

/* -------------------------------------------------------------- hover */

map.on('mousemove', (ev) => {
  const result = state.result;
  if (!result) {
    dom.readout.hidden = true;
    return;
  }
  const geo = gridGeo();
  const r = Math.floor((ev.latlng.lat - geo.lat0) / geo.dLat);
  const c = Math.floor((ev.latlng.lng - geo.lon0) / geo.dLon);
  if (r < 0 || r >= geo.rows || c < 0 || c >= geo.cols) {
    dom.readout.hidden = true;
    return;
  }

  const idx = r * geo.cols + c;
  const m = result.minutes[idx];
  if (m === 255) {
    dom.readout.hidden = false;
    dom.readout.innerHTML =
      `<strong>Beyond ${state.budget} min</strong><span>too far, or not walkable ground</span>`;
    return;
  }

  const via = result.via[idx];
  const detail =
    via >= 0 && state.info.stations[via]
      ? `via ${state.info.stations[via].name}`
      : 'walking the whole way';
  dom.readout.hidden = false;
  dom.readout.innerHTML = `<strong>${formatMinutes(m)}</strong><span>${detail}</span>`;
});

map.on('mouseout', () => {
  dom.readout.hidden = true;
});

map.on('zoomend', () => updateStations());

/* --------------------------------------------------------------- origin */

async function setOrigin(lat, lon, label) {
  const moved = state.lat !== lat || state.lon !== lon;
  state.lat = lat;
  state.lon = lon;
  if (moved) state.fitPending = true;
  officeMarker.setLatLng([lat, lon]);
  if (!map.hasLayer(officeMarker)) officeMarker.addTo(map);

  if (label) {
    state.label = label;
    dom.address.value = label;
  } else {
    state.label = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    dom.address.value = state.label;
    geocode
      .reverse(lat, lon)
      .then((name) => {
        if (state.lat === lat && state.lon === lon) {
          state.label = name;
          dom.address.value = name;
        }
      })
      .catch(() => {});
  }

  scheduleSolve(0);
}

/* ------------------------------------------------------------- controls */

document.querySelectorAll('.segmented button').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.segmented button').forEach((b) => {
      const on = b === button;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', String(on));
    });
    state.mode = button.dataset.mode;
    dom.windowField.hidden = state.mode !== 'transit';
    scheduleSolve(0);
  });
});

dom.budget.addEventListener('input', () => {
  state.budget = Number(dom.budget.value);
  dom.budgetValue.textContent = formatMinutes(state.budget);
  scheduleSolve();
});

dom.window.addEventListener('change', () => {
  state.window = dom.window.value;
  scheduleSolve(0);
});

dom.maxWalk.addEventListener('input', () => {
  state.maxWalk = Number(dom.maxWalk.value);
  dom.maxWalkValue.textContent = `${state.maxWalk} min`;
  scheduleSolve();
});

dom.walkSpeed.addEventListener('input', () => {
  state.walkKph = Number(dom.walkSpeed.value);
  dom.walkSpeedValue.textContent = `${state.walkKph.toFixed(1)} km/h`;
  scheduleSolve();
});

dom.detour.addEventListener('input', () => {
  state.detour = Number(dom.detour.value);
  dom.detourValue.textContent = `${state.detour.toFixed(2)}×`;
  scheduleSolve();
});

dom.dropPin.addEventListener('click', () => setPinArmed(!pinArmed));

dom.basemap.addEventListener('change', () => {
  applyBasemap(dom.basemap.value);
});

dom.showSubway.addEventListener('change', async () => {
  if (dom.showSubway.checked) {
    const ok = await loadSubwayLines();
    if (!ok) {
      dom.showSubway.checked = false;
      return;
    }
    subwayGroup.addTo(map);
    dom.subwayKey.hidden = false;
  } else {
    map.removeLayer(subwayGroup);
    dom.subwayKey.hidden = true;
  }
});

dom.panelToggle?.addEventListener('click', () => {
  const hidden = dom.panel.hasAttribute('hidden');
  if (hidden) dom.panel.removeAttribute('hidden');
  else dom.panel.setAttribute('hidden', '');
  dom.panelToggle.setAttribute('aria-expanded', String(hidden));
});

/* ------------------------------------------------------- address search */

let suggestAbort = null;
let suggestTimer = null;
let activeSuggestion = -1;
let suggestions = [];

function closeSuggestions() {
  dom.suggestions.hidden = true;
  dom.suggestions.innerHTML = '';
  dom.address.setAttribute('aria-expanded', 'false');
  dom.address.removeAttribute('aria-activedescendant');
  activeSuggestion = -1;
  suggestions = [];
}

function highlightSuggestion(index) {
  const items = [...dom.suggestions.children];
  if (!items.length) return;
  activeSuggestion = (index + items.length) % items.length;
  items.forEach((li, i) => {
    const on = i === activeSuggestion;
    li.setAttribute('aria-selected', String(on));
    if (on) {
      li.scrollIntoView({ block: 'nearest' });
      dom.address.setAttribute('aria-activedescendant', li.id);
    }
  });
}

async function chooseSuggestion(result) {
  closeSuggestions();
  let { lat, lon } = result;

  // The firm directory is hand-maintained, so trust its address over its
  // coordinates whenever the geocoder can be reached.
  if (result.kind === 'firm') {
    setStatus(`Locating ${result.label}…`);
    const point = await geocode.resolveFirm(result);
    lat = point.lat;
    lon = point.lon;
    if (!point.precise) {
      setStatus(`Using the stored location for ${result.label} — address lookup was unreachable.`);
    }
  }

  map.setView([lat, lon], Math.max(map.getZoom(), 13));
  await setOrigin(lat, lon, result.label);
}

function showSuggestions(results) {
  dom.suggestions.innerHTML = '';
  suggestions = results;
  activeSuggestion = -1;

  if (!results.length) {
    closeSuggestions();
    return;
  }

  results.forEach((r, i) => {
    const li = document.createElement('li');
    li.id = `suggestion-${i}`;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', 'false');
    li.className = r.kind === 'firm' ? 'combo__item combo__item--firm' : 'combo__item';

    const title = document.createElement('span');
    title.className = 'combo__title';
    title.textContent = r.label;
    li.append(title);

    // A firm row is only useful if it also shows which building it means.
    const detail = document.createElement('span');
    detail.className = 'combo__detail';
    detail.textContent = r.detail || r.source;
    li.append(detail);

    li.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      chooseSuggestion(r);
    });
    li.addEventListener('mousemove', () => highlightSuggestion(i));
    dom.suggestions.append(li);
  });

  dom.suggestions.hidden = false;
  dom.address.setAttribute('aria-expanded', 'true');
}

function runSuggest() {
  clearTimeout(suggestTimer);
  const text = dom.address.value;
  suggestTimer = setTimeout(async () => {
    if (suggestAbort) suggestAbort.abort();
    suggestAbort = new AbortController();
    try {
      showSuggestions(await geocode.suggest(text, suggestAbort.signal));
    } catch (err) {
      if (err.name !== 'AbortError') closeSuggestions();
    }
  }, 160);
}

dom.address.addEventListener('input', runSuggest);

// Clicking into an empty box offers the firm list straight away.
dom.address.addEventListener('focus', () => {
  if (dom.address.value.trim().length >= 2 && dom.suggestions.hidden) runSuggest();
});

dom.address.addEventListener('blur', () => setTimeout(closeSuggestions, 150));

dom.address.addEventListener('keydown', async (ev) => {
  const open = !dom.suggestions.hidden && suggestions.length;

  if (ev.key === 'ArrowDown' && open) {
    ev.preventDefault();
    highlightSuggestion(activeSuggestion + 1);
    return;
  }
  if (ev.key === 'ArrowUp' && open) {
    ev.preventDefault();
    highlightSuggestion(activeSuggestion - 1);
    return;
  }
  if (ev.key === 'Escape') {
    closeSuggestions();
    return;
  }
  if (ev.key !== 'Enter') return;

  ev.preventDefault();

  if (open && activeSuggestion >= 0) {
    await chooseSuggestion(suggestions[activeSuggestion]);
    return;
  }

  const text = dom.address.value.trim();
  if (!text) return;
  closeSuggestions();
  setStatus('Looking up that address…');
  try {
    const results = await geocode.search(text);
    await chooseSuggestion(results[0]);
  } catch (err) {
    setStatus(err.message, true);
  }
});

/* ---------------------------------------------------------------- export */

function exportMeta() {
  const windowLabel =
    state.mode === 'transit'
      ? (state.info.windows.find((w) => w.key === state.window) || {}).label
      : 'walking only';
  return {
    address: state.label,
    minutes: state.budget,
    mode: state.mode === 'transit' ? 'subway + walking' : 'walking only',
    window: windowLabel,
    description:
      `Everywhere within ${state.budget} minutes of ${state.label} ` +
      `(${state.mode === 'transit' ? 'subway + walking, ' + windowLabel : 'walking only'}), ` +
      `max ${state.maxWalk} min walk to a station at ${state.walkKph} km/h.`,
  };
}

function slug() {
  return (state.label || 'nyc')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function rebuildBoundary() {
  const polygons = state.polygons ?? [];
  const pieces = traceablePieces(polygons);
  state.pieces = pieces;

  if (!pieces.some((p) => p.index === state.boundaryPiece)) {
    state.boundaryPiece = pieces.length ? pieces[0].index : 0;
  }

  // Rebuild the picker only when the set of pieces actually changes, so
  // dragging the detail slider does not reset the user's choice.
  const signature = pieces.map((p) => `${p.index}:${p.areaKm2.toFixed(1)}`).join('|');
  if (signature !== state.pieceSignature) {
    state.pieceSignature = signature;
    dom.sePiece.innerHTML = '';
    pieces.forEach((piece, n) => {
      const option = document.createElement('option');
      option.value = String(piece.index);
      option.textContent = `Piece ${n + 1} — ${piece.areaKm2.toFixed(1)} km²`;
      dom.sePiece.append(option);
    });
    dom.sePiece.disabled = pieces.length < 2;
  }
  dom.sePiece.value = String(state.boundaryPiece);

  state.boundary = polygons.length
    ? simplifiedBoundary(polygons, state.boundaryPoints, state.boundaryPiece)
    : null;
  updateExportUI();
}

function updateExportUI() {
  const boundary = state.boundary;
  dom.sePoints.textContent = String(state.boundaryPoints);
  if (!boundary) {
    dom.seFidelity.textContent = '';
    dom.seLink.setAttribute('aria-disabled', 'true');
    return;
  }

  dom.seLink.removeAttribute('aria-disabled');
  dom.seLink.href = streetEasyURL(boundary.ring, dom.seTemplate.value || DEFAULT_STREETEASY_TEMPLATE);

  // Say plainly how much the traceable outline gets wrong, since a hand-drawn
  // boundary is the thing people will actually search listings inside.
  const budget = bandThresholds(state.budget).at(-1);
  const fit = boundaryFidelity(boundary.ring, state.result.minutes, gridGeo(), budget);
  const others = (state.pieces?.length ?? 1) - 1;
  const notes = [
    `This outline holds ${(100 * fit.coverage).toFixed(0)}% of everywhere you could live`,
    `${(100 * fit.overspill).toFixed(0)}% of what it encloses is over budget`,
  ];
  if (others > 0) {
    notes.push(
      `${others} more piece${others > 1 ? 's' : ''} that size sit${others > 1 ? '' : 's'} ` +
        'across the water — draw each as its own boundary'
    );
  }
  if (boundary.droppedHoles) {
    notes.push(`${boundary.droppedHoles} unreachable pocket(s) inside it cannot be cut out`);
  }
  dom.seFidelity.textContent = notes.join('. ') + '.';
}

el('export-geojson').addEventListener('click', () => {
  if (!state.polygons?.length) return;
  download(
    `commute-${state.budget}min-${slug()}.geojson`,
    JSON.stringify(toGeoJSON(state.polygons, exportMeta()), null, 2),
    'application/geo+json'
  );
});

el('export-kml').addEventListener('click', () => {
  if (!state.polygons?.length) return;
  download(`commute-${state.budget}min-${slug()}.kml`, toKML(state.polygons, exportMeta()),
    'application/vnd.google-earth.kml+xml');
});

el('export-coords').addEventListener('click', async () => {
  if (!state.polygons?.length) return;
  const ok = await copyText(toCoordinateList(state.polygons[0].outer));
  setStatus(ok ? 'Boundary points copied.' : 'Could not reach the clipboard.', !ok);
});

el('se-copy').addEventListener('click', async () => {
  if (!state.boundary) return;
  const ok = await copyText(toCoordinateList(state.boundary.ring));
  setStatus(
    ok
      ? `Copied ${state.boundary.ring.length} corner points, in drawing order.`
      : 'Could not reach the clipboard.',
    !ok
  );
});

el('se-trace').addEventListener('click', () => {
  if (!state.boundary) return;
  // A vertex-by-vertex view of exactly what to click on StreetEasy's map.
  contourGroup.clearLayers();
  const ring = state.boundary.ring;
  L.polygon(ring, {
    pane: 'contours',
    fill: false,
    color: readVar('--contour-edge'),
    weight: 3,
    dashArray: '6 4',
    interactive: false,
  }).addTo(contourGroup);
  ring.slice(0, -1).forEach((point, i) => {
    L.circleMarker(point, {
      pane: 'contours',
      radius: 5,
      color: readVar('--contour-edge'),
      weight: 2,
      fillColor: readVar('--surface-1'),
      fillOpacity: 1,
      interactive: false,
    })
      .bindTooltip(String(i + 1), { permanent: true, direction: 'center', className: 'trace-tip' })
      .addTo(contourGroup);
  });
  map.fitBounds(L.polygon(ring).getBounds(), { padding: [30, 30] });
  setStatus(
    `Tracing view: click these ${ring.length - 1} points in order on StreetEasy's draw tool. ` +
      'Change any setting to go back to the normal view.'
  );
});

dom.seTemplate.value = DEFAULT_STREETEASY_TEMPLATE;
dom.seTemplate.addEventListener('input', updateExportUI);

dom.seDetail.value = String(state.boundaryPoints);
dom.seDetail.addEventListener('input', () => {
  state.boundaryPoints = Number(dom.seDetail.value);
  rebuildBoundary();
});

dom.sePiece.addEventListener('change', () => {
  state.boundaryPiece = Number(dom.sePiece.value);
  rebuildBoundary();
});

/* ------------------------------------------------------------ url state */

function updateHash() {
  const parts = [
    `lat=${state.lat.toFixed(5)}`,
    `lon=${state.lon.toFixed(5)}`,
    `min=${state.budget}`,
    `mode=${state.mode}`,
    `when=${state.window}`,
    `walk=${state.maxWalk}`,
  ];
  if (state.label) parts.push(`at=${encodeURIComponent(state.label)}`);
  history.replaceState(null, '', '#' + parts.join('&'));
}

function readHash() {
  const raw = location.hash.replace(/^#/, '');
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const lat = parseFloat(params.get('lat'));
  const lon = parseFloat(params.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    lat,
    lon,
    budget: Number(params.get('min')) || 45,
    mode: params.get('mode') === 'walk' ? 'walk' : 'transit',
    window: params.get('when') || 'am_rush',
    maxWalk: Number(params.get('walk')) || 15,
    label: params.get('at') || '',
  };
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  try {
    // Absolute, because the worker resolves relative URLs against js/, not the page.
    const info = await ask('init', { dataBase: new URL('data/', document.baseURI).href });
    state.info = info;

    dom.window.innerHTML = '';
    for (const w of info.windows) {
      const option = document.createElement('option');
      option.value = w.key;
      option.textContent = w.label;
      dom.window.append(option);
    }
    dom.window.value = state.window;

    if (info.feed.start && info.feed.end) {
      const fmt = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
      dom.feedNote.textContent = `MTA schedule valid ${fmt(info.feed.start)} to ${fmt(info.feed.end)}.`;
    }

    const saved = readHash();
    if (saved) {
      state.budget = saved.budget;
      state.mode = saved.mode;
      state.window = saved.window;
      state.maxWalk = saved.maxWalk;
      dom.budget.value = String(state.budget);
      dom.budgetValue.textContent = formatMinutes(state.budget);
      dom.maxWalk.value = String(state.maxWalk);
      dom.maxWalkValue.textContent = `${state.maxWalk} min`;
      dom.window.value = state.window;
      document.querySelectorAll('.segmented button').forEach((b) => {
        const on = b.dataset.mode === state.mode;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-checked', String(on));
      });
      dom.windowField.hidden = state.mode !== 'transit';
      map.setView([saved.lat, saved.lon], 12);
      await setOrigin(saved.lat, saved.lon, saved.label || null);
    } else {
      setStatus('Type an office address, or click the map.');
      dom.address.focus();
    }
  } catch (err) {
    setStatus(`Could not load the transit data: ${err.message}`, true);
  }
}

boot();
