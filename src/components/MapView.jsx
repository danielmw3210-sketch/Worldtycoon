import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useGame } from '../context/GameContext';
import { createUkGridLayer } from './UkGridLayer';
import {
  Landmark,
  MapPin,
  Sparkles,
  Layers,
  Globe,
  Coins,
  X
} from 'lucide-react';

// Free map tile providers (public/free sources, no paid/private key needed)
const TILE_PROVIDERS = {
  osm_streets: {
    name: "Standard Cartography (OpenStreetMap Free)",
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors",
    subdomains: 'abc',
    maxZoom: 19
  },
  esri_satellite: {
    name: "Earth Satellite (Esri ArcGIS Free)",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "Tiles &copy; Esri &mdash; Source: Esri, Earthstar Geographics",
    subdomains: 'abc',
    maxZoom: 19
  },
  opentopo: {
    name: "Topographic (OpenTopoMap Free)",
    url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    attribution: "Map data: &copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors, SRTM | Map style: &copy; <a href='https://opentopomap.org'>OpenTopoMap</a>",
    subdomains: 'abc',
    maxZoom: 17
  }
};

const RARITY_META = {
  common:       { name: 'Common',       color: '#94a3b8', price: 50 },
  uncommon:     { name: 'Uncommon',     color: '#4ade80', price: 500 },
  rare:         { name: 'Rare',         color: '#38bdf8', price: 5000 },
  super_rare:   { name: 'Super Rare',   color: '#a78bfa', price: 50000 },
  epic:         { name: 'Epic',         color: '#f472b6', price: 500000 },
  legendary:    { name: 'Legendary',    color: '#fbbf24', price: 5000000 },
  mythic:       { name: 'Mythic',       color: '#fb7185', price: 50000000 },
  transcendent: { name: 'Transcendent', color: '#22d3ee', price: 500000000 }
};

const RARITY_ORDER = ['common', 'uncommon', 'rare', 'super_rare', 'epic', 'legendary', 'mythic', 'transcendent'];

function formatNum(n) {
  const value = Number(n) || 0;
  if (value >= 1e9) return `${(value / 1e9).toFixed(value >= 1e10 ? 0 : 1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(value >= 1e7 ? 0 : 1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(value >= 1e4 ? 0 : 1)}k`;
  return `${+value.toFixed(2)}`;
}

function formatIncome(n) {
  const value = Number(n) || 0;
  if (value >= 1000) return formatNum(value);
  if (value >= 1) return value.toFixed(2);
  return value.toFixed(4);
}

export default function MapView() {
  const mapContainerRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const tileLayerRef = useRef(null);
  const gridLayerRef = useRef(null);
  const labelLayerRef = useRef(null);

  const {
    plots,
    selectedPlot,
    setSelectedPlot,
    setActiveModal,
    mapStyle,
    setMapStyle
  } = useGame();

  const [activeTab, setActiveTab] = useState('ALL');
  const [showLayerMenu, setShowLayerMenu] = useState(false);
  const [viewVersion, setViewVersion] = useState(0);

  const rarityTiers = useMemo(() => {
    const found = new Map();
    plots.forEach(p => {
      if (p.rarityKey && !found.has(p.rarityKey)) {
        found.set(p.rarityKey, {
          key: p.rarityKey,
          name: p.rarityName || (RARITY_META[p.rarityKey]?.name ?? p.rarityKey),
          price: p.price,
          color: RARITY_META[p.rarityKey]?.color || '#94a3b8'
        });
      }
    });
    return RARITY_ORDER
      .filter(k => found.has(k))
      .map(k => found.get(k));
  }, [plots]);

  const counts = useMemo(() => {
    const result = {
      ALL: plots.length,
      UNCLAIMED: 0,
      CLAIMED: 0,
      INSTITUTIONS: 0
    };
    RARITY_ORDER.forEach(k => { result[`RARITY:${k}`] = 0; });
    plots.forEach(p => {
      if (p.isClaimed) result.CLAIMED += 1; else result.UNCLAIMED += 1;
      if (p.isLandmark) result.INSTITUTIONS += 1;
      if (p.rarityKey) result[`RARITY:${p.rarityKey}`] = (result[`RARITY:${p.rarityKey}`] || 0) + 1;
    });
    return result;
  }, [plots]);

  const plotFilter = useCallback((plot) => {
    if (activeTab === 'ALL') return true;
    if (activeTab === 'UNCLAIMED') return !plot.isClaimed;
    if (activeTab === 'CLAIMED') return plot.isClaimed;
    if (activeTab === 'INSTITUTIONS') return !!plot.isLandmark;
    if (activeTab.startsWith('RARITY:')) return plot.rarityKey === activeTab.slice(7);
    return true;
  }, [activeTab]);

  // Initialize Map
  useEffect(() => {
    if (!mapContainerRef.current) return;

    if (!mapInstanceRef.current) {
      const map = L.map(mapContainerRef.current, {
        center: [54.3, -2.4],
        zoom: 6,
        minZoom: 5,
        maxZoom: 18,
        zoomControl: false
      });

      L.control.zoom({ position: 'bottomright' }).addTo(map);

      const provider = TILE_PROVIDERS[mapStyle] || TILE_PROVIDERS.carto_dark;
      const tileLayer = L.tileLayer(provider.url, {
        attribution: provider.attribution,
        subdomains: provider.subdomains || 'abc',
        maxZoom: provider.maxZoom || 19,
        crossOrigin: true
      }).addTo(map);

      // If a tile source fails (network/CORS/provider issue), fall back to another free provider
      let tileErrorCount = 0;
      tileLayer.on('tileerror', () => {
        tileErrorCount += 1;
        if (tileErrorCount < 3) return;
        const fallbackOrder = ['osm_streets', 'esri_satellite', 'opentopo'];
        const currentKey = localStorage.getItem('goldnumista_map_style') || mapStyle || 'osm_streets';
        const idx = Math.max(0, fallbackOrder.indexOf(currentKey));
        const nextKey = fallbackOrder.find((k, i) => i > idx) || fallbackOrder.find(k => k !== currentKey);
        if (!nextKey || !TILE_PROVIDERS[nextKey]) return;
        tileErrorCount = 0;
        setMapStyle(nextKey);
        localStorage.setItem('goldnumista_map_style', nextKey);
      });

      tileLayerRef.current = tileLayer;

      const gridLayer = createUkGridLayer({
        plots: [],
        onSelect: (plot) => setSelectedPlot(plot)
      }).addTo(map);
      gridLayerRef.current = gridLayer;

      labelLayerRef.current = L.layerGroup().addTo(map);
      mapInstanceRef.current = map;

      const bumpView = () => setViewVersion(v => v + 1);
      map.on('moveend', bumpView);
      map.on('zoomend', bumpView);

      setTimeout(() => map.invalidateSize(), 0);
    }

    return () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
        tileLayerRef.current = null;
        gridLayerRef.current = null;
        labelLayerRef.current = null;
      }
    };
  }, []);

  // Push fresh plot state into the canvas layer
  useEffect(() => {
    if (gridLayerRef.current) gridLayerRef.current.setPlots(plots);
  }, [plots]);

  useEffect(() => {
    if (gridLayerRef.current) {
      gridLayerRef.current.setFilter(activeTab === 'ALL' ? null : plotFilter);
    }
  }, [activeTab, plotFilter]);

  useEffect(() => {
    if (gridLayerRef.current) gridLayerRef.current.setSelectedId(selectedPlot?.id || null);
  }, [selectedPlot?.id]);

  // Update Tile Layer when mapStyle changes
  useEffect(() => {
    if (!mapInstanceRef.current || !tileLayerRef.current) return;

    const provider = TILE_PROVIDERS[mapStyle] || TILE_PROVIDERS.carto_dark;
    tileLayerRef.current.setUrl(provider.url);
    if (tileLayerRef.current.options) {
      tileLayerRef.current.options.attribution = provider.attribution;
      tileLayerRef.current.options.subdomains = provider.subdomains || 'abc';
      tileLayerRef.current.options.maxZoom = provider.maxZoom || 19;
    }
    if (typeof tileLayerRef.current.redraw === 'function') {
      tileLayerRef.current.redraw();
    }
    mapInstanceRef.current.invalidateSize();
  }, [mapStyle]);

  // Sparse labels: only owned deeds and institutions, once zoomed in.
  useEffect(() => {
    const map = mapInstanceRef.current;
    const labels = labelLayerRef.current;
    if (!map || !labels) return;

    labels.clearLayers();
    if (map.getZoom() < 9) return;

    const bounds = map.getBounds();
    let drawn = 0;
    for (const plot of plots) {
      if (drawn >= 240) break;
      if (!plot.isClaimed && !plot.isLandmark) continue;
      const [lat, lng] = plot.coords || [];
      if (!bounds.contains([lat, lng])) continue;

      L.marker(plot.coords, {
        icon: L.divIcon({
          className: 'plot-label-icon',
          html: `<span>${plot.label}</span>`,
          iconSize: [44, 14],
          iconAnchor: [22, 7]
        }),
        interactive: false,
        keyboard: false
      }).addTo(labels);
      drawn += 1;
    }
  }, [plots, viewVersion]);

  const tabs = [
    { id: 'ALL', label: 'All', count: counts.ALL },
    { id: 'UNCLAIMED', label: 'Unclaimed', count: counts.UNCLAIMED },
    { id: 'CLAIMED', label: 'Owned', count: counts.CLAIMED },
    { id: 'INSTITUTIONS', label: 'Institutions', count: counts.INSTITUTIONS },
    ...rarityTiers.map(t => ({
      id: `RARITY:${t.key}`,
      label: t.name,
      count: counts[`RARITY:${t.key}`] || 0,
      color: t.color
    }))
  ];

  return (
    <div className="relative w-full h-[calc(100vh-62px)] overflow-hidden">

      {/* Map Canvas */}
      <div ref={mapContainerRef} className="w-full h-full z-0 bg-[#0b0e14]" />

      {/* Filter Tabs Overlay */}
      <div className="absolute top-4 left-4 z-20 max-w-[calc(100vw-2rem)] bg-[#0f141c]/90 backdrop-blur-md p-1.5 rounded-xl border border-slate-800 shadow-2xl">
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-2.5 py-1.5 rounded-lg text-[11px] font-semibold whitespace-nowrap transition-all flex items-center space-x-1.5 ${
                activeTab === tab.id
                  ? 'bg-orange-500 text-white shadow-md shadow-orange-500/30'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
              }`}
            >
              {tab.color && (
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: tab.color }}
                />
              )}
              <span>{tab.label}</span>
              <span className={`text-[9px] px-1 rounded-full ${activeTab === tab.id ? 'bg-orange-700 text-white' : 'bg-slate-800 text-slate-300'}`}>
                {tab.count}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Free Map Style Selector Overlay (Top Right) */}
      <div className="absolute top-4 right-4 z-20">
        <div className="relative">
          <button
            onClick={() => setShowLayerMenu(!showLayerMenu)}
            className="px-3 py-1.5 rounded-xl bg-[#0f141c]/90 backdrop-blur-md border border-slate-800 hover:border-slate-700 text-xs font-mono text-slate-300 flex items-center space-x-2 shadow-xl"
          >
            <Globe className="w-3.5 h-3.5 text-orange-400" />
            <span>Map Layer</span>
          </button>

          {showLayerMenu && (
            <div className="absolute right-0 mt-2 w-64 bg-[#161d2a] border border-slate-700 rounded-xl shadow-2xl p-2 space-y-1 text-xs font-mono z-30">
              <div className="text-[10px] uppercase font-bold text-slate-400 px-2 py-1 border-b border-slate-800">
                Free Map Layers (No Paid Key Needed)
              </div>
              <div className="text-[10px] text-slate-500 px-2 pb-1">
                Public tile sources with automatic fallback if a provider fails
              </div>
              {Object.entries(TILE_PROVIDERS).map(([key, prov]) => (
                <button
                  key={key}
                  onClick={() => {
                    setMapStyle(key);
                    localStorage.setItem('goldnumista_map_style', key);
                    setShowLayerMenu(false);
                  }}
                  className={`w-full text-left px-2.5 py-1.5 rounded-lg transition-colors flex items-center justify-between ${
                    mapStyle === key ? 'bg-orange-600/30 text-orange-300 font-bold border border-orange-500/50' : 'text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  <span className="truncate">{prov.name.split('(')[0]}</span>
                  {mapStyle === key && <span className="text-orange-400 text-[10px]">Active</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Rarity Legend Overlay (Bottom Left) */}
      <div className="absolute bottom-6 left-4 z-20 hidden md:block bg-[#0f141c]/90 backdrop-blur-md px-3.5 py-2.5 rounded-xl border border-slate-800 shadow-xl text-xs space-y-1.5 font-mono max-w-[240px]">
        <div className="text-[11px] font-bold uppercase text-slate-400 tracking-wider flex items-center space-x-1.5 pb-1 border-b border-slate-800">
          <Layers className="w-3.5 h-3.5 text-orange-400" />
          <span>UK Land Registry · {plots.length.toLocaleString()} plots</span>
        </div>
        {rarityTiers.map(t => (
          <div key={t.key} className="flex items-center justify-between gap-2">
            <span className="flex items-center space-x-2 min-w-0">
              <span className="w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: t.color }}></span>
              <span className="text-slate-300 truncate">{t.name}</span>
            </span>
            <span className="text-slate-500">{formatNum(t.price)} NUM</span>
          </div>
        ))}
        <div className="flex items-center space-x-2 pt-1 border-t border-slate-800">
          <span className="w-3 h-3 rounded-sm bg-slate-600/40 border border-slate-400"></span>
          <span className="text-slate-400 text-[10px]">Hover reveals plots · owned parcels stay lit</span>
        </div>
      </div>

      {/* Selected Plot Quick Bar */}
      {selectedPlot && (
        <div className="absolute bottom-6 right-4 sm:right-16 z-20 max-w-sm w-full bg-[#161d2a]/95 backdrop-blur-md p-4 rounded-2xl border border-slate-700 shadow-2xl transition-all animate-fadeIn">
          <div className="flex items-start justify-between">
            <div className="min-w-0">
              <span className="text-[10px] font-mono text-orange-400 font-bold tracking-wider uppercase">
                {selectedPlot.region} · {selectedPlot.label || selectedPlot.id}
              </span>
              <h3 className="font-bold text-white text-base leading-tight mt-0.5">{selectedPlot.name}</h3>
              <div className="flex items-center gap-2 mt-1.5">
                <span
                  className="text-[10px] font-mono font-bold px-2 py-0.5 rounded border"
                  style={{
                    color: RARITY_META[selectedPlot.rarityKey]?.color || '#94a3b8',
                    borderColor: `${RARITY_META[selectedPlot.rarityKey]?.color || '#94a3b8'}80`,
                    backgroundColor: `${RARITY_META[selectedPlot.rarityKey]?.color || '#94a3b8'}1a`
                  }}
                >
                  {selectedPlot.rarityName || 'Common'}
                </span>
                <span className="text-[11px] font-mono text-slate-400 flex items-center">
                  <Coins className="w-3 h-3 mr-1 text-orange-400" />
                  {formatNum(selectedPlot.price)} NUM
                </span>
              </div>
            </div>
            <button
              onClick={() => setSelectedPlot(null)}
              className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="mt-2.5 py-2 px-3 rounded-xl bg-slate-900/80 border border-slate-800 text-xs flex items-center justify-between">
            <span className="text-slate-400">Ownership:</span>
            <span className="font-semibold text-cyan-300 font-mono">
              {selectedPlot.isClaimed
                ? (selectedPlot.owner || 'Claimed')
                : 'Unclaimed'}
            </span>
          </div>

          {selectedPlot.isClaimed && selectedPlot.building?.incomePerHour > 0 && (
            <div className="mt-2 py-2 px-3 rounded-xl bg-emerald-950/30 border border-emerald-700/40 text-xs flex items-center justify-between">
              <span className="text-slate-400">Income</span>
              <span className="font-semibold text-emerald-300 font-mono">
                {formatIncome(selectedPlot.building.incomePerHour)} NUM/h
                <span className="text-slate-500 ml-1">· L{selectedPlot.building.level}</span>
              </span>
            </div>
          )}

          {selectedPlot.isClaimed && selectedPlot.building && (
            <div className="mt-2 text-[11px] text-slate-400 font-mono truncate">
              {selectedPlot.building.name}
            </div>
          )}

          <div className="mt-3 flex items-center space-x-2">
            <button
              onClick={() => setActiveModal('plot_details')}
              className="flex-1 py-2 px-3 rounded-xl bg-gradient-to-r from-orange-600 to-amber-600 hover:from-orange-500 hover:to-amber-500 text-white font-semibold text-xs shadow-lg shadow-orange-600/30 transition-all flex items-center justify-center space-x-1.5"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>
                {selectedPlot.isClaimed
                  ? 'Inspect Deed'
                  : `Claim Deed (${formatNum(selectedPlot.price)} NUM)`}
              </span>
            </button>
            {selectedPlot.building?.type === 'town_hall' && (
              <button
                onClick={() => setActiveModal('town_hall')}
                className="py-2 px-3 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/50 text-amber-300 font-semibold text-xs transition-colors"
              >
                <Landmark className="w-3.5 h-3.5 inline mr-1" />
                Hall
              </button>
            )}
          </div>
        </div>
      )}

      {/* Bottom-right hint */}
      {!selectedPlot && (
        <div className="absolute bottom-6 right-4 z-10 hidden sm:flex items-center gap-2 px-3 py-2 rounded-xl bg-[#0f141c]/80 backdrop-blur-md border border-slate-800 text-[11px] font-mono text-slate-400">
          <MapPin className="w-3.5 h-3.5 text-orange-400" />
          <span>Hover to inspect · click to open · zoom for borders and labels</span>
        </div>
      )}
    </div>
  );
}
