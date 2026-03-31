import type { SubstationFeature } from '../types';

export interface SubstationOverride {
  capacityMw?: number | null;
  voltageKv?: number | null;
  notes?: string;
  lastVerified?: string;  // ISO date string
  updatedBy?: string;
}

export type OverrideMap = Record<string, SubstationOverride>;

const STORAGE_KEY = 'voltera:substationOverrides';

export function loadOverrides(): OverrideMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as OverrideMap) : {};
  } catch {
    return {};
  }
}

export function saveOverride(id: string, override: SubstationOverride): OverrideMap {
  const current = loadOverrides();
  const next: OverrideMap = { ...current, [id]: override };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function removeOverride(id: string): OverrideMap {
  const current = loadOverrides();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { [id]: _removed, ...next } = current;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function exportOverridesJson(): void {
  const data = JSON.stringify(loadOverrides(), null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'substation_overrides.json';
  a.click();
  URL.revokeObjectURL(url);
}

export function applyOverrides(
  substations: SubstationFeature[],
  overrides: OverrideMap,
): SubstationFeature[] {
  return substations.map(s => {
    const ov = overrides[s.id];
    if (!ov) return s;
    return {
      ...s,
      capacityMw:           ov.capacityMw  !== undefined ? ov.capacityMw  : s.capacityMw,
      voltageKv:            ov.voltageKv   !== undefined ? ov.voltageKv   : s.voltageKv,
      hasOverride:          true,
      overrideNotes:        ov.notes,
      overrideLastVerified: ov.lastVerified,
    };
  });
}
