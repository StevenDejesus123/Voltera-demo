import { useState, useEffect, useMemo, useRef, Dispatch, SetStateAction } from 'react';
import { FilterPanel } from './FilterPanel';
import { GeoPanel } from './GeoPanel';
import { UtilityGridPanel, defaultSubstationFilters, getEmphasisIds } from './UtilityGridPanel';
import type { SubstationFilters } from './UtilityGridPanel';
import { loadOverrides, applyOverrides, saveOverride, removeOverride, exportOverridesJson } from '../utils/substationOverrides';
import type { OverrideMap } from '../utils/substationOverrides';
import type { CircuitFeature, SelectedFeeder, CircuitColorMode } from './CircuitMapLayer';
import { ExplainabilityPanel } from './ExplainabilityPanel';
import { SavedViewsPanel } from './SavedViewsPanel';
import { TimelineSlider } from './TimelineSlider';
import { CompetitorTrackerPanel } from './CompetitorTrackerPanel';
import { SubstationOverridePanel } from './SubstationOverridePanel';
import { SubstationOverrideListPanel } from './SubstationOverrideListPanel';
import { GeoLevel, Segment, Region, RegionDetails, WhatIfScenario, MapViewState, SubstationFeature } from '../types';
import { getMockRegions, getCountiesForMSA, getTractsForCounties, loadLevelOnDemand, loadDetailsOnDemand, loadTractDetailsForCounty, loadTractRegionsForCounty, getRegionDetails } from '../dataLoader/frontendLoader';
import { loadPolygonsOnDemand, loadTractPolygonsForCounty } from '../dataLoader/geoPolygons';
import { getCompetitorSites, getCompetitorSegments, loadCompetitorData, filterCompetitorSites } from '../dataLoader/competitorLoader';
import { loadSalesforceData } from '../dataLoader/salesforceLoader';
import { msaNamesMatch, isNearCoordinates } from '../utils/msaMatch';

/** Decode compact circuit JSON (short keys) back to CircuitFeature. */
function decodeCircuit(r: any): CircuitFeature {
  return {
    id:             r.id,
    utility:        r.u  ?? '',
    circuitName:    r.cn ?? '',
    substationName: r.sn ?? '',
    voltageKv:      r.vk ?? null,
    loadAvailKw:    r.lk ?? null,
    pvHostingKw:    r.pk ?? null,
    coords:         r.c,
  };
}

/**
 * Handles multi-select toggle logic for a list of regions.
 * With ctrlKey: toggles item in the multi-select list, clears single selection.
 * Without ctrlKey: sets single selection, clears multi-select list.
 */
function handleMultiSelectToggle(
  region: Region,
  ctrlKey: boolean,
  setSingle: Dispatch<SetStateAction<Region | null>>,
  setMulti: Dispatch<SetStateAction<Region[]>>,
): void {
  if (ctrlKey) {
    setMulti(prev => {
      const alreadySelected = prev.some(r => r.id === region.id);
      return alreadySelected
        ? prev.filter(r => r.id !== region.id)
        : [...prev, region];
    });
    setSingle(null);
  } else {
    setSingle(region);
    setMulti([]);
  }
}

function getTractPanelTitle(selectedCounties: Region[], selectedCounty: Region | null): string {
  if (selectedCounties.length > 1) return `Tracts in ${selectedCounties.length} Counties`;
  if (selectedCounties.length === 1) return `Tracts in ${selectedCounties[0].name}`;
  if (selectedCounty) return `Tracts in ${selectedCounty.name}`;
  return 'Tracts';
}

function getBounds(items: Region[]): [number, number] {
  if (items.length === 0) return [0, 0];
  const ranks = items.map((r) => (typeof r.rank === 'number' ? r.rank : 0)).filter(Boolean);
  if (ranks.length === 0) return [0, 0];
  return [Math.min(...ranks), Math.max(...ranks)];
}

function isInRange(rank: number, range: [number, number]): boolean {
  return rank >= range[0] && rank <= range[1];
}

function matchesIdFilter(id: string, selectedIds: string[]): boolean {
  return selectedIds.length === 0 || selectedIds.includes(id);
}

function reRankByOriginalOrder(regions: Region[]): Region[] {
  return [...regions]
    .sort((a, b) => a.rank - b.rank)
    .map((r, idx) => ({ ...r, rank: idx + 1 }));
}

export function MapExplorer() {
  const [segment, setSegment] = useState<Segment>('AV');
  const [rankingThreshold, setRankingThreshold] = useState(25);
  const [msaRange, setMsaRange] = useState<[number, number]>([0, 0]);
  const [countyRange, setCountyRange] = useState<[number, number]>([0, 0]);
  const [tractRange, setTractRange] = useState<[number, number]>([0, 0]);
  const [selectedMSA, setSelectedMSA] = useState<Region | null>(null);
  const [selectedCounty, setSelectedCounty] = useState<Region | null>(null);
  const [selectedCounties, setSelectedCounties] = useState<Region[]>([]);
  const [selectedTract, setSelectedTract] = useState<Region | null>(null);
  const [selectedTracts, setSelectedTracts] = useState<Region[]>([]);
  const [loadingCounties, setLoadingCounties] = useState(false);
  const [loadingTracts, setLoadingTracts] = useState(false);
  const [showSavedViews, setShowSavedViews] = useState(false);
  const [selectedDate, setSelectedDate] = useState(new Date('2026-01-19'));
  const [activeScenario, setActiveScenario] = useState<WhatIfScenario | null>(null);
  const [selectedMSAIds, setSelectedMSAIds] = useState<string[]>([]);
  const [selectedCountyIds, setSelectedCountyIds] = useState<string[]>([]);
  const [selectedTractIds, setSelectedTractIds] = useState<string[]>([]);
  const [expandedPanel, setExpandedPanel] = useState<GeoLevel | null>(null);
  const [filterCollapsed, setFilterCollapsed] = useState(false);
  const [regionAnalysisCollapsed, setRegionAnalysisCollapsed] = useState(true);

  // Market Intelligence / Competitor Tracker state
  const [showCompetitorPanel, setShowCompetitorPanel] = useState(false);
  const [showCompetitorLayer, setShowCompetitorLayer] = useState(true);
  const [competitorIncludeCompanies, setCompetitorIncludeCompanies] = useState<Set<string>>(new Set());
  const [competitorExcludeCompanies, setCompetitorExcludeCompanies] = useState<Set<string>>(new Set());
  const [competitorCompanyMode, setCompetitorCompanyMode] = useState<'include' | 'exclude'>('include');
  // Active company set based on current mode
  const competitorCompanies = competitorCompanyMode === 'include' ? competitorIncludeCompanies : competitorExcludeCompanies;
  const setCompetitorCompanies = competitorCompanyMode === 'include' ? setCompetitorIncludeCompanies : setCompetitorExcludeCompanies;
  const [competitorCategories, setCompetitorCategories] = useState<Set<string>>(new Set());
  const [competitorStatuses, setCompetitorStatuses] = useState<Set<string>>(new Set());
  const [competitorMSAs, setCompetitorMSAs] = useState<Set<string>>(new Set());
  const [competitorStates, setCompetitorStates] = useState<Set<string>>(new Set());
  const [competitorSegments, setCompetitorSegments] = useState<Set<string>>(new Set());
  const [competitorDataLoaded, setCompetitorDataLoaded] = useState(false);

  // Substation data — all substations loaded once, nearby derived from selected tract details
  const [allSubstations, setAllSubstations] = useState<SubstationFeature[]>([]);
  const [highlightedSubstationId, setHighlightedSubstationId] = useState<string | null>(null);

  // Circuit polyline data — loaded on-demand per county (same pattern as tract_polygons/)
  const [circuitsByCounty, setCircuitsByCounty] = useState<Record<string, CircuitFeature[]>>({});
  const circuitCountyFetchedRef = useRef<Set<string>>(new Set());
  const [selectedFeeder, setSelectedFeeder] = useState<SelectedFeeder | null>(null);
  const [circuitColorMode, setCircuitColorMode] = useState<CircuitColorMode>('capacity');

  // Utility Grid panel + filter state
  const [showUtilityPanel, setShowUtilityPanel] = useState(false);
  const [showSubstationLayer, setShowSubstationLayer] = useState(true);
  const [showAllSubstations, setShowAllSubstations] = useState(false);
  const [substationFilters, setSubstationFilters] = useState<SubstationFilters>(defaultSubstationFilters());

  // Voltera override layer — persisted in localStorage
  const [substationOverrides, setSubstationOverrides] = useState<OverrideMap>(() => loadOverrides());
  const [editingSubstationId, setEditingSubstationId] = useState<string | null>(null);
  const [showOverrideList, setShowOverrideList] = useState(false);

  useEffect(() => {
    fetch('/data/exports/substations.json')
      .then(r => r.ok ? r.json() : [])
      .then((data: SubstationFeature[]) => setAllSubstations(data))
      .catch(() => {});
  }, []);

  // Load circuits on-demand for the selected tract's county (same pattern as tract_polygons/)
  useEffect(() => {
    const countyId = (selectedTract as any)?.countyID as string | undefined;
    if (!countyId || circuitCountyFetchedRef.current.has(countyId)) return;
    circuitCountyFetchedRef.current.add(countyId);
    fetch(`/data/exports/circuits/county_${countyId}.json`)
      .then(r => r.ok ? r.json() : [])
      .then((data: any[]) =>
        setCircuitsByCounty(prev => ({ ...prev, [countyId]: data.map(decodeCircuit) }))
      )
      .catch(() => {});
  }, [selectedTract]);

  // Circuits near the selected tract only — filtered from the county data by bounding box.
  // ±0.18° ≈ 20 km captures the full surrounding grid context for a selected tract.
  const allCircuits = useMemo<CircuitFeature[]>(() => {
    const countyId = (selectedTract as any)?.countyID as string | undefined;
    if (!countyId || !selectedTract) return [];
    const county = circuitsByCounty[countyId];
    if (!county) return [];

    const { lat, lng } = selectedTract;
    if (lat == null || lng == null) return county; // no centroid — show all

    const D = 0.18; // ~20 km bounding box half-width
    const minLat = lat - D, maxLat = lat + D;
    const minLng = lng - D, maxLng = lng + D;

    return county.filter(c =>
      c.coords.some(line =>
        line.some(([cLng, cLat]) =>
          cLat >= minLat && cLat <= maxLat && cLng >= minLng && cLng <= maxLng
        )
      )
    );
  }, [selectedTract, circuitsByCounty]);

  // Clear substation highlight when the selected tract changes
  useEffect(() => { setHighlightedSubstationId(null); }, [selectedTract?.id]);

  // Apply Voltera overrides on top of raw substation data
  const allSubstationsWithOverrides = useMemo(
    () => applyOverrides(allSubstations, substationOverrides),
    [allSubstations, substationOverrides],
  );

  // Emphasis IDs — substations matching the active filters; empty = no filter active
  const emphasizedSubstationIds = useMemo(
    () => getEmphasisIds(allSubstationsWithOverrides, substationFilters),
    [allSubstationsWithOverrides, substationFilters],
  );

  // Count of emphasized substations (for the panel header)
  const emphasizedCount = emphasizedSubstationIds.size;

  // Filter circuits by utility and min-capacity threshold only.
  // Capacity tier quick-select is substation-only — circuits are not hidden by tier.
  const filteredCircuits = useMemo<CircuitFeature[]>(() => {
    const utilityActive = substationFilters.utilities.size > 0;
    const minKw = substationFilters.minCircuitCapacityKw;
    if (!utilityActive && minKw === 0) return allCircuits;
    return allCircuits.filter(c => {
      if (utilityActive && !substationFilters.utilities.has(c.utility)) return false;
      if (minKw > 0 && (c.loadAvailKw == null || c.loadAvailKw < minKw)) return false;
      return true;
    });
  }, [allCircuits, substationFilters]);


  // Segments excluded from the default Market Intelligence filter.
  // Pete requested these be pre-filtered so he doesn't manually deselect each session.
  // The toggle buttons remain — user can re-enable any segment if needed.
  const EXCLUDED_SEGMENTS = new Set([
    '3rd Party-Owned School',
    'Automotive',
    'Campus',
    'Charging',
    'Drayage',
    'Heavy Duty-Goods',
    'Heavy Duty-Networks',
    'Heavy Duty-People',
    'Last Mile',
    'Light Duty-Goods',
    'Light Duty-Networks',
    'Transit',
    'Utilities',
  ]);

  // Load competitor + Salesforce data on mount and listen for load events
  useEffect(() => {
    loadCompetitorData();
    loadSalesforceData();
    const handleLoaded = () => {
      setCompetitorDataLoaded(true);
      // Set default segment filter: include all segments EXCEPT excluded ones
      const allSegments = getCompetitorSegments();
      const defaults = allSegments.filter(s => !EXCLUDED_SEGMENTS.has(s));
      setCompetitorSegments(new Set(defaults));
    };
    window.addEventListener('competitor:loaded', handleLoaded);
    return () => window.removeEventListener('competitor:loaded', handleLoaded);
  }, []);

  // Get filtered competitor sites (re-run when data loads or filters change)
  const competitorSites = useMemo(() => {
    const all = getCompetitorSites();
    return filterCompetitorSites(all, {
      companies: competitorCompanies,
      companyMode: competitorCompanyMode,
      categories: competitorCategories,
      statuses: competitorStatuses,
      msas: competitorMSAs,
      states: competitorStates,
      segments: competitorSegments,
    });
  }, [competitorCompanies, competitorCompanyMode, competitorCategories, competitorStatuses, competitorMSAs, competitorStates, competitorSegments, competitorDataLoaded]);

  // Competitor sites scoped to the selected MSA for county/tract pin display.
  // The global `competitorSites` list covers all geographies; narrowing to the
  // selected MSA ensures pins match the logos shown in the MSA view.
  const msaCompetitorSites = useMemo(() => {
    if (!selectedMSA) return [];
    return competitorSites.filter(s => {
      // Fuzzy match on MSA name
      if (s.msa && msaNamesMatch(s.msa, selectedMSA.name)) return true;
      // Fallback: include sites without MSA but near the selected MSA centroid
      if (!s.msa && s.lat != null && s.lng != null) {
        return isNearCoordinates(s.lat, s.lng, selectedMSA.lat, selectedMSA.lng);
      }
      return false;
    });
  }, [competitorSites, selectedMSA?.id]);

  // Holds factors+details for the currently-selected region (loaded from sidecar)
  const [selectedRegionDetails, setSelectedRegionDetails] = useState<{ factors: any[]; details: any } | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsProgress, setDetailsProgress] = useState(-1);
  // Incrementing this forces MapExplorer to re-render and re-read the data cache
  const [dataLoadTick, setDataLoadTick] = useState(0);

  // Derive nearby substations for the currently selected tract from its loaded details.
  // Depends on selectedRegionDetails so it re-runs after the county chunk finishes loading.
  const nearbySubstations = useMemo<SubstationFeature[]>(() => {
    const region = selectedTract;
    if (!region) return [];
    const d = getRegionDetails(region.id, region.geoLevel);
    const nearby = d?.details?.nearbySubstations;
    if (Array.isArray(nearby) && nearby.length > 0) return nearby as SubstationFeature[];
    // Fallback: haversine filter on allSubstations if details not yet loaded
    if (allSubstations.length === 0 || !region.lat || !region.lng) return [];
    const R = 6371000;
    const toRad = (deg: number) => (deg * Math.PI) / 180;
    return allSubstations
      .map(s => {
        const dLat = toRad(s.lat - region.lat);
        const dLng = toRad(s.lng - region.lng);
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(region.lat)) * Math.cos(toRad(s.lat)) * Math.sin(dLng / 2) ** 2;
        const distM = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return { ...s, distM: Math.round(distM) };
      })
      .filter(s => s.distM! <= 50000)
      .sort((a, b) => (a.distM ?? 0) - (b.distM ?? 0));
  }, [selectedTract, selectedRegionDetails, allSubstations]);

  // Set of nearby substation IDs for the map layer to pulse-highlight
  const nearbySubstationIds = useMemo(
    () => new Set(nearbySubstations.map(s => s.id)),
    [nearbySubstations],
  );

  // Visible substations passed to the map — pre-filtered so the `substations`
  // prop array itself shrinks when a tract is active, preventing Leaflet stale
  // DivIcon markers from lingering (e.g. NorCal pins after selecting an LA tract).
  const visibleSubstations = useMemo(() => {
    if (!showSubstationLayer) return [];
    if (selectedTract != null && !showAllSubstations) return nearbySubstations;
    return allSubstationsWithOverrides;
  }, [showSubstationLayer, selectedTract, showAllSubstations, nearbySubstations, allSubstationsWithOverrides]);

  // Pending tract restoration from saved view — applied in two stages:
  //   Stage 1 (county data loads): set selectedCounty + trigger tract load
  //   Stage 2 (tract data loads):  apply selectedTracts / selectedTract
  const pendingTractRestoration = useRef<{ tractIds: string[]; countyId: string; msaId: string } | null>(null);

  // Re-render when County or Tract data arrives from the async fetch
  useEffect(() => {
    const handler = () => setDataLoadTick((n) => n + 1);
    window.addEventListener('frontend:regions:updated', handler as EventListener);
    return () => window.removeEventListener('frontend:regions:updated', handler as EventListener);
  }, []);

  // Restore pending tract selection from a saved view.
  //
  // Two things must be true before we can apply the selection:
  //   1. selectedCounty must be the right county
  //   2. tract data must be in the cache
  //
  // On a cold load (F5), county data arrives asynchronously and selectedCounty is
  // initially null. We resolve the county directly from the cache (effectiveCounty)
  // so we can fall through to the tract check in the same effect run — this handles
  // the React 18 batch case where county + tract data both arrive before a re-render,
  // which would otherwise leave Stage 2 permanently skipped because dataLoadTick
  // only incremented once and selectedCounty was still null in that render.
  useEffect(() => {
    if (!pendingTractRestoration.current) return;
    const { tractIds, countyId, msaId } = pendingTractRestoration.current;

    // Resolve the county — prefer already-set state, fall back to a direct cache lookup.
    // We use a local variable so we can fall through to the tract step without waiting
    // for the setSelectedCounty state update to propagate.
    //
    // IMPORTANT: use the reranked county (rank = 1..N within the MSA) rather than the raw
    // cache county (global rank). The [countyRange] effect checks selectedCounty.rank against
    // countyRange = [1, N]; if we use the global rank it may fall outside [1, N] and be cleared.
    let effectiveCounty = selectedCounty?.id === countyId ? selectedCounty : null;
    if (!effectiveCounty) {
      const allCounties = getCountiesForMSA(msaId, segment, rankingThreshold, null, []);
      const rawCounty = allCounties.find(c => c.id === countyId);
      if (!rawCounty) return; // County data not yet loaded — wait for next dataLoadTick
      const reranked = reRankByOriginalOrder(allCounties);
      effectiveCounty = reranked.find(c => c.id === countyId) ?? rawCounty;
      setSelectedCounty(effectiveCounty);
      loadTractPolygonsForCounty(countyId);
      loadTractRegionsForCounty(countyId);
      // Fall through — if tract data is already in cache (fast / browser-cached load),
      // apply the selection right now rather than waiting for another dataLoadTick.
    }

    // County is resolved — apply tract selections if data is ready.
    const allTracts = getTractsForCounties([countyId], segment, rankingThreshold, null, []);
    if (allTracts.length === 0) return; // Tract data not yet loaded — wait for next tick
    const tractsToSelect = allTracts.filter(t => tractIds.includes(t.id));
    if (tractsToSelect.length > 0) {
      pendingTractRestoration.current = null;
      if (tractsToSelect.length === 1) {
        setSelectedTract(tractsToSelect[0]);
        setSelectedTracts([]);
      } else {
        setSelectedTracts(tractsToSelect);
        setSelectedTract(null);
      }
      setRegionAnalysisCollapsed(false);
    }
  // selectedCounty?.id: re-run when county state settles so Stage 2 can proceed
  // even if county+tract arrived in separate ticks and county was set between them.
  }, [dataLoadTick, selectedCounty?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Track details loading progress and populate selectedRegionDetails when done
  useEffect(() => {
    const activeRegion = selectedTract ?? selectedCounty ?? selectedMSA;
    const isMultiActive = selectedCounties.length > 1 || selectedTracts.length > 1;

    const onLoading = () => {
      if (activeRegion || isMultiActive) { setDetailsLoading(true); setDetailsProgress(0); }
    };
    const onProgress = (e: Event) => {
      setDetailsProgress((e as CustomEvent).detail?.pct ?? -1);
    };
    const onUpdated = () => {
      if (!activeRegion && !isMultiActive) return;
      if (activeRegion) {
        const d = getRegionDetails(activeRegion.id, activeRegion.geoLevel);
        if (d) setSelectedRegionDetails(d);
      }
      // The `:updated` event itself means loading is done — don't re-check module state
      // because loadDetails fires this event before its `finally` block runs.
      setDetailsLoading(false);
      setDetailsProgress(100);
    };

    window.addEventListener('frontend:details:loading', onLoading);
    window.addEventListener('frontend:details:progress', onProgress);
    window.addEventListener('frontend:details:updated', onUpdated);
    return () => {
      window.removeEventListener('frontend:details:loading', onLoading);
      window.removeEventListener('frontend:details:progress', onProgress);
      window.removeEventListener('frontend:details:updated', onUpdated);
    };
  }, [selectedTract, selectedCounty, selectedMSA, selectedCounties.length, selectedTracts.length]);

  // Trigger details sidecar load when multi-select activates (lasso won't hit the single-region effect)
  // Tracts take priority (deeper drill-down) to match multi-region render order
  useEffect(() => {
    if (selectedTracts.length > 1) {
      // Tract uses per-county chunks — load for all unique counties in the selection
      const countyIds = [...new Set(selectedTracts.map(t => (t as any).countyID).filter(Boolean))];
      countyIds.forEach(cid => loadTractDetailsForCounty(cid));
      if (!getRegionDetails(selectedTracts[0].id, selectedTracts[0].geoLevel)) {
        setDetailsLoading(true);
        setDetailsProgress(0);
      }
    } else if (selectedCounties.length > 1) {
      loadDetailsOnDemand(selectedCounties[0].geoLevel);
      if (!getRegionDetails(selectedCounties[0].id, selectedCounties[0].geoLevel)) {
        setDetailsLoading(true);
        setDetailsProgress(0);
      }
    }
  }, [selectedCounties.length, selectedTracts.length]);

  // Persisted/saved map views for each panel
  const [msaMapView, setMsaMapView] = useState<MapViewState | null>(null);
  const [countyMapView, setCountyMapView] = useState<MapViewState | null>(null);
  const [tractMapView, setTractMapView] = useState<MapViewState | null>(null);

  // Get raw data for each level (full lists)
  const msasRaw = getMockRegions('MSA', segment, rankingThreshold, activeScenario, selectedMSAIds);

  const countiesRaw = selectedMSA
    ? reRankByOriginalOrder(getCountiesForMSA(selectedMSA.id, segment, rankingThreshold, activeScenario, selectedCountyIds))
    : [];

  // County IDs for tract lookup (multi-select union or single county)
  let countyIdsForTracts: string[] = [];
  if (selectedCounties.length > 0) {
    countyIdsForTracts = selectedCounties.map(c => c.id);
  } else if (selectedCounty) {
    countyIdsForTracts = [selectedCounty.id];
  }

  const tractsRaw = countyIdsForTracts.length > 0
    ? reRankByOriginalOrder(getTractsForCounties(countyIdsForTracts, segment, rankingThreshold, activeScenario, selectedTractIds))
    : [];

  // Initialize ranges when raw data loads
  useEffect(() => {
    const [minR, maxR] = getBounds(msasRaw);
    setMsaRange(([curMin, curMax]) => (curMin === 0 && curMax === 0 ? [minR, maxR] : [Math.min(curMin, minR), Math.max(curMax, maxR)]));
  }, [msasRaw.length]);

  useEffect(() => {
    const [minR, maxR] = getBounds(countiesRaw);
    if (selectedMSA) {
      setCountyRange([minR, maxR]);
    } else {
      setCountyRange(([curMin, curMax]) => (curMin === 0 && curMax === 0 ? [minR, maxR] : [Math.min(curMin, minR), Math.max(curMax, maxR)]));
    }
  }, [countiesRaw.length, selectedMSA]);

  useEffect(() => {
    const [minR, maxR] = getBounds(tractsRaw);
    if (selectedCounty || selectedCounties.length > 0) {
      setTractRange([minR, maxR]);
    } else {
      setTractRange(([curMin, curMax]) => (curMin === 0 && curMax === 0 ? [minR, maxR] : [Math.min(curMin, minR), Math.max(curMax, maxR)]));
    }
  }, [tractsRaw.length, selectedCounty, selectedCounties.length]);

  // Clear selections if they fall outside the current ranges
  useEffect(() => {
    if (selectedMSA && !isInRange(selectedMSA.rank, msaRange)) {
      setSelectedMSA(null);
      setSelectedCounty(null);
      setSelectedTract(null);
    }
  }, [msaRange]);

  useEffect(() => {
    if (selectedCounty && !isInRange(selectedCounty.rank, countyRange)) {
      setSelectedCounty(null);
      setSelectedTract(null);
    }
  }, [countyRange]);

  useEffect(() => {
    if (selectedTract && !isInRange(selectedTract.rank, tractRange)) {
      setSelectedTract(null);
    }
  }, [tractRange]);

  // Lazy-load County data + polygons when an MSA is first selected
  useEffect(() => {
    if (selectedMSA) {
      loadLevelOnDemand('County');
      loadPolygonsOnDemand('County');
    }
  }, [selectedMSA?.id]);

  // Auto-expand region analysis when an MSA is first selected
  useEffect(() => {
    if (selectedMSA) setRegionAnalysisCollapsed(false);
  }, [selectedMSA?.id]);

  // Lazy-load Tract data + per-county polygons when a County is first selected
  useEffect(() => {
    if (countyIdsForTracts.length > 0) {
      countyIdsForTracts.forEach(id => {
        loadTractPolygonsForCounty(id);
        loadTractRegionsForCounty(id);
      });
    }
  }, [selectedCounty?.id, selectedCounties.length]);

  // Lazy-load details sidecar when a region is selected; set state immediately if already cached
  useEffect(() => {
    const region = selectedTract ?? selectedCounty ?? selectedMSA;
    if (!region) {
      setSelectedRegionDetails(null);
      return;
    }
    // Tract uses per-county chunks; others load monolithic sidecar
    if (region.geoLevel === 'Tract' || (region as any).geoLevel?.toLowerCase() === 'tract') {
      loadTractDetailsForCounty((region as any).countyID);
    } else {
      loadDetailsOnDemand(region.geoLevel);
    }
    // If already in cache, populate immediately without waiting for the event
    const cached = getRegionDetails(region.id, region.geoLevel);
    setSelectedRegionDetails(cached);
  }, [selectedTract?.id, selectedCounty?.id, selectedMSA?.id]);

  // Apply filtering by ranges and selected ids
  const msas = msasRaw.filter((r) => {
    const rank = typeof r.rank === 'number' ? r.rank : 0;
    return isInRange(rank, msaRange) && matchesIdFilter(r.id, selectedMSAIds);
  });

  const counties = countiesRaw.filter((r) => {
    const rank = typeof r.rank === 'number' ? r.rank : 0;
    return isInRange(rank, countyRange) && matchesIdFilter(r.id, selectedCountyIds);
  });

  const tracts = tractsRaw.filter((r) => {
    const rank = typeof r.rank === 'number' ? r.rank : 0;
    if (!isInRange(rank, tractRange) || !matchesIdFilter(r.id, selectedTractIds)) return false;
    return true;
  });

  function handleSelectMSA(msa: Region): void {
    setSelectedMSA(msa);
    setSelectedCounty(null);
    setSelectedCounties([]);
    setSelectedTract(null);
    setLoadingCounties(true);
    setLoadingTracts(false);
    setCountyMapView(null);
    setTractMapView(null);
  }

  function handleSelectCounty(county: Region, ctrlKey?: boolean): void {
    handleMultiSelectToggle(county, !!ctrlKey, setSelectedCounty, setSelectedCounties);
    setSelectedTract(null);
    setSelectedTracts([]);
    setSelectedTractIds([]);
    setLoadingTracts(true);
    setTractMapView(null);
  }

  function handleSelectTract(tract: Region, ctrlKey?: boolean): void {
    handleMultiSelectToggle(tract, !!ctrlKey, setSelectedTract, setSelectedTracts);
  }

  function handleCountyLassoSelect(regions: Region[]): void {
    setSelectedCounties(regions);
    setSelectedCounty(null);
    setSelectedTract(null);
    setSelectedTracts([]);
    setSelectedTractIds([]);
    setLoadingTracts(true);
    setTractMapView(null);
  }

  function handleTractLassoSelect(regions: Region[]): void {
    setSelectedTracts(regions);
    setSelectedTract(null);
  }

  // Clear loading flags when data arrives or parent selection is removed
  useEffect(() => {
    setLoadingCounties(false);
  }, [counties, selectedMSA]);

  useEffect(() => {
    setLoadingTracts(false);
  }, [tracts, selectedCounty, selectedCounties]);

  function handleExpandPanel(level: GeoLevel): void {
    setExpandedPanel(expandedPanel === level ? null : level);
  }

  function renderRegionAnalysisPanel(): React.ReactNode {
    const collapseProps = {
      collapsed: regionAnalysisCollapsed,
      onToggleCollapse: () => setRegionAnalysisCollapsed(prev => !prev),
    };

    // Multi-region mode (lasso or ctrl+click) — tracts take priority (deeper drill-down)
    let multiRegions: Region[] = [];
    if (selectedTracts.length > 1) {
      multiRegions = selectedTracts;
    } else if (selectedCounties.length > 1 && !selectedTract && selectedTracts.length === 0) {
      multiRegions = selectedCounties;
    }

    if (multiRegions.length > 1) {
      const allMultiDetails = multiRegions.map(r => {
        const d = getRegionDetails(r.id, r.geoLevel);
        return d?.details as RegionDetails | undefined;
      });
      return (
        <ExplainabilityPanel
          regions={multiRegions}
          allDetails={allMultiDetails}
          isLoadingDetails={detailsLoading}
          onClose={() => {
            setSelectedCounties([]);
            setSelectedTracts([]);
            setSelectedCounty(null);
            setSelectedTract(null);
          }}
          {...collapseProps}
        />
      );
    }

    // Single-region or empty mode
    const activeRegion = selectedTract || (selectedTracts.length === 1 ? selectedTracts[0] : null) || selectedCounty || (selectedCounties.length === 1 ? selectedCounties[0] : null) || selectedMSA;

    const regionWithDetails = activeRegion
      ? {
          ...activeRegion,
          factors: selectedRegionDetails?.factors ?? [],
          details: selectedRegionDetails?.details ?? undefined,
        }
      : undefined;

    const handleCloseRegion = activeRegion
      ? () => {
          setSelectedTract(null);
          setSelectedCounty(null);
          setSelectedMSA(null);
        }
      : undefined;

    return (
      <ExplainabilityPanel
        region={regionWithDetails}
        isLoadingDetails={detailsLoading}
        detailsProgress={detailsProgress}
        onClose={handleCloseRegion}
        onAddToCompare={undefined} // Disabled - Coming Soon feature
        nearbySubstations={activeRegion?.geoLevel?.toUpperCase() === 'TRACT' ? nearbySubstations : undefined}
        highlightedSubstationId={highlightedSubstationId}
        onHighlightSubstation={id => setHighlightedSubstationId(prev => prev === id ? null : id)}
        {...collapseProps}
      />
    );
  }

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex-shrink-0">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold text-gray-900">Catalyst</h1>
          <div className="flex items-center gap-3">
            <div className="relative">
              <button
                onClick={() => { setShowUtilityPanel(p => !p); setShowCompetitorPanel(false); }}
                className={`px-4 py-2 rounded-lg transition-colors ${
                  showUtilityPanel
                    ? 'bg-yellow-500 text-white'
                    : 'bg-yellow-100 hover:bg-yellow-200 text-yellow-700'
                }`}
              >
                Utility Grid
              </button>
              {showUtilityPanel && (
                <UtilityGridPanel
                  onClose={() => setShowUtilityPanel(false)}
                  allSubstations={allSubstations}
                  circuits={allCircuits}
                  filteredCount={emphasizedCount}
                  filters={substationFilters}
                  onFiltersChange={setSubstationFilters}
                  showLayer={showSubstationLayer}
                  onToggleLayer={v => { setShowSubstationLayer(v); if (!v) setSelectedFeeder(null); }}
                  showAll={showAllSubstations}
                  onToggleShowAll={setShowAllSubstations}
                  circuitColorMode={circuitColorMode}
                  onCircuitColorModeChange={setCircuitColorMode}
                />
              )}
            </div>
            <div className="relative">
              <button
                onClick={() => { setShowCompetitorPanel(p => !p); setShowUtilityPanel(false); }}
                className={`px-4 py-2 rounded-lg transition-colors ${
                  showCompetitorPanel
                    ? 'bg-indigo-600 text-white'
                    : 'bg-indigo-100 hover:bg-indigo-200 text-indigo-700'
                }`}
              >
                Market Intelligence
              </button>
              {showCompetitorPanel && (
                <CompetitorTrackerPanel
                  onClose={() => setShowCompetitorPanel(false)}
                  selectedCompanies={competitorCompanies}
                  onCompaniesChange={setCompetitorCompanies}
                  companyFilterMode={competitorCompanyMode}
                  onCompanyFilterModeChange={setCompetitorCompanyMode}
                  selectedCategories={competitorCategories}
                  onCategoriesChange={setCompetitorCategories}
                  selectedStatuses={competitorStatuses}
                  onStatusesChange={setCompetitorStatuses}
                  selectedMSAs={competitorMSAs}
                  onMSAsChange={setCompetitorMSAs}
                  selectedStates={competitorStates}
                  onStatesChange={setCompetitorStates}
                  selectedSegments={competitorSegments}
                  onSegmentsChange={setCompetitorSegments}
                  showLayer={showCompetitorLayer}
                  onToggleLayer={setShowCompetitorLayer}
                />
              )}
            </div>
            <div className="relative">
              <button
                onClick={() => setShowSavedViews(!showSavedViews)}
                className={`px-4 py-2 rounded-lg transition-colors ${
                  showSavedViews
                    ? 'bg-indigo-600 text-white'
                    : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
                }`}
              >
                Saved Views
              </button>
              {showSavedViews && (
                <SavedViewsPanel
                  onClose={() => setShowSavedViews(false)}
                  onLoadView={(view) => {
                    // Cancel any in-flight tract restoration from a previous load
                    pendingTractRestoration.current = null;

                    // Restore basic filters
                    setSegment(view.segment);
                    setRankingThreshold(view.rankingThreshold);

                    // Don't auto-expand panels - user will manually navigate as needed
                    // Removed: setExpandedPanel(view.geoLevel);

                    // Close region analysis panel temporarily during restoration
                    // This prevents showing drill-down county/MSA while we restore the actual selections
                    setRegionAnalysisCollapsed(true);

                    // Clear region selection arrays immediately to prevent stale data from showing
                    setSelectedCounties([]);
                    setSelectedTracts([]);
                    setSelectedTract(null);

                    // Restore map view
                    if (view.mapView) {
                      if (view.geoLevel === 'MSA') setMsaMapView(view.mapView);
                      else if (view.geoLevel === 'County') setCountyMapView(view.mapView);
                      else if (view.geoLevel === 'Tract') setTractMapView(view.mapView);
                    }

                    // Restore drill-down context (which parent regions were clicked)
                    if (view.drillDownMSAId) {
                      // Find the MSA region object by ID
                      const allMSAs = getMockRegions('MSA', view.segment, view.rankingThreshold, null, []);
                      const msa = allMSAs.find(m => m.id === view.drillDownMSAId);
                      if (msa) {
                        setSelectedMSA(msa);
                        loadLevelOnDemand('County');
                      }
                    } else {
                      setSelectedMSA(null);
                    }

                    if (view.drillDownCountyId && view.drillDownMSAId) {
                      // Find the County region object by ID.
                      // Use the reranked version so its rank is within countyRange = [1, N],
                      // preventing the [countyRange] effect from clearing selectedCounty.
                      const allCounties = getCountiesForMSA(view.drillDownMSAId, view.segment, view.rankingThreshold, null, []);
                      const rawCounty = allCounties.find(c => c.id === view.drillDownCountyId);
                      if (rawCounty) {
                        const reranked = reRankByOriginalOrder(allCounties);
                        const county = reranked.find(c => c.id === view.drillDownCountyId) ?? rawCounty;
                        setSelectedCounty(county);
                        loadTractPolygonsForCounty(view.drillDownCountyId);
                        loadTractRegionsForCounty(view.drillDownCountyId);
                      }
                    } else {
                      setSelectedCounty(null);
                    }

                    // Restore region selections (IDs for map filtering)
                    setSelectedMSAIds(view.selectedMSAIds || []);
                    setSelectedCountyIds(view.selectedCountyIds || []);
                    setSelectedTractIds(view.selectedTractIds || []);

                    // Restore region selections (Region objects for analysis panel)
                    // Need to find actual Region objects from saved IDs
                    if (view.selectedTractIds && view.selectedTractIds.length > 0 && view.drillDownCountyId && view.drillDownMSAId) {
                      // Store pending restoration — the useEffect on dataLoadTick will apply it
                      // once tract data finishes loading (handles cold load after F5 correctly).
                      pendingTractRestoration.current = {
                        tractIds: view.selectedTractIds,
                        countyId: view.drillDownCountyId,
                        msaId: view.drillDownMSAId,
                      };
                      // Also attempt immediately in case tract data is already cached
                      const allTracts = getTractsForCounties([view.drillDownCountyId!], view.segment, view.rankingThreshold, null, []);
                      const tractsToSelect = allTracts.filter(t => view.selectedTractIds!.includes(t.id));
                      if (tractsToSelect.length > 0) {
                        pendingTractRestoration.current = null;
                        if (tractsToSelect.length === 1) {
                          setSelectedTract(tractsToSelect[0]);
                          setSelectedTracts([]);
                        } else {
                          setSelectedTracts(tractsToSelect);
                          setSelectedTract(null);
                        }
                        setRegionAnalysisCollapsed(false);
                      }
                    } else if (view.selectedCountyIds && view.selectedCountyIds.length > 0 && view.drillDownMSAId) {
                      // Restore county selections for region analysis
                      // Increased timeout to ensure county data is loaded
                      setTimeout(() => {
                        const allCounties = getCountiesForMSA(view.drillDownMSAId!, view.segment, view.rankingThreshold, null, []);
                        const countiesToSelect = allCounties.filter(c => view.selectedCountyIds!.includes(c.id));
                        if (countiesToSelect.length > 0) {
                          setSelectedCounties(countiesToSelect);
                          setRegionAnalysisCollapsed(false);
                        }
                      }, 1000);
                    } else if (view.selectedMSAIds && view.selectedMSAIds.length > 0) {
                      // Restore MSA selections for region analysis (no drill-down needed)
                      const allMSAs = getMockRegions('MSA', view.segment, view.rankingThreshold, null, []);
                      const msasToSelect = allMSAs.filter(m => view.selectedMSAIds!.includes(m.id));
                      if (msasToSelect.length > 0) {
                        // For MSAs, we use selectedCounties array (it's a bit confusing but that's the current structure)
                        setSelectedCounties(msasToSelect);
                        setRegionAnalysisCollapsed(false);
                      }
                    }

                    // Restore competitor tracker state
                    if (view.showCompetitorLayer !== undefined) {
                      setShowCompetitorLayer(view.showCompetitorLayer);
                    }
                    if (view.competitorCompanies) {
                      const companiesSet = new Set(view.competitorCompanies);
                      if (view.competitorCompanyMode === 'include') {
                        setCompetitorIncludeCompanies(companiesSet);
                        setCompetitorExcludeCompanies(new Set());
                      } else {
                        setCompetitorExcludeCompanies(companiesSet);
                        setCompetitorIncludeCompanies(new Set());
                      }
                    } else {
                      setCompetitorIncludeCompanies(new Set());
                      setCompetitorExcludeCompanies(new Set());
                    }
                    if (view.competitorCompanyMode) {
                      setCompetitorCompanyMode(view.competitorCompanyMode);
                    }
                    if (view.competitorCategories) {
                      setCompetitorCategories(new Set(view.competitorCategories));
                    } else {
                      setCompetitorCategories(new Set());
                    }
                    if (view.competitorSegments) {
                      setCompetitorSegments(new Set(view.competitorSegments));
                    } else {
                      setCompetitorSegments(new Set());
                    }
                    if (view.competitorStatuses) {
                      setCompetitorStatuses(new Set(view.competitorStatuses));
                    } else {
                      setCompetitorStatuses(new Set());
                    }

                    setShowSavedViews(false);
                  }}
                  // Current state for saving
                  currentGeoLevel={expandedPanel || 'MSA'}
                  currentSegment={segment}
                  currentRankingThreshold={rankingThreshold}
                  currentMapView={
                    expandedPanel === 'MSA' ? (msaMapView || undefined) :
                    expandedPanel === 'County' ? (countyMapView || undefined) :
                    expandedPanel === 'Tract' ? (tractMapView || undefined) :
                    undefined
                  }
                  currentDrillDownMSAId={selectedMSA?.id}
                  currentDrillDownCountyId={selectedCounty?.id}
                  currentSelectedMSAIds={
                    selectedCounties.filter(r => r.geoLevel === 'MSA').map(r => r.id).length > 0
                      ? selectedCounties.filter(r => r.geoLevel === 'MSA').map(r => r.id)
                      : selectedMSAIds
                  }
                  currentSelectedCountyIds={
                    selectedCounties.filter(r => r.geoLevel === 'County').map(r => r.id).length > 0
                      ? selectedCounties.filter(r => r.geoLevel === 'County').map(r => r.id)
                      : selectedCountyIds
                  }
                  currentSelectedTractIds={
                    selectedTracts.length > 0
                      ? selectedTracts.map(r => r.id)
                      : selectedTract
                        ? [selectedTract.id]
                        : selectedTractIds
                  }
                  currentShowCompetitorLayer={showCompetitorLayer}
                  currentCompetitorCompanies={competitorCompanies}
                  currentCompetitorCompanyMode={competitorCompanyMode}
                  currentCompetitorCategories={competitorCategories}
                  currentCompetitorSegments={competitorSegments}
                  currentCompetitorStatuses={competitorStatuses}
                />
              )}
            </div>
            {/* Simulation Analysis and Compare tabs hidden for demo — components kept for future use */}
          </div>
        </div>

        {/* Timeline Slider */}
        <TimelineSlider selectedDate={selectedDate} onDateChange={setSelectedDate} />
      </header>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Panel - Filters */}
        <FilterPanel
          segment={segment}
          setSegment={setSegment}
          rankingThreshold={rankingThreshold}
          setRankingThreshold={setRankingThreshold}
          msas={msas}
          counties={counties}
          tracts={tracts}
          allMsas={msasRaw}
          allCounties={countiesRaw}
          allTracts={tractsRaw}
          selectedMSAIds={selectedMSAIds}
          setSelectedMSAIds={setSelectedMSAIds}
          selectedCountyIds={selectedCountyIds}
          setSelectedCountyIds={setSelectedCountyIds}
          selectedTractIds={selectedTractIds}
          setSelectedTractIds={setSelectedTractIds}
          activeScenario={activeScenario}
          msaRange={msaRange}
          setMsaRange={setMsaRange}
          countyRange={countyRange}
          setCountyRange={setCountyRange}
          tractRange={tractRange}
          setTractRange={setTractRange}
          selectedCounty={selectedCounty}
          selectedTract={selectedTract}
          multiSelectedCounties={selectedCounties}
          multiSelectedTracts={selectedTracts}
          collapsed={filterCollapsed}
          onToggleCollapse={() => setFilterCollapsed(prev => !prev)}
          filteredCompetitorSites={selectedMSA ? msaCompetitorSites : competitorSites}
          showCompetitorLayer={showCompetitorLayer}
        />

        {/* Center - 3 Panel Layout */}
        <div className="flex-1 flex gap-2 p-2 overflow-hidden">
          {/* MSA Panel */}
          <GeoPanel
            title="MSAs"
            regions={msas}
            selectedRegion={selectedMSA}
            onSelectRegion={handleSelectMSA}
            onAddToCompare={undefined} // Disabled - Coming Soon feature
            geoLevel="MSA"
            isExpanded={expandedPanel === 'MSA'}
            isMinimized={expandedPanel !== null && expandedPanel !== 'MSA'}
            onToggleExpand={() => handleExpandPanel('MSA')}
            savedMapView={msaMapView}
            onMapViewChange={setMsaMapView}
            competitorSites={competitorSites}
            showCompetitorLayer={showCompetitorLayer}
          />

          {/* County Panel */}
          <GeoPanel
            title={selectedMSA ? `Counties in ${selectedMSA.name}` : 'Counties'}
            regions={counties}
            selectedRegion={selectedCounty}
            selectedRegions={selectedCounties}
            onSelectRegion={handleSelectCounty}
            onAddToCompare={undefined}
            geoLevel="County"
            isLoading={loadingCounties}
            disabled={!selectedMSA}
            isExpanded={expandedPanel === 'County'}
            isMinimized={expandedPanel !== null && expandedPanel !== 'County'}
            onToggleExpand={() => handleExpandPanel('County')}
            multiSelectEnabled={true}
            onLassoSelect={handleCountyLassoSelect}
            savedMapView={countyMapView}
            onMapViewChange={setCountyMapView}
            competitorSites={msaCompetitorSites}
            showCompetitorLayer={showCompetitorLayer}
          />

          {/* Tract Panel */}
          <GeoPanel
            title={getTractPanelTitle(selectedCounties, selectedCounty)}
            regions={tracts}
            selectedRegion={selectedTract}
            selectedRegions={selectedTracts}
            onSelectRegion={handleSelectTract}
            onAddToCompare={undefined}
            geoLevel="Tract"
            isLoading={loadingTracts}
            disabled={!selectedCounty && selectedCounties.length === 0}
            isExpanded={expandedPanel === 'Tract'}
            isMinimized={expandedPanel !== null && expandedPanel !== 'Tract'}
            onToggleExpand={() => handleExpandPanel('Tract')}
            multiSelectEnabled={true}
            onLassoSelect={handleTractLassoSelect}
            savedMapView={tractMapView}
            onMapViewChange={setTractMapView}
            competitorSites={msaCompetitorSites}
            showCompetitorLayer={showCompetitorLayer}
            circuits={showSubstationLayer ? filteredCircuits : []}
            selectedFeeder={selectedFeeder}
            onFeederClick={f => setSelectedFeeder(prev =>
              prev?.utility === f.utility && prev?.circuitName === f.circuitName ? null : f
            )}
            circuitColorMode={circuitColorMode}
            substations={visibleSubstations}
            nearbySubstationIds={nearbySubstationIds}
            emphasizedSubstationIds={emphasizedSubstationIds}
            highlightedSubstationId={highlightedSubstationId}
            onClickSubstation={s => {
              setHighlightedSubstationId(prev => prev === s.id ? null : s.id);
              setEditingSubstationId(prev => prev === s.id ? null : s.id);
            }}
          />

          {/* Selected feeder banner — appears when a circuit/feeder is clicked */}
          {selectedFeeder && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-[500] flex items-center gap-3
                            bg-gray-900/95 text-white text-xs px-4 py-2.5 rounded-full shadow-xl
                            border border-white/10 backdrop-blur-sm pointer-events-auto">
              <span className="font-semibold">
                {selectedFeeder.circuitName || 'Unnamed Circuit'}
              </span>
              <span className="text-gray-400">
                {selectedFeeder.utility.toUpperCase()}
                {selectedFeeder.substationName ? ` · ${selectedFeeder.substationName}` : ''}
              </span>
              {selectedFeeder.loadAvailKw != null && (
                <span
                  className="font-semibold"
                  style={{ color: selectedFeeder.loadAvailKw <= 0 ? '#ef4444'
                    : selectedFeeder.loadAvailKw < 1000 ? '#f97316'
                    : selectedFeeder.loadAvailKw < 5000 ? '#eab308'
                    : '#22c55e' }}
                >
                  {selectedFeeder.loadAvailKw >= 1000
                    ? `${(selectedFeeder.loadAvailKw / 1000).toFixed(1)} MW`
                    : `${Math.round(selectedFeeder.loadAvailKw)} kW`}
                </span>
              )}
              <button
                onClick={() => setSelectedFeeder(null)}
                className="ml-1 text-gray-400 hover:text-white leading-none"
                title="Deselect feeder"
              >✕</button>
            </div>
          )}
        </div>

        {/* Right Panels */}
        {renderRegionAnalysisPanel()}

        {/* Substation override editor */}
        {editingSubstationId && (() => {
          const raw = allSubstations.find(s => s.id === editingSubstationId);
          if (!raw) return null;
          return (
            <SubstationOverridePanel
              substation={raw}
              overrides={substationOverrides}
              onOverridesChange={setSubstationOverrides}
              onClose={() => setEditingSubstationId(null)}
              onViewAll={() => { setShowOverrideList(true); setEditingSubstationId(null); }}
            />
          );
        })()}

        {/* Overrides list panel */}
        {showOverrideList && (
          <SubstationOverrideListPanel
            overrides={substationOverrides}
            allSubstations={allSubstations}
            onOverridesChange={setSubstationOverrides}
            onEdit={id => { setEditingSubstationId(id); setShowOverrideList(false); }}
            onClose={() => setShowOverrideList(false)}
          />
        )}
      </div>
    </div>
  );
}
