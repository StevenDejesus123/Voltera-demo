import type { CircuitFeature } from '../components/CircuitMapLayer';

export interface CircuitOverride {
  loadAvailKw?:  number | null;
  pvHostingKw?:  number | null;
  voltageKv?:    number | null;
  notes?:        string;
  lastVerified?: string;   // ISO date string
  updatedBy?:    string;
}

export type CircuitOverrideMap = Record<string, CircuitOverride>;

/** Stable key used both as the map key and the API path segment. */
export function circuitOverrideKey(utility: string, circuitName: string): string {
  return `${utility}::${circuitName}`;
}

// ── API calls ─────────────────────────────────────────────────────────────────

export async function fetchCircuitOverrides(): Promise<CircuitOverrideMap> {
  try {
    const res = await fetch('/api/overrides/circuits');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json() as CircuitOverrideMap;
  } catch (err) {
    console.warn('fetchCircuitOverrides failed, falling back to localStorage:', err);
    return loadCircuitOverridesFromStorage();
  }
}

export async function saveCircuitOverride(
  utility: string,
  circuitName: string,
  override: CircuitOverride,
): Promise<CircuitOverrideMap> {
  const id = circuitOverrideKey(utility, circuitName);
  try {
    const res = await fetch(`/api/overrides/circuits/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(override),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.warn('saveCircuitOverride API failed, falling back to localStorage:', err);
    return saveCircuitOverrideToStorage(id, override);
  }
  return fetchCircuitOverrides();
}

export async function removeCircuitOverride(
  utility: string,
  circuitName: string,
): Promise<CircuitOverrideMap> {
  const id = circuitOverrideKey(utility, circuitName);
  try {
    const res = await fetch(`/api/overrides/circuits/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.warn('removeCircuitOverride API failed, falling back to localStorage:', err);
    return removeCircuitOverrideFromStorage(id);
  }
  return fetchCircuitOverrides();
}

// ── localStorage fallbacks ────────────────────────────────────────────────────

const STORAGE_KEY = 'voltera:circuitOverrides';

export function loadCircuitOverrides(): CircuitOverrideMap {
  return loadCircuitOverridesFromStorage();
}

function loadCircuitOverridesFromStorage(): CircuitOverrideMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as CircuitOverrideMap) : {};
  } catch {
    return {};
  }
}

function saveCircuitOverrideToStorage(id: string, override: CircuitOverride): CircuitOverrideMap {
  const current = loadCircuitOverridesFromStorage();
  const next: CircuitOverrideMap = { ...current, [id]: override };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

function removeCircuitOverrideFromStorage(id: string): CircuitOverrideMap {
  const current = loadCircuitOverridesFromStorage();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { [id]: _removed, ...next } = current;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

// ── Export JSON ───────────────────────────────────────────────────────────────

export function exportCircuitOverridesJson(overrides: CircuitOverrideMap): void {
  const data = JSON.stringify(overrides, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'circuit_overrides.json';
  a.click();
  URL.revokeObjectURL(url);
}

// ── Apply overrides to circuit list ──────────────────────────────────────────

export function applyCircuitOverrides(
  circuits: CircuitFeature[],
  overrides: CircuitOverrideMap,
): CircuitFeature[] {
  return circuits.map(c => {
    const key = circuitOverrideKey(c.utility, c.circuitName);
    const ov = overrides[key];
    if (!ov) return c;
    return {
      ...c,
      loadAvailKw:   ov.loadAvailKw  !== undefined ? ov.loadAvailKw  : c.loadAvailKw,
      pvHostingKw:   ov.pvHostingKw  !== undefined ? ov.pvHostingKw  : c.pvHostingKw,
      voltageKv:     ov.voltageKv    !== undefined ? ov.voltageKv    : c.voltageKv,
      hasOverride:         true,
      overrideNotes:       ov.notes,
      overrideLastVerified: ov.lastVerified,
    };
  });
}
