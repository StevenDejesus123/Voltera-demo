import { Download, Zap, ChevronDown, PanelLeftClose, PanelLeftOpen, Loader2 } from 'lucide-react';
import { Segment, Region, WhatIfScenario, GeoLevel, RegionDetails } from '../types';
import { exportToCSV, exportToGeoJSON, exportToKML, ExportOptions } from '../utils/exportUtils';
import { ensureDetailsLoaded, getRegionDetails } from '../dataLoader/frontendLoader';
import { useState } from 'react';
import * as Slider from '@radix-ui/react-slider';

interface FilterPanelProps {
  segment: Segment;
  setSegment: (segment: Segment) => void;
  rankingThreshold: number;
  setRankingThreshold: (threshold: number) => void;
  msas: Region[];
  counties: Region[];
  tracts: Region[];
  allMsas: Region[];
  allCounties: Region[];
  allTracts: Region[];
  selectedMSAIds: string[];
  setSelectedMSAIds: (ids: string[]) => void;
  selectedCountyIds: string[];
  setSelectedCountyIds: (ids: string[]) => void;
  selectedTractIds: string[];
  setSelectedTractIds: (ids: string[]) => void;
  activeScenario: WhatIfScenario | null;
  msaRange: [number, number];
  setMsaRange: (r: [number, number]) => void;
  countyRange: [number, number];
  setCountyRange: (r: [number, number]) => void;
  tractRange: [number, number];
  setTractRange: (r: [number, number]) => void;
  selectedCounty?: Region | null;
  selectedTract?: Region | null;
  multiSelectedCounties?: Region[];
  multiSelectedTracts?: Region[];
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export function FilterPanel({
  segment,
  setSegment,
  rankingThreshold,
  setRankingThreshold,
  msas,
  counties,
  tracts,
  allMsas,
  allCounties,
  allTracts,
  selectedMSAIds,
  setSelectedMSAIds,
  selectedCountyIds,
  setSelectedCountyIds,
  selectedTractIds,
  setSelectedTractIds,
  activeScenario,
  msaRange,
  setMsaRange,
  countyRange,
  setCountyRange,
  tractRange,
  setTractRange,
  selectedCounty = null,
  selectedTract = null,
  multiSelectedCounties = [],
  multiSelectedTracts = [],
  collapsed = false,
  onToggleCollapse,
}: FilterPanelProps) {
  const [msaDropdownOpen, setMsaDropdownOpen] = useState(false);
  const [countyDropdownOpen, setCountyDropdownOpen] = useState(false);
  const [tractDropdownOpen, setTractDropdownOpen] = useState(false);
  const [exportLevel, setExportLevel] = useState<GeoLevel>('MSA');
  const [exportFormat, setExportFormat] = useState<'CSV' | 'GeoJSON' | 'KML'>('CSV');
  const [exportDropdownOpen, setExportDropdownOpen] = useState(false);
  const [useSmartMerge, setUseSmartMerge] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  const hasCountySelection = multiSelectedCounties.length > 0 || selectedCounty !== null;
  const hasTractSelection = multiSelectedTracts.length > 0 || selectedTract !== null;

  function hasSelectionForLevel(level: GeoLevel): boolean {
    switch (level) {
      case 'County': return hasCountySelection;
      case 'Tract': return hasTractSelection;
      default: return false;
    }
  }

  function getSelectedRegionsForLevel(level: GeoLevel): Region[] | null {
    switch (level) {
      case 'County':
        if (multiSelectedCounties.length > 0) return multiSelectedCounties;
        return selectedCounty ? [selectedCounty] : null;
      case 'Tract':
        if (multiSelectedTracts.length > 0) return multiSelectedTracts;
        return selectedTract ? [selectedTract] : null;
      default:
        return null;
    }
  }

  function getFilteredRegionsForLevel(level: GeoLevel): Region[] {
    switch (level) {
      case 'MSA': return msas;
      case 'County': return counties;
      default: return tracts;
    }
  }

  function toggleId(id: string, selectedIds: string[], setSelectedIds: (ids: string[]) => void): void {
    setSelectedIds(
      selectedIds.includes(id)
        ? selectedIds.filter(i => i !== id)
        : [...selectedIds, id]
    );
  }

  function getRegionsForExport(): Region[] {
    return getSelectedRegionsForLevel(exportLevel) ?? getFilteredRegionsForLevel(exportLevel);
  }

  async function handleExport(): Promise<void> {
    const regions = getRegionsForExport();
    setIsExporting(true);
    try {
      await ensureDetailsLoaded(exportLevel);

      const analysisData = new Map<string, RegionDetails>();
      for (const region of regions) {
        const details = getRegionDetails(region.id, exportLevel)?.details;
        if (details) analysisData.set(region.id, details);
      }

      const options: ExportOptions = {
        useSmartMerge,
        analysisData: analysisData.size > 0 ? analysisData : undefined,
      };

      if (exportFormat === 'CSV') {
        exportToCSV(regions, options);
      } else if (exportFormat === 'GeoJSON') {
        exportToGeoJSON(regions, exportLevel, options);
      } else {
        exportToKML(regions, exportLevel, options);
      }
    } finally {
      setIsExporting(false);
    }
  }

  function getExportCountForLevel(level: GeoLevel): { count: number; isSelected: boolean } {
    const selected = getSelectedRegionsForLevel(level);
    if (selected) return { count: selected.length, isSelected: true };
    return { count: getFilteredRegionsForLevel(level).length, isSelected: false };
  }

  function rankBoundsFor(items: Region[] | undefined): [number, number] {
    if (!items || items.length === 0) return [0, 0];
    const ranks = items.map((r) => (typeof r.rank === 'number' ? r.rank : 0)).filter(Boolean);
    if (!ranks.length) return [0, 0];
    return [Math.max(0, Math.min(...ranks)), Math.max(...ranks)];
  }

  const exportRegions = getRegionsForExport();
  const msaBounds = rankBoundsFor(allMsas);
  const countyBounds = rankBoundsFor(allCounties);
  const tractBounds = rankBoundsFor(allTracts);
  const exportLevelLabel = hasSelectionForLevel(exportLevel) ? 'selected' : 'on view';

  if (collapsed) {
    return (
      <div className="w-12 bg-white border-r border-gray-200 flex-shrink-0 flex flex-col items-center py-4 transition-all duration-200">
        <button
          onClick={onToggleCollapse}
          className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 hover:text-gray-700 transition-colors"
          title="Expand filters"
        >
          <PanelLeftOpen className="w-5 h-5" />
        </button>
        <span
          className="text-xs text-gray-500 mt-4 tracking-wider"
          style={{ writingMode: 'vertical-lr' }}
        >
          Filters
        </span>
      </div>
    );
  }

  return (
    <div className="w-80 bg-white border-r border-gray-200 p-6 overflow-y-auto flex-shrink-0 transition-all duration-200">
      <div className="flex items-center justify-between mb-6">
        <h2 className="font-semibold text-gray-900">Filters & Controls</h2>
        {onToggleCollapse && (
          <button
            onClick={onToggleCollapse}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 hover:text-gray-700 transition-colors"
            title="Collapse filters"
          >
            <PanelLeftClose className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Active Scenario Indicator */}
      {activeScenario && (
        <div className="mb-6 bg-purple-50 border border-purple-200 rounded-lg p-3">
          <div className="flex items-center gap-2 mb-1">
            <Zap className="w-4 h-4 text-purple-600" />
            <span className="text-xs font-semibold text-purple-900">Scenario Active</span>
          </div>
          <p className="text-xs text-purple-700">{activeScenario.name}</p>
          <p className="text-xs text-purple-600 mt-1">+{activeScenario.scoreImpact.toFixed(1)}% impact</p>
        </div>
      )}

      {/* MSA Multi-Select */}
      <div className="mb-6">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Filter MSAs
        </label>
        <div className="relative">
          <button
            onClick={() => setMsaDropdownOpen(!msaDropdownOpen)}
            className="w-full px-3 py-2 bg-white border border-gray-300 rounded-lg text-left flex items-center justify-between hover:bg-gray-50"
          >
            <span className="text-sm text-gray-700">
              {selectedMSAIds.length === 0 ? 'All MSAs' : `${selectedMSAIds.length} selected`}
            </span>
            <ChevronDown className="w-4 h-4 text-gray-500" />
          </button>
          {msaDropdownOpen && (
            <div className="absolute z-10 mt-1 w-full bg-white border border-gray-300 rounded-lg shadow-lg max-h-48 overflow-y-auto">
              <div className="p-2">
                <button
                  onClick={() => setSelectedMSAIds([])}
                  className="w-full text-left px-2 py-1 text-xs text-indigo-600 hover:bg-indigo-50 rounded"
                >
                  Clear All
                </button>
              </div>
              {allMsas.map((msa) => (
                <label
                  key={msa.id}
                  className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={selectedMSAIds.length === 0 || selectedMSAIds.includes(msa.id)}
                    onChange={() => toggleId(msa.id, selectedMSAIds, setSelectedMSAIds)}
                    className="w-4 h-4 text-indigo-600"
                  />
                  <span className="text-sm text-gray-700">{msa.name}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* County Multi-Select */}
      <div className="mb-6">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Filter Counties
        </label>
        <div className="relative">
          <button
            onClick={() => setCountyDropdownOpen(!countyDropdownOpen)}
            className="w-full px-3 py-2 bg-white border border-gray-300 rounded-lg text-left flex items-center justify-between hover:bg-gray-50"
          >
            <span className="text-sm text-gray-700">
              {selectedCountyIds.length === 0 ? 'All Counties' : `${selectedCountyIds.length} selected`}
            </span>
            <ChevronDown className="w-4 h-4 text-gray-500" />
          </button>
          {countyDropdownOpen && allCounties.length > 0 && (
            <div className="absolute z-10 mt-1 w-full bg-white border border-gray-300 rounded-lg shadow-lg max-h-48 overflow-y-auto">
              <div className="p-2">
                <button
                  onClick={() => setSelectedCountyIds([])}
                  className="w-full text-left px-2 py-1 text-xs text-indigo-600 hover:bg-indigo-50 rounded"
                >
                  Clear All
                </button>
              </div>
              {allCounties.map((county) => (
                <label
                  key={county.id}
                  className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={selectedCountyIds.length === 0 || selectedCountyIds.includes(county.id)}
                    onChange={() => toggleId(county.id, selectedCountyIds, setSelectedCountyIds)}
                    className="w-4 h-4 text-indigo-600"
                  />
                  <span className="text-sm text-gray-700">{county.name}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Tract Multi-Select */}
      <div className="mb-6">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Filter Tracts
        </label>
        <div className="relative">
          <button
            onClick={() => setTractDropdownOpen(!tractDropdownOpen)}
            className="w-full px-3 py-2 bg-white border border-gray-300 rounded-lg text-left flex items-center justify-between hover:bg-gray-50"
          >
            <span className="text-sm text-gray-700">
              {selectedTractIds.length === 0 ? 'All Tracts' : `${selectedTractIds.length} selected`}
            </span>
            <ChevronDown className="w-4 h-4 text-gray-500" />
          </button>
          {tractDropdownOpen && allTracts.length > 0 && (
            <div className="absolute z-10 mt-1 w-full bg-white border border-gray-300 rounded-lg shadow-lg max-h-48 overflow-y-auto">
              <div className="p-2">
                <button
                  onClick={() => setSelectedTractIds([])}
                  className="w-full text-left px-2 py-1 text-xs text-indigo-600 hover:bg-indigo-50 rounded"
                >
                  Clear All
                </button>
              </div>
              {allTracts.map((tract) => (
                <label
                  key={tract.id}
                  className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={selectedTractIds.length === 0 || selectedTractIds.includes(tract.id)}
                    onChange={() => toggleId(tract.id, selectedTractIds, setSelectedTractIds)}
                    className="w-4 h-4 text-indigo-600"
                  />
                  <span className="text-sm text-gray-700">{tract.name}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Ranking Filter */}
      <div className="mb-6">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Ranking Threshold
        </label>
        <div className="space-y-4">
          {/* MSA range */}
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-600">MSA Rank</span>
              <span className="text-xs text-gray-600">{msaRange[0]} - {msaRange[1]}</span>
            </div>
            <div className="mt-3">
              <Slider.Root
                className="relative flex items-center select-none touch-none w-full h-5"
                min={msaBounds[0]}
                max={msaBounds[1]}
                step={1}
                value={msaRange}
                onValueChange={(v: number[]) => setMsaRange([v[0], v[1]])}
                aria-label="MSA rank range"
              >
                <Slider.Track className="bg-gray-200 relative grow h-2 rounded w-full">
                  <Slider.Range className="absolute h-full bg-indigo-600 rounded" />
                </Slider.Track>
                <Slider.Thumb className="block w-4 h-4 bg-white border border-gray-300 rounded-full shadow -mt-1" />
                <Slider.Thumb className="block w-4 h-4 bg-white border border-gray-300 rounded-full shadow -mt-1" />
              </Slider.Root>
            </div>
          </div>

          {/* County range */}
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-600">County Rank</span>
              <span className="text-xs text-gray-600">{countyRange[0]} - {countyRange[1]}</span>
            </div>
            <div className="mt-3">
              <Slider.Root
                className="relative flex items-center select-none touch-none w-full h-5"
                min={countyBounds[0]}
                max={countyBounds[1]}
                step={1}
                value={countyRange}
                onValueChange={(v: number[]) => setCountyRange([v[0], v[1]])}
                aria-label="County rank range"
              >
                <Slider.Track className="bg-gray-200 relative grow h-2 rounded w-full">
                  <Slider.Range className="absolute h-full bg-indigo-600 rounded" />
                </Slider.Track>
                <Slider.Thumb className="block w-4 h-4 bg-white border border-gray-300 rounded-full shadow -mt-1" />
                <Slider.Thumb className="block w-4 h-4 bg-white border border-gray-300 rounded-full shadow -mt-1" />
              </Slider.Root>
            </div>
          </div>

          {/* Tract range */}
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-600">Tract Rank</span>
              <span className="text-xs text-gray-600">{tractRange[0]} - {tractRange[1]}</span>
            </div>
            <div className="mt-3">
              <Slider.Root
                className="relative flex items-center select-none touch-none w-full h-5"
                min={tractBounds[0]}
                max={tractBounds[1]}
                step={1}
                value={tractRange}
                onValueChange={(v: number[]) => setTractRange([v[0], v[1]])}
                aria-label="Tract rank range"
              >
                <Slider.Track className="bg-gray-200 relative grow h-2 rounded w-full">
                  <Slider.Range className="absolute h-full bg-indigo-600 rounded" />
                </Slider.Track>
                <Slider.Thumb className="block w-4 h-4 bg-white border border-gray-300 rounded-full shadow -mt-1" />
                <Slider.Thumb className="block w-4 h-4 bg-white border border-gray-300 rounded-full shadow -mt-1" />
              </Slider.Root>
            </div>
          </div>
        </div>
      </div>

      {/* Export Section */}
      <div className="border-t border-gray-200 pt-6">
        <div className="flex items-center gap-2 mb-4">
          <Download className="w-5 h-5 text-gray-700" />
          <h3 className="font-medium text-gray-900">Export Data</h3>
        </div>

        {/* Export Level Selector */}
        <div className="mb-3">
          <label className="block text-xs font-medium text-gray-700 mb-2">
            Data to Export
          </label>
          <div className="relative">
            <button
              onClick={() => setExportDropdownOpen(!exportDropdownOpen)}
              className="w-full px-3 py-2 bg-white border border-gray-300 rounded-lg text-left flex items-center justify-between hover:bg-gray-50"
            >
              <span className="text-sm text-gray-700">
                {exportLevel}s {exportLevelLabel} ({exportRegions.length})
              </span>
              <ChevronDown className="w-4 h-4 text-gray-500" />
            </button>
            {exportDropdownOpen && (
              <div className="absolute z-10 mt-1 w-full bg-white border border-gray-300 rounded-lg shadow-lg">
                {(['MSA', 'County', 'Tract'] as GeoLevel[]).map((level) => {
                  const { count, isSelected } = getExportCountForLevel(level);
                  return (
                    <button
                      key={level}
                      onClick={() => {
                        setExportLevel(level);
                        setExportDropdownOpen(false);
                      }}
                      className={`w-full text-left px-3 py-2 hover:bg-gray-50 text-sm ${
                        exportLevel === level ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-gray-700'
                      }`}
                    >
                      {level}s {isSelected ? 'selected' : ''} ({count})
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Export Format Tabs */}
        <div className="mb-3">
          <label className="block text-xs font-medium text-gray-700 mb-2">
            Format
          </label>
          <div className="flex gap-1 bg-gray-100 p-1 rounded-lg">
            {(['CSV', 'GeoJSON', 'KML'] as const).map((format) => (
              <button
                key={format}
                onClick={() => setExportFormat(format)}
                className={`flex-1 px-2 py-1.5 rounded text-xs font-medium transition-colors ${
                  exportFormat === format
                    ? 'bg-white text-indigo-700 shadow-sm'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                {format}
              </button>
            ))}
          </div>
        </div>

        {/* Smart Merge Option - only for GeoJSON/KML with multiple regions */}
        {(exportFormat === 'GeoJSON' || exportFormat === 'KML') && exportRegions.length > 1 && (
          <div className="mb-3 space-y-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={useSmartMerge}
                onChange={(e) => setUseSmartMerge(e.target.checked)}
                className="w-4 h-4 text-indigo-600 rounded border-gray-300 focus:ring-indigo-500"
              />
              <span className="text-sm text-gray-700">Smart merge (combine into boundary polygon)</span>
            </label>
            {useSmartMerge && (
              <p className="text-xs text-gray-500 ml-6">
                Merges selected regions into a unified boundary following actual tract shapes. Separated areas become distinct polygons in one file.
              </p>
            )}
          </div>
        )}

        {/* Export Button */}
        <button
          onClick={handleExport}
          disabled={exportRegions.length === 0 || isExporting}
          className="w-full px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
        >
          {isExporting ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Preparing...
            </>
          ) : (
            <>
              <Download className="w-4 h-4" />
              Export {exportFormat}
            </>
          )}
        </button>

        <p className="text-xs text-gray-500 mt-3">
          {exportRegions.length} {exportLevel}{exportRegions.length !== 1 ? 's' : ''} will be exported
          {hasSelectionForLevel(exportLevel) && (
            <span className="text-indigo-600"> (from selection)</span>
          )}
        </p>
      </div>
    </div>
  );
}
