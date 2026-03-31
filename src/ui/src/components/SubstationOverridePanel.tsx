import { useState, useEffect } from 'react';
import { X, Download, Trash2, Save, AlertTriangle } from 'lucide-react';
import type { SubstationFeature } from '../types';
import {
  saveOverride, removeOverride, exportOverridesJson,
} from '../utils/substationOverrides';
import type { OverrideMap, SubstationOverride } from '../utils/substationOverrides';

interface SubstationOverridePanelProps {
  substation: SubstationFeature;   // raw (pre-override) source data
  overrides: OverrideMap;
  onOverridesChange: (next: OverrideMap) => void;
  onClose: () => void;
}

function voltageLabel(kv: number | null): string {
  if (kv == null) return 'Unknown';
  if (kv <= 33)  return `${kv} kV (Distribution)`;
  if (kv <= 115) return `${kv} kV (Sub-transmission)`;
  return `${kv} kV (Transmission)`;
}

export function SubstationOverridePanel({
  substation,
  overrides,
  onOverridesChange,
  onClose,
}: SubstationOverridePanelProps) {
  const existing = overrides[substation.id];

  const [capacityMw, setCapacityMw]   = useState<string>(existing?.capacityMw != null ? String(existing.capacityMw) : '');
  const [voltageKv,  setVoltageKv]    = useState<string>(existing?.voltageKv  != null ? String(existing.voltageKv)  : '');
  const [notes,      setNotes]        = useState<string>(existing?.notes        ?? '');
  const [lastVerified, setLastVerified] = useState<string>(existing?.lastVerified ?? '');
  const [updatedBy,  setUpdatedBy]    = useState<string>(existing?.updatedBy    ?? '');
  const [dirty, setDirty] = useState(false);

  // Reset form when switching to a different substation
  useEffect(() => {
    const ov = overrides[substation.id];
    setCapacityMw(ov?.capacityMw != null ? String(ov.capacityMw) : '');
    setVoltageKv(ov?.voltageKv   != null ? String(ov.voltageKv)  : '');
    setNotes(ov?.notes        ?? '');
    setLastVerified(ov?.lastVerified ?? '');
    setUpdatedBy(ov?.updatedBy  ?? '');
    setDirty(false);
  }, [substation.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function markDirty() { setDirty(true); }

  function handleSave() {
    const override: SubstationOverride = {};
    const cap = parseFloat(capacityMw);
    const kv  = parseFloat(voltageKv);
    if (!isNaN(cap)) override.capacityMw = cap;
    if (!isNaN(kv))  override.voltageKv  = kv;
    if (notes.trim())        override.notes       = notes.trim();
    if (lastVerified.trim()) override.lastVerified = lastVerified.trim();
    if (updatedBy.trim())    override.updatedBy   = updatedBy.trim();
    const next = saveOverride(substation.id, override);
    onOverridesChange(next);
    setDirty(false);
  }

  function handleRemove() {
    const next = removeOverride(substation.id);
    onOverridesChange(next);
    setCapacityMw(''); setVoltageKv(''); setNotes('');
    setLastVerified(''); setUpdatedBy('');
    setDirty(false);
  }

  function handleExport() {
    exportOverridesJson();
  }

  const hasExisting = !!existing;
  const overrideCount = Object.keys(overrides).length;

  return (
    <div className="absolute bottom-6 right-6 w-80 bg-white rounded-xl shadow-2xl border border-indigo-200 z-[9999] flex flex-col overflow-hidden">
      {/* Header */}
      <div className="bg-indigo-600 text-white px-4 py-3 flex items-start justify-between gap-2 flex-shrink-0">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-bold bg-white text-indigo-600 rounded px-1.5 py-0.5 flex-shrink-0">V</span>
            <p className="font-semibold text-sm truncate">{substation.name || 'Unnamed Substation'}</p>
          </div>
          <p className="text-indigo-200 text-[11px] uppercase tracking-wide mt-0.5">{substation.utility || 'Unknown utility'}</p>
        </div>
        <button onClick={onClose} className="p-1 rounded hover:bg-indigo-500 transition-colors flex-shrink-0 mt-0.5">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Source data (read-only) */}
      <div className="px-4 py-2 bg-gray-50 border-b border-gray-100 flex-shrink-0">
        <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1">Source data (read-only)</p>
        <div className="flex gap-4 text-[11px] text-gray-600">
          <span>Load Avail: <span className="font-medium text-gray-800">
            {substation.capacityMw != null ? `${substation.capacityMw.toFixed(1)} MW` : 'N/A'}
          </span></span>
          <span>Voltage: <span className="font-medium text-gray-800">
            {voltageLabel(substation.voltageKv)}
          </span></span>
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
              Load Availability (MW)
            </label>
            <input
              type="number"
              step="0.1"
              min="0"
              placeholder={substation.capacityMw != null ? `${substation.capacityMw.toFixed(1)}` : 'e.g. 8.5'}
              value={capacityMw}
              onChange={e => { setCapacityMw(e.target.value); markDirty(); }}
              className="w-full text-xs border border-gray-200 rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-400"
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-gray-600 mb-1">
              Voltage (kV)
            </label>
            <input
              type="number"
              step="1"
              min="0"
              placeholder={substation.voltageKv != null ? `${substation.voltageKv}` : 'e.g. 12'}
              value={voltageKv}
              onChange={e => { setVoltageKv(e.target.value); markDirty(); }}
              className="w-full text-xs border border-gray-200 rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-400"
            />
          </div>
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

      {/* Footer actions */}
      <div className="px-4 py-3 border-t border-gray-100 flex-shrink-0 space-y-2">
        <div className="flex gap-2">
          <button
            onClick={handleSave}
            disabled={!dirty && !hasExisting}
            className="flex-1 flex items-center justify-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium py-2 rounded-lg transition-colors"
          >
            <Save className="w-3.5 h-3.5" />
            {hasExisting ? 'Update Override' : 'Save Override'}
          </button>
          {hasExisting && (
            <button
              onClick={handleRemove}
              className="flex items-center justify-center gap-1 px-3 py-2 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 text-xs font-medium transition-colors"
              title="Remove override — restore source data"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <button
          onClick={handleExport}
          className="w-full flex items-center justify-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 py-1.5 hover:bg-gray-50 rounded-lg transition-colors"
        >
          <Download className="w-3.5 h-3.5" />
          Export all overrides ({overrideCount})
        </button>
      </div>
    </div>
  );
}
