import { useMemo, useEffect, useRef, useState } from 'react';
import { MapContainer, TileLayer, GeoJSON, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

import { Region, GeoLevel, MapViewState, CompetitorSite } from '../types';
import { getPolygonsForLevel, getPolygonLoadingState } from '../dataLoader/geoPolygons';
import { LassoSelector } from './LassoSelector';
import { LassoToggleButton } from './LassoToggleButton';
import { CompetitorMapLayer } from './CompetitorMapLayer';
import { MSACompetitorLayer } from './MSACompetitorLayer';

const DEFAULT_STYLE: L.PathOptions = {
  fillOpacity: 0.1,
  color: '#334155',
  opacity: 0.1,
  weight: 1,
};

const VIRIDIS_COLORS = [
  [68, 1, 84],    // purple
  [59, 82, 139],  // blue
  [33, 145, 140], // teal
  [94, 201, 98],  // green
  [253, 231, 37], // yellow
] as const;

function getScoreColor(score: number): string {
  const clamped = Math.max(0, Math.min(1, score));
  const idx = Math.floor(clamped * (VIRIDIS_COLORS.length - 1));
  const frac = clamped * (VIRIDIS_COLORS.length - 1) - idx;

  const [r1, g1, b1] = VIRIDIS_COLORS[idx];
  const [r2, g2, b2] = VIRIDIS_COLORS[Math.min(idx + 1, VIRIDIS_COLORS.length - 1)];

  const r = Math.round(r1 + frac * (r2 - r1));
  const g = Math.round(g1 + frac * (g2 - g1));
  const b = Math.round(b1 + frac * (b2 - b1));

  return `rgb(${r}, ${g}, ${b})`;
}

function getRestingOpacity(isSelected: boolean, isMultiSelected: boolean): number {
  if (isSelected) return 0.7;
  if (isMultiSelected) return 0.65;
  return 0.5;
}

// ── Overlay shown while polygon data streams in ──────────────────────────────
function PolyLoadingOverlay({ progress, geoLevel }: { progress: number; geoLevel: GeoLevel }) {
  const sizeMB: Record<GeoLevel, string> = { MSA: '71 MB', County: '37 MB', Tract: '304 MB' };
  const known = progress >= 0;
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-900/70 z-[1000] backdrop-blur-sm">
      <div className="bg-white rounded-xl shadow-2xl px-8 py-6 w-72 text-center space-y-4">
        <div className="flex flex-col items-center gap-2">
          <div className="w-10 h-10 rounded-full border-4 border-indigo-200 border-t-indigo-600 animate-spin" />
          <p className="font-semibold text-gray-800 text-sm">Loading {geoLevel} map data</p>
          <p className="text-xs text-gray-500">{sizeMB[geoLevel]} — this may take a moment</p>
        </div>
        <div className="space-y-1">
          <div className="h-2 w-full bg-gray-200 rounded-full overflow-hidden">
            <div
              className="h-2 bg-indigo-500 rounded-full transition-all duration-300"
              style={{ width: known ? `${progress}%` : '40%' }}
            />
          </div>
          <p className="text-xs text-gray-500 tabular-nums">
            {known ? `${progress}%` : 'Downloading…'}
          </p>
        </div>
      </div>
    </div>
  );
}

interface GeoMapViewProps {
  regions: Region[];
  geoLevel: GeoLevel;
  selectedRegion: Region | null;
  selectedRegions?: Region[];
  onSelectRegion: (region: Region, ctrlKey?: boolean) => void;
  onAddToCompare?: (region: Region) => void;
  multiSelectEnabled?: boolean;
  onLassoSelect?: (regions: Region[]) => void;
  savedMapView?: MapViewState | null;
  onMapViewChange?: (view: MapViewState) => void;
  lassoEnabled?: boolean;
  onToggleLasso?: () => void;
  // Market Intelligence layer
  competitorSites?: CompetitorSite[];
  showCompetitorLayer?: boolean;
  competitorCategories?: Set<string>;
  competitorCompanies?: Set<string>;
}

/**
 * Auto-zooms to fit regions when the region LIST changes (new data loaded).
 * On first mount with a savedMapView, skips fitBounds (MapContainer already
 * initialized at the saved position). On subsequent data changes, always
 * fitBounds so the user sees the new data.
 */
function MapBoundsController({ regions, polygonData, savedMapView }: {
  regions: Region[];
  polygonData: any;
  savedMapView?: MapViewState | null;
}) {
  const map = useMap();
  const prevKeyRef = useRef<string>('');
  const isFirstRun = useRef(true);

  const regionKey = useMemo(
    () => regions.map(r => r.id).sort().join(','),
    [regions],
  );

  useEffect(() => {
    if (regionKey === prevKeyRef.current) return;

    if (isFirstRun.current) {
      isFirstRun.current = false;
      if (savedMapView) {
        prevKeyRef.current = regionKey;
        return;
      }
    }

    if (regions.length === 0 || !polygonData?.features) return;

    const regionIds = new Set(regions.map(r => r.id));
    const relevantFeatures = polygonData.features.filter(
      (feature: any) => feature?.properties && regionIds.has(feature.properties.id)
    );
    if (relevantFeatures.length === 0) return;

    const geoJsonLayer = L.geoJSON({
      type: 'FeatureCollection',
      features: relevantFeatures,
    } as any);

    const bounds = geoJsonLayer.getBounds();
    if (bounds.isValid()) {
      map.fitBounds(bounds, {
        padding: [30, 30],
        maxZoom: 10,
        animate: true,
        duration: 0.5,
      });
    }

    // Only mark as processed after fitBounds succeeds.
    // If polygon data wasn't ready, we'll retry on the next render.
    prevKeyRef.current = regionKey;
  }, [regionKey, polygonData, map, regions, savedMapView]);

  return null;
}

/**
 * Continuously tracks the map's center and zoom, reporting changes
 * to the parent via onMapViewChange. Uses a ref for the callback
 * so event listeners are registered once and never re-registered.
 */
function MapViewTracker({ onMapViewChange }: { onMapViewChange?: (view: MapViewState) => void }) {
  const map = useMap();
  const callbackRef = useRef(onMapViewChange);
  callbackRef.current = onMapViewChange;

  useEffect(() => {
    const handler = () => {
      const center = map.getCenter();
      callbackRef.current?.({
        center: [center.lat, center.lng],
        zoom: map.getZoom(),
      });
    };

    map.on('moveend', handler);
    map.on('zoomend', handler);

    return () => {
      map.off('moveend', handler);
      map.off('zoomend', handler);
    };
  }, [map]);

  return null;
}

/**
 * Handles map tile re-rendering when the container resizes (expand/collapse panels).
 * Saves center+zoom (container-independent) before resize and restores after,
 * preventing zoom drift that occurs with bounds-based restoration.
 */
function MapResizeHandler() {
  const map = useMap();

  useEffect(() => {
    const container = map.getContainer();
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const resizeObserver = new ResizeObserver(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        // Capture the CURRENT view right before invalidateSize.
        // This reflects any fitBounds that ran during the debounce window,
        // avoiding the race where a stale saved view overwrites fitBounds.
        const center = map.getCenter();
        const zoom = map.getZoom();
        map.invalidateSize({ animate: false });
        map.setView(center, zoom, { animate: false });
        debounceTimer = null;
      }, 200);
    });

    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [map]);

  return null;
}

/**
 * Imperatively updates GeoJSON layer styles when selection changes,
 * without destroying/recreating the entire GeoJSON layer tree.
 */
function MapStyleUpdater({ styleFnRef }: { styleFnRef: React.RefObject<((feature: any) => L.PathOptions) | null> }) {
  const map = useMap();

  // No dependency array: runs on every render so selection-driven style
  // changes are applied immediately without remounting the GeoJSON layer.
  useEffect(() => {
    const fn = styleFnRef.current;
    if (!fn) return;
    map.eachLayer((layer: any) => {
      if (layer.feature && layer.setStyle) {
        try {
          layer.setStyle(fn(layer.feature));
        } catch { /* layer may have been removed */ }
      }
    });
  });

  return null;
}

export function GeoMapView({
  regions,
  geoLevel,
  selectedRegion,
  selectedRegions = [],
  onSelectRegion,
  onAddToCompare,
  multiSelectEnabled = false,
  onLassoSelect,
  savedMapView,
  onMapViewChange,
  lassoEnabled = false,
  onToggleLasso,
  competitorSites = [],
  showCompetitorLayer = false,
  competitorCategories,
  competitorCompanies,
}: GeoMapViewProps) {
  const lassoEnabledRef = useRef(false);
  lassoEnabledRef.current = lassoEnabled;
  const [polygonUpdateTrigger, setPolygonUpdateTrigger] = useState(0);
  const polygonData = getPolygonsForLevel(geoLevel);

  // Refs for values that onEachFeature closures need to stay current
  const selectedRegionRef = useRef(selectedRegion);
  selectedRegionRef.current = selectedRegion;
  const selectedRegionIdsRef = useRef(new Set<string>());
  selectedRegionIdsRef.current = useMemo(
    () => new Set(selectedRegions.map(r => r.id)),
    [selectedRegions],
  );
  const onSelectRegionRef = useRef(onSelectRegion);
  onSelectRegionRef.current = onSelectRegion;
  const regionByIdRef = useRef(new Map<string, Region>());
  regionByIdRef.current = useMemo(
    () => new Map(regions.map(r => [r.id, r])),
    [regions],
  );

  // Polygon loading state — seed from module state so it's correct if already in-flight on mount
  const [polyLoading, setPolyLoading] = useState(() => getPolygonLoadingState(geoLevel).loading);
  const [polyProgress, setPolyProgress] = useState(() => getPolygonLoadingState(geoLevel).progress);

  // Listen for polygon data updates and loading progress
  useEffect(() => {
    const isForMe = (e: Event) => (e as CustomEvent).detail?.level === geoLevel;

    const onLoading = (e: Event) => { if (isForMe(e)) { setPolyLoading(true); setPolyProgress(0); } };
    const onProgress = (e: Event) => {
      if (isForMe(e)) {
        const pct = (e as CustomEvent).detail?.pct ?? -1;
        setPolyProgress(pct);
      }
    };
    const onUpdated = (e: Event) => {
      if (isForMe(e)) {
        setPolyLoading(false);
        setPolyProgress(100);
        setPolygonUpdateTrigger(prev => prev + 1);
      }
    };

    window.addEventListener('frontend:polygons:loading', onLoading);
    window.addEventListener('frontend:polygons:progress', onProgress);
    window.addEventListener('frontend:polygons:updated', onUpdated);

    return () => {
      window.removeEventListener('frontend:polygons:loading', onLoading);
      window.removeEventListener('frontend:polygons:progress', onProgress);
      window.removeEventListener('frontend:polygons:updated', onUpdated);
    };
  }, [geoLevel]);

  // GeoJSON key: only changes when actual DATA changes, NOT selection.
  // Selection styling is handled imperatively by MapStyleUpdater.
  const geoJsonKey = [
    regions.map(r => r.id).join('|'),
    String(polygonUpdateTrigger),
  ].join('::');

  function geoJsonStyle(feature: any): L.PathOptions {
    if (!feature?.properties) return DEFAULT_STYLE;
    const region = regionByIdRef.current.get(feature.properties.id);
    if (!region) return DEFAULT_STYLE;

    const fillColor = getScoreColor(region.score);

    if (selectedRegionIdsRef.current.has(region.id)) {
      return { fillColor, fillOpacity: 0.65, color: '#f80015', weight: 3 };
    }
    if (selectedRegionRef.current?.id === region.id) {
      return { fillColor, fillOpacity: 0.7, color: '#ff00b3', weight: 3 };
    }
    if (region.inGeofence) {
      return { fillColor, fillOpacity: 0.5, color: '#8b5cf6', weight: 2, dashArray: '5,5' };
    }
    return { fillColor, fillOpacity: 0.5, color: '#334155', opacity: 0.5, weight: 1 };
  }

  // Keep a ref to the style function so MapStyleUpdater can call it
  const styleFnRef = useRef<((feature: any) => L.PathOptions) | null>(geoJsonStyle);
  styleFnRef.current = geoJsonStyle;

  function onEachFeature(feature: any, layer: L.Layer) {
    if (!feature?.properties) return;
    const region = regionByIdRef.current.get(feature.properties.id);
    if (!region) return;

    layer.on({
      mouseover: () => {
        if (!(layer as any)._map) return;
        try { (layer as any).setStyle({ fillOpacity: 0.75 }); } catch { /* layer may have been removed */ }
      },
      mouseout: () => {
        if (!(layer as any)._map) return;
        const r = regionByIdRef.current.get(feature.properties.id);
        if (!r) return;
        const opacity = getRestingOpacity(
          selectedRegionRef.current?.id === r.id,
          selectedRegionIdsRef.current.has(r.id),
        );
        try { (layer as any).setStyle({ fillOpacity: opacity }); } catch { /* layer may have been removed */ }
      },
      click: (e: L.LeafletMouseEvent) => {
        if (lassoEnabledRef.current) return;
        onSelectRegionRef.current(region, multiSelectEnabled && (e.originalEvent.ctrlKey || e.originalEvent.metaKey));
      },
    });

    layer.bindTooltip(
      `
      <div style="font-size:12px">
        <strong>${region.name}</strong><br/>
        Rank: #${region.rank}<br/>
        Score: ${(region.score * 100.0).toFixed(0)}%<br/>
        Customers: ${region.customerCount.toLocaleString()}
        ${region.inGeofence ? '<br/><span style="color:#7c3aed">✓ Inside customer zone</span>' : ''}
      </div>
      `,
      { sticky: true }
    );
  }

  return (
    <div className="relative h-full w-full" style={{ zIndex: 0 }}>
      {/* Polygon loading overlay */}
      {polyLoading && <PolyLoadingOverlay progress={polyProgress} geoLevel={geoLevel} />}

      {/* Map */}
      <MapContainer
        center={savedMapView?.center ?? [37.8, -96]}
        zoom={savedMapView?.zoom ?? 3}
        minZoom={3}
        maxZoom={19}
        className="h-full w-full"
        style={{ zIndex: 0 }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {polygonData?.features?.length > 0 && (
          <GeoJSON
            key={geoJsonKey}
            data={polygonData}
            style={geoJsonStyle}
            onEachFeature={onEachFeature}
          />
        )}

        {multiSelectEnabled && onLassoSelect && (
          <>
            <LassoSelector
              enabled={lassoEnabled}
              regions={regions}
              onLassoSelect={onLassoSelect}
            />
            <LassoToggleButton
              active={lassoEnabled}
              onToggle={() => onToggleLasso?.()}
            />
          </>
        )}

        {/* Auto-zoom to fit current regions (skips if savedMapView present) */}
        <MapBoundsController regions={regions} polygonData={polygonData} savedMapView={savedMapView} />

        {/* Track center+zoom and report to parent for persistence */}
        <MapViewTracker onMapViewChange={onMapViewChange} />

        {/* Imperative style updates when selection changes (no GeoJSON remount) */}
        <MapStyleUpdater styleFnRef={styleFnRef} />

        {/* Handle map resize when container size changes */}
        <MapResizeHandler />

        {/* Market Intelligence / Competitor layer - color pins for County/Tract */}
        {geoLevel !== 'MSA' && (
          <CompetitorMapLayer sites={competitorSites} visible={showCompetitorLayer} />
        )}

        {/* MSA-level competitor markers with company logos */}
        {geoLevel === 'MSA' && (
          <MSACompetitorLayer
            regions={regions}
            visible={showCompetitorLayer}
            selectedCategories={competitorCategories}
            selectedCompanies={competitorCompanies}
          />
        )}
      </MapContainer>

      {/* Info Banner */}
      <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-blue-50 border border-blue-200 rounded-lg px-2 py-1.5 z-[1000] max-w-[90%] pointer-events-none">
        <p className="text-[10px] text-blue-900 text-center whitespace-nowrap overflow-hidden text-ellipsis">
          {lassoEnabled ? (
            <><span className="font-medium">Lasso:</span> Draw to select • Click toggle to exit</>
          ) : (
            <><span className="font-medium">Tip:</span> Drag to pan • Scroll to zoom • Click regions
            {multiSelectEnabled && ' • Ctrl+click to multi-select'}</>
          )}
        </p>
      </div>
    </div>
  );
}
