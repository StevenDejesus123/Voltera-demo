import { X, Save, Star, Trash2, Plus, Search } from 'lucide-react';
import { SavedView, GeoLevel, Segment, MapViewState } from '../types';
import { useState, useEffect } from 'react';
import { loadSavedViews, addSavedView, deleteSavedView } from '../dataLoader/savedViewsLoader';

interface SavedViewsPanelProps {
  onClose: () => void;
  onLoadView: (view: SavedView) => void;
  // Current state to save
  currentGeoLevel: GeoLevel;
  currentSegment: Segment;
  currentRankingThreshold: number;
  currentMapView?: MapViewState;
  // Drill-down context
  currentDrillDownMSAId?: string;
  currentDrillDownCountyId?: string;
  // Region selections
  currentSelectedMSAIds?: string[];
  currentSelectedCountyIds?: string[];
  currentSelectedTractIds?: string[];
  // Competitor tracker state
  currentShowCompetitorLayer?: boolean;
  currentCompetitorCompanies?: Set<string>;
  currentCompetitorCompanyMode?: 'include' | 'exclude';
  currentCompetitorCategories?: Set<string>;
  currentCompetitorSegments?: Set<string>;
}

export function SavedViewsPanel({
  onClose,
  onLoadView,
  currentGeoLevel,
  currentSegment,
  currentRankingThreshold,
  currentMapView,
  currentDrillDownMSAId,
  currentDrillDownCountyId,
  currentSelectedMSAIds,
  currentSelectedCountyIds,
  currentSelectedTractIds,
  currentShowCompetitorLayer,
  currentCompetitorCompanies,
  currentCompetitorCompanyMode,
  currentCompetitorCategories,
  currentCompetitorSegments,
}: SavedViewsPanelProps) {
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [viewName, setViewName] = useState('');
  const [viewDescription, setViewDescription] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    setSavedViews(loadSavedViews());
  }, []);

  const handleDeleteView = (id: string) => {
    deleteSavedView(id);
    setSavedViews(loadSavedViews());
  };

  const handleSaveCurrentView = () => {
    if (!viewName.trim()) return;

    const newView = addSavedView({
      name: viewName.trim(),
      description: viewDescription.trim(),
      geoLevel: currentGeoLevel,
      segment: currentSegment,
      rankingThreshold: currentRankingThreshold,
      minProbability: 0, // Not used but required by type
      mapView: currentMapView,
      drillDownMSAId: currentDrillDownMSAId,
      drillDownCountyId: currentDrillDownCountyId,
      selectedMSAIds: currentSelectedMSAIds,
      selectedCountyIds: currentSelectedCountyIds,
      selectedTractIds: currentSelectedTractIds,
      showCompetitorLayer: currentShowCompetitorLayer,
      competitorCompanies: currentCompetitorCompanies ? [...currentCompetitorCompanies] : undefined,
      competitorCompanyMode: currentCompetitorCompanyMode,
      competitorCategories: currentCompetitorCategories ? [...currentCompetitorCategories] : undefined,
      competitorSegments: currentCompetitorSegments ? [...currentCompetitorSegments] : undefined,
    });

    setSavedViews(loadSavedViews());
    setShowCreateForm(false);
    setViewName('');
    setViewDescription('');
  };

  // Count total selections
  const totalSelections = (currentSelectedMSAIds?.length || 0) +
    (currentSelectedCountyIds?.length || 0) +
    (currentSelectedTractIds?.length || 0);

  // Count competitor filters
  const competitorFiltersCount =
    (currentCompetitorCompanies?.size || 0) +
    (currentCompetitorCategories && currentCompetitorCategories.size > 0 ? 1 : 0) +
    (currentCompetitorSegments && currentCompetitorSegments.size > 0 ? 1 : 0);

  // Filter saved views based on search query
  const filteredViews = savedViews.filter(view =>
    view.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (view.description && view.description.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  return (
    <div
      className="absolute top-full right-0 mt-2 w-[400px] bg-white rounded-2xl shadow-[0_20px_60px_-15px_rgba(0,0,0,0.25)] border border-gray-200/60 z-50 overflow-hidden animate-in fade-in slide-in-from-top-2"
      style={{ animation: 'popoverIn 150ms ease-out', maxHeight: '85vh' }}
    >
      {/* Header */}
      <div className="bg-white px-5 py-3 border-b border-gray-200">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-gray-900">Saved Views</h2>
            <p className="text-xs text-gray-500">Quick access to saved configurations</p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="p-4 space-y-3">
        {/* Create New View Button */}
        <button
          onClick={() => setShowCreateForm(!showCreateForm)}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-medium transition-all shadow-sm"
        >
          <Plus className="w-4 h-4" />
          Save Current View
        </button>

        {/* Search */}
        {savedViews.length > 0 && (
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
            <input
              type="text"
              placeholder="Search saved views..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-sm bg-gray-50 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300 focus:bg-white transition-all placeholder:text-gray-400"
            />
          </div>
        )}

        {/* Create Form */}
        {showCreateForm && (
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-3">
            <h3 className="font-medium text-gray-900 mb-2 text-xs">Save Current Configuration</h3>

            {/* Preview what will be saved */}
            <div className="mb-2 p-2 bg-white rounded-lg border border-gray-200 text-xs space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-gray-500">Level:</span>
                <span className="font-semibold text-gray-900">{currentGeoLevel}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-gray-500">Segment:</span>
                <span className="font-semibold text-gray-900">{currentSegment}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-gray-500">Top:</span>
                <span className="font-semibold text-gray-900">{currentRankingThreshold}%</span>
              </div>
              {totalSelections > 0 && (
                <div className="flex items-center justify-between pt-1 border-t border-gray-100">
                  <span className="text-gray-500">Selections:</span>
                  <span className="font-semibold text-indigo-700">{totalSelections} region{totalSelections !== 1 ? 's' : ''}</span>
                </div>
              )}
              {currentShowCompetitorLayer && (
                <div className="flex items-center justify-between">
                  <span className="text-gray-500">Competitor Layer:</span>
                  <span className="font-semibold text-green-700">Visible</span>
                </div>
              )}
              {competitorFiltersCount > 0 && (
                <div className="flex items-center justify-between">
                  <span className="text-gray-500">Competitor Filters:</span>
                  <span className="font-semibold text-amber-700">{competitorFiltersCount} active</span>
                </div>
              )}
            </div>

            <input
              type="text"
              placeholder="View name..."
              value={viewName}
              onChange={(e) => setViewName(e.target.value)}
              className="w-full px-2.5 py-1.5 text-sm bg-white border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300 transition-all placeholder:text-gray-400 mb-2"
            />
            <textarea
              placeholder="Description (optional)..."
              value={viewDescription}
              onChange={(e) => setViewDescription(e.target.value)}
              className="w-full px-2.5 py-1.5 text-sm bg-white border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300 transition-all placeholder:text-gray-400 mb-2 resize-none"
              rows={2}
            />
            <div className="flex gap-2">
              <button
                onClick={() => {
                  setShowCreateForm(false);
                  setViewName('');
                  setViewDescription('');
                }}
                className="flex-1 px-3 py-1.5 bg-white hover:bg-gray-50 text-gray-700 border border-gray-300 rounded-lg text-xs font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveCurrentView}
                disabled={!viewName.trim()}
                className="flex-1 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Save
              </button>
            </div>
          </div>
        )}

        {/* Saved Views List */}
        <div className="space-y-2 overflow-y-auto" style={{ maxHeight: 'calc(85vh - 200px)' }}>
          {filteredViews.map((view) => {
            const viewSelections = (view.selectedMSAIds?.length || 0) +
              (view.selectedCountyIds?.length || 0) +
              (view.selectedTractIds?.length || 0);

            const viewCompetitorFilters =
              (view.competitorCompanies?.length || 0) +
              (view.competitorCategories && view.competitorCategories.length > 0 ? 1 : 0) +
              (view.competitorSegments && view.competitorSegments.length > 0 ? 1 : 0);

            return (
              <div
                key={view.id}
                className="bg-white border border-gray-200 rounded-lg p-3 hover:border-indigo-300 hover:shadow-sm transition-all"
              >
                <div className="flex items-start justify-between mb-2">
                  <div className="flex items-start gap-1.5 flex-1">
                    <Star className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <h4 className="font-semibold text-gray-900 text-sm truncate">{view.name}</h4>
                      {view.description && (
                        <p className="text-xs text-gray-500 mt-0.5 line-clamp-1">{view.description}</p>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => handleDeleteView(view.id)}
                    className="text-gray-400 hover:text-red-500 p-0.5 rounded hover:bg-red-50 transition-colors flex-shrink-0"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>

                {/* View Details */}
                <div className="grid grid-cols-2 gap-1.5 mb-2 text-xs">
                  <div className="bg-gray-50 rounded px-2 py-1">
                    <span className="text-gray-500">Level:</span>
                    <span className="font-medium text-gray-900 ml-1">{view.geoLevel}</span>
                  </div>
                  <div className="bg-gray-50 rounded px-2 py-1">
                    <span className="text-gray-500">Segment:</span>
                    <span className="font-medium text-gray-900 ml-1">{view.segment}</span>
                  </div>
                  <div className="bg-gray-50 rounded px-2 py-1">
                    <span className="text-gray-500">Top:</span>
                    <span className="font-medium text-gray-900 ml-1">{view.rankingThreshold}%</span>
                  </div>
                  {viewSelections > 0 && (
                    <div className="bg-indigo-50 rounded px-2 py-1">
                      <span className="text-indigo-600 text-[10px] font-medium">Selections:</span>
                      <span className="font-medium text-indigo-900 ml-1">{viewSelections}</span>
                    </div>
                  )}
                  {view.showCompetitorLayer && (
                    <div className="bg-green-50 rounded px-2 py-1 col-span-2">
                      <span className="text-green-600 text-[10px] font-medium">Competitor</span>
                      {viewCompetitorFilters > 0 && (
                        <span className="font-medium text-green-900 ml-1">({viewCompetitorFilters})</span>
                      )}
                    </div>
                  )}
                </div>

                <button
                  onClick={() => onLoadView(view)}
                  className="w-full px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-medium transition-all mt-2"
                >
                  Load View
                </button>
              </div>
            );
          })}
        </div>

        {/* Empty State */}
        {savedViews.length === 0 && (
          <div className="text-center py-8">
            <div className="inline-flex items-center justify-center w-12 h-12 bg-gray-100 rounded-xl mb-3">
              <Save className="w-6 h-6 text-gray-400" />
            </div>
            <p className="text-sm text-gray-600 font-medium">No saved views yet</p>
            <p className="text-xs text-gray-400 mt-1">Save your current configuration</p>
          </div>
        )}

        {/* No Results */}
        {savedViews.length > 0 && filteredViews.length === 0 && (
          <div className="text-center py-8">
            <p className="text-sm text-gray-500">No views match "{searchQuery}"</p>
          </div>
        )}
      </div>
    </div>
  );
}
