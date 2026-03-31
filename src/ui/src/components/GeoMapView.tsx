import { useMemo, useEffect, useRef, useState } from 'react';
import { MapContainer, TileLayer, GeoJSON, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

import { Region, GeoLevel, MapViewState, CompetitorSite, SubstationFeature } from '../types';
import { getPolygonsForLevel, getPolygonLoadingState } from '../dataLoader/geoPolygons';
import { LassoSelector } from './LassoSelector';
import { LassoToggleButton } from './LassoToggleButton';
import { CompetitorMapLayer } from './CompetitorMapLayer';
import { MSACompetitorLayer } from './MSACompetitorLayer';
import { SubstationMapLayer } from './SubstationMapLayer';
import { CircuitMapLayer } from './CircuitMapLayer';
import type { CircuitFeature } from './CircuitMapLayer';
import { ColorScale, getColorMode, isRankBased, RANK_LEGEND_ROWS } from '../utils/colorScale';
import type { ZoningDistrict, ZoningColorMode } from '../types/zoning';

// ── Zoning district color helpers ─────────────────────────────────────────────

const ZONE_CATEGORY_COLORS: Record<string, { fill: string; border: string }> = {
  'Commercial':  { fill: '#3b82f6', border: '#1d4ed8' },
  'Industrial':  { fill: '#f97316', border: '#c2410c' },
  'Residential': { fill: '#ef4444', border: '#b91c1c' },
  'Mixed Use':   { fill: '#f59e0b', border: '#b45309' },
};
const ZONE_DEFAULT_COLOR = { fill: '#6b7280', border: '#374151' };

function zoneColor(category: string): { fill: string; border: string } {
  return ZONE_CATEGORY_COLORS[category] ?? ZONE_DEFAULT_COLOR;
}

function evPermittedColor(permitted: boolean): { fill: string; border: string } {
  return permitted
    ? { fill: '#22c55e', border: '#15803d' }
    : { fill: '#ef4444', border: '#b91c1c' };
}

const DEFAULT_STYLE: L.PathOptions = {
  fillOpacity: 0,
  color: '#334155',
  opacity: 0,
  weight: 0,
};

function getRestingOpacity(isSelected: boolean, isMultiSelected: boolean): number {
  if (isSelected) return 0.7;
  if (isMultiSelected) return 0.65;
  return 0.5;
}

// ── Overlay shown while polygon data streams in ──────────────────────────────
function PolyLoadingOverlay({ progress, geoLevel }: { progress: number; geoLevel: GeoLevel }) {
  const known = progress >= 0;
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-900/70 z-[1000] backdrop-blur-sm">
      <div className="bg-white rounded-xl shadow-2xl px-8 py-6 w-72 text-center space-y-4">
        <div className="flex flex-col items-center gap-2">
          <div className="w-10 h-10 rounded-full border-4 border-indigo-200 border-t-indigo-600 animate-spin" />
          <p className="font-semibold text-gray-800 text-sm">Loading {geoLevel} map data</p>
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
  // Zoning Feasibility overlay (Tract level)
  zoningDistricts?: ZoningDistrict[];
  zoningColorMode?: ZoningColorMode;
  onSelectZoningDistrict?: (district: ZoningDistrict) => void;
  // Circuit polylines + Substation pins (Tract level)
  circuits?: CircuitFeature[];
  substations?: SubstationFeature[];
  nearbySubstationIds?: Set<string>;
  emphasizedSubstationIds?: Set<string>;
  highlightedSubstationId?: string | null;
  onClickSubstation?: (s: SubstationFeature) => void;
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

/** Applies a CSS filter to Leaflet's tile pane only — choropleth layers above are unaffected. */
function TileLayerFilter({ filter }: { filter: string }) {
  const map = useMap();
  useEffect(() => {
    const pane = map.getPane('tilePane');
    if (pane) pane.style.filter = filter;
    return () => { if (pane) pane.style.filter = ''; };
  }, [map, filter]);
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
      // Only update ranking choropleth layers (have 'id' in properties).
      // Zoning overlay layers use '_zoning_id' and manage their own styles.
      if (layer.feature && layer.setStyle && layer.feature.properties?.id) {
        try {
          layer.setStyle(fn(layer.feature));
        } catch { /* layer may have been removed */ }
      }
    });
  });

  return null;
}

/**
 * Renders zoning district polygons as a second GeoJSON layer on top of the
 * ranking choropleth. Each district is a separate city-zoning polygon
 * (multiple per census tract). Colored by EV permission or zone category.
 */
function ZoningOverlayLayer({
  districts,
  zoningColorMode,
  onSelectZoningDistrict,
}: {
  districts: ZoningDistrict[];
  zoningColorMode: ZoningColorMode;
  onSelectZoningDistrict?: (district: ZoningDistrict) => void;
}) {
  const map = useMap();
  const colorModeRef = useRef(zoningColorMode);
  colorModeRef.current = zoningColorMode;
  const onSelectRef = useRef(onSelectZoningDistrict);
  onSelectRef.current = onSelectZoningDistrict;

  const districtByZoneId = useMemo(
    () => new Map(districts.map(d => [d.zone_id, d])),
    [districts],
  );
  const districtByZoneIdRef = useRef(districtByZoneId);
  districtByZoneIdRef.current = districtByZoneId;

  const geojsonData = useMemo<GeoJSON.FeatureCollection>(() => ({
    type: 'FeatureCollection',
    features: districts.map(d => d.feature),
  }), [districts]);

  function districtStyle(feature: any): L.PathOptions {
    const d = districtByZoneIdRef.current.get(feature?.properties?.zone_id);
    if (!d) return {};
    const colors = colorModeRef.current === 'zone_category'
      ? zoneColor(d.zone_category)
      : evPermittedColor(d.ev_permitted);
    return {
      fillColor: colors.fill,
      fillOpacity: 0.65,
      color: colors.border,
      weight: 2,
      opacity: 1,
    };
  }

  const styleFnRef = useRef(districtStyle);
  styleFnRef.current = districtStyle;

  // Re-apply styles imperatively on every render so color-mode toggle takes effect
  useEffect(() => {
    const fn = styleFnRef.current;
    map.eachLayer((layer: any) => {
      if (layer.feature && layer.setStyle && layer.feature.properties?.zone_id) {
        try { layer.setStyle(fn(layer.feature)); } catch {}
      }
    });
  });

  const geoJsonKey = districts.map(d => d.zone_id).sort().join('|');

  if (districts.length === 0) return null;

  return (
    <GeoJSON
      key={geoJsonKey}
      data={geojsonData}
      style={districtStyle}
      onEachFeature={(feature, layer) => {
        const d = districtByZoneIdRef.current.get(feature?.properties?.zone_id);
        if (!d) return;
        const permColor = d.ev_permitted ? '#15803d' : '#b91c1c';
        const permLabel = d.ev_permitted ? '✓ Permitted by right' : '✗ Not permitted';
        layer.on({
          mouseover: () => {
            if (!(layer as any)._map) return;
            try { (layer as any).setStyle({ fillOpacity: 0.88, weight: 3 }); } catch {}
          },
          mouseout: () => {
            if (!(layer as any)._map) return;
            try { (layer as any).setStyle(styleFnRef.current(feature)); } catch {}
          },
          click: (e: L.LeafletMouseEvent) => {
            e.originalEvent?.stopPropagation();
            const clicked = districtByZoneIdRef.current.get(feature?.properties?.zone_id);
            if (clicked) onSelectRef.current?.(clicked);
          },
        });
        layer.bindTooltip(
          `<div style="font-size:12px;line-height:1.7;min-width:200px">
            <div style="font-weight:700;font-size:10px;letter-spacing:0.06em;text-transform:uppercase;color:#374151;margin-bottom:3px">⬡ Zoning District</div>
            <div style="font-weight:600;font-size:13px">${d.city}</div>
            <div style="color:#9ca3af;font-size:10px;margin-bottom:6px">Tract ${d.tract_id}</div>
            <div style="margin-bottom:3px">
              <span style="color:#6b7280">Zone code:</span>
              <strong style="margin-left:4px">${d.zone_code}</strong>
              <span style="margin-left:6px;color:#6b7280">(${d.zone_category})</span>
            </div>
            <div style="font-weight:600;color:${permColor}">${permLabel}</div>
          </div>`,
          { sticky: true },
        );
      }}
    />
  );
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
  zoningDistricts,
  zoningColorMode = 'ev_permitted',
  onSelectZoningDistrict,
  circuits = [],
  substations = [],
  nearbySubstationIds,
  emphasizedSubstationIds,
  highlightedSubstationId,
  onClickSubstation,
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

  // Dynamic color scale — recomputes whenever the visible region set changes.
  // Because GeoMapView only receives the regions it should render (e.g. only
  // tracts for the selected county), this is automatically "local" normalization.
  const colorScale = useMemo(
    () => new ColorScale(regions.map(r => r.score), getColorMode(geoLevel)),
    [regions, geoLevel],
  );
  // Ref so geoJsonStyle (stored in styleFnRef) always uses the latest scale
  // without needing to be re-registered as a Leaflet event handler.
  const colorScaleRef = useRef(colorScale);
  colorScaleRef.current = colorScale;

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

    // ── Default ranking style ──────────────────────────────────────────────────
    const fillColor = isRankBased(geoLevel)
      ? colorScaleRef.current.getColorByRank(region.rank, regionByIdRef.current.size)
      : colorScaleRef.current.getColor(region.score);

    if (selectedRegionIdsRef.current.has(region.id)) {
      return { fillColor, fillOpacity: 0.65, color: '#f80015', weight: 3 };
    }
    if (selectedRegionRef.current?.id === region.id) {
      return { fillColor, fillOpacity: 0.7, color: '#ff00b3', weight: 3 };
    }
    if (region.inGeofence) {
      return { fillColor, fillOpacity: 0.3, color: '#8b5cf6', weight: 2, dashArray: '5,5' };
    }
    return { fillColor, fillOpacity: 0.3, color: '#334155', opacity: 0.5, weight: 1 };
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
        <TileLayerFilter filter="grayscale(1) brightness(1.1) contrast(0.9)" />

        {polygonData?.features?.length > 0 && (
          <GeoJSON
            key={geoJsonKey}
            data={polygonData}
            style={geoJsonStyle}
            onEachFeature={onEachFeature}
            renderer={L.canvas({ padding: 0.5 })}
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

        {/* Zoning Feasibility overlay — second GeoJSON layer, district polygons */}
        {zoningDistricts && zoningDistricts.length > 0 && (
          <ZoningOverlayLayer
            districts={zoningDistricts}
            zoningColorMode={zoningColorMode}
            onSelectZoningDistrict={onSelectZoningDistrict}
          />
        )}

        {/* Handle map resize when container size changes */}
        <MapResizeHandler />

        {/* Market Intelligence / Competitor layer - dots at County/Tract only */}
        {geoLevel !== 'MSA' && (
          <CompetitorMapLayer sites={competitorSites} visible={showCompetitorLayer} />
        )}

        {/* Circuit polylines — distribution-level load availability, rendered beneath substation pins */}
        {geoLevel === 'Tract' && circuits.length > 0 && (
          <CircuitMapLayer circuits={circuits} visible={true} />
        )}

        {/* Substation pins — shown when a tract is selected and nearby substations are available */}
        {geoLevel === 'Tract' && substations.length > 0 && (
          <SubstationMapLayer
            substations={substations}
            nearbySubstationIds={nearbySubstationIds}
            emphasizedIds={emphasizedSubstationIds}
            highlightedId={highlightedSubstationId}
            onClickSubstation={onClickSubstation}
          />
        )}

        {/* MSA-level competitor markers with company logos */}
        {geoLevel === 'MSA' && (
          <MSACompetitorLayer
            regions={regions}
            sites={competitorSites}
            visible={showCompetitorLayer}
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

      {/* Zoning overlay mini-legend — appears above the score legend when active */}
      {zoningDistricts && zoningDistricts.length > 0 && (
        <div className="absolute bottom-6 left-2 z-[1000] pointer-events-none select-none" style={{ minWidth: 148, bottom: 'calc(1.5rem + 170px)' }}>
          <div className="bg-white/95 backdrop-blur-sm rounded-lg shadow-md border border-gray-200 px-2.5 py-2">
            <p className="text-[10px] font-semibold text-gray-800 leading-tight mb-1.5">
              Zoning Overlay
            </p>
            {zoningColorMode === 'ev_permitted' ? (
              <div className="space-y-[3px]">
                <div className="flex items-center gap-1.5">
                  <div className="flex-shrink-0 rounded-sm" style={{ width: 12, height: 10, backgroundColor: '#22c55e', border: '1px solid #15803d' }} />
                  <span className="text-[9px] text-gray-600">EV Permitted</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="flex-shrink-0 rounded-sm" style={{ width: 12, height: 10, backgroundColor: '#ef4444', border: '1px solid #b91c1c' }} />
                  <span className="text-[9px] text-gray-600">Not Permitted</span>
                </div>
              </div>
            ) : (
              <div className="space-y-[3px]">
                {([
                  { label: 'Commercial',  fill: '#3b82f6', border: '#1d4ed8' },
                  { label: 'Industrial',  fill: '#f97316', border: '#c2410c' },
                  { label: 'Mixed Use',   fill: '#f59e0b', border: '#b45309' },
                  { label: 'Residential', fill: '#ef4444', border: '#b91c1c' },
                ] as { label: string; fill: string; border: string }[]).map(({ label, fill, border }) => (
                  <div key={label} className="flex items-center gap-1.5">
                    <div className="flex-shrink-0 rounded-sm" style={{ width: 12, height: 10, backgroundColor: fill, border: `1px solid ${border}` }} />
                    <span className="text-[9px] text-gray-600">{label}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Floating color-scale legend — bottom-left, outside MapContainer so z-index is reliable */}
      <div
        className="absolute bottom-6 left-2 z-[1000] pointer-events-none select-none"
        style={{ minWidth: 148 }}
      >
        <div className="bg-white/90 backdrop-blur-sm rounded-lg shadow-md border border-gray-200 px-2.5 py-2">
          {/* Header */}
          <div className="mb-1.5">
            <p className="text-[10px] font-semibold text-gray-800 leading-tight">Score Classification</p>
            <p className="text-[9px] text-gray-400 leading-tight">
              {isRankBased(geoLevel) ? 'Rank-based' : colorScale.mode === 'quantile' ? 'Equal-count' : 'Asymmetric'} · {regions.length} {geoLevel}{regions.length !== 1 ? 's' : ''}
            </p>
          </div>

          {/* Bands — best first */}
          <div className="space-y-[3px]">
            {isRankBased(geoLevel)
              ? RANK_LEGEND_ROWS.map(({ band, color, label, range }) => (
                  <div key={band} className="flex items-center gap-1.5">
                    <div className="flex-shrink-0 rounded-sm" style={{ width: 12, height: 10, backgroundColor: color }} />
                    <span className="text-[9px] text-gray-600 leading-tight whitespace-nowrap">
                      {label}
                      {range && <span className="text-gray-400 ml-1">{range}</span>}
                    </span>
                  </div>
                ))
              : colorScale.getLegendRows().map(({ band, color, label, lo, hi }) => (
                  <div key={band} className="flex items-center gap-1.5">
                    <div className="flex-shrink-0 rounded-sm" style={{ width: 12, height: 10, backgroundColor: color }} />
                    <span className="text-[9px] text-gray-600 leading-tight whitespace-nowrap">
                      {label}
                      <span className="text-gray-400 ml-1">
                        {band === 5 ? `≥${lo}%` : band === 0 ? `<${hi}%` : `${lo}–${hi}%`}
                      </span>
                    </span>
                  </div>
                ))}
          </div>

          {/* Divider + map indicators */}
          <div className="mt-1.5 pt-1.5 border-t border-gray-100 space-y-[3px]">
            <div className="flex items-center gap-1.5">
              <div className="flex-shrink-0 rounded-sm border-2 border-dashed border-purple-500" style={{ width: 12, height: 10 }} />
              <span className="text-[9px] text-gray-500">Geofence</span>
            </div>
            {multiSelectEnabled && (
              <div className="flex items-center gap-1.5">
                <div className="flex-shrink-0 rounded-sm border-2 border-red-500" style={{ width: 12, height: 10 }} />
                <span className="text-[9px] text-gray-500">Selected</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
