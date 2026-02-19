import { X, Zap, TrendingUp, Plus, Trash2 } from 'lucide-react';
import { WhatIfScenario } from '../types';
import { useState } from 'react';

interface WhatIfPanelProps {
  onClose: () => void;
  activeScenario: WhatIfScenario | null;
  onScenarioChange: (scenario: WhatIfScenario | null) => void;
}

export function WhatIfPanel({ onClose, activeScenario, onScenarioChange }: WhatIfPanelProps) {
  const [evStations, setEvStations] = useState(10);
  const [chargingSpeed, setChargingSpeed] = useState<'fast' | 'standard'>('fast');

  const calculateImpact = () => {
    const baseImpact = evStations * 0.5;
    const speedMultiplier = chargingSpeed === 'fast' ? 1.5 : 1.0;
    return Math.min(baseImpact * speedMultiplier, 25); // Cap at 25%
  };

  const handleApplyScenario = () => {
    const scenario: WhatIfScenario = {
      id: `scenario-${Date.now()}`,
      name: `${evStations} ${chargingSpeed} EV stations`,
      evStations,
      chargingSpeed,
      scoreImpact: calculateImpact(),
    };
    onScenarioChange(scenario);
  };

  const handleClearScenario = () => {
    onScenarioChange(null);
  };

  return (
    <div className="w-96 bg-white border-l border-gray-200 overflow-y-auto flex-shrink-0 shadow-xl">
      {/* Header */}
      <div className="sticky top-0 bg-purple-600 text-white p-6 z-10">
        <div className="flex items-start justify-between mb-2">
          <h2 className="font-semibold">Simulation Analysis</h2>
          <button
            onClick={onClose}
            className="text-white hover:bg-purple-700 p-1 rounded transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <p className="text-sm text-purple-100">Simulate infrastructure changes</p>
      </div>
      <div className="p-6 space-y-6">
        AI/ML model doesn't say something ABSOLUTELY ACCURATE, It just calculates out mathematically.
        But Simulation can say reality. It can show what will happen and how good it will be after infrastructure setup or any properties change.
      </div>
      {/* Content */}
      {false && <div className="p-6 space-y-6">
        {/* Active Scenario Banner */}
        {activeScenario && (
          <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
            <div className="flex items-start justify-between mb-2">
              <div className="flex items-center gap-2">
                <Zap className="w-5 h-5 text-purple-600" />
                <h3 className="font-semibold text-purple-900">Active Scenario</h3>
              </div>
              <button
                onClick={handleClearScenario}
                className="text-purple-600 hover:text-purple-800"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
            <p className="text-sm text-purple-800 mb-2">{activeScenario.name}</p>
            <div className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-purple-600" />
              <p className="text-sm font-semibold text-purple-900">
                +{activeScenario.scoreImpact.toFixed(1)}% score increase
              </p>
            </div>
          </div>
        )}

        {/* Scenario Builder */}
        <div>
          <h3 className="font-semibold text-gray-900 mb-4">Create New Scenario</h3>
          
          {/* EV Stations Slider */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Number of EV Charging Stations: {evStations}
            </label>
            <input
              type="range"
              min="0"
              max="50"
              value={evStations}
              onChange={(e) => setEvStations(Number(e.target.value))}
              className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-purple-600"
            />
            <div className="flex justify-between text-xs text-gray-500 mt-1">
              <span>0</span>
              <span>25</span>
              <span>50</span>
            </div>
          </div>

          {/* Charging Speed */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Charging Speed
            </label>
            <div className="space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="chargingSpeed"
                  value="fast"
                  checked={chargingSpeed === 'fast'}
                  onChange={(e) => setChargingSpeed('fast')}
                  className="w-4 h-4 text-purple-600"
                />
                <span className="text-sm text-gray-700">Fast Charging (DC)</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="chargingSpeed"
                  value="standard"
                  checked={chargingSpeed === 'standard'}
                  onChange={(e) => setChargingSpeed('standard')}
                  className="w-4 h-4 text-purple-600"
                />
                <span className="text-sm text-gray-700">Standard Charging (AC)</span>
              </label>
            </div>
          </div>

          {/* Impact Preview */}
          <div className="bg-gradient-to-br from-green-50 to-green-100 border border-green-200 rounded-lg p-4 mb-4">
            <p className="text-xs font-medium text-green-700 mb-1">Estimated Impact</p>
            <p className="text-2xl font-bold text-green-900">+{calculateImpact().toFixed(1)}%</p>
            <p className="text-xs text-green-700 mt-1">Average score increase across regions</p>
          </div>

          {/* Apply Button */}
          <button
            onClick={handleApplyScenario}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-medium transition-colors"
          >
            <Plus className="w-5 h-5" />
            Apply Scenario
          </button>
        </div>

        {/* Explanation */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <h4 className="text-sm font-semibold text-blue-900 mb-2">
            How This Works
          </h4>
          <p className="text-sm text-blue-800 leading-relaxed">
            This simulation estimates how adding EV charging infrastructure would impact 
            regional rankings. Fast charging stations have a stronger positive effect on 
            scores due to reduced wait times and better user experience.
          </p>
        </div>

        {/* Preset Scenarios */}
        <div>
          <h3 className="font-semibold text-gray-900 mb-3">Preset Scenarios</h3>
          <div className="space-y-2">
            <button
              onClick={() => {
                setEvStations(15);
                setChargingSpeed('fast');
              }}
              className="w-full text-left px-4 py-3 bg-gray-50 hover:bg-gray-100 rounded-lg border border-gray-200 transition-colors"
            >
              <p className="font-medium text-gray-900 text-sm">Urban Expansion</p>
              <p className="text-xs text-gray-600">15 fast charging stations</p>
            </button>
            <button
              onClick={() => {
                setEvStations(30);
                setChargingSpeed('fast');
              }}
              className="w-full text-left px-4 py-3 bg-gray-50 hover:bg-gray-100 rounded-lg border border-gray-200 transition-colors"
            >
              <p className="font-medium text-gray-900 text-sm">Metro Build-Out</p>
              <p className="text-xs text-gray-600">30 fast charging stations</p>
            </button>
            <button
              onClick={() => {
                setEvStations(20);
                setChargingSpeed('standard');
              }}
              className="w-full text-left px-4 py-3 bg-gray-50 hover:bg-gray-100 rounded-lg border border-gray-200 transition-colors"
            >
              <p className="font-medium text-gray-900 text-sm">Suburban Network</p>
              <p className="text-xs text-gray-600">20 standard charging stations</p>
            </button>
          </div>
        </div>
      </div>}
    </div>
  );
}
