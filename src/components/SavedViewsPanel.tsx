import { X, Save, Star, Trash2, Plus } from 'lucide-react';
import { SavedView, GeoLevel, Segment } from '../types';
import { useState } from 'react';

interface SavedViewsPanelProps {
  onClose: () => void;
  onLoadView: (view: SavedView) => void;
}

// Simplified state paths (subset for demonstration - these are approximate outlines)
export const MOCK_SAVED_VIEWS: SavedView[] = [
  {
    id: '1',
    name: 'Top AV Markets – West Coast',
    description: 'Best performing MSAs in CA, OR, WA for autonomous vehicles',
    segment: 'AV',
    rankingThreshold: 10,
    minProbability: 80,
    createdAt: new Date('2026-01-15'),
  },
  {
    id: '2',
    name: 'High-Density Urban Counties',
    description: 'County-level analysis of top urban centers',
    segment: 'Non-AV',
    rankingThreshold: 25,
    minProbability: 70,
    createdAt: new Date('2026-01-12'),
  },
  {
    id: '3',
    name: 'Tier 1 MSAs - All Segments',
    description: 'Top 5% MSAs regardless of segment type',
    segment: 'AV',
    rankingThreshold: 5,
    minProbability: 90,
    createdAt: new Date('2026-01-10'),
  },
  {
    id: '4',
    name: 'Census Tract Drill-Down - SF Bay',
    description: 'Detailed tract analysis for San Francisco Bay Area',
    segment: 'AV',
    rankingThreshold: 50,
    minProbability: 60,
    createdAt: new Date('2026-01-08'),
  },
];

export function SavedViewsPanel({ onClose, onLoadView }: SavedViewsPanelProps) {
  const [savedViews, setSavedViews] = useState<SavedView[]>(MOCK_SAVED_VIEWS);
  const [showCreateForm, setShowCreateForm] = useState(false);

  const handleDeleteView = (id: string) => {
    setSavedViews(savedViews.filter(view => view.id !== id));
  };

  return (
    <div className="w-96 bg-white border-l border-gray-200 overflow-y-auto flex-shrink-0 shadow-xl">
      {/* Header */}
      <div className="sticky top-0 bg-indigo-600 text-white p-6 z-10">
        <div className="flex items-start justify-between mb-2">
          <h2 className="font-semibold">Saved Views</h2>
          <button
            onClick={onClose}
            className="text-white hover:bg-indigo-700 p-1 rounded transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <p className="text-sm text-indigo-100">Quick access to frequently used filters</p>
      </div>

      {/* Content */}
      <div className="p-6 space-y-4">
        {/* Create New View Button */}
        <button
          onClick={() => setShowCreateForm(!showCreateForm)}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-medium transition-colors"
        >
          <Plus className="w-5 h-5" />
          Save Current View
        </button>

        {/* Create Form */}
        {showCreateForm && (
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
            <h3 className="font-semibold text-gray-900 mb-3">Save Current Configuration</h3>
            <input
              type="text"
              placeholder="View name..."
              className="w-full px-3 py-2 border border-gray-300 rounded-lg mb-2"
            />
            <textarea
              placeholder="Description (optional)..."
              className="w-full px-3 py-2 border border-gray-300 rounded-lg mb-3"
              rows={2}
            />
            <div className="flex gap-2">
              <button
                onClick={() => setShowCreateForm(false)}
                className="flex-1 px-3 py-2 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded-lg text-sm font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  // Would save the view here
                  setShowCreateForm(false);
                }}
                className="flex-1 px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-medium transition-colors"
              >
                Save
              </button>
            </div>
          </div>
        )}

        {/* Saved Views List */}
        <div className="space-y-3">
          {savedViews.map((view) => (
            <div
              key={view.id}
              className="bg-white border border-gray-200 rounded-lg p-4 hover:border-indigo-300 transition-colors"
            >
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-start gap-2 flex-1">
                  <Star className="w-4 h-4 text-yellow-500 flex-shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <h4 className="font-semibold text-gray-900 text-sm">{view.name}</h4>
                    <p className="text-xs text-gray-600 mt-1">{view.description}</p>
                  </div>
                </div>
                <button
                  onClick={() => handleDeleteView(view.id)}
                  className="text-gray-400 hover:text-red-500 p-1"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>

              {/* View Details */}
              <div className="grid grid-cols-2 gap-2 mb-3 text-xs">
                <div className="bg-gray-50 rounded px-2 py-1">
                  <span className="text-gray-600">Level:</span>
                  <span className="font-medium text-gray-900 ml-1">{view.geoLevel}</span>
                </div>
                <div className="bg-gray-50 rounded px-2 py-1">
                  <span className="text-gray-600">Segment:</span>
                  <span className="font-medium text-gray-900 ml-1">{view.segment}</span>
                </div>
                <div className="bg-gray-50 rounded px-2 py-1">
                  <span className="text-gray-600">Top:</span>
                  <span className="font-medium text-gray-900 ml-1">{view.rankingThreshold}%</span>
                </div>
                <div className="bg-gray-50 rounded px-2 py-1">
                  <span className="text-gray-600">Min Score:</span>
                  <span className="font-medium text-gray-900 ml-1">{view.minProbability}%</span>
                </div>
              </div>

              <div className="flex items-center justify-between text-xs text-gray-500 mb-3">
                <span>Saved {view.createdAt.toLocaleDateString()}</span>
              </div>

              <button
                onClick={() => onLoadView(view)}
                className="w-full px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-medium transition-colors"
              >
                Load View
              </button>
            </div>
          ))}
        </div>

        {/* Empty State */}
        {savedViews.length === 0 && (
          <div className="text-center py-12">
            <Save className="w-16 h-16 text-gray-300 mx-auto mb-4" />
            <p className="text-gray-500">No saved views yet</p>
            <p className="text-sm text-gray-400 mt-2">Save your current filter configuration for quick access</p>
          </div>
        )}
      </div>
    </div>
  );
}