import type { SalesforceData, SalesforceMSASummary } from '../types';

const BASE = '/data/exports';

let cache: SalesforceData | null = null;
let loading = false;
let loadPromise: Promise<SalesforceData> | null = null;

/** Shared fetch logic used by both initial load and reload. */
function doFetch(): Promise<SalesforceData> {
  loading = true;
  loadPromise = fetch(`${BASE}/salesforceData.json`)
    .then(res => {
      if (!res.ok) throw new Error(`Failed to load Salesforce data: ${res.status}`);
      return res.json();
    })
    .then((data: SalesforceData) => {
      cache = data;
      loading = false;
      window.dispatchEvent(new CustomEvent('salesforce:loaded'));
      return data;
    })
    .catch(err => {
      loading = false;
      loadPromise = null;
      console.error('Failed to load Salesforce data:', err);
      throw err;
    });
  return loadPromise;
}

async function fetchData(): Promise<SalesforceData> {
  if (cache) return cache;
  if (loadPromise) return loadPromise;
  return doFetch();
}

/** Trigger data load (no-op if already loaded/loading). */
export function loadSalesforceData(): void {
  if (!cache && !loading) {
    fetchData();
  }
}

/** Get all MSA summaries. */
export function getSalesforceMSASummaries(): Record<string, SalesforceMSASummary> {
  if (!cache && !loading) {
    fetchData();
  }
  return cache?.msaSummaries ?? {};
}

/** Get MSA summary for a specific MSA name. */
export function getSalesforceMSASummary(msa: string): SalesforceMSASummary | null {
  const summaries = getSalesforceMSASummaries();
  // Try exact match first, then normalized match
  if (summaries[msa]) return summaries[msa];

  // Try matching with/without " MSA" suffix
  const normalized = msa.replace(/ MSA$/, '');
  for (const [key, summary] of Object.entries(summaries)) {
    const keyNorm = key.replace(/ MSA$/, '');
    if (keyNorm.toLowerCase() === normalized.toLowerCase()) {
      return summary;
    }
  }
  return null;
}

/** Get unique account names across all MSAs. */
export function getSalesforceAccounts(): string[] {
  const summaries = getSalesforceMSASummaries();
  const accounts = new Set(Object.values(summaries).flatMap(s => s.accounts));
  return [...accounts].sort();
}

/** Get the last updated timestamp. */
export function getSalesforceLastUpdated(): string | null {
  return cache?.lastUpdated ?? null;
}

/** Check if SF data had an error (credentials missing, etc). */
export function hasSalesforceError(): boolean {
  return !!cache?.error;
}

/** Check if data is currently loading. */
export function isSalesforceDataLoading(): boolean {
  return loading;
}

/** Invalidate cache so next access re-fetches. */
export function invalidateSalesforceCache(): void {
  cache = null;
  loadPromise = null;
  loading = false;
}

/** Force re-fetch without clearing existing cache (avoids flash of empty data). */
export function reloadSalesforceData(): void {
  loadPromise = null;
  loading = false;
  doFetch();
}

/** Trigger a full Salesforce refresh (re-query SF + rebuild competitor tracker). */
export async function refreshSalesforceData(): Promise<{ status: string; duration: string }> {
  const res = await fetch('/api/salesforce/refresh', { method: 'POST' });
  const result = await res.json();

  if (result.status === 'ok') {
    // Re-fetch both — old cache stays readable until new data arrives (no flash)
    reloadSalesforceData();
    const { reloadCompetitorData } = await import('./competitorLoader');
    reloadCompetitorData();
  }

  return result;
}
