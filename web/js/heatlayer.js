/* Canvas layer that paints the travel-time grid.
 *
 * The grid is spaced evenly in latitude, but Leaflet draws in Web Mercator, so
 * the source image is resampled into Mercator rows once per solve. After that
 * every pan and zoom is a single drawImage of a 405x407 bitmap -- cheap enough
 * to redraw on every frame of a zoom animation.
 */

'use strict';

const DEG = Math.PI / 180;

function mercY(lat) {
  return Math.log(Math.tan(Math.PI / 4 + (lat * DEG) / 2));
}

function invMercY(y) {
  return (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / DEG;
}

export function createHeatLayer(L) {
  return L.Layer.extend({
    initialize(options) {
      L.setOptions(this, options);
      this._image = null;
      this._bounds = null;
    },

    onAdd(map) {
      this._map = map;
      this._canvas = L.DomUtil.create('canvas', 'commute-heat');
      this._canvas.style.position = 'absolute';
      this._canvas.style.pointerEvents = 'none';
      this._ctx = this._canvas.getContext('2d');
      map.getPanes().overlayPane.appendChild(this._canvas);

      map.on('moveend zoomend resize viewreset', this._reset, this);
      map.on('zoomanim', this._animateZoom, this);
      this._reset();
    },

    onRemove(map) {
      map.off('moveend zoomend resize viewreset', this._reset, this);
      map.off('zoomanim', this._animateZoom, this);
      if (this._canvas && this._canvas.parentNode) this._canvas.parentNode.removeChild(this._canvas);
      this._canvas = null;
      this._ctx = null;
    },

    /**
     * @param {Uint8Array} minutes   one value per grid cell, 255 = out of range
     * @param {object} geo           grid geometry from the worker
     * @param {function} colorFor    minutes -> [r, g, b, a]
     */
    setData(minutes, geo, colorFor) {
      const { rows, cols } = geo;
      const latMin = geo.lat0;
      const latMax = geo.lat0 + rows * geo.dLat;
      const yTop = mercY(latMax);
      const yBottom = mercY(latMin);

      const source = document.createElement('canvas');
      source.width = cols;
      source.height = rows;
      const sctx = source.getContext('2d');
      const img = sctx.createImageData(cols, rows);
      const data = img.data;

      // Cache one colour per distinct minute value rather than per pixel.
      const palette = new Uint8ClampedArray(256 * 4);
      for (let v = 0; v < 256; v++) {
        const [r, g, b, a] = colorFor(v);
        palette[v * 4] = r;
        palette[v * 4 + 1] = g;
        palette[v * 4 + 2] = b;
        palette[v * 4 + 3] = a;
      }

      for (let outRow = 0; outRow < rows; outRow++) {
        // Output rows are evenly spaced in Mercator y, top to bottom.
        const y = yTop + ((outRow + 0.5) / rows) * (yBottom - yTop);
        const lat = invMercY(y);
        let srcRow = Math.floor((lat - geo.lat0) / geo.dLat);
        if (srcRow < 0) srcRow = 0;
        if (srcRow >= rows) srcRow = rows - 1;

        const srcBase = srcRow * cols;
        const dstBase = outRow * cols * 4;
        for (let c = 0; c < cols; c++) {
          const v = minutes[srcBase + c];
          const p = v * 4;
          const d = dstBase + c * 4;
          data[d] = palette[p];
          data[d + 1] = palette[p + 1];
          data[d + 2] = palette[p + 2];
          data[d + 3] = palette[p + 3];
        }
      }

      sctx.putImageData(img, 0, 0);
      this._image = source;
      this._bounds = L.latLngBounds(
        L.latLng(latMin, geo.lon0),
        L.latLng(latMax, geo.lon0 + cols * geo.dLon)
      );
      this._reset();
    },

    clear() {
      this._image = null;
      this._reset();
    },

    setOpacity(value) {
      this.options.opacity = value;
      if (this._canvas) this._canvas.style.opacity = value;
    },

    _animateZoom(e) {
      if (!this._image || !this._map || !this._anchor) return;
      // The canvas covers the viewport, so pin its top-left corner to the
      // geographic point that was there when it was drawn, and scale about it.
      const scale = this._map.getZoomScale(e.zoom, this._zoom);
      const offset = this._map._latLngToNewLayerPoint(this._anchor, e.zoom, e.center);
      L.DomUtil.setTransform(this._canvas, offset, scale);
    },

    _reset() {
      if (!this._map || !this._canvas) return;
      const map = this._map;
      const canvas = this._canvas;

      if (!this._image || !this._bounds) {
        canvas.width = 0;
        canvas.height = 0;
        return;
      }

      // Sizing the canvas to the data bounds would ask for a 14000 px bitmap at
      // street-level zoom, which the browser refuses to allocate. A viewport
      // sized canvas keeps the cost flat; drawImage clips whatever falls off.
      const size = map.getSize();
      this._anchor = map.containerPointToLatLng([0, 0]);
      this._zoom = map.getZoom();

      L.DomUtil.setTransform(canvas, map.containerPointToLayerPoint([0, 0]), 1);
      canvas.width = size.x;
      canvas.height = size.y;
      canvas.style.width = size.x + 'px';
      canvas.style.height = size.y + 'px';
      canvas.style.opacity = this.options.opacity ?? 1;

      const nw = map.latLngToContainerPoint(this._bounds.getNorthWest());
      const se = map.latLngToContainerPoint(this._bounds.getSouthEast());

      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, size.x, size.y);

      // Smoothing blends 120 m cells into a gradient, which is what you want
      // while the city fits on screen. Once a cell is several pixels wide the
      // same blend smears colour across shorelines and out past the boundary,
      // so switch to honest square cells instead.
      const cellPixels = (se.x - nw.x) / this._image.width;
      const smooth = cellPixels < 6;
      ctx.imageSmoothingEnabled = smooth;
      if (smooth) ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this._image, nw.x, nw.y, se.x - nw.x, se.y - nw.y);
    },
  });
}
