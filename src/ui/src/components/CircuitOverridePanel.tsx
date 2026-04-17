import { useState, useEffect } from 'react';
import { X, Download, Trash2, Save, AlertTriangle, Zap } from 'lucide-react';
import type { SelectedFeeder } from './CircuitMapLayer';
import {
  saveCircuitOverride, removeCircuitOverride, exportCircuitOverridesJson,
  circuitOverrideKey,
} from '../utils/circuitOverrides';
import type { CircuitOverrideMap, CircuitOverride } from '../utils/circuitOverrides';

interface CircuitOverridePanelProps {
  feeder: SelectedFeeder;
  overrides: CircuitOverrideMap;
  onOverridesChange: (next: CircuitOverrideMap) => void;
  onClose: () => void;
}

function loadLabel(kw: number | null): string {
  if (kw == null) return 'N/A';
  if (kw >= 1000) return `${(kw / 1000).toFixed(1)} MW`;
  return `${Math.round(kw)} kW`;
}

function loadColor(kw: number | null): string {
  if (kw == null || kw <= 0) return '#ef4444';
  if (kw < 1000)             return '#f97316';
  if (kw < 5000)             return '#eab308';
  return '#22c55e';
}

const UTILITY_BADGE: Record<string, string> = {
  sce:   'bg-amber-100 text-amber-700',
  pge:   'bg-blue-100 text-blue-700',
  ladwp: 'bg-emerald-100 text-emerald-700',
  sdge:  'bg-violet-100 text-violet-700',
};

export function CircuitOverridePanel({
  feeder,
  overrides,
  onOverridesChange,
  onClose,
}: CircuitOverridePanelProps) {
  const key = circuitOverrideKey(feeder.utility, feeder.circuitName);
  const existing = overrides[key];

  const [loadAvailKw, setLoadAvailKw] = useState<string>(existing?.loadAvailKw != null ? String(existing.loadAvailKw) : '');
  const [pvHostingKw, setPvHostingKw] = useState<string>(existing?.pvHostingKw != null ? String(existing.pvHostingKw) : '');
  const [voltageKv,   setVoltageKv]   = useState<string>(existing?.voltageKv   != null ? String(existing.voltageKv)   : '');
  const [notes,       setNotes]       = useState<string>(existing?.notes        ?? '');
  const [lastVerified, setLastVerified] = useState<string>(existing?.lastVerified ?? '');
  const [updatedBy,   setUpdatedBy]   = useState<string>(existing?.updatedBy    ?? '');
  const [dirty,  setDirty]  = useState(false);
  const [saving, setSaving] = useState(false);

  // Reset form when switching to a different feeder
  useEffect(() => {
    const ov = overrides[circuitOverrideKey(feeder.utility, feeder.circuitName)];
    setLoadAvailKw(ov?.loadAvailKw != null ? String(ov.loadAvailKw) : '');
    setPvHostingKw(ov?.pvHostingKw != null ? String(ov.pvHostingKw) : '');
    setVoltageKv(ov?.voltageKv     != null ? String(ov.voltageKv)   : '');
    setNotes(ov?.notes        ?? '');
    setLastVerified(ov?.lastVerified ?? '');
    setUpdatedBy(ov?.updatedBy  ?? '');
    setDirty(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feeder.utility, feeder.circuitName]);

  function markDirty() { setDirty(true); }

  async function handleSave() {
    setSaving(true);
    try {
      const override: CircuitOverride = {};
      const kw  = parseFloat(loadAvailKw);
      const pv  = parseFloat(pvHostingKw);
      const kv  = parseFloat(voltageKv);
      if (!isNaN(kw))  override.loadAvailKw = kw;
      if (!isNaN(pv))  override.pvHostingKw = pv;
      if (!isNaN(kv))  override.voltageKv   = kv;
      if (notes.trim())        override.notes       = notes.trim();
      if (lastVerified.trim()) override.lastVerified = lastVerified.trim();
      if (updatedBy.trim())    override.updatedBy   = updatedBy.trim();
      const next = await saveCircuitOverride(feeder.utility, feeder.circuitName, override);
      onOverridesChange(next);
      setDirty(false);
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove() {
    setSaving(true);
    try {
      const next = await removeCircuitOverride(feeder.utility, feeder.circuitName);
      onOverridesChange(next);
      setLoadAvailKw(''); setPvHostingKw(''); setVoltageKv('');
      setNotes(''); setLastVerified(''); setUpdatedBy('');
      setDirty(false);
    } finally {
      setSaving(false);
    }
  }

  const hasExisting = !!existing;
  const badgeClass  = UTILITY_BADGE[feeder.utility] ?? 'bg-gray-100 text-gray-600';
  const srcColor    = loadColor(feeder.loadAvailKw);

  return (
    <div className="absolute bottom-6 right-6 w-80 bg-white rounded-xl shadow-2xl border border-indigo-200 z-[9999] flex flex-col overflow-hidden">
      {/* Header */}
      <div className="bg-indigo-600 text-white px-4 py-3 flex items-start justify-between gap-2 flex-shrink-0">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5 flex-shrink-0 opacity-80" />
            <p className="font-semibold text-sm truncate">
              {feeder.circuitName || 'Unnamed Circuit'}
            </p>
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${badgeClass}`}>
              {feeder.utility}
            </span>
            {feeder.substationName && (
              <span className="text-indigo-200 text-[11px] truncate">{feeder.substationName}</span>
            )}
          </div>
        </div>
        <button onClick={onClose} className="p-1 rounded hover:bg-indigo-500 transition-colors flex-shrink-0 mt-0.5">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Source data (read-only) */}
      <div className="px-4 py-2 bg-gray-50 border-b border-gray-100 flex-shrink-0">
        <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1">Source data (read-only)</p>
        <div className="flex gap-4 text-[11px] text-gray-600 flex-wrap">
          <span>Load Avail: <span className="font-medium" style={{ color: srcColor }}>
            {loadLabel(feeder.loadAvailKw)}
          </span></span>
          {feeder.pvHostingKw != null && (
            <span>PV Hosting: <span className="font-medium text-gray-800">
              {loadLabel(feeder.pvHostingKw)}
            </span></span>
          )}
          {feeder.voltageKv != null && (
            <span>Voltage: <span className="font-medium text-gray-800">
              {feeder.voltageKv} kV
            </span></span>
          )}
        </div>
      </div>

      {/* Form */}
      <div className="px-4 py-3 space-y-3 overflow-y-auto flex-1">
        {hasExisting && (
          <div className="flex items-center gap-1.5 text-[11px] text-indigo-700 bg-indigo-50 px-2 py-1.5 rounded-md">
            <AlertTriangle className="w-3 h-3 flex-shrink-0" />
            Override active — source data is replaced below
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[11px] font-medium text-gray-600 mb-1">
              Load Availability (kW)
            </label>
            <input
              type="number"
              step="1"
              min="0"
              placeholder={feeder.loadAvailKw != null ? `${Math.round(feeder.loadAvailKw)}` : 'e.g. 3500'}
              value={loadAvailKw}
              onChange={e => { setLoadAvailKw(e.target.value); markDirty(); }}
              className="w-full text-xs border border-gray-200 rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-400"
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-gray-600 mb-1">
              PV Hosting (kW)
            </label>
            <input
              type="number"
              step="1"
              min="0"
              placeholder={feeder.pvHostingKw != null ? `${Math.round(feeder.pvHostingKw)}` : 'e.g. 1200'}
              value={pvHostingKw}
              onChange={e => { setPvHostingKw(e.target.value); markDirty(); }}
              className="w-full text-xs border border-gray-200 rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-400"
            />
          </div>
        </div>

        <div>
          <label className="block text-[11px] font-medium text-gray-600 mb-1">Voltage (kV)</label>
          <input
            type="number"
            step="0.1"
            min="0"
            placeholder={feeder.voltageKv != null ? `${feeder.voltageKv}` : 'e.g. 12'}
            value={voltageKv}
            onChange={e => { setVoltageKv(e.target.value); markDirty(); }}
            className="w-full text-xs border border-gray-200 rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />
        </div>

        <div>
          <label className="block text-[11px] font-medium text-gray-600 mb-1">Notes</label>
          <textarea
            rows={2}
            placeholder="Reason for override, source of updated info…"
            value={notes}
            onChange={e => { setNotes(e.target.value); markDirty(); }}
            className="w-full text-xs border border-gray-200 rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-400 resize-none"
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[11px] font-medium text-gray-600 mb-1">Last Verified</label>
            <input
              type="date"
              value={lastVerified}
              onChange={e => { setLastVerified(e.target.value); markDirty(); }}
              className="w-full text-xs border border-gray-200 rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-400"
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-gray-600 mb-1">Updated By</label>
            <input
              type="text"
              placeholder="Name / initials"
              value={updatedBy}
              onChange={e => { setUpdatedBy(e.target.value); markDirty(); }}
              className="w-full text-xs border border-gray-200 rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-400"
            />
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-gray-100 flex-shrink-0 space-y-2">
        <div className="flex gap-2">
          <button
            onClick={handleSave}
            disabled={saving || (!dirty && !hasExisting)}
            className="flex-1 flex items-center justify-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium py-2 rounded-lg transition-colors"
          >
            <Save className="w-3.5 h-3.5" />
            {saving ? 'Saving…' : hasExisting ? 'Update Override' : 'Save Override'}
          </button>
          {hasExisting && (
            <button
              onClick={handleRemove}
              disabled={saving}
              className="flex items-center justify-center gap-1 px-3 py-2 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title="Remove override — restore source data"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <button
          onClick={() => exportCircuitOverridesJson(overrides)}
          className="w-full flex items-center justify-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 py-1.5 hover:bg-gray-50 rounded-lg transition-colors"
        >
          <Download className="w-3.5 h-3.5" />
          Export circuit overrides
        </button>
      </div>
    </div>
  );
}
