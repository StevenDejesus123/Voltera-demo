export type DemandTier = 'Low' | 'Medium' | 'High';
export type DataConfidence = 'Low' | 'Medium' | 'High';

/**
 * How the overlay polygons are colored:
 *   'ev_permitted'  → green (permitted) / red (not permitted)
 *   'zone_category' → color per zone type (Commercial, Industrial, Residential, Mixed Use)
 */
export type ZoningColorMode = 'ev_permitted' | 'zone_category';

/**
 * One zoning district polygon loaded from the city GIS overlay (zoning_tracts_demo.geojson).
 * Many districts can exist within a single census tract.
 */
export interface ZoningDistrict {
  zone_id: string;
  tract_id: string;
  city: string;
  zone_code: string;       // raw city code e.g. "C-1", "MU-3", "R-2", "M-1"
  zone_category: string;   // standardized: "Commercial" | "Industrial" | "Residential" | "Mixed Use"
  ev_permitted: boolean;   // permitted by right for EV charging infrastructure
  feature: GeoJSON.Feature<GeoJSON.Polygon>; // geometry with original properties
}

/**
 * Tract-level aggregate summary derived from intersecting zoning districts
 * with census tract boundaries (zoning_tracts_demo.csv — one row per tract).
 */
export interface ZoningTractSummary {
  tract_id: string;
  city: string;
  ml_rank_score: number;
  demand_tier: DemandTier;
  pct_area_ev_permitted: number;
  pct_area_commercial: number;
  pct_area_industrial: number;
  pct_area_residential: number;
  dominant_zone_category: string;
  /** feasibility_score = (pct_area_ev_permitted × 0.7) + (ml_rank_score × 0.3) */
  feasibility_score: number;
  data_confidence: DataConfidence;
  computed_at: string;
}

/** Active filter state for the zoning overlay. */
export interface ZoningFilters {
  showPermittedOnly: boolean;  // true = show only EV-permitted districts
  zoneCategories: string[];    // empty = all categories shown
}

export const DEFAULT_ZONING_FILTERS: ZoningFilters = {
  showPermittedOnly: false,
  zoneCategories: [],
};
