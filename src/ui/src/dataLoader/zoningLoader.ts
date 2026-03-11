/**
 * Zoning Feasibility Overlay — Data Loader
 *
 * Two-level loading strategy:
 *
 *   1. Summary CSV  (lightweight, loaded once when overlay is first opened)
 *      /data/exports/zoning/tract_summaries.csv
 *      One row per tract → tract-level aggregate stats shown in the detail card.
 *
 *   2. Per-tract GeoJSON  (lazy, loaded on demand when a tract is selected)
 *      /data/exports/zoning/tract_{tractId}.geojson
 *      One file per tract → parcel-level polygons rendered on the map.
 *      Files are cached in memory so repeat selections don't re-fetch.
 *
 * Events dispatched on window:
 *   'zoning:loaded'         — summary CSV finished loading
 *   'zoning:tract:loaded'   — { tractId } one tract's GeoJSON finished loading
 */

import type { ZoningDistrict, ZoningTractSummary } from '../types/zoning';

const BASE = '/data/exports/zoning';

// ── Module-level cache ────────────────────────────────────────────────────────

/** Parcel features per tract, keyed by tract_id. Populated on demand. */
const tractCache = new Map<string, ZoningDistrict[]>();

/** Tract-level aggregate summaries from the CSV. */
let tractSummaries = new Map<string, ZoningTractSummary>();

/** In-flight fetch promises so concurrent callers don't double-fetch. */
const tractLoadPromises = new Map<string, Promise<void>>();

let summaryLoaded  = false;
let summaryPromise: Promise<void> | null = null;

// ── CSV parser ────────────────────────────────────────────────────────────────

function parseCSV(text: string): Record<string, string>[] {
  const lines = text.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).map(line => {
    // Handle quoted fields (e.g. "NEW YORK, NY")
    const values: string[] = [];
    let cur = '';
    let inQuote = false;
    for (const ch of line) {
      if (ch === '"') { inQuote = !inQuote; continue; }
      if (ch === ',' && !inQuote) { values.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    values.push(cur.trim());

    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = values[i] ?? ''; });
    return row;
  });
}

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

// ── Summary CSV load ──────────────────────────────────────────────────────────

async function doLoadSummary(): Promise<void> {
  const resp = await fetch(`${BASE}/tract_summaries.csv`);
  if (!resp.ok) throw new Error(`tract_summaries.csv fetch failed: ${resp.status}`);
  const text = await resp.text();

  tractSummaries = new Map(
    parseCSV(text)
      .filter(row => row['tract_id'])
      .map(row => {
        const s = toSummary(row);
        return [s.tract_id, s];
      }),
  );

  summaryLoaded = true;
  window.dispatchEvent(new CustomEvent('zoning:loaded', {
    detail: { tracts: tractSummaries.size },
  }));
  console.info(`[zoningLoader] Summary loaded: ${tractSummaries.size} tract summaries`);
}

/** Trigger summary CSV load (no-op if already loaded or in-flight). */
export function loadZoningData(): void {
  if (summaryLoaded || summaryPromise) return;
  summaryPromise = doLoadSummary().catch(err => {
    console.error('[zoningLoader] Summary load failed:', err);
    summaryPromise = null;
  });
}

// ── Per-tract GeoJSON load ────────────────────────────────────────────────────

async function doLoadTract(tractId: string): Promise<void> {
  const resp = await fetch(`${BASE}/tract_${tractId}.geojson`);

  const contentType = resp.headers.get('content-type') ?? '';
  if (!resp.ok || !contentType.includes('json')) {
    // 404 or Vite SPA fallback returning HTML (200 with index.html) — no data for this tract
    tractCache.set(tractId, []);
    window.dispatchEvent(new CustomEvent('zoning:tract:loaded', { detail: { tractId } }));
    console.info(`[zoningLoader] No zoning data for tract ${tractId} (${resp.status})`);
    return;
  }

  const geojson = await resp.json() as GeoJSON.FeatureCollection<GeoJSON.Polygon>;
  const districts: ZoningDistrict[] = geojson.features
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

  tractCache.set(tractId, districts);
  window.dispatchEvent(new CustomEvent('zoning:tract:loaded', { detail: { tractId } }));
  console.info(`[zoningLoader] Tract ${tractId}: ${districts.length} parcels loaded`);
}

/**
 * Trigger a lazy load of one tract's parcel GeoJSON.
 * No-op if already cached or in-flight.
 * Listen for 'zoning:tract:loaded' to know when it completes.
 */
export function loadTractZoning(tractId: string): void {
  if (tractCache.has(tractId)) return;       // already cached
  if (tractLoadPromises.has(tractId)) return; // already in-flight

  const p = doLoadTract(tractId).catch(err => {
    console.error(`[zoningLoader] Tract ${tractId} load failed:`, err);
    tractLoadPromises.delete(tractId);
  });
  tractLoadPromises.set(tractId, p);
}

// ── Public read API ───────────────────────────────────────────────────────────

/** Returns all cached parcel districts for a tract ([] until loaded). */
export function getZoningDistrictsForTract(tractId: string): ZoningDistrict[] {
  return tractCache.get(tractId) ?? [];
}

/** True if the tract's parcel file has been fetched (including 404 → empty). */
export function isTractZoningLoaded(tractId: string): boolean {
  return tractCache.has(tractId);
}

/** Returns the tract-level aggregate summary, or undefined if not yet loaded. */
export function getZoningTractSummary(tractId: string): ZoningTractSummary | undefined {
  return tractSummaries.get(tractId);
}

/** True after the summary CSV has loaded successfully. */
export function isZoningLoaded(): boolean {
  return summaryLoaded;
}

/** Returns all unique zone_category values across all cached tracts, sorted. */
export function getZoneCategoryOptions(): string[] {
  const cats = new Set<string>();
  for (const districts of tractCache.values()) {
    for (const d of districts) cats.add(d.zone_category);
  }
  return [...cats].sort();
}
