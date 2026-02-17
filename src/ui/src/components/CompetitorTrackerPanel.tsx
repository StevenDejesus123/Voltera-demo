import { useState, useEffect } from 'react';
import { X, Building2, Filter, ChevronDown, ChevronUp, Eye, EyeOff } from 'lucide-react';
import type { CompetitorFilters } from '../types';
import {
  getCompetitorFilters,
  getCompetitorStats,
  getCategoryColor,
  loadCompetitorData,
} from '../dataLoader/competitorLoader';

interface CompetitorTrackerPanelProps {
  onClose: () => void;
  selectedCompanies: Set<string>;
  onCompaniesChange: (companies: Set<string>) => void;
  selectedCategories: Set<string>;
  onCategoriesChange: (categories: Set<string>) => void;
  selectedStatuses: Set<string>;
  onStatusesChange: (statuses: Set<string>) => void;
  selectedMSAs: Set<string>;
  onMSAsChange: (msas: Set<string>) => void;
  selectedStates: Set<string>;
  onStatesChange: (states: Set<string>) => void;
  showLayer: boolean;
  onToggleLayer: (show: boolean) => void;
}

const CategoryBadge = ({ category, selected, onClick }: { category: string; selected: boolean; onClick: () => void }) => {
  const color = getCategoryColor(category);
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-full text-sm font-medium transition-all ${
        selected
          ? 'ring-2 ring-offset-1'
          : 'opacity-60 hover:opacity-100'
      }`}
      style={{
        backgroundColor: selected ? color : `${color}40`,
        color: selected ? 'white' : color,
        ringColor: color,
      }}
    >
      {category}
    </button>
  );
};

const FilterSection = ({
  title,
  items,
  selected,
  onChange,
  defaultExpanded = false,
}: {
  title: string;
  items: string[];
  selected: Set<string>;
  onChange: (selected: Set<string>) => void;
  defaultExpanded?: boolean;
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [searchTerm, setSearchTerm] = useState('');

  const filteredItems = items.filter(item =>
    item.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const toggleItem = (item: string) => {
    const newSelected = new Set(selected);
    if (newSelected.has(item)) {
      newSelected.delete(item);
    } else {
      newSelected.add(item);
    }
    onChange(newSelected);
  };

  const selectAll = () => onChange(new Set(filteredItems));
  const selectNone = () => onChange(new Set());

  return (
    <div className="border-b border-gray-200 last:border-0">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-6 py-3 flex items-center justify-between hover:bg-gray-50"
      >
        <span className="font-medium text-gray-700">
          {title}
          {selected.size > 0 && (
            <span className="ml-2 text-xs text-indigo-600">({selected.size})</span>
          )}
        </span>
        {expanded ? <ChevronUp className="w-4 h-4 text-gray-500" /> : <ChevronDown className="w-4 h-4 text-gray-500" />}
      </button>

      {expanded && (
        <div className="px-6 pb-4">
          {items.length > 5 && (
            <input
              type="text"
              placeholder={`Search ${title.toLowerCase()}...`}
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent mb-3"
            />
          )}

          <div className="flex gap-2 mb-3 text-xs">
            <button
              onClick={selectAll}
              className="text-indigo-600 hover:underline"
            >
              Select All
            </button>
            <span className="text-gray-300">|</span>
            <button
              onClick={selectNone}
              className="text-indigo-600 hover:underline"
            >
              Clear
            </button>
          </div>

          <div className="max-h-48 overflow-y-auto space-y-1">
            {filteredItems.map(item => (
              <label
                key={item}
                className="flex items-center gap-2 py-1.5 px-2 hover:bg-gray-50 rounded-lg cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={selected.has(item)}
                  onChange={() => toggleItem(item)}
                  className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                />
                <span className="text-sm text-gray-700 truncate">{item || '(empty)'}</span>
              </label>
            ))}
            {filteredItems.length === 0 && (
              <p className="text-sm text-gray-500 py-2">No items match your search</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export function CompetitorTrackerPanel({
  onClose,
  selectedCompanies,
  onCompaniesChange,
  selectedCategories,
  onCategoriesChange,
  selectedStatuses,
  onStatusesChange,
  selectedMSAs,
  onMSAsChange,
  selectedStates,
  onStatesChange,
  showLayer,
  onToggleLayer,
}: CompetitorTrackerPanelProps) {
  const [filters, setFilters] = useState<CompetitorFilters | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    loadCompetitorData();
    const handler = () => {
      setFilters(getCompetitorFilters());
      setTick(t => t + 1);
    };
    window.addEventListener('competitor:loaded', handler);
    // Check if already loaded
    const existing = getCompetitorFilters();
    if (existing) setFilters(existing);
    return () => window.removeEventListener('competitor:loaded', handler);
  }, []);

  const stats = getCompetitorStats();

  const categoryOrder = ['Voltera', 'Customer', 'Competitor', 'Interest'];
  const sortedCategories = filters?.categories
    ?.sort((a, b) => {
      const aIdx = categoryOrder.indexOf(a);
      const bIdx = categoryOrder.indexOf(b);
      if (aIdx >= 0 && bIdx >= 0) return aIdx - bIdx;
      if (aIdx >= 0) return -1;
      if (bIdx >= 0) return 1;
      return a.localeCompare(b);
    }) ?? [];

  const toggleCategory = (category: string) => {
    const newSelected = new Set(selectedCategories);
    if (newSelected.has(category)) {
      newSelected.delete(category);
    } else {
      newSelected.add(category);
    }
    onCategoriesChange(newSelected);
  };

  return (
    <div className="w-96 bg-white border-l border-gray-200 overflow-hidden flex flex-col flex-shrink-0 shadow-xl">
      {/* Header - matching ExplainabilityPanel style */}
      <div className="sticky top-0 bg-indigo-600 text-white p-6 z-10">
        <div className="flex items-start justify-between mb-2">
          <div className="flex items-center gap-2">
            <Building2 className="w-5 h-5" />
            <h2 className="font-semibold">Market Intelligence</h2>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => onToggleLayer(!showLayer)}
              className={`p-1 rounded transition-colors ${
                showLayer ? 'bg-indigo-700 hover:bg-indigo-800' : 'bg-indigo-500 hover:bg-indigo-700'
              }`}
              title={showLayer ? 'Hide layer on map' : 'Show layer on map'}
            >
              {showLayer ? <Eye className="w-5 h-5" /> : <EyeOff className="w-5 h-5" />}
            </button>
            <button
              onClick={onClose}
              className="text-white hover:bg-indigo-700 p-1 rounded transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
        <p className="text-sm text-indigo-100">Competitor & Site Tracker</p>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-3 gap-4 p-6 bg-gray-50 border-b border-gray-200">
          <div className="text-center">
            <p className="text-2xl font-bold text-gray-900">{stats.totalSites}</p>
            <p className="text-xs text-gray-500">Total Sites</p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold text-gray-900">{stats.sitesWithCoords}</p>
            <p className="text-xs text-gray-500">On Map</p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold text-gray-900">{stats.companiesCount}</p>
            <p className="text-xs text-gray-500">Companies</p>
          </div>
        </div>
      )}

      {/* Category Filters */}
      <div className="p-6 border-b border-gray-200">
        <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
          <Filter className="w-4 h-4" />
          Categories
        </h3>
        <div className="flex flex-wrap gap-2">
          {sortedCategories.map(category => (
            <CategoryBadge
              key={category}
              category={category}
              selected={selectedCategories.size === 0 || selectedCategories.has(category)}
              onClick={() => toggleCategory(category)}
            />
          ))}
        </div>
      </div>

      {/* Scrollable Filters */}
      <div className="flex-1 overflow-y-auto">
        {filters && (
          <>
            <FilterSection
              title="Companies"
              items={filters.companies}
              selected={selectedCompanies}
              onChange={onCompaniesChange}
              defaultExpanded
            />
            <FilterSection
              title="Status"
              items={filters.statuses.filter(Boolean)}
              selected={selectedStatuses}
              onChange={onStatusesChange}
            />
            <FilterSection
              title="MSA"
              items={filters.msas.filter(Boolean)}
              selected={selectedMSAs}
              onChange={onMSAsChange}
            />
            <FilterSection
              title="State"
              items={filters.states.filter(Boolean)}
              selected={selectedStates}
              onChange={onStatesChange}
            />
          </>
        )}
      </div>

      {/* Footer with Clear All */}
      <div className="p-6 border-t border-gray-200 bg-gray-50">
        <button
          onClick={() => {
            onCompaniesChange(new Set());
            onCategoriesChange(new Set());
            onStatusesChange(new Set());
            onMSAsChange(new Set());
            onStatesChange(new Set());
          }}
          className="w-full px-4 py-2.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
        >
          Clear All Filters
        </button>
      </div>
    </div>
  );
}
