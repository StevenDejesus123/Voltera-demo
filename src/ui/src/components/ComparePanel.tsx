import { X, TrendingUp, Users, MapPin, Trash2, Plus, ArrowRight } from 'lucide-react';
import { Region } from '../types';
import { useState } from 'react';

interface ComparePanelProps {
  regions: [Region | null, Region | null];
  onClose: () => void;
  onRemoveRegion: (index: number) => void;
  allRegions: Region[];
  onAddRegion: (region: Region) => void;
}

export function ComparePanel({ regions, onClose, onRemoveRegion, allRegions, onAddRegion }: ComparePanelProps) {
  const [region1, region2] = regions;
  const [showSuggestions, setShowSuggestions] = useState(true);

  // Get top regions for suggestions
  const topRegions = allRegions.slice(0, 5);

  return (
    <div className="w-[700px] bg-white border-l border-gray-200 overflow-y-auto flex-shrink-0 shadow-xl">
      {/* Header */}
      <div className="sticky top-0 bg-blue-600 text-white p-6 z-10">
        <div className="flex items-start justify-between mb-2">
          <h2 className="font-semibold">Compare Regions</h2>
          <button
            onClick={onClose}
            className="text-white hover:bg-blue-700 p-1 rounded transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <p className="text-sm text-blue-100">Side-by-side comparison of selected regions</p>
      </div>

      {/* Content */}
      <div className="p-6">
        {!region1 && !region2 ? (
          <div>
            {/* Empty State with Suggestions */}
            <div className="text-center py-8 mb-6">
              <MapPin className="w-16 h-16 text-gray-300 mx-auto mb-4" />
              <p className="text-gray-500 font-medium">No regions selected for comparison</p>
              <p className="text-sm text-gray-400 mt-2">Click on regions in any panel to add them for comparison</p>
            </div>

            {/* Quick Suggestions */}
            {showSuggestions && topRegions.length > 0 && (
              <div className="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-lg p-6 border border-blue-200">
                <h3 className="font-semibold text-gray-900 mb-4 flex items-center gap-2">
                  <TrendingUp className="w-5 h-5 text-indigo-600" />
                  Suggested Comparisons
                </h3>
                <p className="text-sm text-gray-600 mb-4">
                  Compare top-ranked regions to understand performance differences
                </p>
                <div className="space-y-2">
                  {topRegions.map((region) => (
                    <button
                      key={region.id}
                      onClick={() => onAddRegion(region)}
                      className="w-full flex items-center justify-between p-3 bg-white hover:bg-gray-50 rounded-lg border border-gray-200 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <span className="inline-flex items-center justify-center w-8 h-8 bg-indigo-100 text-indigo-700 font-semibold rounded-full text-sm">
                          #{region.rank}
                        </span>
                        <div className="text-left">
                          <p className="font-medium text-gray-900 text-sm">{region.name}</p>
                          <p className="text-xs text-gray-500">{region.geoLevel} • Score: {(region.score * 100).toFixed(0)}%</p>
                        </div>
                      </div>
                      <Plus className="w-4 h-4 text-indigo-600" />
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Why Compare Section */}
            <div className="mt-6 bg-gray-50 rounded-lg p-6 border border-gray-200">
              <h3 className="font-semibold text-gray-900 mb-3">Why Compare Regions?</h3>
              <ul className="space-y-2 text-sm text-gray-600">
                <li className="flex items-start gap-2">
                  <ArrowRight className="w-4 h-4 text-indigo-600 flex-shrink-0 mt-0.5" />
                  <span>Identify key differences in ranking factors</span>
                </li>
                <li className="flex items-start gap-2">
                  <ArrowRight className="w-4 h-4 text-indigo-600 flex-shrink-0 mt-0.5" />
                  <span>Understand score variations across similar markets</span>
                </li>
                <li className="flex items-start gap-2">
                  <ArrowRight className="w-4 h-4 text-indigo-600 flex-shrink-0 mt-0.5" />
                  <span>Make data-driven expansion decisions</span>
                </li>
                <li className="flex items-start gap-2">
                  <ArrowRight className="w-4 h-4 text-indigo-600 flex-shrink-0 mt-0.5" />
                  <span>Validate model performance across geographies</span>
                </li>
              </ul>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-6">
            {/* Region 1 Column */}
            <div>
              {region1 ? (
                <div className="space-y-4">
                  <div className="flex items-start justify-between">
                    <h3 className="font-semibold text-gray-900 text-sm">{region1.name}</h3>
                    <button
                      onClick={() => onRemoveRegion(0)}
                      className="text-red-500 hover:text-red-700 p-1"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>

                  {/* Metrics */}
                  <div className="bg-gradient-to-br from-indigo-50 to-indigo-100 rounded-lg p-4 border border-indigo-200">
                    <p className="text-xs font-medium text-indigo-700 mb-1">Rank</p>
                    <p className="text-3xl font-bold text-indigo-900">#{region1.rank}</p>
                  </div>

                  <div className="bg-gradient-to-br from-green-50 to-green-100 rounded-lg p-4 border border-green-200">
                    <p className="text-xs font-medium text-green-700 mb-1">Score</p>
                    <p className="text-3xl font-bold text-green-900">{(region1.score * 100).toFixed(0)}%</p>
                  </div>

                  <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                    <div className="flex items-center gap-2 mb-2">
                      <Users className="w-4 h-4 text-gray-600" />
                      <p className="text-xs font-medium text-gray-700">Customers</p>
                    </div>
                    <p className="text-2xl font-bold text-gray-900">{region1.customerCount.toLocaleString()}</p>
                  </div>

                  <div className={`rounded-lg p-4 border ${
                    region1.inGeofence ? 'bg-purple-50 border-purple-200' : 'bg-gray-50 border-gray-200'
                  }`}>
                    <p className="text-xs font-medium mb-2">Geofence Status</p>
                    <p className={`text-sm font-semibold ${region1.inGeofence ? 'text-purple-900' : 'text-gray-700'}`}>
                      {region1.inGeofence ? '✓ Inside Zone' : '✗ Outside Zone'}
                    </p>
                  </div>

                  {/* Factors */}
                  <div>
                    <h4 className="text-xs font-semibold text-gray-700 mb-3">Top Factors</h4>
                    <div className="space-y-2">
                      {region1.factors.slice(0, 3).map((factor, i) => (
                        <div key={i} className="text-xs">
                          <p className="font-medium text-gray-900">{factor.name}</p>
                          <p className="text-gray-600">{factor.description}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="text-center py-8 bg-gray-50 rounded-lg border-2 border-dashed border-gray-300">
                  <p className="text-sm text-gray-500 mb-3">Region 1</p>
                  <p className="text-xs text-gray-400 mb-4">Select a region from any panel</p>
                  {topRegions.length > 0 && (
                    <button
                      onClick={() => onAddRegion(topRegions[0])}
                      className="inline-flex items-center gap-2 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded text-xs font-medium transition-colors"
                    >
                      <Plus className="w-3 h-3" />
                      Add Top Region
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Region 2 Column */}
            <div>
              {region2 ? (
                <div className="space-y-4">
                  <div className="flex items-start justify-between">
                    <h3 className="font-semibold text-gray-900 text-sm">{region2.name}</h3>
                    <button
                      onClick={() => onRemoveRegion(1)}
                      className="text-red-500 hover:text-red-700 p-1"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>

                  {/* Metrics */}
                  <div className="bg-gradient-to-br from-indigo-50 to-indigo-100 rounded-lg p-4 border border-indigo-200">
                    <p className="text-xs font-medium text-indigo-700 mb-1">Rank</p>
                    <p className="text-3xl font-bold text-indigo-900">#{region2.rank}</p>
                  </div>

                  <div className="bg-gradient-to-br from-green-50 to-green-100 rounded-lg p-4 border border-green-200">
                    <p className="text-xs font-medium text-green-700 mb-1">Score</p>
                    <p className="text-3xl font-bold text-green-900">{(region2.score * 100).toFixed(0)}%</p>
                  </div>

                  <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                    <div className="flex items-center gap-2 mb-2">
                      <Users className="w-4 h-4 text-gray-600" />
                      <p className="text-xs font-medium text-gray-700">Customers</p>
                    </div>
                    <p className="text-2xl font-bold text-gray-900">{region2.customerCount.toLocaleString()}</p>
                  </div>

                  <div className={`rounded-lg p-4 border ${
                    region2.inGeofence ? 'bg-purple-50 border-purple-200' : 'bg-gray-50 border-gray-200'
                  }`}>
                    <p className="text-xs font-medium mb-2">Geofence Status</p>
                    <p className={`text-sm font-semibold ${region2.inGeofence ? 'text-purple-900' : 'text-gray-700'}`}>
                      {region2.inGeofence ? '✓ Inside Zone' : '✗ Outside Zone'}
                    </p>
                  </div>

                  {/* Factors */}
                  <div>
                    <h4 className="text-xs font-semibold text-gray-700 mb-3">Top Factors</h4>
                    <div className="space-y-2">
                      {region2.factors.slice(0, 3).map((factor, i) => (
                        <div key={i} className="text-xs">
                          <p className="font-medium text-gray-900">{factor.name}</p>
                          <p className="text-gray-600">{factor.description}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="text-center py-8 bg-gray-50 rounded-lg border-2 border-dashed border-gray-300">
                  <p className="text-sm text-gray-500 mb-3">Region 2</p>
                  <p className="text-xs text-gray-400 mb-4">Select a region from any panel</p>
                  {topRegions.length > 1 && region1 && (
                    <button
                      onClick={() => onAddRegion(topRegions.find(r => r.id !== region1.id) || topRegions[1])}
                      className="inline-flex items-center gap-2 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded text-xs font-medium transition-colors"
                    >
                      <Plus className="w-3 h-3" />
                      Add Region to Compare
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Comparison Summary */}
        {region1 && region2 && (
          <div className="mt-6 pt-6 border-t border-gray-200">
            <h3 className="font-semibold text-gray-900 mb-4">Quick Comparison</h3>
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-gradient-to-br from-blue-50 to-blue-100 rounded-lg p-4 border border-blue-200">
                <p className="text-xs text-blue-700 mb-1">Better Rank</p>
                <p className="font-semibold text-blue-900 text-sm">
                  {region1.rank < region2.rank ? region1.name : region2.name}
                </p>
              </div>
              <div className="bg-gradient-to-br from-green-50 to-green-100 rounded-lg p-4 border border-green-200">
                <p className="text-xs text-green-700 mb-1">Higher Score</p>
                <p className="font-semibold text-green-900 text-sm">
                  {region1.score > region2.score ? region1.name : region2.name}
                </p>
              </div>
              <div className="bg-gradient-to-br from-purple-50 to-purple-100 rounded-lg p-4 border border-purple-200">
                <p className="text-xs text-purple-700 mb-1">More Customers</p>
                <p className="font-semibold text-purple-900 text-sm">
                  {region1.customerCount > region2.customerCount ? region1.name : region2.name}
                </p>
              </div>
              <div className="bg-gradient-to-br from-amber-50 to-amber-100 rounded-lg p-4 border border-amber-200">
                <p className="text-xs text-amber-700 mb-1">Score Difference</p>
                <p className="font-semibold text-amber-900 text-sm">
                  {Math.abs((region1.score - region2.score) * 100).toFixed(1)}%
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}