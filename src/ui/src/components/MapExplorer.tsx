import { useState, useEffect, useMemo, Dispatch, SetStateAction } from 'react';
import { FilterPanel } from './FilterPanel';
import { GeoPanel } from './GeoPanel';
import { ExplainabilityPanel } from './ExplainabilityPanel';
import { ComparePanel } from './ComparePanel';
import { WhatIfPanel } from './WhatIfPanel';
import { SavedViewsPanel } from './SavedViewsPanel';
import { TimelineSlider } from './TimelineSlider';
import { CompetitorTrackerPanel } from './CompetitorTrackerPanel';
import { GeoLevel, Segment, Region, RegionDetails, WhatIfScenario, MapViewState } from '../types';
import { getMockRegions, getCountiesForMSA, getTractsForCounties, loadLevelOnDemand, loadDetailsOnDemand, getRegionDetails } from '../dataLoader/frontendLoader';
import { loadPolygonsOnDemand, loadTractPolygonsForCounty } from '../dataLoader/geoPolygons';
import { getCompetitorSites, loadCompetitorData, filterCompetitorSites } from '../dataLoader/competitorLoader';
import { loadSalesforceData } from '../dataLoader/salesforceLoader';
import { msaNamesMatch, isNearCoordinates } from '../utils/msaMatch';

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
  const [compareRegions, setCompareRegions] = useState<[Region | null, Region | null]>([null, null]);
  const [showCompare, setShowCompare] = useState(false);
  const [showWhatIf, setShowWhatIf] = useState(false);
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

  // Load competitor + Salesforce data on mount and listen for load events
  useEffect(() => {
    loadCompetitorData();
    loadSalesforceData();
    const handleLoaded = () => setCompetitorDataLoaded(true);
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
  // Setter-only — incrementing this forces MapExplorer to re-render and re-read the data cache
  const [, setDataLoadTick] = useState(0);

  // Re-render when County or Tract data arrives from the async fetch
  useEffect(() => {
    const handler = () => setDataLoadTick((n) => n + 1);
    window.addEventListener('frontend:regions:updated', handler as EventListener);
    return () => window.removeEventListener('frontend:regions:updated', handler as EventListener);
  }, []);

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
  useEffect(() => {
    if (selectedCounties.length > 1) {
      loadDetailsOnDemand(selectedCounties[0].geoLevel);
      if (!getRegionDetails(selectedCounties[0].id, selectedCounties[0].geoLevel)) {
        setDetailsLoading(true);
        setDetailsProgress(0);
      }
    } else if (selectedTracts.length > 1) {
      loadDetailsOnDemand(selectedTracts[0].geoLevel);
      if (!getRegionDetails(selectedTracts[0].id, selectedTracts[0].geoLevel)) {
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

  // Auto-collapse region analysis when other right panels open
  useEffect(() => {
    if (showCompare || showWhatIf) {
      setRegionAnalysisCollapsed(true);
    }
  }, [showCompare, showWhatIf]);

  // Lazy-load Tract data + per-county polygons when a County is first selected
  useEffect(() => {
    if (countyIdsForTracts.length > 0) {
      loadLevelOnDemand('Tract');
      countyIdsForTracts.forEach(id => loadTractPolygonsForCounty(id));
    }
  }, [selectedCounty?.id, selectedCounties.length]);

  // Lazy-load details sidecar when a region is selected; set state immediately if already cached
  useEffect(() => {
    const region = selectedTract ?? selectedCounty ?? selectedMSA;
    if (!region) {
      setSelectedRegionDetails(null);
      return;
    }
    loadDetailsOnDemand(region.geoLevel);
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
    return isInRange(rank, tractRange) && matchesIdFilter(r.id, selectedTractIds);
  });

  function handleAddToCompare(region: Region): void {
    if (!compareRegions[0]) {
      setCompareRegions([region, null]);
    } else if (!compareRegions[1]) {
      setCompareRegions([compareRegions[0], region]);
      setShowCompare(true);
    } else {
      setCompareRegions([region, compareRegions[1]]);
    }
  }

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

    // Multi-region mode (lasso or ctrl+click)
    let multiRegions: Region[] = [];
    if (selectedCounties.length > 1) {
      multiRegions = selectedCounties;
    } else if (selectedTracts.length > 1) {
      multiRegions = selectedTracts;
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
    const activeRegion = selectedTract || selectedCounty || selectedMSA;

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
        {...collapseProps}
      />
    );
  }

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex-shrink-0">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold text-gray-900">Site Ranking Explorer</h1>
          <div className="flex items-center gap-3">
            <div className="relative">
              <button
                onClick={() => setShowCompetitorPanel(!showCompetitorPanel)}
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
                      // Find the County region object by ID
                      const allCounties = getCountiesForMSA(view.drillDownMSAId, view.segment, view.rankingThreshold, null, []);
                      const county = allCounties.find(c => c.id === view.drillDownCountyId);
                      if (county) {
                        setSelectedCounty(county);
                        loadLevelOnDemand('Tract');
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
                    // Use setTimeout to allow data to load first (longer delay for tracts on first load)
                    if (view.selectedTractIds && view.selectedTractIds.length > 0 && view.drillDownCountyId && view.drillDownMSAId) {
                      // Restore tract selections for region analysis
                      // Increased timeout to 1200ms to ensure tract data is loaded on first visit
                      setTimeout(() => {
                        const allTracts = getTractsForCounties([view.drillDownCountyId!], view.segment, view.rankingThreshold, null, []);
                        const tractsToSelect = allTracts.filter(t => view.selectedTractIds!.includes(t.id));
                        if (tractsToSelect.length > 0) {
                          if (tractsToSelect.length === 1) {
                            // Single tract: set singular state for proper region analysis
                            setSelectedTract(tractsToSelect[0]);
                            setSelectedTracts([]);
                          } else {
                            // Multiple tracts: set plural state
                            setSelectedTracts(tractsToSelect);
                            setSelectedTract(null);
                          }
                          setRegionAnalysisCollapsed(false);
                        }
                      }, 1200);
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
            <div className="relative">
              <button
                disabled
                className="px-4 py-2 bg-gray-100 text-gray-400 rounded-lg cursor-not-allowed transition-colors relative"
                title="Coming Soon"
              >
                Simulation Analysis
                <span className="absolute -top-1 -right-1 px-1.5 py-0.5 bg-purple-500 text-white text-[10px] font-semibold rounded-full">
                  Soon
                </span>
              </button>
            </div>
            <div className="relative">
              <button
                disabled
                className="px-4 py-2 bg-gray-100 text-gray-400 rounded-lg cursor-not-allowed transition-colors relative"
                title="Coming Soon"
              >
                Compare ({compareRegions.filter(r => r).length})
                <span className="absolute -top-1 -right-1 px-1.5 py-0.5 bg-blue-500 text-white text-[10px] font-semibold rounded-full">
                  Soon
                </span>
              </button>
            </div>
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
          />
        </div>

        {/* Right Panels */}
        {showWhatIf && (
          <WhatIfPanel
            onClose={() => setShowWhatIf(false)}
            activeScenario={activeScenario}
            onScenarioChange={setActiveScenario}
          />
        )}

        {showCompare && (
          <ComparePanel
            regions={compareRegions}
            onClose={() => setShowCompare(false)}
            onRemoveRegion={(index) => {
              const newCompare: [Region | null, Region | null] = [...compareRegions];
              newCompare[index] = null;
              setCompareRegions(newCompare);
            }}
            allRegions={[...msas, ...counties, ...tracts]}
            onAddRegion={handleAddToCompare}
          />
        )}

        {renderRegionAnalysisPanel()}
      </div>
    </div>
  );
}
