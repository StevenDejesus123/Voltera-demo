import { useState, useEffect, useMemo, Dispatch, SetStateAction } from 'react';
import { FilterPanel } from './FilterPanel';
import { GeoPanel } from './GeoPanel';
import { ExplainabilityPanel } from './ExplainabilityPanel';
import { ComparePanel } from './ComparePanel';
import { WhatIfPanel } from './WhatIfPanel';
import { SavedViewsPanel } from './SavedViewsPanel';
import { TimelineSlider } from './TimelineSlider';
import { CompetitorTrackerPanel } from './CompetitorTrackerPanel';
import { GeoLevel, Segment, Region, RegionDetails, WhatIfScenario, MapViewState, CompetitorSite } from '../types';
import { getMockRegions, getCountiesForMSA, getTractsForCounty, getTractsForCounties, loadLevelOnDemand, loadDetailsOnDemand, getRegionDetails } from '../dataLoader/frontendLoader';
import { loadPolygonsOnDemand, loadTractPolygonsForCounty } from '../dataLoader/geoPolygons';
import { getCompetitorSites, loadCompetitorData, filterCompetitorSites } from '../dataLoader/competitorLoader';
import { loadSalesforceData } from '../dataLoader/salesforceLoader';

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
  const [competitorCompanies, setCompetitorCompanies] = useState<Set<string>>(new Set());
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
      categories: competitorCategories,
      statuses: competitorStatuses,
      msas: competitorMSAs,
      states: competitorStates,
      segments: competitorSegments,
    });
  }, [competitorCompanies, competitorCategories, competitorStatuses, competitorMSAs, competitorStates, competitorSegments, competitorDataLoaded]);

  // Competitor sites scoped to the selected MSA for county/tract pin display.
  // The global `competitorSites` list covers all geographies; narrowing to the
  // selected MSA ensures pins match the logos shown in the MSA view.
  const msaCompetitorSites = useMemo(() => {
    if (!selectedMSA) return [];
    const msaName = selectedMSA.name.toLowerCase().trim();
    // Strip state suffix (after comma) so "Los Angeles-Long Beach-Anaheim, CA"
    // matches "Los Angeles-Long Beach-Anaheim" in the competitor data.
    const msaBase = msaName.split(',')[0].trim();
    return competitorSites.filter(s => {
      if (!s.msa) return false;
      const siteMsa = s.msa.toLowerCase().trim();
      const siteBase = siteMsa.split(',')[0].trim();
      return siteMsa === msaName
        || siteMsa.includes(msaBase)
        || msaBase.includes(siteBase)
        || siteBase.includes(msaBase);
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
  const countyIdsForTracts = selectedCounties.length > 0
    ? selectedCounties.map(c => c.id)
    : selectedCounty
      ? [selectedCounty.id]
      : [];

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
    if (showCompare || showWhatIf || showSavedViews) {
      setRegionAnalysisCollapsed(true);
    }
  }, [showCompare, showWhatIf, showSavedViews]);

  // Lazy-load Tract data + per-county polygons when a County is first selected
  useEffect(() => {
    const countyIds = selectedCounties.length > 0
      ? selectedCounties.map(c => c.id)
      : selectedCounty ? [selectedCounty.id] : [];
    if (countyIds.length > 0) {
      loadLevelOnDemand('Tract');
      countyIds.forEach(id => loadTractPolygonsForCounty(id));
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
        onAddToCompare={activeRegion ? () => handleAddToCompare(activeRegion) : undefined}
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
            <button
              onClick={() => setShowSavedViews(!showSavedViews)}
              className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg transition-colors"
            >
              Saved Views
            </button>
            <button
              onClick={() => setShowWhatIf(!showWhatIf)}
              className="px-4 py-2 bg-purple-100 hover:bg-purple-200 text-purple-700 rounded-lg transition-colors"
            >
              Simulation Analysis
            </button>
            <button
              onClick={() => setShowCompare(!showCompare)}
              className="px-4 py-2 bg-blue-100 hover:bg-blue-200 text-blue-700 rounded-lg transition-colors"
            >
              Compare ({compareRegions.filter(r => r).length})
            </button>
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
            onAddToCompare={handleAddToCompare}
            geoLevel="MSA"
            isExpanded={expandedPanel === 'MSA'}
            isMinimized={expandedPanel !== null && expandedPanel !== 'MSA'}
            onToggleExpand={() => handleExpandPanel('MSA')}
            savedMapView={msaMapView}
            onMapViewChange={setMsaMapView}
            competitorSites={competitorSites}
            showCompetitorLayer={showCompetitorLayer}
            competitorCategories={competitorCategories}
            competitorCompanies={competitorCompanies}
          />

          {/* County Panel */}
          <GeoPanel
            title={selectedMSA ? `Counties in ${selectedMSA.name}` : 'Counties'}
            regions={counties}
            selectedRegion={selectedCounty}
            selectedRegions={selectedCounties}
            onSelectRegion={handleSelectCounty}
            onAddToCompare={handleAddToCompare}
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
            onAddToCompare={handleAddToCompare}
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
        {showSavedViews && (
          <SavedViewsPanel
            onClose={() => setShowSavedViews(false)}
            onLoadView={(view) => {
              setSegment(view.segment);
              setRankingThreshold(view.rankingThreshold);
              setShowSavedViews(false);
            }}
          />
        )}

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
