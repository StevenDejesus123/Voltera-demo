import type { GeoLevel } from '../types';

type LevelKey = 'MSA' | 'County' | 'Tract';

const polygons: Record<LevelKey, any> = {
  MSA: { type: 'FeatureCollection', features: [] },
  County: { type: 'FeatureCollection', features: [] },
  Tract: { type: 'FeatureCollection', features: [] },
};
const loadingState: Record<LevelKey, boolean> = { MSA: false, County: false, Tract: false };
const progressState: Record<LevelKey, number> = { MSA: 0, County: 0, Tract: 0 };

// Track which county polygon chunks have been loaded/are loading
const tractCountyLoaded = new Set<string>();
const tractCountyLoading = new Set<string>();

function levelKey(geoLevel: GeoLevel): LevelKey {
  return geoLevel === 'MSA' ? 'MSA' : geoLevel === 'Tract' ? 'Tract' : 'County';
}

async function loadPolygonsFor(level: LevelKey) {
  if (loadingState[level]) return;
  loadingState[level] = true;
  progressState[level] = 0;

  window.dispatchEvent(new CustomEvent('frontend:polygons:loading', { detail: { level } }));

  try {
    const res = await fetch(`/data/exports/geoPolygons_${level.toLowerCase()}.json`);
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
      const pct = total && total > 0 ? Math.min(99, Math.round((loaded / total) * 100)) : -1;
      progressState[level] = pct;
      window.dispatchEvent(
        new CustomEvent('frontend:polygons:progress', { detail: { level, loaded, total, pct } })
      );
    }

    const buf = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) { buf.set(chunk, offset); offset += chunk.length; }
    polygons[level] = JSON.parse(new TextDecoder().decode(buf));
    progressState[level] = 100;

    window.dispatchEvent(new CustomEvent('frontend:polygons:updated', { detail: { level } }));
  } catch (e) {
    console.warn('Failed to load polygons for', level, e);
  } finally {
    loadingState[level] = false;
  }
}

/**
 * Load tract polygons for a specific county on demand.
 * Fetches /data/exports/tract_polygons/county_{countyId}.json and merges
 * its features into polygons['Tract']. Much cheaper than loading all 304MB at once.
 */
export async function loadTractPolygonsForCounty(countyId: string): Promise<void> {
  if (tractCountyLoaded.has(countyId) || tractCountyLoading.has(countyId)) return;
  tractCountyLoading.add(countyId);

  // Signal that Tract polygons are loading
  loadingState['Tract'] = true;
  progressState['Tract'] = 0;
  window.dispatchEvent(new CustomEvent('frontend:polygons:loading', { detail: { level: 'Tract' } }));

  try {
    const res = await fetch(`/data/exports/tract_polygons/county_${countyId}.json`);
    if (!res.ok) throw new Error(`${res.status} for county_${countyId}`);

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
      const pct = total && total > 0 ? Math.min(99, Math.round((loaded / total) * 100)) : -1;
      progressState['Tract'] = pct;
      window.dispatchEvent(
        new CustomEvent('frontend:polygons:progress', { detail: { level: 'Tract', loaded, total, pct } })
      );
    }

    const buf = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) { buf.set(chunk, offset); offset += chunk.length; }
    const fc = JSON.parse(new TextDecoder().decode(buf));

    // Merge new features into the Tract FeatureCollection
    polygons['Tract'] = {
      type: 'FeatureCollection',
      features: [...polygons['Tract'].features, ...fc.features],
    };

    tractCountyLoaded.add(countyId);
    progressState['Tract'] = 100;
    window.dispatchEvent(new CustomEvent('frontend:polygons:updated', { detail: { level: 'Tract' } }));
  } catch (e) {
    console.warn('Failed to load tract polygons for county', countyId, e);
    tractCountyLoaded.add(countyId); // mark as attempted to avoid infinite retries
  } finally {
    tractCountyLoading.delete(countyId);
    loadingState['Tract'] = false;
  }
}

// Only MSA polygons load eagerly
loadPolygonsFor('MSA');

/** Trigger polygon load for MSA or County levels. Tract uses per-county loading via loadTractPolygonsForCounty. */
export function loadPolygonsOnDemand(level: LevelKey) {
  if (level === 'Tract') return; // Tract uses per-county loading — never load the 304MB file
  if (!loadingState[level] && polygons[level].features.length === 0) {
    loadPolygonsFor(level);
  }
}

export function getPolygonsForLevel(geoLevel: GeoLevel) {
  return polygons[levelKey(geoLevel)];
}

/** Returns current loading state and progress (0–100, or -1 if unknown) for a level. */
export function getPolygonLoadingState(geoLevel: GeoLevel): { loading: boolean; progress: number } {
  const k = levelKey(geoLevel);
  return { loading: loadingState[k], progress: progressState[k] };
}
