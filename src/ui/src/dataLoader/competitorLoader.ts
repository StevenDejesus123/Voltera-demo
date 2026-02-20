import type { CompetitorTrackerData, CompetitorSite, CompetitorFilters } from '../types';

const BASE = '/data/exports';

let cache: CompetitorTrackerData | null = null;
let loading = false;
let loadPromise: Promise<CompetitorTrackerData> | null = null;

/** Shared fetch logic used by both initial load and reload. */
function doFetch(): Promise<CompetitorTrackerData> {
  loading = true;
  loadPromise = fetch(`${BASE}/competitorTracker.json`)
    .then(res => {
      if (!res.ok) throw new Error(`Failed to load competitor data: ${res.status}`);
      return res.json();
    })
    .then((data: CompetitorTrackerData) => {
      cache = data;
      loading = false;
      window.dispatchEvent(new CustomEvent('competitor:loaded'));
      return data;
    })
    .catch(err => {
      loading = false;
      loadPromise = null;
      console.error('Failed to load competitor tracker data:', err);
      throw err;
    });
  return loadPromise;
}

async function loadData(): Promise<CompetitorTrackerData> {
  if (cache) return cache;
  if (loadPromise) return loadPromise;
  return doFetch();
}

/** Get all competitor sites. Triggers load if not cached. */
export function getCompetitorSites(): CompetitorSite[] {
  if (!cache && !loading) {
    loadData();
  }
  return cache?.sites ?? [];
}

/** Get competitor sites with valid coordinates for mapping. */
export function getCompetitorSitesWithCoords(): CompetitorSite[] {
  return getCompetitorSites().filter(s => s.lat !== null && s.lng !== null);
}

/** Get filter options (companies, categories, etc.). */
export function getCompetitorFilters(): CompetitorFilters | null {
  if (!cache && !loading) {
    loadData();
  }
  return cache?.filters ?? null;
}

/** Get unique companies from the data. */
export function getCompetitorCompanies(): string[] {
  return cache?.filters?.companies ?? [];
}

/** Get unique segments from the data. */
export function getCompetitorSegments(): string[] {
  if (!cache) return [];
  const segments = new Set<string>();
  for (const site of cache.sites) {
    if (site.volteraSegment) segments.add(site.volteraSegment);
    if (site.customerSegment) segments.add(site.customerSegment);
  }
  return [...segments].sort();
}

/** Get stats about the competitor data. */
export function getCompetitorStats(): { totalSites: number; sitesWithCoords: number; companiesCount: number } | null {
  return cache?.stats ?? null;
}

/** Check if data is currently loading. */
export function isCompetitorDataLoading(): boolean {
  return loading;
}

/** Trigger data load (no-op if already loaded/loading). */
export function loadCompetitorData(): void {
  if (!cache && !loading) {
    loadData();
  }
}

/** Returns true if the set is empty or contains the value. */
function matchesFilter(set: Set<string> | undefined, value: string): boolean {
  return !set || set.size === 0 || set.has(value);
}

/** Filter sites by selected criteria. */
export function filterCompetitorSites(
  sites: CompetitorSite[],
  filters: {
    companies?: Set<string>;
    categories?: Set<string>;
    statuses?: Set<string>;
    msas?: Set<string>;
    states?: Set<string>;
    segments?: Set<string>;
  }
): CompetitorSite[] {
  return sites.filter(site => {
    // For segment filtering, check both volteraSegment and customerSegment
    const segmentMatch = !filters.segments || filters.segments.size === 0 ||
      filters.segments.has(site.volteraSegment) ||
      filters.segments.has(site.customerSegment);

    return matchesFilter(filters.companies, site.companyName)
      && matchesFilter(filters.categories, site.category)
      && matchesFilter(filters.statuses, site.status)
      && matchesFilter(filters.msas, site.msa)
      && matchesFilter(filters.states, site.state)
      && segmentMatch;
  });
}

/** Get color for a category. */
export function getCategoryColor(category: string): string {
  switch (category) {
    case 'Voltera':
      return '#3B82F6'; // Blue
    case 'Customer':
      return '#22C55E'; // Green
    case 'Competitor':
      return '#EF4444'; // Red
    case 'Interest':
      return '#EAB308'; // Yellow
    default:
      return '#6B7280'; // Gray
  }
}

/** Invalidate cache so next access re-fetches. */
export function invalidateCompetitorCache(): void {
  cache = null;
  loadPromise = null;
  loading = false;
}

/** Force re-fetch without clearing existing cache (avoids flash of empty data). */
export function reloadCompetitorData(): void {
  loadPromise = null;
  loading = false;
  doFetch();
}

/** Get sites grouped by company for toggle panel. */
export function getSitesByCompany(): Map<string, CompetitorSite[]> {
  const sites = getCompetitorSites();
  const byCompany = new Map<string, CompetitorSite[]>();

  for (const site of sites) {
    const existing = byCompany.get(site.companyName) ?? [];
    existing.push(site);
    byCompany.set(site.companyName, existing);
  }

  return byCompany;
}

/** Get sites grouped by MSA for logo overlay. */
export function getSitesByMSA(): Map<string, CompetitorSite[]> {
  const sites = getCompetitorSites();
  const byMSA = new Map<string, CompetitorSite[]>();

  for (const site of sites) {
    if (!site.msa) continue;
    const existing = byMSA.get(site.msa) ?? [];
    existing.push(site);
    byMSA.set(site.msa, existing);
  }

  return byMSA;
}

/** Get unique companies present in an MSA. */
export function getCompaniesInMSA(msa: string): string[] {
  const sites = getCompetitorSites().filter(s => s.msa === msa);
  return [...new Set(sites.map(s => s.companyName))];
}

/** Competitor summary for an MSA (categories, counts, companies). */
export interface MSACompetitorSummary {
  msa: string;
  categories: string[];
  companies: string[];
  siteCount: number;
  sites: CompetitorSite[];
}

/** Get competitor summary for each MSA. */
export function getMSACompetitorSummaries(): Map<string, MSACompetitorSummary> {
  const byMSA = getSitesByMSA();
  const summaries = new Map<string, MSACompetitorSummary>();

  for (const [msa, sites] of byMSA) {
    const categories = [...new Set(sites.map(s => s.category))];
    const companies = [...new Set(sites.map(s => s.companyName))];
    summaries.set(msa, {
      msa,
      categories,
      companies,
      siteCount: sites.length,
      sites,
    });
  }

  return summaries;
}
