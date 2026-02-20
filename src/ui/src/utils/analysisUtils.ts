import type { GeoLevel, RegionDetails } from '../types';

// ── Aggregation ───────────────────────────────────────────────────────────────

export type AggType = 'sum' | 'avg' | 'max';

export const FIELD_AGGREGATION: Partial<Record<keyof RegionDetails, AggType>> = {
  // sums — absolute counts / totals
  population:            'sum',
  rideshareTrips:        'sum',
  evStationCount:        'sum',
  federalFundingAmount:  'sum',
  stateFundingCount:     'sum',
  evStationCountMSA:     'sum',
  areaSqrtMiles:         'sum',
  // infrastructure counts — see resolveAggType() for level-specific logic
  airportCount:          'max',
  avTestingCount:        'max',
  avTestingVehicles:     'max',
  // averages — rates, prices, densities
  populationDensity:     'avg',
  medianIncome:          'avg',
  avgWeeklyWage:         'avg',
  publicTransitPct:      'avg',
  ridesharePerCapita:    'avg',
  rideshareDensity:      'avg',
  gasPrice:              'avg',
  electricityPrice:      'avg',
  snowdays:              'avg',
  snowdaysMSA:           'avg',
  temperature:           'avg',
  temperatureMSA:        'avg',
  precipitation:         'avg',
  hurricaneRisk:         'avg',
  stormRisk:             'avg',
  earthquakeRisk:        'avg',
};

/**
 * Infrastructure fields use different aggregation depending on geo level:
 *  - County (0-mile buffer): regions are non-overlapping → sum is correct
 *  - Tract (25-mile buffer): heavy overlap between adjacent tracts → max avoids
 *    double-counting the same airports/AV sites across neighboring tracts
 */
const INFRA_FIELDS_OVERLAP: Set<keyof RegionDetails> = new Set([
  'airportCount', 'avTestingCount', 'avTestingVehicles',
]);

export function resolveAggType(key: keyof RegionDetails, geoLevel: GeoLevel | string): AggType {
  const base = FIELD_AGGREGATION[key];
  if (!base) return 'avg';
  if (INFRA_FIELDS_OVERLAP.has(key)) {
    return geoLevel.toUpperCase() === 'COUNTY' ? 'sum' : 'max';
  }
  return base;
}

// ── Field visibility ──────────────────────────────────────────────────────────

export const FIELD_VISIBILITY: Record<string, Record<GeoLevel, boolean>> = {
  evStationCount:       { MSA: true,  County: true,  Tract: true  },
  airportCount:         { MSA: true,  County: true,  Tract: true  },
  avTestingCount:       { MSA: true,  County: true,  Tract: true  },
  avTestingVehicles:    { MSA: false, County: true,  Tract: false },
  population:           { MSA: true,  County: true,  Tract: true  },
  populationDensity:    { MSA: true,  County: true,  Tract: true  },
  medianIncome:         { MSA: true,  County: true,  Tract: true  },
  avgWeeklyWage:        { MSA: true,  County: true,  Tract: true  },
  publicTransitPct:     { MSA: true,  County: true,  Tract: true  },
  rideshareTrips:       { MSA: true,  County: true,  Tract: true  },
  ridesharePerCapita:   { MSA: true,  County: false, Tract: false },
  rideshareDensity:     { MSA: false, County: false, Tract: true  },
  federalFundingAmount: { MSA: true,  County: true,  Tract: false },
  stateFundingCount:    { MSA: true,  County: true,  Tract: false },
  gasPrice:             { MSA: true,  County: true,  Tract: true  },
  electricityPrice:     { MSA: true,  County: true,  Tract: true  },
  snowdays:             { MSA: true,  County: true,  Tract: true  },
  temperature:          { MSA: true,  County: true,  Tract: true  },
  precipitation:        { MSA: true,  County: false, Tract: false },
  hurricaneRisk:        { MSA: true,  County: false, Tract: false },
  stormRisk:            { MSA: false, County: true,  Tract: false },
  earthquakeRisk:       { MSA: false, County: false, Tract: true  },
};

// ── Human-readable labels ─────────────────────────────────────────────────────

export const FIELD_LABELS: Record<string, string> = {
  evStationCount:       'EV Stations (Non-Tesla)',
  airportCount:         'Nearby Airports',
  avTestingCount:       'AV Testing Sites',
  avTestingVehicles:    'AV Testing Vehicles',
  population:           'Total Population',
  populationDensity:    'Population Density (/sq mi)',
  medianIncome:         'Median Income ($)',
  avgWeeklyWage:        'Avg Weekly Wage ($)',
  publicTransitPct:     'Public Transit %',
  rideshareTrips:       'Rideshare Trips',
  ridesharePerCapita:   'Rideshare Per Capita',
  rideshareDensity:     'Rideshare Density',
  federalFundingAmount: 'Federal Funding ($)',
  stateFundingCount:    'State Funding Awards',
  gasPrice:             'Gas Price ($/gal)',
  electricityPrice:     'Electricity Price (cents/kWh)',
  snowdays:             'Annual Snow Days',
  temperature:          'Avg Temperature (F)',
  precipitation:        'Precipitation (in)',
  hurricaneRisk:        'Hurricane Risk Rating',
  stormRisk:            'Storm Risk Rating',
  earthquakeRisk:       'Earthquake Risk Rating',
  evStationCountMSA:    'EV Stations in MSA',
  snowdaysMSA:          'Snow Days (MSA)',
  temperatureMSA:       'Temperature (MSA)',
  areaSqrtMiles:        'Area (Sqrt Miles)',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeGeoLevel(geoLevel: GeoLevel | string): GeoLevel {
  const LEVEL_MAP: Record<string, GeoLevel> = { MSA: 'MSA', COUNTY: 'County', TRACT: 'Tract' };
  return LEVEL_MAP[geoLevel.toUpperCase()] ?? geoLevel as GeoLevel;
}

export function shouldShow(field: string, geoLevel: GeoLevel | string): boolean {
  return FIELD_VISIBILITY[field]?.[normalizeGeoLevel(geoLevel)] ?? false;
}

export function aggregateDetails(
  detailsList: (RegionDetails | undefined)[],
  geoLevel: GeoLevel | string = 'County',
): RegionDetails {
  const result: Partial<RegionDetails> = {};
  for (const key of Object.keys(FIELD_AGGREGATION) as (keyof RegionDetails)[]) {
    const aggType = resolveAggType(key, geoLevel);
    const values = detailsList
      .map(d => d?.[key] as number | undefined)
      .filter((v): v is number => v != null && !isNaN(v));
    if (values.length === 0) continue;
    const sum = values.reduce((a, b) => a + b, 0);
    switch (aggType) {
      case 'sum': (result as any)[key] = sum; break;
      case 'max': (result as any)[key] = Math.max(...values); break;
      case 'avg': (result as any)[key] = sum / values.length; break;
    }
  }
  // True deduplication for AV testing: union participant lists, derive count from unique set
  const allParticipants = detailsList.flatMap(d => d?.avTestingParticipants ?? []);
  if (allParticipants.length > 0) {
    const uniqueParticipants = [...new Set(allParticipants)].sort();
    result.avTestingParticipants = uniqueParticipants;
    result.avTestingCount = uniqueParticipants.length;
  }
  return result as RegionDetails;
}

/** Returns the list of RegionDetails field keys visible for a given geo level. */
export function getVisibleFields(geoLevel: GeoLevel | string): (keyof RegionDetails)[] {
  const normalized = normalizeGeoLevel(geoLevel);
  return (Object.keys(FIELD_VISIBILITY) as (keyof RegionDetails)[])
    .filter(field => FIELD_VISIBILITY[field as string]?.[normalized]);
}

/** Filters a RegionDetails object to only the fields visible for a given geo level. */
export function getVisibleAnalysis(
  details: RegionDetails | undefined,
  geoLevel: GeoLevel | string,
): Partial<RegionDetails> | null {
  if (!details) return null;
  const fields = getVisibleFields(geoLevel);
  const result: Partial<RegionDetails> = {};
  for (const field of fields) {
    const val = details[field];
    if (val != null) {
      (result as any)[field] = val;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}
