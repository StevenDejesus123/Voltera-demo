import type { SubstationFeature } from '../types';

export interface SubstationOverride {
  capacityMw?: number | null;
  voltageKv?: number | null;
  notes?: string;
  lastVerified?: string;  // ISO date string
  updatedBy?: string;
}

export type OverrideMap = Record<string, SubstationOverride>;

// ── API calls ─────────────────────────────────────────────────────────────────

/** Fetch all overrides from the database. */
export async function fetchOverrides(): Promise<OverrideMap> {
  try {
    const res = await fetch('/api/overrides');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json() as OverrideMap;
  } catch (err) {
    console.warn('fetchOverrides failed, falling back to localStorage:', err);
    return loadOverridesFromStorage();
  }
}

/** Persist a single override to the database. */
export async function saveOverride(id: string, override: SubstationOverride): Promise<OverrideMap> {
  try {
    const res = await fetch(`/api/overrides/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(override),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.warn('saveOverride API failed, falling back to localStorage:', err);
    return saveOverrideToStorage(id, override);
  }
  return fetchOverrides();
}

/** Remove an override from the database. */
export async function removeOverride(id: string): Promise<OverrideMap> {
  try {
    const res = await fetch(`/api/overrides/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.warn('removeOverride API failed, falling back to localStorage:', err);
    return removeOverrideFromStorage(id);
  }
  return fetchOverrides();
}

// ── localStorage fallbacks (used when API is unreachable) ─────────────────────

const STORAGE_KEY = 'voltera:substationOverrides';

export function loadOverrides(): OverrideMap {
  return loadOverridesFromStorage();
}

function loadOverridesFromStorage(): OverrideMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as OverrideMap) : {};
  } catch {
    return {};
  }
}

function saveOverrideToStorage(id: string, override: SubstationOverride): OverrideMap {
  const current = loadOverridesFromStorage();
  const next: OverrideMap = { ...current, [id]: override };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

function removeOverrideFromStorage(id: string): OverrideMap {
  const current = loadOverridesFromStorage();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { [id]: _removed, ...next } = current;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

// ── Export JSON ───────────────────────────────────────────────────────────────

export function exportOverridesJson(overrides: OverrideMap): void {
  const data = JSON.stringify(overrides, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'substation_overrides.json';
  a.click();
  URL.revokeObjectURL(url);
}

// ── Apply overrides to substation list ───────────────────────────────────────

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
