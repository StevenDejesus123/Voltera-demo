import type { Region, GeoLevel, Segment, WhatIfScenario, SalesforceMSASummary } from '../types';
import { getSalesforceMSASummaries } from './salesforceLoader';

const BASE = '/data/exports';

type LevelKey = 'MSA' | 'County' | 'Tract';

const cache: Record<LevelKey, Region[]> = { MSA: [], County: [], Tract: [] };
const loadingState: Record<LevelKey, boolean> = { MSA: false, County: false, Tract: false };
const loadingProgress: Record<LevelKey, number> = { MSA: 0, County: 0, Tract: 0 };

// Per-level details sidecar cache: id → { factors, details }
const detailsCache: Record<LevelKey, Record<string, { factors: any[]; details: any }> | null> = {
    MSA: null,
    County: null,
    Tract: null,
};
const detailsLoadingState: Record<LevelKey, boolean> = { MSA: false, County: false, Tract: false };
const detailsLoadingProgress: Record<LevelKey, number> = { MSA: 0, County: 0, Tract: 0 };

function toKey(g: string): LevelKey {
    if (g.toLowerCase() === 'msa') return 'MSA';
    if (g.toLowerCase() === 'tract') return 'Tract';
    return 'County';
}

/** Ensure a level's regions are loaded (triggers fetch if empty and not already loading). */
function ensureLoaded(key: LevelKey): void {
    if (!cache[key].length && !loadingState[key]) loadLevel(key);
}

/** Generic streaming fetch helper — fires progress callbacks, returns parsed JSON. */
async function streamFetch(
    url: string,
    onProgress: (loaded: number, total: number | null) => void
): Promise<any> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));

    const contentLength = res.headers.get('Content-Length');
    const total = contentLength ? parseInt(contentLength, 10) : null;

    const reader = res.body!.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        onProgress(loaded, total);
    }

    const buf = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) { buf.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder().decode(buf));
}

async function loadLevel(level: LevelKey) {
    if (loadingState[level]) return;
    loadingState[level] = true;
    loadingProgress[level] = 0;
    window.dispatchEvent(new CustomEvent('frontend:regions:loading', { detail: { level } }));
    try {
        const data = await streamFetch(
            `${BASE}/mockRegions_${level.toLowerCase()}.json`,
            (loaded, total) => {
                const pct = total ? Math.min(99, Math.round((loaded / total) * 100)) : -1;
                loadingProgress[level] = pct;
                window.dispatchEvent(new CustomEvent('frontend:regions:progress', {
                    detail: { level, loaded, total, pct }
                }));
            }
        );
        const normalized: Region[] = (data as any[]).map((it: any) => {
            const r: any = { ...it };
            r.msaID = r.msaID ?? r.msa_id ?? r.MSAID ?? r.msaid ?? r.msa ?? r.MSA ?? null;
            r.countyID = r.countyID ?? r.county_id ?? r.COUNTYID ?? r.countyid ?? r.county ?? r.COUNTY ?? null;
            if ((r.lat === undefined || r.lng === undefined) && r.centroid && Array.isArray(r.centroid)) {
                r.lng = r.lng ?? r.centroid[0];
                r.lat = r.lat ?? r.centroid[1];
            }
            r.geoLevel = r.geoLevel ?? r.geo_level ?? level;
            return r as Region;
        });
        cache[level] = normalized;
        enrichWithSalesforceData();
        loadingProgress[level] = 100;
        window.dispatchEvent(new CustomEvent('frontend:regions:updated', { detail: { level } }));
    } catch (e) {
        console.warn('Failed to load frontend regions', level, e);
    } finally {
        loadingState[level] = false;
    }
}

async function loadDetails(level: LevelKey) {
    if (detailsLoadingState[level] || detailsCache[level] !== null) return;
    detailsLoadingState[level] = true;
    detailsLoadingProgress[level] = 0;
    window.dispatchEvent(new CustomEvent('frontend:details:loading', { detail: { level } }));
    try {
        const data = await streamFetch(
            `${BASE}/regionDetails_${level.toLowerCase()}.json`,
            (loaded, total) => {
                const pct = total ? Math.min(99, Math.round((loaded / total) * 100)) : -1;
                detailsLoadingProgress[level] = pct;
                window.dispatchEvent(new CustomEvent('frontend:details:progress', {
                    detail: { level, loaded, total, pct }
                }));
            }
        );
        detailsCache[level] = data;
        detailsLoadingProgress[level] = 100;
        window.dispatchEvent(new CustomEvent('frontend:details:updated', { detail: { level } }));
    } catch (e) {
        console.warn('Failed to load region details', level, e);
        detailsCache[level] = {};
    } finally {
        detailsLoadingState[level] = false;
    }
}

// ── Salesforce enrichment ────────────────────────────────────────────────────
// Populates `customerCount` on cached regions from SF Sales Opportunity data.
// MSA: matched by name. County/Tract: inherit their parent MSA's count.

/** Normalize MSA name for fuzzy matching: lowercase, collapse dashes/en-dashes. */
function normMsa(s: string): string {
  return s.toLowerCase().trim().replace(/[\u2013\u2014-]+/g, '-');
}

function matchSfSummary(
  msaName: string,
  summaries: Record<string, SalesforceMSASummary>,
): SalesforceMSASummary | null {
  if (!msaName) return null;
  if (summaries[msaName]) return summaries[msaName];
  const norm = normMsa(msaName);
  // Extract the primary city (everything before the first dash or comma)
  const primaryCity = norm.split(/[-,]/)[0].trim();
  for (const [key, summary] of Object.entries(summaries)) {
    const keyNorm = normMsa(key);
    // Exact normalized match
    if (norm === keyNorm) return summary;
    // Substring match (handles suffix differences like "NY-NJ-PA" vs "NY-NJ-CT-PA")
    if (norm.includes(keyNorm) || keyNorm.includes(norm)) return summary;
    // Primary city match (e.g. "nashville" matches "nashville-davidson-...")
    const keyCity = keyNorm.split(/[-,]/)[0].trim();
    if (primaryCity.length > 3 && primaryCity === keyCity) return summary;
  }
  return null;
}

function enrichWithSalesforceData() {
  const summaries = getSalesforceMSASummaries();
  if (!summaries || Object.keys(summaries).length === 0) return;

  // Enrich MSAs only — customerCount is per-MSA from SF Sales Opportunities
  for (const region of cache.MSA) {
    const name = (region as any).msaName || region.name;
    const sf = matchSfSummary(name, summaries);
    if (sf) {
      region.customerCount = sf.accountCount;
    }
  }

  // Notify MSA listeners that data changed
  window.dispatchEvent(new CustomEvent('frontend:regions:updated', { detail: { level: 'MSA' } }));
}

// Re-enrich whenever SF data loads (or reloads after a sync)
window.addEventListener('salesforce:loaded', () => enrichWithSalesforceData());

// Only MSA loads eagerly — County/Tract load on demand
loadLevel('MSA');

/** Trigger load for a level (no-op if already loaded/loading). */
export function loadLevelOnDemand(level: LevelKey) {
    ensureLoaded(level);
}

/** Trigger load of the details sidecar for a level.
 *  Accepts raw geoLevel strings from region objects (e.g. "COUNTY", "TRACT"). */
export function loadDetailsOnDemand(level: string) {
    loadDetails(toKey(level));
}

/** Returns loading state and progress (0–100, or -1 if unknown) for region list. */
export function getRegionsLoadingState(geoLevel: GeoLevel): { loading: boolean; progress: number } {
    const k = toKey(geoLevel);
    return { loading: loadingState[k], progress: loadingProgress[k] };
}

/** Returns loading state and progress for the details sidecar. */
export function getDetailsLoadingState(geoLevel: GeoLevel): { loading: boolean; progress: number } {
    const k = toKey(geoLevel);
    return { loading: detailsLoadingState[k], progress: detailsLoadingProgress[k] };
}

export function getMockRegions(
    geoLevel: GeoLevel,
    _segment: Segment,
    _rankingThreshold: number,
    _activeScenario?: WhatIfScenario | null,
    _selectedIds?: string[]
): Region[] {
    const key = toKey(geoLevel);
    ensureLoaded(key);
    return cache[key];
}

export function getCountiesForMSA(
    msaId: string,
    _segment: Segment,
    _rankingThreshold: number,
    _activeScenario?: WhatIfScenario | null,
    _selectedIds?: string[]
): Region[] {
    const key: LevelKey = 'County';
    ensureLoaded(key);
    return cache[key].filter(
        (r) => (r as any).msaID === msaId || (r as any).msa_id === msaId || (r as any).parent_id === msaId
    );
}

export function getTractsForCounty(
    countyId: string,
    _segment: Segment,
    _rankingThreshold: number,
    _activeScenario?: WhatIfScenario | null,
    _selectedIds?: string[]
): Region[] {
    const key: LevelKey = 'Tract';
    ensureLoaded(key);
    return cache[key].filter(
        (r) => (r as any).countyID === countyId || (r as any).county_id === countyId || (r as any).parent_id === countyId
    );
}

export function getTractsForCounties(
    countyIds: string[],
    _segment: Segment,
    _rankingThreshold: number,
    _activeScenario?: WhatIfScenario | null,
    _selectedIds?: string[]
): Region[] {
    const key: LevelKey = 'Tract';
    ensureLoaded(key);
    if (countyIds.length === 0) return [];
    const countyIdSet = new Set(countyIds);
    return cache[key].filter((r) => {
        const cid = (r as any).countyID ?? (r as any).county_id ?? (r as any).parent_id ?? (r as any).county;
        return countyIdSet.has(r.id) || countyIdSet.has(cid);
    });
}

/** Returns details for a region if the sidecar is loaded; null if still loading. */
export function getRegionDetails(
    id: string,
    geoLevel: GeoLevel
): { factors: any[]; details: any } | null {
    const key = toKey(geoLevel);
    const dc = detailsCache[key];
    if (dc === null) return null;
    // County detail keys have embedded single-quotes (e.g. "'01001'") while
    // county region IDs are plain (e.g. "01001"). Fall back to the quoted form.
    return dc[id] ?? dc[`'${id}'`] ?? { factors: [], details: {} };
}
