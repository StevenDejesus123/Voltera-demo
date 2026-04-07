import { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, X, Zap } from 'lucide-react';
import type { SubstationFeature } from '../types';
import type { CircuitFeature } from './CircuitMapLayer';

// ── Types ──────────────────────────────────────────────────────────────────────
export type CapacityTier = 'green' | 'yellow' | 'orange' | 'red';
export type VoltageClass  = 'distribution' | 'subtransmission' | 'transmission';

export interface SubstationFilters {
  utilities:           Set<string>;
  capacityTiers:       Set<CapacityTier>;
  voltageClasses:      Set<VoltageClass>;
  minCapacityMw:       number;   // substation min load availability
  minCircuitCapacityKw: number;  // circuit min load availability
}

export function defaultSubstationFilters(): SubstationFilters {
  return {
    utilities: new Set(),
    capacityTiers: new Set(),
    voltageClasses: new Set<VoltageClass>(['distribution']),
    minCapacityMw: 0,
    minCircuitCapacityKw: 0,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────
export function getCapacityTier(mw: number | null): CapacityTier {
  if (mw == null || mw <= 0) return 'red';
  if (mw < 5)  return 'orange';
  if (mw <= 10) return 'yellow';
  return 'green';
}

export function getVoltageClass(kv: number | null): VoltageClass {
  if (kv == null || kv <= 33)  return 'distribution';
  if (kv <= 115)               return 'subtransmission';
  return 'transmission';
}

export function filterSubstations(
  substations: SubstationFeature[],
  filters: SubstationFilters,
): SubstationFeature[] {
  return substations.filter(s => {
    if (filters.utilities.size > 0 && !filters.utilities.has(s.utility)) return false;
    if (filters.capacityTiers.size > 0 && !filters.capacityTiers.has(getCapacityTier(s.capacityMw))) return false;
    if (filters.voltageClasses.size > 0 && !filters.voltageClasses.has(getVoltageClass(s.voltageKv))) return false;
    if (filters.minCapacityMw > 0 && (s.capacityMw == null || s.capacityMw < filters.minCapacityMw)) return false;
    return true;
  });
}

/**
 * Returns IDs of substations that match the active filters.
 * Empty set = no active filters (all substations are "normal", none are highlighted).
 * Non-empty set = highlight these, dim the rest — but never hide.
 */
export function getEmphasisIds(
  substations: SubstationFeature[],
  filters: SubstationFilters,
): Set<string> {
  if (!hasAnyFilter(filters)) return new Set();
  return new Set(
    substations
      .filter(s => {
        if (filters.utilities.size > 0 && !filters.utilities.has(s.utility)) return false;
        if (filters.capacityTiers.size > 0 && !filters.capacityTiers.has(getCapacityTier(s.capacityMw))) return false;
        if (filters.voltageClasses.size > 0 && !filters.voltageClasses.has(getVoltageClass(s.voltageKv))) return false;
        if (filters.minCapacityMw > 0 && (s.capacityMw == null || s.capacityMw < filters.minCapacityMw)) return false;
        return true;
      })
      .map(s => s.id),
  );
}

export function hasAnyFilter(f: SubstationFilters): boolean {
  return f.utilities.size > 0 || f.capacityTiers.size > 0 || f.voltageClasses.size > 0 || f.minCapacityMw > 0 || f.minCircuitCapacityKw > 0;
}

// Toggle helpers — empty set = "show all"; toggling off the last item resets to empty
function toggleSet<T>(set: Set<T>, value: T, all: T[]): Set<T> {
  const next = new Set(set);
  if (next.has(value)) {
    next.delete(value);
    // If nothing left, treat as "all selected" (clear to empty)
    return next.size === 0 ? new Set() : next;
  } else {
    // First toggle: initialize to all-except-value complement pattern
    if (next.size === 0) {
      // Select all except… no: just add this one
      next.add(value);
      return next;
    }
    next.add(value);
    // If all values are now selected, reset to empty (show all)
    if (all.every(v => next.has(v))) return new Set();
    return next;
  }
}

// ── Constants ─────────────────────────────────────────────────────────────────
const UTILITIES: { id: string; label: string; color: string }[] = [
  { id: 'sce',   label: 'SCE',   color: '#f59e0b' },
  { id: 'pge',   label: 'PG&E',  color: '#3b82f6' },
  { id: 'ladwp', label: 'LADWP', color: '#10b981' },
];

const CAPACITY_TIERS: { id: CapacityTier; label: string; range: string; color: string }[] = [
  { id: 'green',  label: 'High',    range: '> 10 MW',  color: '#22c55e' },
  { id: 'yellow', label: 'Medium',  range: '5–10 MW',  color: '#eab308' },
  { id: 'orange', label: 'Low',     range: '1–5 MW',   color: '#f97316' },
  { id: 'red',    label: 'Minimal', range: '0–1 MW',   color: '#ef4444' },
];

const VOLTAGE_CLASSES: { id: VoltageClass; label: string; range: string }[] = [
  { id: 'distribution',    label: 'Distribution',     range: '≤ 33 kV'   },
  { id: 'subtransmission', label: 'Sub-transmission', range: '44–115 kV' },
  { id: 'transmission',    label: 'Transmission',     range: '≥ 161 kV'  },
];

// ── Props ──────────────────────────────────────────────────────────────────────
interface UtilityGridPanelProps {
  onClose:           () => void;
  allSubstations:    SubstationFeature[];
  circuits?:         CircuitFeature[];
  filteredCount:     number;
  filters:           SubstationFilters;
  onFiltersChange:   (f: SubstationFilters) => void;
  showLayer:         boolean;
  onToggleLayer:     (show: boolean) => void;
  showAll:           boolean;
  onToggleShowAll:   (v: boolean) => void;
}

// ── Component ─────────────────────────────────────────────────────────────────
export function UtilityGridPanel({
  onClose,
  allSubstations,
  circuits = [],
  filteredCount,
  filters,
  onFiltersChange,
  showLayer,
  onToggleLayer,
  showAll,
  onToggleShowAll,
}: UtilityGridPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [subDraft,  setSubDraft]  = useState('');
  const [circDraft, setCircDraft] = useState('');

  // Click-outside to close
  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [onClose]);

  // Counts per dimension (from full set, not filtered)
  const utilityCounts = Object.fromEntries(
    UTILITIES.map(u => [u.id, allSubstations.filter(s => s.utility === u.id).length])
  );
  const circuitCounts = Object.fromEntries(
    UTILITIES.map(u => [u.id, circuits.filter(c => c.utility === u.id).length])
  );
  const circuitsLoaded = circuits.length > 0;
  const tierCounts = Object.fromEntries(
    CAPACITY_TIERS.map(t => [t.id, allSubstations.filter(s => getCapacityTier(s.capacityMw) === t.id).length])
  );
  const voltageCounts = Object.fromEntries(
    VOLTAGE_CLASSES.map(v => [v.id, allSubstations.filter(s => getVoltageClass(s.voltageKv) === v.id).length])
  );

  function setUtilities(v: string) {
    onFiltersChange({ ...filters, utilities: toggleSet(filters.utilities, v, UTILITIES.map(u => u.id)) });
  }
  function setCapacityTiers(v: CapacityTier) {
    onFiltersChange({ ...filters, capacityTiers: toggleSet(filters.capacityTiers, v, CAPACITY_TIERS.map(t => t.id)) });
  }
  function setVoltageClasses(v: VoltageClass) {
    onFiltersChange({ ...filters, voltageClasses: toggleSet(filters.voltageClasses, v, VOLTAGE_CLASSES.map(c => c.id)) });
  }
  function resetAll() {
    onFiltersChange(defaultSubstationFilters());
  }

  const activeCount = [filters.utilities.size, filters.capacityTiers.size, filters.voltageClasses.size]
    .filter(n => n > 0).length + (filters.minCapacityMw > 0 ? 1 : 0) + (filters.minCircuitCapacityKw > 0 ? 1 : 0);

  return (
    <div
      ref={panelRef}
      className="absolute right-0 top-full mt-2 w-80 bg-white rounded-xl shadow-2xl border border-gray-200 z-50 animate-in fade-in slide-in-from-top-2 duration-150"
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Zap className="w-4 h-4 text-yellow-500" />
          <span className="text-sm font-semibold text-gray-800">Utility Grid</span>
          <span className="text-xs text-gray-400">
            {filteredCount > 0
              ? `${filteredCount.toLocaleString()} highlighted`
              : `${allSubstations.length.toLocaleString()} substations`}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => onToggleLayer(!showLayer)}
            title={showLayer ? 'Hide pins' : 'Show pins'}
            className={`p-1.5 rounded-md transition-colors ${showLayer ? 'text-yellow-600 bg-yellow-50 hover:bg-yellow-100' : 'text-gray-400 hover:bg-gray-100'}`}
          >
            {showLayer ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
          </button>
          <button onClick={onClose} className="p-1.5 rounded-md text-gray-400 hover:bg-gray-100 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="px-4 py-3 space-y-4 max-h-[480px] overflow-y-auto">

        {/* Show all vs nearby-only toggle */}
        <div className="flex items-center justify-between py-1">
          <div>
            <p className="text-xs font-medium text-gray-700">Show all substations</p>
            <p className="text-[10px] text-gray-400 mt-0.5">
              {showAll ? 'All CA substations visible' : 'Only nearby shown when tract selected'}
            </p>
          </div>
          <button
            onClick={() => onToggleShowAll(!showAll)}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${
              showAll ? 'bg-yellow-500' : 'bg-gray-200'
            }`}
          >
            <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
              showAll ? 'translate-x-4' : 'translate-x-0.5'
            }`} />
          </button>
        </div>

        <div className="border-t border-gray-100" />

        {/* Utility */}
        <section>
          <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-2">Utility</p>
          <div className="flex gap-2">
            {UTILITIES.map(u => {
              const active = filters.utilities.size === 0 || filters.utilities.has(u.id);
              const selected = filters.utilities.has(u.id);
              return (
                <button
                  key={u.id}
                  onClick={() => setUtilities(u.id)}
                  className={`flex-1 flex flex-col items-center py-2 px-3 rounded-lg border text-xs transition-all ${
                    selected
                      ? 'border-transparent text-white shadow-sm'
                      : filters.utilities.size > 0
                      ? 'border-gray-200 text-gray-400 bg-gray-50 opacity-50'
                      : 'border-gray-200 text-gray-700 hover:border-gray-300 bg-gray-50'
                  }`}
                  style={selected ? { backgroundColor: u.color, borderColor: u.color } : {}}
                >
                  <span className="font-bold">{u.label}</span>
                  <span className={`text-[10px] mt-0.5 ${selected ? 'text-white/80' : 'text-gray-400'}`}>
                    {utilityCounts[u.id] > 0 ? `${utilityCounts[u.id]} subs` : null}
                    {utilityCounts[u.id] > 0 && circuitsLoaded && circuitCounts[u.id] > 0 ? ' · ' : null}
                    {circuitsLoaded && circuitCounts[u.id] > 0 ? `${circuitCounts[u.id]} circ` : null}
                    {utilityCounts[u.id] === 0 && !circuitsLoaded ? 'ICA data' : null}
                    {utilityCounts[u.id] === 0 && circuitsLoaded && circuitCounts[u.id] === 0 ? 'not in area' : null}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {/* Capacity Threshold Slider */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Min. Load Availability</p>
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-gray-400">≥</span>
              <input
                type="number"
                min={0}
                max={50}
                step={1}
                placeholder="Any"
                className={`w-14 text-xs text-center border rounded px-1 py-0.5 focus:outline-none focus:border-yellow-400 font-semibold ${filters.minCapacityMw > 0 ? 'border-yellow-300 text-yellow-600' : 'border-gray-200 text-gray-400'}`}
                value={subDraft !== '' ? subDraft : filters.minCapacityMw === 0 ? '' : filters.minCapacityMw}
                onChange={e => setSubDraft(e.target.value)}
                onFocus={e => { setSubDraft(String(filters.minCapacityMw || '')); e.currentTarget.select(); }}
                onBlur={() => {
                  const v = Math.max(0, Math.min(50, parseFloat(subDraft) || 0));
                  onFiltersChange({ ...filters, minCapacityMw: v });
                  setSubDraft('');
                }}
                onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
              />
              <span className="text-[10px] text-gray-400">MW</span>
            </div>
          </div>
          <input
            type="range"
            min={0}
            max={50}
            step={1}
            value={filters.minCapacityMw}
            onChange={e => onFiltersChange({ ...filters, minCapacityMw: Number(e.target.value) })}
            className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-yellow-500"
            style={{ background: filters.minCapacityMw === 0
              ? '#e5e7eb'
              : `linear-gradient(to right, #f59e0b 0%, #f59e0b ${filters.minCapacityMw * 2}%, #e5e7eb ${filters.minCapacityMw * 2}%, #e5e7eb 100%)`
            }}
          />
          <div className="flex justify-between text-[10px] text-gray-400 mt-1 px-0.5">
            <span>0</span>
            <span>10</span>
            <span>25</span>
            <span>50 MW</span>
          </div>
        </section>

        {/* Circuit Min Capacity Slider */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Min. Circuit Capacity</p>
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-gray-400">≥</span>
              <input
                type="number"
                min={0}
                max={20}
                step={0.5}
                placeholder="Any"
                className={`w-14 text-xs text-center border rounded px-1 py-0.5 focus:outline-none focus:border-blue-400 font-semibold ${filters.minCircuitCapacityKw > 0 ? 'border-blue-300 text-blue-600' : 'border-gray-200 text-gray-400'}`}
                value={circDraft !== '' ? circDraft : filters.minCircuitCapacityKw === 0 ? '' : filters.minCircuitCapacityKw / 1000}
                onChange={e => setCircDraft(e.target.value)}
                onFocus={e => { setCircDraft(String(filters.minCircuitCapacityKw ? filters.minCircuitCapacityKw / 1000 : '')); e.currentTarget.select(); }}
                onBlur={() => {
                  const v = Math.max(0, Math.min(20, parseFloat(circDraft) || 0));
                  onFiltersChange({ ...filters, minCircuitCapacityKw: Math.round(v * 1000) });
                  setCircDraft('');
                }}
                onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
              />
              <span className="text-[10px] text-gray-400">MW</span>
            </div>
          </div>
          <input
            type="range"
            min={0}
            max={20000}
            step={500}
            value={filters.minCircuitCapacityKw}
            onChange={e => onFiltersChange({ ...filters, minCircuitCapacityKw: Number(e.target.value) })}
            className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-blue-500"
            style={{ background: filters.minCircuitCapacityKw === 0
              ? '#e5e7eb'
              : `linear-gradient(to right, #3b82f6 0%, #3b82f6 ${filters.minCircuitCapacityKw / 200}%, #e5e7eb ${filters.minCircuitCapacityKw / 200}%, #e5e7eb 100%)`
            }}
          />
          <div className="flex justify-between text-[10px] text-gray-400 mt-1 px-0.5">
            <span>0</span>
            <span>5 MW</span>
            <span>10 MW</span>
            <span>20 MW</span>
          </div>
        </section>

        {/* Capacity Tier Quick-select */}
        <section>
          <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-2">Tier Quick-select</p>
          <div className="grid grid-cols-2 gap-1.5">
            {CAPACITY_TIERS.map(t => {
              const selected = filters.capacityTiers.has(t.id);
              const dimmed   = filters.capacityTiers.size > 0 && !selected;
              return (
                <button
                  key={t.id}
                  onClick={() => setCapacityTiers(t.id)}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs transition-all ${
                    selected
                      ? 'border-transparent text-white shadow-sm'
                      : dimmed
                      ? 'border-gray-200 text-gray-400 bg-gray-50 opacity-50'
                      : 'border-gray-200 text-gray-700 hover:border-gray-300 bg-gray-50'
                  }`}
                  style={selected ? { backgroundColor: t.color, borderColor: t.color } : {}}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10">
                    <polygon points="5,1 9,9 1,9" fill={selected ? 'rgba(255,255,255,0.9)' : t.color} />
                  </svg>
                  <div className="text-left min-w-0">
                    <div className="font-semibold leading-none">{t.label}</div>
                    <div className={`text-[10px] mt-0.5 ${selected ? 'text-white/80' : 'text-gray-400'}`}>{t.range}</div>
                  </div>
                  <span className={`ml-auto text-[10px] ${selected ? 'text-white/80' : 'text-gray-400'}`}>
                    {tierCounts[t.id]}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {/* Voltage Class */}
        <section>
          <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-2">Voltage Class</p>
          <div className="space-y-1.5">
            {VOLTAGE_CLASSES.map(v => {
              const selected = filters.voltageClasses.has(v.id);
              const dimmed   = filters.voltageClasses.size > 0 && !selected;
              return (
                <button
                  key={v.id}
                  onClick={() => setVoltageClasses(v.id)}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-lg border text-xs transition-all ${
                    selected
                      ? 'border-blue-400 bg-blue-50 text-blue-800'
                      : dimmed
                      ? 'border-gray-200 text-gray-400 bg-gray-50 opacity-50'
                      : 'border-gray-200 text-gray-700 hover:border-gray-300 bg-gray-50'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${selected ? 'bg-blue-500' : 'bg-gray-300'}`} />
                    <span className="font-medium">{v.label}</span>
                    <span className={`text-[10px] ${selected ? 'text-blue-500' : 'text-gray-400'}`}>{v.range}</span>
                  </div>
                  <span className="text-gray-400 text-[10px]">{voltageCounts[v.id]}</span>
                </button>
              );
            })}
          </div>
        </section>
      </div>

      {/* Footer */}
      {hasAnyFilter(filters) && (
        <div className="px-4 py-2.5 border-t border-gray-100">
          <button
            onClick={resetAll}
            className="w-full text-xs text-red-500 hover:text-red-700 font-medium py-1 hover:bg-red-50 rounded-md transition-colors"
          >
            Clear highlights ({activeCount} active)
          </button>
        </div>
      )}
    </div>
  );
}
