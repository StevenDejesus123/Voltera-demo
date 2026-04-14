import { useState } from 'react';
import { X, Download, Trash2, Pencil, AlertTriangle } from 'lucide-react';
import type { SubstationFeature } from '../types';
import { removeOverride, exportOverridesJson } from '../utils/substationOverrides';
import type { OverrideMap } from '../utils/substationOverrides';

interface SubstationOverrideListPanelProps {
  overrides:      OverrideMap;
  allSubstations: SubstationFeature[];
  onOverridesChange: (next: OverrideMap) => void;
  onEdit:  (id: string) => void;
  onClose: () => void;
}

const UTILITY_COLORS: Record<string, string> = {
  sce:   'bg-amber-100 text-amber-700',
  pge:   'bg-blue-100 text-blue-700',
  ladwp: 'bg-emerald-100 text-emerald-700',
  sdge:  'bg-violet-100 text-violet-700',
};

function fmt(v: number | null | undefined, unit: string): string {
  if (v == null) return '—';
  return `${v.toFixed(1)} ${unit}`;
}

export function SubstationOverrideListPanel({
  overrides,
  allSubstations,
  onOverridesChange,
  onEdit,
  onClose,
}: SubstationOverrideListPanelProps) {
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const overriddenIds = Object.keys(overrides);

  // Build rows: pair each override ID with its raw source substation
  const rows = overriddenIds.map(id => ({
    id,
    ov:  overrides[id],
    raw: allSubstations.find(s => s.id === id) ?? null,
  }));

  function handleRemove(id: string) {
    if (confirmId !== id) { setConfirmId(id); return; }
    const next = removeOverride(id);
    onOverridesChange(next);
    setConfirmId(null);
  }

  return (
    <div className="absolute bottom-6 right-6 w-[420px] max-h-[560px] bg-white rounded-xl shadow-2xl border border-indigo-200 z-[9999] flex flex-col overflow-hidden">
      {/* Header */}
      <div className="bg-indigo-600 text-white px-4 py-3 flex items-center justify-between gap-2 flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold bg-white text-indigo-600 rounded px-1.5 py-0.5">V</span>
          <span className="font-semibold text-sm">Overridden Substations</span>
          <span className="bg-white/20 text-white text-[11px] font-semibold rounded-full px-2 py-0.5">
            {overriddenIds.length}
          </span>
        </div>
        <button onClick={onClose} className="p-1 rounded hover:bg-indigo-500 transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Body */}
      <div className="overflow-y-auto flex-1 divide-y divide-gray-100">
        {rows.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <AlertTriangle className="w-8 h-8 text-gray-300 mx-auto mb-2" />
            <p className="text-sm text-gray-400 font-medium">No overrides saved yet</p>
            <p className="text-[11px] text-gray-300 mt-1">
              Click a substation pin on the map to add an override.
            </p>
          </div>
        ) : (
          rows.map(({ id, ov, raw }) => {
            const name    = raw?.name    ?? id;
            const utility = raw?.utility ?? '';
            const utColor = UTILITY_COLORS[utility] ?? 'bg-gray-100 text-gray-600';

            const srcCap = raw?.capacityMw ?? null;
            const srcKv  = raw?.voltageKv  ?? null;
            const ovCap  = ov.capacityMw  ?? null;
            const ovKv   = ov.voltageKv   ?? null;

            const capChanged = ovCap != null && ovCap !== srcCap;
            const kvChanged  = ovKv  != null && ovKv  !== srcKv;

            return (
              <div key={id} className="px-4 py-3 hover:bg-gray-50 transition-colors">
                {/* Row header */}
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold text-gray-800 truncate">{name}</p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      {utility && (
                        <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${utColor}`}>
                          {utility}
                        </span>
                      )}
                      {ov.updatedBy && (
                        <span className="text-[10px] text-gray-400">by {ov.updatedBy}</span>
                      )}
                      {ov.lastVerified && (
                        <span className="text-[10px] text-gray-400">· {ov.lastVerified}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      onClick={() => { onEdit(id); onClose(); }}
                      title="Edit this override"
                      className="p-1.5 rounded-md text-indigo-500 hover:bg-indigo-50 transition-colors"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => handleRemove(id)}
                      title={confirmId === id ? 'Click again to confirm' : 'Remove override'}
                      className={`p-1.5 rounded-md transition-colors ${
                        confirmId === id
                          ? 'bg-red-100 text-red-600 hover:bg-red-200'
                          : 'text-gray-400 hover:bg-red-50 hover:text-red-500'
                      }`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Value comparison */}
                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <div className="bg-gray-50 rounded-md px-2 py-1.5">
                    <p className="text-gray-400 font-medium mb-0.5">Load Availability</p>
                    <div className="flex items-center gap-1.5">
                      <span className="text-gray-500 line-through">{fmt(srcCap, 'MW')}</span>
                      {capChanged && (
                        <>
                          <span className="text-gray-400">→</span>
                          <span className="font-semibold text-indigo-700">{fmt(ovCap, 'MW')}</span>
                        </>
                      )}
                      {!capChanged && ovCap == null && (
                        <span className="text-gray-400 italic">unchanged</span>
                      )}
                    </div>
                  </div>
                  <div className="bg-gray-50 rounded-md px-2 py-1.5">
                    <p className="text-gray-400 font-medium mb-0.5">Voltage</p>
                    <div className="flex items-center gap-1.5">
                      <span className="text-gray-500 line-through">{fmt(srcKv, 'kV')}</span>
                      {kvChanged && (
                        <>
                          <span className="text-gray-400">→</span>
                          <span className="font-semibold text-indigo-700">{fmt(ovKv, 'kV')}</span>
                        </>
                      )}
                      {!kvChanged && ovKv == null && (
                        <span className="text-gray-400 italic">unchanged</span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Notes */}
                {ov.notes && (
                  <p className="mt-1.5 text-[11px] text-gray-500 italic truncate" title={ov.notes}>
                    "{ov.notes}"
                  </p>
                )}

                {/* Confirm delete prompt */}
                {confirmId === id && (
                  <div className="mt-2 flex items-center justify-between bg-red-50 rounded-md px-2 py-1.5">
                    <span className="text-[11px] text-red-600 font-medium">Remove this override?</span>
                    <div className="flex gap-1.5">
                      <button
                        onClick={() => setConfirmId(null)}
                        className="text-[11px] text-gray-500 hover:text-gray-700 px-2 py-0.5 rounded"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => handleRemove(id)}
                        className="text-[11px] bg-red-600 text-white px-2 py-0.5 rounded hover:bg-red-700"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2.5 border-t border-gray-100 flex-shrink-0">
        <button
          onClick={exportOverridesJson}
          disabled={overriddenIds.length === 0}
          className="w-full flex items-center justify-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 py-1.5 hover:bg-gray-50 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Download className="w-3.5 h-3.5" />
          Export all overrides ({overriddenIds.length})
        </button>
      </div>
    </div>
  );
}
