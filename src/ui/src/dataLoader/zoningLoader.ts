/**
 * Zoning Feasibility Overlay — Data Loader
 *
 * Loads two sources in parallel:
 *   1. zoning_tracts_demo.geojson  — zoning district polygons (21 features, 4-5 per tract)
 *                                    Each feature's properties carry all district attributes:
 *                                    zone_id, tract_id, city, zone_code, zone_category, ev_permitted
 *   2. zoning_tracts_demo.csv      — tract-level aggregate summary (one row per tract),
 *                                    derived from intersecting districts with census boundaries
 *
 * After loading, dispatches 'zoning:loaded' on window so components can react
 * without prop-drilling.
 */

import type { ZoningDistrict, ZoningTractSummary } from '../types/zoning';

const BASE = '/data/exports';

// ── Module-level cache ────────────────────────────────────────────────────────

let districts: ZoningDistrict[] = [];
let tractSummaries: Map<string, ZoningTractSummary> = new Map();
let loadPromise: Promise<void> | null = null;
let loaded = false;

// ── CSV parser ────────────────────────────────────────────────────────────────

function parseCSV(text: string): Record<string, string>[] {
  const lines = text.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).map(line => {
    const values = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = values[i] ?? ''; });
    return row;
  });
}

// ── Row → typed summary ───────────────────────────────────────────────────────

function toSummary(row: Record<string, string>): ZoningTractSummary {
  return {
    tract_id:               row['tract_id'],
    city:                   row['city'],
    ml_rank_score:          parseFloat(row['ml_rank_score']),
    demand_tier:            row['demand_tier'] as ZoningTractSummary['demand_tier'],
    pct_area_ev_permitted:  parseFloat(row['pct_area_ev_permitted']),
    pct_area_commercial:    parseFloat(row['pct_area_commercial']),
    pct_area_industrial:    parseFloat(row['pct_area_industrial']),
    pct_area_residential:   parseFloat(row['pct_area_residential']),
    dominant_zone_category: row['dominant_zone_category'],
    feasibility_score:      parseFloat(row['feasibility_score']),
    data_confidence:        row['data_confidence'] as ZoningTractSummary['data_confidence'],
    computed_at:            row['computed_at'],
  };
}

// ── Main load function ────────────────────────────────────────────────────────

async function doLoad(): Promise<void> {
  const [geojsonRes, csvRes] = await Promise.all([
    fetch(`${BASE}/zoning_tracts_demo.geojson`),
    fetch(`${BASE}/zoning_tracts_demo.csv`),
  ]);

  if (!geojsonRes.ok) throw new Error(`zoning GeoJSON fetch failed: ${geojsonRes.status}`);
  if (!csvRes.ok)     throw new Error(`zoning CSV fetch failed: ${csvRes.status}`);

  const [geojson, csvText] = await Promise.all([
    geojsonRes.json() as Promise<GeoJSON.FeatureCollection<GeoJSON.Polygon>>,
    csvRes.text(),
  ]);

  // Each GeoJSON feature IS a zoning district — all attributes are in properties
  districts = geojson.features
    .filter(f => f.properties?.zone_id)
    .map(f => ({
      zone_id:       f.properties!.zone_id as string,
      tract_id:      f.properties!.tract_id as string,
      city:          f.properties!.city as string,
      zone_code:     f.properties!.zone_code as string,
      zone_category: f.properties!.zone_category as string,
      ev_permitted:  f.properties!.ev_permitted === true,
      feature:       f,
    }));

  // CSV provides the tract-level aggregate summary (one row per tract)
  tractSummaries = new Map(
    parseCSV(csvText).map(row => {
      const s = toSummary(row);
      return [s.tract_id, s];
    }),
  );

  loaded = true;
  window.dispatchEvent(new CustomEvent('zoning:loaded', {
    detail: { districts: districts.length, tracts: tractSummaries.size },
  }));
  console.info(`[zoningLoader] Loaded ${districts.length} districts across ${tractSummaries.size} tracts`);
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Trigger data load (no-op if already loaded or in-flight). */
export function loadZoningData(): void {
  if (loaded || loadPromise) return;
  loadPromise = doLoad().catch(err => {
    console.error('[zoningLoader] Load failed:', err);
    loadPromise = null;
  });
}

/** Returns all ZoningDistrict objects (empty until load completes). */
export function getZoningDistricts(): ZoningDistrict[] {
  return districts;
}

/** Returns the tract-level summary for a given tract_id, or undefined. */
export function getZoningTractSummary(tractId: string): ZoningTractSummary | undefined {
  return tractSummaries.get(tractId);
}

/** True after the first successful load. */
export function isZoningLoaded(): boolean {
  return loaded;
}

/** Returns all zoning districts for a specific tract_id (empty until load completes). */
export function getZoningDistrictsForTract(tractId: string): ZoningDistrict[] {
  return districts.filter(d => d.tract_id === tractId);
}

/** Returns all unique zone_category values from loaded districts, sorted. */
export function getZoneCategoryOptions(): string[] {
  return [...new Set(districts.map(d => d.zone_category))].sort();
}
