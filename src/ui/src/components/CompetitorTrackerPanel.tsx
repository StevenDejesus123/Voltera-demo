import { useState, useEffect, useRef, useMemo } from 'react';
import { Eye, EyeOff, RefreshCw, Search, X } from 'lucide-react';
import type { CompetitorFilters } from '../types';
import {
  getCompetitorFilters,
  getCompetitorStats,
  getCompetitorSegments,
  getCategoryColor,
  loadCompetitorData,
} from '../dataLoader/competitorLoader';
import {
  getSalesforceLastUpdated,
  refreshSalesforceData,
  loadSalesforceData,
} from '../dataLoader/salesforceLoader';

// ── Types & Helpers ──────────────────────────────────────────────────────────

interface CompetitorTrackerPanelProps {
  onClose: () => void;
  selectedCompanies: Set<string>;
  onCompaniesChange: (companies: Set<string>) => void;
  selectedCategories: Set<string>;
  onCategoriesChange: (categories: Set<string>) => void;
  selectedSegments: Set<string>;
  onSegmentsChange: (segments: Set<string>) => void;
  // Kept for parent compatibility — not used in the popover UI
  selectedStatuses: Set<string>;
  onStatusesChange: (statuses: Set<string>) => void;
  selectedMSAs: Set<string>;
  onMSAsChange: (msas: Set<string>) => void;
  selectedStates: Set<string>;
  onStatesChange: (states: Set<string>) => void;
  showLayer: boolean;
  onToggleLayer: (show: boolean) => void;
}

const CATEGORY_ORDER = ['Customer', 'Competitor', 'Voltera'];

function formatTimeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function getSyncLabel(refreshing: boolean, lastSynced: string | null): string {
  if (refreshing) return 'Syncing...';
  if (lastSynced) return formatTimeAgo(lastSynced);
  return 'Sync';
}

// ── Main Component ───────────────────────────────────────────────────────────

export function CompetitorTrackerPanel({
  onClose,
  selectedCompanies,
  onCompaniesChange,
  selectedCategories,
  onCategoriesChange,
  selectedSegments,
  onSegmentsChange,
  showLayer,
  onToggleLayer,
}: CompetitorTrackerPanelProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [filters, setFilters] = useState<CompetitorFilters | null>(null);
  const [, setTick] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [companyQuery, setCompanyQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);

  // ── Data loading ───────────────────────────────────────────────────────────
  useEffect(() => {
    loadCompetitorData();
    loadSalesforceData();
    const handler = () => {
      setFilters(getCompetitorFilters());
      setTick(t => t + 1);
    };
    const sfHandler = () => setLastSynced(getSalesforceLastUpdated());
    window.addEventListener('competitor:loaded', handler);
    window.addEventListener('salesforce:loaded', sfHandler);
    const existing = getCompetitorFilters();
    if (existing) setFilters(existing);
    const existingSynced = getSalesforceLastUpdated();
    if (existingSynced) setLastSynced(existingSynced);
    return () => {
      window.removeEventListener('competitor:loaded', handler);
      window.removeEventListener('salesforce:loaded', sfHandler);
    };
  }, []);

  // ── Click outside ──────────────────────────────────────────────────────────
  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) onClose();
    };
    const timer = setTimeout(() => document.addEventListener('mousedown', handle), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handle);
    };
  }, [onClose]);

  // ── Salesforce refresh ─────────────────────────────────────────────────────
  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await refreshSalesforceData();
      setLastSynced(getSalesforceLastUpdated());
      setFilters(getCompetitorFilters());
      setTick(t => t + 1);
    } catch (e) {
      console.error('Salesforce refresh failed:', e);
    } finally {
      setRefreshing(false);
    }
  };

  // ── Derived data ───────────────────────────────────────────────────────────
  const stats = getCompetitorStats();

  const sortedCategories = useMemo(() => {
    // Filter out 'Pipeline' — SF sites are displayed as 'Customer'
    return (filters?.categories ?? [])
      .filter(c => c !== 'Pipeline')
      .sort((a, b) => {
        const ai = CATEGORY_ORDER.indexOf(a);
        const bi = CATEGORY_ORDER.indexOf(b);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      });
  }, [filters?.categories]);

  const availableSegments = useMemo(() => getCompetitorSegments(), [filters]);

  const allCompanies = filters?.companies ?? [];
  const companyResults = companyQuery
    ? allCompanies.filter(c =>
        c.toLowerCase().includes(companyQuery.toLowerCase()) && !selectedCompanies.has(c)
      ).slice(0, 8)
    : [];

  // ── Shared toggle logic ──────────────────────────────────────────────────────
  // "Show all" = empty set. Toggling off the last item returns to "show all".
  function toggleInSet(
    selected: Set<string>,
    allItems: string[],
    item: string,
    onChange: (next: Set<string>) => void,
  ): void {
    const next = new Set(selected);
    if (selected.size === 0) {
      // Currently showing all — select everything EXCEPT this item
      for (const s of allItems) {
        if (s !== item) next.add(s);
      }
    } else if (next.has(item)) {
      next.delete(item);
      if (next.size === 0) { onChange(new Set()); return; }
    } else {
      next.add(item);
    }
    onChange(next);
  }

  function isCategoryActive(cat: string): boolean {
    return selectedCategories.size === 0 || selectedCategories.has(cat);
  }

  function isSegmentActive(seg: string): boolean {
    return selectedSegments.size === 0 || selectedSegments.has(seg);
  }

  // ── Company selection ──────────────────────────────────────────────────────
  function addCompany(name: string) {
    const next = new Set(selectedCompanies);
    next.add(name);
    onCompaniesChange(next);
    setCompanyQuery('');
    searchRef.current?.focus();
  }

  function removeCompany(name: string) {
    const next = new Set(selectedCompanies);
    next.delete(name);
    onCompaniesChange(next);
  }

  const hasAnyFilter = selectedCompanies.size > 0 || selectedCategories.size > 0 || selectedSegments.size > 0;

  return (
    <div
      ref={popoverRef}
      className="absolute top-full right-0 mt-2 w-[400px] bg-white rounded-2xl shadow-[0_20px_60px_-15px_rgba(0,0,0,0.25)] border border-gray-200/60 z-50 overflow-hidden animate-in fade-in slide-in-from-top-2"
      style={{ animation: 'popoverIn 150ms ease-out' }}
    >
      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      <div className="px-5 pt-4 pb-3">
        <div className="flex items-center justify-between">
          {/* Layer toggle */}
          <button
            onClick={() => onToggleLayer(!showLayer)}
            className={`group flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
              showLayer
                ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
            }`}
          >
            {showLayer ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
            Map Pins {showLayer ? 'On' : 'Off'}
          </button>

          <div className="flex items-center gap-2">
            {/* Sync */}
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-gray-400 hover:text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-50"
              title="Sync from Salesforce"
            >
              <RefreshCw className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} />
              <span className="tabular-nums">{getSyncLabel(refreshing, lastSynced)}</span>
            </button>

            {/* Close */}
            <button onClick={onClose} className="p-1 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Stats */}
        {stats && (
          <p className="mt-2.5 text-xs text-gray-400">
            <span className="text-gray-900 font-semibold">{stats.totalSites.toLocaleString()}</span> sites across{' '}
            <span className="text-gray-900 font-semibold">{stats.companiesCount}</span> companies
            {stats.sitesWithCoords < stats.totalSites && (
              <span> · <span className="text-gray-900 font-semibold">{stats.sitesWithCoords}</span> mapped</span>
            )}
          </p>
        )}
      </div>

      {/* ── Category toggles ─────────────────────────────────────────────── */}
      <div className="px-5 pb-3">
        <div className="flex gap-2">
          {sortedCategories.map(cat => {
            const active = isCategoryActive(cat);
            const color = getCategoryColor(cat);
            return (
              <button
                key={cat}
                onClick={() => toggleInSet(selectedCategories, sortedCategories, cat, onCategoriesChange)}
                className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold transition-all border ${
                  active
                    ? 'text-white shadow-sm'
                    : 'bg-white text-gray-400 border-gray-200 hover:border-gray-300 hover:text-gray-600'
                }`}
                style={active ? { backgroundColor: color, borderColor: color } : undefined}
              >
                <span
                  className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: active ? 'rgba(255,255,255,0.7)' : color }}
                />
                {cat}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Segment toggles ───────────────────────────────────────────────── */}
      {availableSegments.length > 0 && (
        <div className="px-5 pb-3">
          <p className="text-xs text-gray-500 font-medium mb-2">Customer Segment</p>
          <div className="flex flex-wrap gap-2">
            {availableSegments.map(seg => {
              const active = isSegmentActive(seg);
              return (
                <button
                  key={seg}
                  onClick={() => toggleInSet(selectedSegments, availableSegments, seg, onSegmentsChange)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all border ${
                    active
                      ? 'bg-indigo-50 text-indigo-700 border-indigo-200'
                      : 'bg-white text-gray-400 border-gray-200 hover:border-gray-300 hover:text-gray-600'
                  }`}
                >
                  {seg}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="border-t border-gray-100" />

      {/* ── Company search ────────────────────────────────────────────────── */}
      <div className="px-5 py-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-300" />
          <input
            ref={searchRef}
            type="text"
            placeholder={selectedCompanies.size > 0
              ? 'Add another company...'
              : `Filter from ${allCompanies.length} companies...`
            }
            value={companyQuery}
            onChange={e => setCompanyQuery(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setTimeout(() => setSearchFocused(false), 150)}
            className="w-full pl-10 pr-3 py-2.5 text-sm bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300 focus:bg-white transition-all placeholder:text-gray-400"
          />
        </div>

        {/* Selected company chips */}
        {selectedCompanies.size > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2.5">
            {[...selectedCompanies].map(name => (
              <span
                key={name}
                className="inline-flex items-center gap-1 pl-2.5 pr-1.5 py-1 bg-indigo-50 text-indigo-700 rounded-lg text-xs font-medium group"
              >
                {name}
                <button
                  onClick={() => removeCompany(name)}
                  className="p-0.5 rounded hover:bg-indigo-100 transition-colors"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Search results dropdown */}
        {companyQuery && searchFocused && (
          <div className="mt-2 max-h-40 overflow-y-auto rounded-xl border border-gray-200 bg-white shadow-lg">
            {companyResults.length > 0 ? (
              companyResults.map(name => (
                <button
                  key={name}
                  onMouseDown={() => addCompany(name)}
                  className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-indigo-50 hover:text-indigo-700 transition-colors first:rounded-t-xl last:rounded-b-xl"
                >
                  {name}
                </button>
              ))
            ) : (
              <p className="px-4 py-3 text-sm text-gray-400">No companies match "{companyQuery}"</p>
            )}
          </div>
        )}
      </div>

      {/* ── Footer ────────────────────────────────────────────────────────── */}
      {hasAnyFilter && (
        <div className="px-5 py-2.5 border-t border-gray-100">
          <button
            onClick={() => {
              onCompaniesChange(new Set());
              onCategoriesChange(new Set());
              onSegmentsChange(new Set());
            }}
            className="w-full text-xs font-medium text-gray-400 hover:text-gray-600 transition-colors py-1"
          >
            Reset all filters
          </button>
        </div>
      )}
    </div>
  );
}
