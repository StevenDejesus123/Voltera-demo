import { useState, useEffect } from 'react';
import { Region, GeoLevel, MapViewState, CompetitorSite } from '../types';
import { MapPin, Table, Map, Eye, GitCompare, ArrowUpDown, ArrowUp, ArrowDown, Maximize2, Minimize2, MoreVertical } from 'lucide-react';
import { GeoMapView } from './GeoMapView';

interface GeoPanelProps {
  title: string;
  regions: Region[];
  selectedRegion: Region | null;
  selectedRegions?: Region[];
  onSelectRegion: (region: Region, ctrlKey?: boolean) => void;
  onAddToCompare: (region: Region) => void;
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
  competitorCategories?: Set<string>;
  competitorCompanies?: Set<string>;
  competitorCompanyMode?: 'include' | 'exclude';
  competitorSegments?: Set<string>;
}

type ViewMode = 'map' | 'table';
type SortField = 'rank' | 'name' | 'score' | 'customerCount';
type SortDirection = 'asc' | 'desc';

function getScoreColor(score: number) {
  if (score >= 0.9) return '#10b981';
  if (score >= 0.8) return '#3b82f6';
  if (score >= 0.7) return '#f59e0b';
  return '#ef4444';
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="w-4 h-3 rounded" style={{ backgroundColor: color }} />
      <span className="text-gray-600">{label}</span>
    </div>
  );
}

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
  competitorCategories,
  competitorCompanies,
  competitorCompanyMode,
  competitorSegments,
}: GeoPanelProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('map');
  const [sortField, setSortField] = useState<SortField>('rank');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [legendOpen, setLegendOpen] = useState(false);
  const [lassoEnabled, setLassoEnabled] = useState(false);

  // Reset lasso and legend when switching to table view or when panel has no data
  useEffect(() => {
    if (viewMode === 'table' || regions.length === 0) {
      setLassoEnabled(false);
      setLegendOpen(false);
    }
  }, [viewMode, regions.length]);

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
                <Map className="w-4 h-4" />
              </button>
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
                                      backgroundColor: getScoreColor(region.score),
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
                                <button
                                  onClick={(e) => { e.stopPropagation(); onAddToCompare(region); }}
                                  className="p-1 hover:bg-blue-100 rounded transition-colors"
                                  title="Add to Compare"
                                >
                                  <GitCompare className="w-3.5 h-3.5 text-blue-600" />
                                </button>
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
                  competitorCategories={competitorCategories}
                  competitorCompanies={competitorCompanies}
                  competitorCompanyMode={competitorCompanyMode}
                  competitorSegments={competitorSegments}
                />
                {isLoading && (
                  <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.35)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                    <div className="bg-white rounded-md px-4 py-2 flex items-center gap-2 shadow" style={{ pointerEvents: 'auto' }}>
                      <div style={{ width: 18, height: 18, borderRadius: 9999, border: '2px solid #e5e7eb', borderTopColor: '#4f46e5' }} className="animate-spin" />
                      <div className="text-sm text-gray-700">Loading…</div>
                    </div>
                  </div>
                )}
                {/* Legend popup */}
                {legendOpen && (
                  <div className="bg-white shadow-lg rounded-lg p-3 border border-gray-200" style={{ position: 'absolute', top: 8, right: 8, zIndex: 1100 }}>
                    <h3 className="text-xs font-semibold text-gray-900 mb-2">Score Legend</h3>
                    <div className="space-y-1.5 text-xs">
                      <LegendItem color="#10b981" label="90-100%" />
                      <LegendItem color="#3b82f6" label="80-89%" />
                      <LegendItem color="#f59e0b" label="70-79%" />
                      <LegendItem color="#ef4444" label="< 70%" />
                      <div className="flex items-center gap-2 pt-1 border-t">
                        <div className="w-4 h-3 border-2 border-dashed border-purple-600" />
                        <span className="text-gray-600">Geofence</span>
                      </div>
                      {multiSelectEnabled && (
                        <div className="flex items-center gap-2 pt-1 border-t">
                          <div className="w-4 h-3 border-2 border-dashed border-blue-600" />
                          <span className="text-gray-600">Selected</span>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="bg-gray-50 border-t border-gray-200 px-4 py-2 flex-shrink-0">
            <div className="flex items-center justify-between">
              <div>
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
              </div>
              <button
                onClick={() => setLegendOpen(prev => !prev)}
                className="p-1 rounded hover:bg-gray-200 transition-colors"
                title={legendOpen ? 'Hide legend' : 'Show legend'}
              >
                <MoreVertical className="w-4 h-4 text-gray-500" />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
