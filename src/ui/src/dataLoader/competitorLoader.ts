import type { CompetitorTrackerData, CompetitorSite, CompetitorFilters } from '../types';

const BASE = '/data/exports';

let cache: CompetitorTrackerData | null = null;
let loading = false;
let loadPromise: Promise<CompetitorTrackerData> | null = null;

async function loadData(): Promise<CompetitorTrackerData> {
  if (cache) return cache;
  if (loadPromise) return loadPromise;

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

/** Filter sites by selected criteria. */
export function filterCompetitorSites(
  sites: CompetitorSite[],
  filters: {
    companies?: Set<string>;
    categories?: Set<string>;
    statuses?: Set<string>;
    msas?: Set<string>;
    states?: Set<string>;
  }
): CompetitorSite[] {
  return sites.filter(site => {
    if (filters.companies && filters.companies.size > 0 && !filters.companies.has(site.companyName)) {
      return false;
    }
    if (filters.categories && filters.categories.size > 0 && !filters.categories.has(site.category)) {
      return false;
    }
    if (filters.statuses && filters.statuses.size > 0 && !filters.statuses.has(site.status)) {
      return false;
    }
    if (filters.msas && filters.msas.size > 0 && !filters.msas.has(site.msa)) {
      return false;
    }
    if (filters.states && filters.states.size > 0 && !filters.states.has(site.state)) {
      return false;
    }
    return true;
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
