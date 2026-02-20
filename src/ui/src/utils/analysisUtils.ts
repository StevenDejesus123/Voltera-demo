import type { GeoLevel, RegionDetails } from '../types';

// ── Aggregation ───────────────────────────────────────────────────────────────

export type AggType = 'sum' | 'avg';

export const FIELD_AGGREGATION: Partial<Record<keyof RegionDetails, AggType>> = {
  // sums — absolute counts / totals
  population:            'sum',
  rideshareTrips:        'sum',
  evStationCount:        'sum',
  airportCount:          'sum',
  avTestingCount:        'sum',
  avTestingVehicles:     'sum',
  federalFundingAmount:  'sum',
  stateFundingCount:     'sum',
  evStationCountMSA:     'sum',
  areaSqrtMiles:         'sum',
  // averages — rates, prices, densities
  populationDensity:     'avg',
  medianIncome:          'avg',
  avgWeeklyWage:         'avg',
  publicTransitPct:      'avg',
  ridesharePerCapita:    'avg',
  rideshareDensity:      'avg',
  gasPrice:              'avg',
  electricityPrice:      'avg',
  landValue:             'avg',
  snowdays:              'avg',
  snowdaysMSA:           'avg',
  temperature:           'avg',
  temperatureMSA:        'avg',
  precipitation:         'avg',
  hurricaneRisk:         'avg',
  stormRisk:             'avg',
  earthquakeRisk:        'avg',
};

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
  landValue:            { MSA: true,  County: true,  Tract: true  },
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
  landValue:            'Land Value ($/quarter-acre)',
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

export function aggregateDetails(detailsList: (RegionDetails | undefined)[]): RegionDetails {
  const result: Partial<RegionDetails> = {};
  for (const key of Object.keys(FIELD_AGGREGATION) as (keyof RegionDetails)[]) {
    const aggType = FIELD_AGGREGATION[key];
    const values = detailsList
      .map(d => d?.[key] as number | undefined)
      .filter((v): v is number => v != null && !isNaN(v));
    if (values.length === 0) continue;
    const sum = values.reduce((a, b) => a + b, 0);
    (result as any)[key] = aggType === 'sum' ? sum : sum / values.length;
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
