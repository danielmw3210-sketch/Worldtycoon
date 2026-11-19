import L from 'leaflet';
import { UK_OUTLINE } from '../data/ukOutline';

/**
 * UkGridLayer
 *
 * Draws the 3,500 plot grid onto a single canvas, clipped to the UK coastline
 * (Natural Earth 50m outline). At country zoom the plots read as a faint
 * rarity heat-map that blends into the landmass; as you zoom in the cell
 * borders and labels fade in. Nothing is ever drawn over the sea or Ireland.
 */

const RARITY_COLORS = {
  common: [148, 163, 184],
  uncommon: [74, 222, 128],
  rare: [56, 189, 248],
  super_rare: [167, 139, 250],
  epic: [244, 114, 182],
  legendary: [251, 191, 36],
  mythic: [251, 113, 133],
  transcendent: [34, 211, 238]
};

function rgba(rgb, alpha) {
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
}

function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][0];
    const xi = ring[i][1];
    const yj = ring[j][0];
    const xj = ring[j][1];
    if (((yi > lat) !== (yj > lat)) &&
        (lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function isOnLand(lat, lng) {
  for (let i = 0; i < UK_OUTLINE.length; i++) {
    if (pointInRing(lng, lat, UK_OUTLINE[i])) return true;
  }
  return false;
}

const UkGridLayer = L.Layer.extend({
  options: {
    pane: 'overlayPane',
    plots: [],
    filter: null,
    selectedId: null,
    onSelect: null
  },

  initialize(options) {
    L.setOptions(this, options);
    this._plots = options.plots || [];
    this._filter = options.filter || null;
    this._selectedId = options.selectedId || null;
    this._hoveredId = null;
    this._frame = null;
  },

  onAdd(map) {
    this._map = map;

    const canvas = this._canvas = L.DomUtil.create('canvas', 'uk-grid-canvas');
    canvas.style.position = 'absolute';
    canvas.style.pointerEvents = 'auto';
    this._ctx = canvas.getContext('2d');

    map.getPane(this.options.pane).appendChild(canvas);

    this._tooltip = L.DomUtil.create('div', 'uk-grid-tooltip', map.getContainer());
    this._tooltip.style.display = 'none';

    L.DomEvent.on(canvas, 'mousemove', this._onMouseMove, this);
    L.DomEvent.on(canvas, 'mouseleave', this._onMouseLeave, this);
    L.DomEvent.on(canvas, 'mousedown', this._onMouseDown, this);
    L.DomEvent.on(canvas, 'click', this._onClick, this);

    map.on('move zoomend resize viewreset', this._schedule, this);
    map.on('zoomstart', this._onZoomStart, this);

    this._deriveGrid();
    this._reset();
  },

  onRemove(map) {
    if (this._frame) cancelAnimationFrame(this._frame);
    this._frame = null;

    L.DomEvent.off(this._canvas);
    map.off('move zoomend resize viewreset', this._schedule, this);
    map.off('zoomstart', this._onZoomStart, this);

    if (this._canvas?.parentNode) this._canvas.parentNode.removeChild(this._canvas);
    if (this._tooltip?.parentNode) this._tooltip.parentNode.removeChild(this._tooltip);

    this._map = null;
    this._canvas = null;
    this._ctx = null;
    this._tooltip = null;
  },

  setPlots(plots) {
    this._plots = plots || [];
    this._deriveGrid();
    // Draw immediately: rAF is paused in background/hidden windows, and a
    // stale empty canvas is much worse than one synchronous repaint.
    this._drawNow();
  },

  setFilter(filter) {
    this._filter = filter || null;
    this._drawNow();
  },

  setSelectedId(id) {
    this._selectedId = id || null;
    this._drawNow();
  },

  _drawNow() {
    if (!this._map) return;
    if (this._frame) {
      cancelAnimationFrame(this._frame);
      this._frame = null;
    }
    this._reset();
  },

  /* ------------------------------------------------------------------ */

  _deriveGrid() {
    const plots = this._plots;
    if (!plots || plots.length < 2) return;

    let minLat = Infinity;
    let minLng = Infinity;
    let maxCol = 0;
    let maxRow = 0;

    plots.forEach(p => {
      if (!p.bounds) return;
      if (p.bounds[0][0] < minLat) minLat = p.bounds[0][0];
      if (p.bounds[0][1] < minLng) minLng = p.bounds[0][1];
      if (p.col > maxCol) maxCol = p.col;
      if (p.row > maxRow) maxRow = p.row;
    });

    const sample = plots.find(p => p.bounds);
    if (!sample) return;

    this._grid = {
      minLat,
      minLng,
      latStep: sample.bounds[1][0] - sample.bounds[0][0],
      lngStep: sample.bounds[1][1] - sample.bounds[0][1],
      cols: maxCol + 1,
      rows: maxRow + 1
    };
  },

  _plotAtLatLng(lat, lng) {
    const grid = this._grid;
    if (!grid || !(grid.latStep > 0) || !(grid.lngStep > 0)) return null;

    const row = Math.floor((lat - grid.minLat) / grid.latStep);
    const col = Math.floor((lng - grid.minLng) / grid.lngStep);
    if (row < 0 || row >= grid.rows || col < 0 || col >= grid.cols) return null;

    const index = row * grid.cols + col;
    const plot = this._plots[index];
    if (!plot || plot.row !== row || plot.col !== col) return null;
    if (this._filter && !this._filter(plot)) return null;
    return plot;
  },

  _matches(plot) {
    return !this._filter || this._filter(plot);
  },

  _schedule() {
    if (!this._map || this._frame) return;
    this._frame = requestAnimationFrame(() => {
      this._frame = null;
      this._reset();
    });
  },

  _onZoomStart() {
    if (this._canvas) this._canvas.style.opacity = '0';
  },

  _reset() {
    const map = this._map;
    const canvas = this._canvas;
    const ctx = this._ctx;
    if (!map || !canvas || !ctx) return;

    const size = map.getSize();
    const topLeft = map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(canvas, topLeft);

    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(size.x * dpr));
    const height = Math.max(1, Math.round(size.y * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    canvas.style.width = `${size.x}px`;
    canvas.style.height = `${size.y}px`;
    canvas.style.opacity = '1';

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._size = size;
    this._draw();
  },

  _draw() {
    const map = this._map;
    const ctx = this._ctx;
    if (!map || !ctx || !this._size) return;

    const { x: width, y: height } = this._size;
    const zoom = map.getZoom();
    const view = map.getBounds().pad(0.1);

    ctx.clearRect(0, 0, width, height);

    // --- Coastline clip path -------------------------------------------
    const clip = new Path2D();
    for (let r = 0; r < UK_OUTLINE.length; r++) {
      const ring = UK_OUTLINE[r];
      for (let i = 0; i < ring.length; i++) {
        const p = map.latLngToContainerPoint(ring[i]);
        if (i === 0) clip.moveTo(p.x, p.y);
        else clip.lineTo(p.x, p.y);
      }
      clip.closePath();
    }

    // At country zoom an unfiltered map shows no unclaimed grid at all — the
    // land looks untouched. Borders fade in from zoom 8, and selecting any
    // filter tab lights up the matching parcels so the tabs stay useful.
    const t = Math.max(0, Math.min(1, (zoom - 6) / 5));
    const emphasize = !!this._filter;
    const fillAlpha = emphasize ? 0.16 : Math.max(0, (zoom - 6.5) / 4.5) * 0.11;
    const strokeAlpha = emphasize ? 0.14 : (zoom < 8 ? 0 : 0.02 + t * 0.16);
    const lineWidth = zoom >= 10 ? 0.8 : 0.55;

    ctx.save();
    ctx.clip(clip, 'evenodd');

    const south = view.getSouth();
    const north = view.getNorth();
    const west = view.getWest();
    const east = view.getEast();

    for (let i = 0; i < this._plots.length; i++) {
      const plot = this._plots[i];
      if (!plot.bounds || !this._matches(plot)) continue;

      const [pSouth, pWest] = plot.bounds[0];
      const [pNorth, pEast] = plot.bounds[1];
      if (pNorth < south || pSouth > north || pEast < west || pWest > east) continue;

      const nw = map.latLngToContainerPoint([pNorth, pWest]);
      const se = map.latLngToContainerPoint([pSouth, pEast]);
      const x = Math.min(nw.x, se.x);
      const y = Math.min(nw.y, se.y);
      const w = Math.max(0.5, Math.abs(se.x - nw.x));
      const h = Math.max(0.5, Math.abs(se.y - nw.y));

      const rgb = RARITY_COLORS[plot.rarityKey] || RARITY_COLORS.common;
      const hovered = plot.id === this._hoveredId;
      const selected = plot.id === this._selectedId;
      const claimed = !!plot.isClaimed;
      const landmark = !!plot.isLandmark;
      // A deed whose mint is still gathering confirmations: reserved, lit, but
      // drawn with an amber edge so it reads as unsettled.
      const pending = plot.nftState?.stage === 'pending' || !!plot.pendingJobId;

      let fill = fillAlpha;
      let stroke = strokeAlpha;
      let strokeWidth = lineWidth;

      if (claimed || landmark || pending) {
        fill = (landmark ? 0.24 : pending ? 0.2 : 0.16) + t * 0.18;
        stroke = pending ? 0.95 : 0.6;
        strokeWidth = pending ? 1.2 : 1;
      }
      if (hovered || selected) {
        fill = 0.4;
        stroke = 0.95;
        strokeWidth = 1.4;
      }

      if (landmark && zoom >= 7) {
        ctx.shadowColor = rgba(rgb, 0.8);
        ctx.shadowBlur = 8;
      }

      ctx.fillStyle = rgba(rgb, fill);
      ctx.strokeStyle = pending ? `rgba(251, 191, 36, ${stroke})` : rgba(rgb, stroke);
      ctx.lineWidth = strokeWidth;

      ctx.fillRect(x, y, w, h);
      if (stroke > 0.02) ctx.strokeRect(x, y, w, h);

      if (landmark && zoom >= 7) ctx.shadowBlur = 0;

      if ((hovered || selected) && zoom >= 6) {
        ctx.strokeStyle = hovered ? 'rgba(255,255,255,0.9)' : 'rgba(251,146,60,0.95)';
        ctx.lineWidth = 1.75;
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      }
    }

    // A crisp coast edge so the tinted land reads as part of the map.
    ctx.strokeStyle = `rgba(251, 146, 60, ${0.18 + t * 0.2})`;
    ctx.lineWidth = 1.1;
    ctx.stroke(clip);

    ctx.restore();
  },

  /* ------------------------------------------------------------------ */
  /* Pointer interaction (hit test on the regular grid)                 */
  /* ------------------------------------------------------------------ */

  _onMouseMove(e) {
    if (!this._map) return;

    const point = this._map.mouseEventToContainerPoint(e);
    const latlng = this._map.containerPointToLatLng(point);

    if (!isOnLand(latlng.lat, latlng.lng)) {
      this._setHovered(null, point);
      return;
    }

    const plot = this._plotAtLatLng(latlng.lat, latlng.lng);
    this._setHovered(plot, point);
  },

  _setHovered(plot, point) {
    const id = plot ? plot.id : null;
    if (id !== this._hoveredId) {
      this._hoveredId = id;
      // Repaint immediately rather than waiting on rAF: hover feedback must
      // survive occluded/background windows.
      this._drawNow();
    }

    if (this._canvas) {
      this._canvas.style.cursor = plot ? 'pointer' : '';
    }

    if (!plot) {
      if (this._tooltip) this._tooltip.style.display = 'none';
      return;
    }

    const tooltip = this._tooltip;
    if (!tooltip) return;

    const color = RARITY_COLORS[plot.rarityKey] || RARITY_COLORS.common;
    const price = Number(plot.price) || 0;
    const priceText = price >= 1e6
      ? `${(price / 1e6).toFixed(price >= 1e7 ? 0 : 1)}M`
      : price >= 1e3
        ? `${(price / 1e3).toFixed(price >= 1e4 ? 0 : 1)}k`
        : `${price}`;
    const pending = plot.nftState?.stage === 'pending' || !!plot.pendingJobId;
    const status = pending
      ? `<span class="uk-grid-tooltip-owner">${plot.owner || 'Reserved'} · minting</span>`
      : plot.isClaimed
        ? `<span class="uk-grid-tooltip-owner">${plot.owner || 'Claimed'}</span>`
        : '<span class="uk-grid-tooltip-free">Unclaimed</span>';

    tooltip.innerHTML =
      `<span class="uk-grid-tooltip-label">${plot.label || plot.id}</span>` +
      `<span class="uk-grid-tooltip-dot" style="background:rgb(${color.join(',')})"></span>` +
      `<span class="uk-grid-tooltip-rarity">${plot.rarityName || 'Common'}</span>` +
      `<span class="uk-grid-tooltip-sep">·</span>` +
      `<span class="uk-grid-tooltip-price">${priceText} NUM</span>` +
      status;

    tooltip.style.display = 'block';

    const size = this._size || { x: 0, y: 0 };
    const tipW = tooltip.offsetWidth || 180;
    const tipH = tooltip.offsetHeight || 26;
    const x = Math.min(Math.max(8, point.x + 14), size.x - tipW - 8);
    const y = Math.min(Math.max(8, point.y - tipH - 12), size.y - tipH - 8);
    tooltip.style.transform = `translate(${x}px, ${y}px)`;
  },

  _onMouseLeave() {
    this._setHovered(null, { x: 0, y: 0 });
  },

  _onMouseDown(e) {
    this._downPoint = this._map.mouseEventToContainerPoint(e);
  },

  _onClick(e) {
    if (!this._map) return;
    const point = this._map.mouseEventToContainerPoint(e);

    if (this._downPoint) {
      const dx = point.x - this._downPoint.x;
      const dy = point.y - this._downPoint.y;
      if (dx * dx + dy * dy > 25) return; // was a drag, not a click
    }

    const latlng = this._map.containerPointToLatLng(point);
    if (!isOnLand(latlng.lat, latlng.lng)) return;

    const plot = this._plotAtLatLng(latlng.lat, latlng.lng);
    if (plot && this.options.onSelect) this.options.onSelect(plot);
  }
});

export function createUkGridLayer(options) {
  return new UkGridLayer(options);
}

export default UkGridLayer;
