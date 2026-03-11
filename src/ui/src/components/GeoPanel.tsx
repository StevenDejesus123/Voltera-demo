import { useState, useMemo, useEffect } from 'react';
import { Region, GeoLevel, MapViewState, CompetitorSite } from '../types';
import {
  MapPin, Table, Map as MapIcon, Eye, GitCompare,
  ArrowUpDown, ArrowUp, ArrowDown, Maximize2, Minimize2,
  Layers, SlidersHorizontal, Download, X,
} from 'lucide-react';
import { GeoMapView } from './GeoMapView';
import { ColorScale, getColorMode, isRankBased } from '../utils/colorScale';
import type { ZoningColorMode, ZoningDistrict, ZoningFilters } from '../types/zoning';
import { DEFAULT_ZONING_FILTERS } from '../types/zoning';
import {
  loadZoningData, loadTractZoning, getZoningDistrictsForTract,
  isTractZoningLoaded, getZoningTractSummary, isZoningLoaded, getZoneCategoryOptions,
} from '../dataLoader/zoningLoader';

interface GeoPanelProps {
  title: string;
  regions: Region[];
  selectedRegion: Region | null;
  selectedRegions?: Region[];
  onSelectRegion: (region: Region, ctrlKey?: boolean) => void;
  onAddToCompare?: (region: Region) => void;
  geoLevel: GeoLevel;
  disabled?: boolean;
  isExpanded: boolean;
  isMinimized: boolean;
  onToggleExpand: () => void;
  isLoading?: boolean;
  multiSelectEnabled?: boolean;
  onLassoSelect?: (regions: Region[]) => void;
  savedMapView?: MapViewState | null;
  onMapViewChange?: (view: MapViewState) => void;
  // Market Intelligence layer
  competitorSites?: CompetitorSite[];
  showCompetitorLayer?: boolean;
}

type ViewMode = 'map' | 'table';
type SortField = 'rank' | 'name' | 'score' | 'customerCount';
type SortDirection = 'asc' | 'desc';


export function GeoPanel({
  title,
  regions,
  selectedRegion,
  selectedRegions = [],
  onSelectRegion,
  onAddToCompare,
  geoLevel,
  disabled = false,
  isExpanded,
  isMinimized,
  onToggleExpand,
  isLoading = false,
  multiSelectEnabled = false,
  onLassoSelect,
  savedMapView,
  onMapViewChange,
  competitorSites = [],
  showCompetitorLayer = false,
}: GeoPanelProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('map');
  const [sortField, setSortField] = useState<SortField>('rank');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [lassoEnabled, setLassoEnabled] = useState(false);

  // ── Zoning overlay (Tract-level only) ──────────────────────────────────────
  const [showZoning, setShowZoning] = useState(false);
  const [zoningColorMode, setZoningColorMode] = useState<ZoningColorMode>('ev_permitted');
  const [zoningTick, setZoningTick] = useState(0);
  const [zoningFilters, setZoningFilters] = useState<ZoningFilters>(DEFAULT_ZONING_FILTERS);
  const [showZoningFilters, setShowZoningFilters] = useState(false);
  const [selectedZoningDistrict, setSelectedZoningDistrict] = useState<ZoningDistrict | null>(null);
  const [tractZoningLoading, setTractZoningLoading] = useState(false);

  // Dynamic color scale — same computation as GeoMapView, so table bars match the map.
  const colorScale = useMemo(
    () => new ColorScale(regions.map(r => r.score), getColorMode(geoLevel)),
    [regions, geoLevel],
  );

  // Reset lasso when switching to table view or when panel has no data
  useEffect(() => {
    if (viewMode === 'table' || regions.length === 0) {
      setLassoEnabled(false);
    }
  }, [viewMode, regions.length]);

  // Load summary CSV when the overlay is first opened
  useEffect(() => {
    if (!showZoning || geoLevel !== 'Tract') return;
    loadZoningData();
    const handler = () => setZoningTick(t => t + 1);
    window.addEventListener('zoning:loaded', handler);
    return () => window.removeEventListener('zoning:loaded', handler);
  }, [showZoning, geoLevel]);

  // Trigger per-tract GeoJSON load when selected tract changes
  useEffect(() => {
    if (!showZoning || geoLevel !== 'Tract' || !selectedRegion) return;
    if (isTractZoningLoaded(selectedRegion.id)) return;
    setTractZoningLoading(true);
    loadTractZoning(selectedRegion.id);
  }, [showZoning, geoLevel, selectedRegion?.id]);

  // Listen for per-tract load completion → re-run memo + clear spinner
  useEffect(() => {
    if (!showZoning || geoLevel !== 'Tract') return;
    const handler = (e: Event) => {
      const tractId = (e as CustomEvent).detail?.tractId;
      if (tractId === selectedRegion?.id) {
        setTractZoningLoading(false);
        setZoningTick(t => t + 1);
      }
    };
    window.addEventListener('zoning:tract:loaded', handler);
    return () => window.removeEventListener('zoning:tract:loaded', handler);
  }, [showZoning, geoLevel, selectedRegion?.id]);

  // All derived zoning state in one memo — keyed on tick so it re-runs after load.
  // Districts are scoped to the selected tract: one tract → its parcels only.
  const { allDistricts, filteredDistricts, zoningStats, zoneCategoryOptions } =
    useMemo(() => {
      if (!showZoning || geoLevel !== 'Tract' || !isZoningLoaded()) {
        return {
          allDistricts: [] as ZoningDistrict[],
          filteredDistricts: [] as ZoningDistrict[],
          zoningStats: null,
          zoneCategoryOptions: [] as string[],
        };
      }

      // Scope to the selected tract — show nothing until a tract is clicked
      const tractId = selectedRegion?.id;
      const all = tractId
        ? getZoningDistrictsForTract(tractId)
        : [] as ZoningDistrict[];

      const filtered = all.filter(d => {
        if (zoningFilters.showPermittedOnly && !d.ev_permitted) return false;
        if (zoningFilters.zoneCategories.length > 0 && !zoningFilters.zoneCategories.includes(d.zone_category)) return false;
        return true;
      });

      const stats = filtered.length === 0 ? null : {
        total: filtered.length,
        evPermitted: filtered.filter(d => d.ev_permitted).length,
      };

      return {
        allDistricts: all,
        filteredDistricts: filtered,
        zoningStats: stats,
        zoneCategoryOptions: getZoneCategoryOptions(),
      };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showZoning, geoLevel, zoningTick, zoningFilters, selectedRegion?.id]);

  // CSV export of currently filtered zoning districts
  function downloadZoningCSV() {
    if (!filteredDistricts.length) return;
    const headers = ['zone_id', 'tract_id', 'city', 'zone_code', 'zone_category', 'ev_permitted'];
    const rows = filteredDistricts.map(d => [
      d.zone_id, d.tract_id, d.city, d.zone_code, d.zone_category,
      d.ev_permitted ? 'true' : 'false',
    ]);
    const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'zoning_districts_export.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const sortedRegions = [...regions].sort((a, b) => {
    let aVal: any = a[sortField];
    let bVal: any = b[sortField];
    if (sortField === 'name') { aVal = aVal.toLowerCase(); bVal = bVal.toLowerCase(); }
    return sortDirection === 'asc' ? (aVal > bVal ? 1 : -1) : (aVal < bVal ? 1 : -1);
  });

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <ArrowUpDown className="w-3 h-3 text-gray-400" />;
    return sortDirection === 'asc'
      ? <ArrowUp className="w-3 h-3 text-indigo-600" />
      : <ArrowDown className="w-3 h-3 text-indigo-600" />;
  };

  if (disabled && !isExpanded) {
    return (
      <div className={`bg-white rounded-lg border-2 border-dashed border-gray-300 flex items-center justify-center transition-all ${
        isMinimized ? 'w-16' : 'flex-1'
      }`}>
        {isMinimized ? (
          <div className="transform -rotate-90 whitespace-nowrap">
            <p className="text-xs text-gray-400 font-medium">{geoLevel}</p>
          </div>
        ) : (
          <div className="text-center">
            <MapPin className="w-12 h-12 text-gray-300 mx-auto mb-3" />
            <p className="text-gray-500 font-medium">{title}</p>
            <p className="text-sm text-gray-400 mt-1">
              Select a {geoLevel === 'County' ? 'MSA' : 'County'} to view {geoLevel}s
            </p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`bg-white rounded-lg shadow-md border border-gray-200 flex flex-col overflow-hidden transition-all ${
      isExpanded ? 'flex-1' : isMinimized ? 'w-16' : 'flex-1'
    }`}>
      {/* Header */}
      <div className="bg-gradient-to-r from-indigo-600 to-indigo-700 text-white px-4 py-3 flex items-center justify-between flex-shrink-0">
        {isMinimized ? (
          <div className="transform -rotate-90 origin-center whitespace-nowrap text-center w-full">
            <span className="font-semibold text-sm">{geoLevel}</span>
          </div>
        ) : (
          <>
            <h3 className="font-semibold truncate">{title}</h3>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setViewMode('table')}
                className={`p-1.5 rounded transition-colors ${viewMode === 'table' ? 'bg-white/20' : 'hover:bg-white/10'}`}
                title="Table View"
              >
                <Table className="w-4 h-4" />
              </button>
              <button
                onClick={() => setViewMode('map')}
                className={`p-1.5 rounded transition-colors ${viewMode === 'map' ? 'bg-white/20' : 'hover:bg-white/10'}`}
                title="Map View"
              >
                <MapIcon className="w-4 h-4" />
              </button>
              {geoLevel === 'Tract' && (
                <button
                  onClick={() => setShowZoning(prev => !prev)}
                  className={`p-1.5 rounded transition-colors ${showZoning ? 'bg-purple-400/50 text-white' : 'hover:bg-white/10 text-white/70'}`}
                  title="Zoning Feasibility Overlay"
                >
                  <Layers className="w-4 h-4" />
                </button>
              )}
              <button
                onClick={onToggleExpand}
                className="p-1.5 rounded hover:bg-white/10 transition-colors"
                title={isExpanded ? 'Minimize' : 'Expand'}
              >
                {isExpanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
              </button>
            </div>
          </>
        )}
      </div>

      {!isMinimized && (
        <>
          <div className="flex-1 overflow-hidden flex flex-col">
            {regions.length === 0 ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center">
                  <MapPin className="w-12 h-12 text-gray-300 mx-auto mb-3" />
                  <p className="text-gray-500">No {geoLevel}s found</p>
                  <p className="text-sm text-gray-400 mt-1">Adjust filters to see results</p>
                </div>
              </div>
            ) : viewMode === 'table' ? (
              isLoading ? (
                <div className="flex-1 flex items-center justify-center">
                  <div className="animate-pulse text-sm text-gray-600">Loading…</div>
                </div>
              ) : (
                /* Table View */
                <div className="flex-1 overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 sticky top-0 border-b border-gray-200">
                      <tr>
                        <th className="px-3 py-2 text-left">
                          <button
                            onClick={() => handleSort('rank')}
                            className="flex items-center gap-1 font-semibold text-gray-700 hover:text-gray-900"
                          >
                            # <SortIcon field="rank" />
                          </button>
                        </th>
                        <th className="px-3 py-2 text-left">
                          <button
                            onClick={() => handleSort('name')}
                            className="flex items-center gap-1 font-semibold text-gray-700 hover:text-gray-900"
                          >
                            Name <SortIcon field="name" />
                          </button>
                        </th>
                        <th className="px-3 py-2 text-left">
                          <button
                            onClick={() => handleSort('score')}
                            className="flex items-center gap-1 font-semibold text-gray-700 hover:text-gray-900"
                          >
                            Score <SortIcon field="score" />
                          </button>
                        </th>
                        <th className="px-3 py-2 text-left">
                          <span className="font-semibold text-gray-700">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {sortedRegions.map((region) => {
                        const isSelected = selectedRegion?.id === region.id;
                        const isMultiSelected = selectedRegions.some(r => r.id === region.id);
                        return (
                          <tr
                            key={region.id}
                            className={`hover:bg-gray-50 transition-colors cursor-pointer ${
                              isSelected ? 'bg-indigo-50' : isMultiSelected ? 'bg-blue-50 border-l-4 border-l-blue-500' : ''
                            }`}
                            onClick={(e) => onSelectRegion(region, multiSelectEnabled && (e.ctrlKey || e.metaKey))}
                          >
                            <td className="px-3 py-2">
                              <span className="inline-flex items-center justify-center w-7 h-7 bg-indigo-100 text-indigo-700 font-semibold rounded-full text-xs">
                                {region.rank}
                              </span>
                            </td>
                            <td className="px-3 py-2">
                              <p className="font-medium text-gray-900 text-xs">{region.name}</p>
                              {region.inGeofence && (
                                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-700 mt-1">
                                  Geofence
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              <div className="flex items-center gap-2">
                                <div className="flex-1 bg-gray-200 rounded-full h-1.5 max-w-[60px]">
                                  <div
                                    className="h-1.5 rounded-full"
                                    style={{
                                      width: `${region.score * 100}%`,
                                      backgroundColor: isRankBased(geoLevel)
                                        ? colorScale.getColorByRank(region.rank, regions.length)
                                        : colorScale.getColor(region.score),
                                    }}
                                  />
                                </div>
                                <span className="font-medium text-gray-900 text-xs">
                                  {(region.score * 100).toFixed(0)}%
                                </span>
                              </div>
                            </td>
                            <td className="px-3 py-2">
                              <div className="flex items-center gap-1">
                                <button
                                  onClick={(e) => { e.stopPropagation(); onSelectRegion(region); }}
                                  className="p-1 hover:bg-gray-200 rounded transition-colors"
                                  title="View Details"
                                >
                                  <Eye className="w-3.5 h-3.5 text-gray-600" />
                                </button>
                                {onAddToCompare && (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); onAddToCompare(region); }}
                                    className="p-1 hover:bg-blue-100 rounded transition-colors"
                                    title="Add to Compare"
                                  >
                                    <GitCompare className="w-3.5 h-3.5 text-blue-600" />
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )
            ) : (
              /* Map View */
              <div className="flex-1 flex flex-col overflow-hidden">

                {/* ── Zoning sub-bar ── */}
                {showZoning && geoLevel === 'Tract' && (
                  <div className="flex-shrink-0 px-3 py-1.5 bg-purple-50 border-b border-purple-100 flex items-center gap-1.5 flex-wrap">
                    {/* Color mode toggles */}
                    <button
                      onClick={() => setZoningColorMode('ev_permitted')}
                      className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${zoningColorMode === 'ev_permitted' ? 'bg-purple-600 text-white' : 'text-purple-700 hover:bg-purple-100'}`}
                    >
                      EV Permission
                    </button>
                    <button
                      onClick={() => setZoningColorMode('zone_category')}
                      className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${zoningColorMode === 'zone_category' ? 'bg-purple-600 text-white' : 'text-purple-700 hover:bg-purple-100'}`}
                    >
                      Zone Type
                    </button>

                    <div className="w-px h-4 bg-purple-200 mx-0.5" />

                    {/* Filter toggle */}
                    <button
                      onClick={() => setShowZoningFilters(prev => !prev)}
                      className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${showZoningFilters ? 'bg-purple-600 text-white' : 'text-purple-700 hover:bg-purple-100'}`}
                      title="Toggle filters"
                    >
                      <SlidersHorizontal className="w-3 h-3" />
                      Filter
                    </button>

                    {/* Export */}
                    <button
                      onClick={downloadZoningCSV}
                      disabled={filteredDistricts.length === 0}
                      className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium text-purple-700 hover:bg-purple-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      title="Download filtered districts as CSV"
                    >
                      <Download className="w-3 h-3" />
                      Export
                    </button>

                    {/* Stats / loading indicator */}
                    <span className="ml-auto text-[11px] text-purple-600 font-medium whitespace-nowrap flex items-center gap-1">
                      {tractZoningLoading ? (
                        <>
                          <span className="w-3 h-3 rounded-full border-2 border-purple-300 border-t-purple-600 animate-spin inline-block" />
                          Loading parcels…
                        </>
                      ) : zoningStats ? (
                        <>{zoningStats.evPermitted}/{zoningStats.total} EV-permitted</>
                      ) : selectedRegion ? (
                        'No zoning data'
                      ) : null}
                    </span>
                  </div>
                )}

                {/* ── Zoning filter panel ── */}
                {showZoning && geoLevel === 'Tract' && showZoningFilters && (
                  <div className="flex-shrink-0 px-3 py-2 bg-purple-50 border-b border-purple-200 space-y-2">
                    {/* EV Permitted toggle */}
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={zoningFilters.showPermittedOnly}
                        onChange={e => setZoningFilters(f => ({ ...f, showPermittedOnly: e.target.checked }))}
                        className="accent-purple-600 w-3.5 h-3.5"
                      />
                      <span className="text-[11px] text-purple-700 font-medium">Show EV-permitted only</span>
                    </label>

                    {/* Zone Type checkboxes */}
                    {zoneCategoryOptions.length > 0 && (
                      <div className="flex items-start gap-2 flex-wrap">
                        <label className="text-[11px] text-purple-700 font-medium w-20 flex-shrink-0 pt-0.5">Zone Type</label>
                        <div className="flex gap-x-3 gap-y-1 flex-wrap">
                          {zoneCategoryOptions.map(zone => (
                            <label key={zone} className="flex items-center gap-1 cursor-pointer select-none">
                              <input
                                type="checkbox"
                                checked={zoningFilters.zoneCategories.includes(zone)}
                                onChange={e => setZoningFilters(f => ({
                                  ...f,
                                  zoneCategories: e.target.checked
                                    ? [...f.zoneCategories, zone]
                                    : f.zoneCategories.filter(z => z !== zone),
                                }))}
                                className="accent-purple-600 w-3 h-3"
                              />
                              <span className="text-[11px] text-purple-700">{zone}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Reset */}
                    <div className="flex justify-end">
                      <button
                        onClick={() => setZoningFilters(DEFAULT_ZONING_FILTERS)}
                        className="text-[11px] text-purple-600 hover:text-purple-800 underline"
                      >
                        Reset filters
                      </button>
                    </div>
                  </div>
                )}

                {/* ── Map + zoning detail overlay ── */}
                <div className="flex-1 relative">
                  <GeoMapView
                    regions={regions}
                    geoLevel={geoLevel}
                    selectedRegion={selectedRegion}
                    selectedRegions={selectedRegions}
                    onSelectRegion={onSelectRegion}
                    onAddToCompare={onAddToCompare}
                    multiSelectEnabled={multiSelectEnabled}
                    onLassoSelect={onLassoSelect}
                    savedMapView={savedMapView}
                    onMapViewChange={onMapViewChange}
                    lassoEnabled={lassoEnabled}
                    onToggleLasso={() => setLassoEnabled(prev => !prev)}
                    competitorSites={competitorSites}
                    showCompetitorLayer={showCompetitorLayer}
                    zoningDistricts={showZoning && geoLevel === 'Tract' ? filteredDistricts : undefined}
                    zoningColorMode={zoningColorMode}
                    onSelectZoningDistrict={setSelectedZoningDistrict}
                  />

                  {/* Zoning detail card */}
                  {selectedZoningDistrict && (() => {
                    const d = selectedZoningDistrict;
                    const tractSummary = getZoningTractSummary(d.tract_id);
                    const evCls = d.ev_permitted ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700';
                    const zoneCls =
                      d.zone_category === 'Commercial' ? 'bg-blue-100 text-blue-700' :
                      d.zone_category === 'Industrial' ? 'bg-orange-100 text-orange-700' :
                      d.zone_category === 'Mixed Use'  ? 'bg-amber-100 text-amber-700' :
                      'bg-rose-100 text-rose-700';
                    return (
                      <div className="absolute bottom-0 left-0 right-0 bg-white border-t-2 border-purple-300 shadow-xl z-[2000] max-h-60 overflow-y-auto">
                        <div className="px-3 py-2.5">
                          {/* Card header */}
                          <div className="flex items-start justify-between mb-2">
                            <div>
                              <p className="font-semibold text-gray-900 text-sm leading-tight">{d.city}</p>
                              <p className="text-[10px] text-gray-400 font-mono mt-0.5">{d.zone_id} · Tract {d.tract_id}</p>
                            </div>
                            <div className="flex items-center gap-1.5 flex-shrink-0 ml-2">
                              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${evCls}`}>
                                {d.ev_permitted ? 'EV Permitted' : 'Not Permitted'}
                              </span>
                              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${zoneCls}`}>
                                {d.zone_category}
                              </span>
                              <button
                                onClick={() => setSelectedZoningDistrict(null)}
                                className="p-0.5 hover:bg-gray-100 rounded transition-colors"
                                title="Close"
                              >
                                <X className="w-3.5 h-3.5 text-gray-500" />
                              </button>
                            </div>
                          </div>

                          {/* District info */}
                          <div className="flex items-center gap-3 mb-2 text-[11px] text-gray-600">
                            <span>Zone code: <span className="font-semibold text-gray-800 font-mono">{d.zone_code}</span></span>
                            <span>Category: <span className="font-semibold text-gray-800">{d.zone_category}</span></span>
                          </div>

                          {/* Tract summary (if available) */}
                          {tractSummary && (
                            <>
                              <div className="grid grid-cols-3 gap-2 mb-2">
                                {[
                                  { label: 'Demand Score', value: tractSummary.ml_rank_score, color: 'bg-purple-500' },
                                  { label: 'Feasibility', value: tractSummary.feasibility_score, color: 'bg-purple-500' },
                                  { label: 'EV Area', value: tractSummary.pct_area_ev_permitted, color: 'bg-green-500' },
                                ].map(({ label, value, color }) => (
                                  <div key={label}>
                                    <p className="text-[10px] text-gray-500 mb-0.5">{label}</p>
                                    <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                                      <div className={`h-full rounded-full ${color}`} style={{ width: `${value * 100}%` }} />
                                    </div>
                                    <p className="text-[11px] font-semibold text-gray-700 mt-0.5 tabular-nums">
                                      {(value * 100).toFixed(0)}%
                                    </p>
                                  </div>
                                ))}
                              </div>
                              <div className="flex items-center justify-between gap-2 text-[10px] text-gray-500 border-t border-gray-100 pt-1.5">
                                <span>
                                  Demand: <span className={`font-medium ${tractSummary.demand_tier === 'High' ? 'text-green-700' : tractSummary.demand_tier === 'Medium' ? 'text-amber-700' : 'text-red-700'}`}>{tractSummary.demand_tier}</span>
                                </span>
                                <span>Confidence: <span className="font-medium text-gray-700">{tractSummary.data_confidence}</span></span>
                                <span>Dominant zone: <span className="font-medium text-gray-700">{tractSummary.dominant_zone_category}</span></span>
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })()}

                  {isLoading && (
                    <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.35)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                      <div className="bg-white rounded-md px-4 py-2 flex items-center gap-2 shadow" style={{ pointerEvents: 'auto' }}>
                        <div style={{ width: 18, height: 18, borderRadius: 9999, border: '2px solid #e5e7eb', borderTopColor: '#4f46e5' }} className="animate-spin" />
                        <div className="text-sm text-gray-700">Loading…</div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="bg-gray-50 border-t border-gray-200 px-4 py-2 flex-shrink-0">
            <div>
              {showZoning && geoLevel === 'Tract' ? (
                <p className="text-xs text-gray-600">
                  {selectedRegion
                    ? <>Zoning · <span className="font-medium">{selectedRegion.name}</span> · {zoningStats ? zoningStats.evPermitted : 0}/{zoningStats ? zoningStats.total : 0} parcels EV-permitted</>
                    : 'Zoning overlay on — click a tract to see its parcels'}
                </p>
              ) : (
                <>
                  <p className="text-xs text-gray-600">
                    {regions.length} {geoLevel}{regions.length !== 1 ? 's' : ''}
                    {selectedRegions.length > 0 && ` • ${selectedRegions.length} selected (Cmd/Ctrl+click)`}
                    {selectedRegions.length === 0 && selectedRegion && ` • Selected: ${selectedRegion.name}`}
                  </p>
                  {multiSelectEnabled && selectedRegions.length === 0 && !lassoEnabled && (
                    <p className="text-xs text-blue-500 mt-0.5">Cmd/Ctrl+click to multi-select</p>
                  )}
                  {multiSelectEnabled && lassoEnabled && (
                    <p className="text-xs text-amber-600 mt-0.5">Lasso active — disable lasso to click-select</p>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
