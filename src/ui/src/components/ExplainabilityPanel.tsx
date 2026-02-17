import { X, TrendingUp, MapPin, Users, CheckCircle2, AlertCircle, GitCompare, Zap, Building2, Car, DollarSign, Thermometer, CloudSnow, CloudRain, Activity, Layers } from 'lucide-react';
import { Region, GeoLevel, RegionDetails } from '../types';

// ── Aggregation ───────────────────────────────────────────────────────────────

type AggType = 'sum' | 'avg';

const FIELD_AGGREGATION: Partial<Record<keyof RegionDetails, AggType>> = {
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

function aggregateDetails(detailsList: (RegionDetails | undefined)[]): RegionDetails {
  const result: Partial<RegionDetails> = {};
  for (const key of Object.keys(FIELD_AGGREGATION) as (keyof RegionDetails)[]) {
    const aggType = FIELD_AGGREGATION[key];
    const values = detailsList
      .map(d => d?.[key] as number | undefined)
      .filter((v): v is number => v !== undefined && v !== null && !isNaN(v as number));
    if (values.length === 0) continue;
    (result as any)[key] = aggType === 'sum'
      ? values.reduce((a, b) => a + b, 0)
      : values.reduce((a, b) => a + b, 0) / values.length;
  }
  return result as RegionDetails;
}

// ── Field visibility ──────────────────────────────────────────────────────────

const FIELD_VISIBILITY: Record<string, Record<GeoLevel, boolean>> = {
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

const shouldShow = (field: string, geoLevel: GeoLevel | string): boolean => {
  const normalizedLevel = geoLevel.toUpperCase() === 'MSA' ? 'MSA'
    : geoLevel.toUpperCase() === 'COUNTY' ? 'County'
      : geoLevel.toUpperCase() === 'TRACT' ? 'Tract'
        : geoLevel as GeoLevel;
  return FIELD_VISIBILITY[field]?.[normalizedLevel] ?? false;
};

// ── Props ─────────────────────────────────────────────────────────────────────

interface ExplainabilityPanelProps {
  /** Single-region mode */
  region?: Region;
  /** Multi-region mode — pass 2+ regions */
  regions?: Region[];
  /** Details for each entry in `regions` (parallel array) */
  allDetails?: (RegionDetails | undefined)[];
  onClose: () => void;
  onAddToCompare?: () => void;
  isLoadingDetails?: boolean;
  detailsProgress?: number;
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

const SkeletonRow = () => (
  <div className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0 animate-pulse">
    <div className="h-3 bg-gray-200 rounded w-32" />
    <div className="h-3 bg-gray-200 rounded w-16" />
  </div>
);

const SkeletonSection = ({ rows = 3, label, icon: Icon }: { rows?: number; label: string; icon: React.ElementType }) => (
  <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
    <div className="bg-gray-50 px-4 py-2 border-b border-gray-200 flex items-center gap-2">
      <Icon className="w-4 h-4 text-gray-300" />
      <span className="text-sm font-semibold text-gray-400">{label}</span>
    </div>
    <div className="px-4 py-2">
      {Array.from({ length: rows }).map((_, i) => <SkeletonRow key={i} />)}
    </div>
  </div>
);

// ── Formatters ────────────────────────────────────────────────────────────────

const formatNumber = (val: number | undefined | null, prefix = '', suffix = ''): string => {
  if (val === undefined || val === null) return 'N/A';
  if (val >= 1000000) return `${prefix}${(val / 1000000).toFixed(1)}M${suffix}`;
  if (val >= 1000) return `${prefix}${(val / 1000).toFixed(1)}K${suffix}`;
  if (val < 1 && val > 0) return `${prefix}${val.toFixed(3)}${suffix}`;
  return `${prefix}${val.toLocaleString()}${suffix}`;
};

const formatDecimal = (val: number | undefined | null, decimals: number, prefix = '', suffix = ''): string => {
  if (val === undefined || val === null || typeof val !== 'number') return 'N/A';
  return `${prefix}${val.toFixed(decimals)}${suffix}`;
};

// ── DetailItem ────────────────────────────────────────────────────────────────

const AggBadge = ({ type }: { type: AggType }) => (
  <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
    type === 'sum' ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'
  }`}>
    {type}
  </span>
);

const DetailItem = ({
  label, value, icon: Icon, aggregation,
}: {
  label: string;
  value: string;
  icon?: React.ElementType;
  aggregation?: AggType;
}) => (
  <div className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
    <div className="flex items-center gap-2 text-gray-600">
      {Icon && <Icon className="w-4 h-4" />}
      <span className="text-sm">{label}</span>
    </div>
    <div className="flex items-center gap-1.5">
      {aggregation && <AggBadge type={aggregation} />}
      <span className="text-sm font-medium text-gray-900">{value}</span>
    </div>
  </div>
);

// ── Detail sections (shared between single and multi) ─────────────────────────

interface DetailSectionsProps {
  details: RegionDetails;
  geoLevel: GeoLevel | string;
  showAggBadges?: boolean;
  isAirportTract?: boolean;
}

function DetailSections({ details, geoLevel, showAggBadges, isAirportTract }: DetailSectionsProps) {
  const agg = (field: keyof RegionDetails): AggType | undefined =>
    showAggBadges ? FIELD_AGGREGATION[field] : undefined;

  return (
    <div className="space-y-4">
      {/* Infrastructure */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="bg-gray-50 px-4 py-2 border-b border-gray-200">
          <h4 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
            <Zap className="w-4 h-4 text-yellow-500" />
            Infrastructure
          </h4>
        </div>
        <div className="px-4 py-2">
          {shouldShow('evStationCount', geoLevel) && details.evStationCount !== undefined && (
            <DetailItem label="EV Stations (Non-Tesla)" value={formatNumber(details.evStationCount)} icon={Zap} aggregation={agg('evStationCount')} />
          )}
          {shouldShow('airportCount', geoLevel) && details.airportCount !== undefined && (
            <DetailItem
              label={isAirportTract ? 'Nearby Airports (25mi)' : 'Nearby Airports'}
              value={formatNumber(details.airportCount)}
              icon={Building2}
              aggregation={agg('airportCount')}
            />
          )}
          {shouldShow('avTestingCount', geoLevel) && details.avTestingCount !== undefined && (
            <DetailItem label="AV Testing Sites" value={formatNumber(details.avTestingCount)} icon={Car} aggregation={agg('avTestingCount')} />
          )}
          {shouldShow('avTestingVehicles', geoLevel) && details.avTestingVehicles !== undefined && (
            <DetailItem label="AV Testing Vehicles" value={formatNumber(details.avTestingVehicles)} icon={Car} aggregation={agg('avTestingVehicles')} />
          )}
        </div>
      </div>

      {/* Demographics */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="bg-gray-50 px-4 py-2 border-b border-gray-200">
          <h4 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
            <Users className="w-4 h-4 text-blue-500" />
            Demographics
          </h4>
        </div>
        <div className="px-4 py-2">
          {shouldShow('population', geoLevel) && details.population !== undefined && (
            <DetailItem label="Total Population" value={formatNumber(details.population)} icon={Users} aggregation={agg('population')} />
          )}
          {shouldShow('populationDensity', geoLevel) && details.populationDensity !== undefined && (
            <DetailItem label="Population Density" value={formatNumber(details.populationDensity, '', '/sq mi')} aggregation={agg('populationDensity')} />
          )}
          {shouldShow('medianIncome', geoLevel) && details.medianIncome !== undefined && (
            <DetailItem label="Median Income" value={formatNumber(details.medianIncome, '$')} icon={DollarSign} aggregation={agg('medianIncome')} />
          )}
          {shouldShow('avgWeeklyWage', geoLevel) && details.avgWeeklyWage !== undefined && (
            <DetailItem label="Avg Weekly Wage" value={formatNumber(details.avgWeeklyWage, '$')} icon={DollarSign} aggregation={agg('avgWeeklyWage')} />
          )}
          {shouldShow('publicTransitPct', geoLevel) && details.publicTransitPct !== undefined && details.publicTransitPct !== null && (
            <DetailItem label="Public Transit %" value={formatDecimal(details.publicTransitPct * 100, 1, '', '%')} aggregation={agg('publicTransitPct')} />
          )}
        </div>
      </div>

      {/* Mobility */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="bg-gray-50 px-4 py-2 border-b border-gray-200">
          <h4 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
            <Activity className="w-4 h-4 text-green-500" />
            Mobility & Rideshare
          </h4>
        </div>
        <div className="px-4 py-2">
          {shouldShow('rideshareTrips', geoLevel) && details.rideshareTrips !== undefined && (
            <DetailItem label="Rideshare Trips" value={formatNumber(details.rideshareTrips)} icon={Car} aggregation={agg('rideshareTrips')} />
          )}
          {shouldShow('ridesharePerCapita', geoLevel) && details.ridesharePerCapita !== undefined && (
            <DetailItem label="Rideshare Per Capita" value={formatNumber(details.ridesharePerCapita)} aggregation={agg('ridesharePerCapita')} />
          )}
          {shouldShow('rideshareDensity', geoLevel) && details.rideshareDensity !== undefined && (
            <DetailItem label="Rideshare Density" value={formatNumber(details.rideshareDensity)} aggregation={agg('rideshareDensity')} />
          )}
        </div>
      </div>

      {/* Funding */}
      {(shouldShow('federalFundingAmount', geoLevel) || shouldShow('stateFundingCount', geoLevel)) &&
        (details.federalFundingAmount !== undefined || details.stateFundingCount !== undefined) && (
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <div className="bg-gray-50 px-4 py-2 border-b border-gray-200">
              <h4 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                <DollarSign className="w-4 h-4 text-emerald-500" />
                Funding & Incentives
              </h4>
            </div>
            <div className="px-4 py-2">
              {shouldShow('federalFundingAmount', geoLevel) && details.federalFundingAmount !== undefined && (
                <DetailItem label="Federal Funding" value={formatNumber(details.federalFundingAmount, '$')} icon={DollarSign} aggregation={agg('federalFundingAmount')} />
              )}
              {shouldShow('stateFundingCount', geoLevel) && details.stateFundingCount !== undefined && (
                <DetailItem label="State Funding Awards" value={formatNumber(details.stateFundingCount)} aggregation={agg('stateFundingCount')} />
              )}
            </div>
          </div>
        )}

      {/* Costs */}
      {(details.gasPrice !== undefined || details.electricityPrice !== undefined || details.landValue !== undefined) && (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className="bg-gray-50 px-4 py-2 border-b border-gray-200">
            <h4 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
              <DollarSign className="w-4 h-4 text-amber-500" />
              Costs
            </h4>
          </div>
          <div className="px-4 py-2">
            {shouldShow('gasPrice', geoLevel) && details.gasPrice !== undefined && details.gasPrice !== null && (
              <DetailItem label="Gas Price" value={formatDecimal(details.gasPrice, 2, '$', '/gal')} icon={DollarSign} aggregation={agg('gasPrice')} />
            )}
            {shouldShow('electricityPrice', geoLevel) && details.electricityPrice !== undefined && details.electricityPrice !== null && (
              <DetailItem label="Electricity Price" value={formatDecimal(details.electricityPrice, 1, '', '¢/kWh')} icon={Zap} aggregation={agg('electricityPrice')} />
            )}
            {shouldShow('landValue', geoLevel) && details.landValue !== undefined && details.landValue !== null && (
              <DetailItem label="Land Value (¼ acre)" value={formatNumber(details.landValue, '$')} icon={DollarSign} aggregation={agg('landValue')} />
            )}
          </div>
        </div>
      )}

      {/* Climate & Risk */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="bg-gray-50 px-4 py-2 border-b border-gray-200">
          <h4 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
            <Thermometer className="w-4 h-4 text-orange-500" />
            Climate & Risk
          </h4>
        </div>
        <div className="px-4 py-2">
          {shouldShow('snowdays', geoLevel) && details.snowdays !== undefined && details.snowdays !== null && (
            <DetailItem label="Annual Snow Days" value={formatNumber(details.snowdays)} icon={CloudSnow} aggregation={agg('snowdays')} />
          )}
          {shouldShow('temperature', geoLevel) && details.temperature !== undefined && details.temperature !== null && (
            <DetailItem label="Avg Temperature" value={formatDecimal(details.temperature, 1, '', '°F')} icon={Thermometer} aggregation={agg('temperature')} />
          )}
          {shouldShow('precipitation', geoLevel) && details.precipitation !== undefined && details.precipitation !== null && (
            <DetailItem label="Precipitation" value={formatDecimal(details.precipitation, 1, '', ' in')} icon={CloudRain} aggregation={agg('precipitation')} />
          )}
          {shouldShow('hurricaneRisk', geoLevel) && details.hurricaneRisk !== undefined && details.hurricaneRisk !== null && (
            <DetailItem label="Hurricane Risk" value={formatDecimal(details.hurricaneRisk, 1, 'Rating: ', '')} icon={AlertCircle} aggregation={agg('hurricaneRisk')} />
          )}
          {shouldShow('stormRisk', geoLevel) && details.stormRisk !== undefined && details.stormRisk !== null && (
            <DetailItem label="Storm Risk" value={formatDecimal(details.stormRisk, 1, 'Rating: ', '')} icon={AlertCircle} aggregation={agg('stormRisk')} />
          )}
          {shouldShow('earthquakeRisk', geoLevel) && details.earthquakeRisk !== undefined && details.earthquakeRisk !== null && (
            <DetailItem label="Earthquake Risk" value={formatDecimal(details.earthquakeRisk, 1, 'Rating: ', '')} icon={AlertCircle} aggregation={agg('earthquakeRisk')} />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function ExplainabilityPanel({
  region,
  regions,
  allDetails,
  onClose,
  onAddToCompare,
  isLoadingDetails = false,
  detailsProgress = -1,
}: ExplainabilityPanelProps) {

  // ── Multi-region mode ──────────────────────────────────────────────────────
  const isMulti = regions !== undefined && regions.length >= 2;

  if (isMulti) {
    const geoLevel = regions[0].geoLevel;
    const isAirportTract = geoLevel.toUpperCase() === 'TRACT';
    const aggregated = allDetails && allDetails.some(Boolean)
      ? aggregateDetails(allDetails)
      : null;

    const totalCustomers = regions.reduce((s, r) => s + r.customerCount, 0);
    const avgScore = regions.reduce((s, r) => s + r.score, 0) / regions.length;
    const bestRank = Math.min(...regions.map(r => r.rank));
    const inGeofenceCount = regions.filter(r => r.inGeofence).length;

    return (
      <div className="w-96 bg-white border-l border-gray-200 overflow-y-auto flex-shrink-0 shadow-xl">
        {/* Header */}
        <div className="sticky top-0 bg-indigo-600 text-white p-6 z-10">
          <div className="flex items-start justify-between mb-2">
            <div className="flex items-center gap-2">
              <Layers className="w-5 h-5" />
              <h2 className="font-semibold">Multi-Region Analysis</h2>
            </div>
            <button onClick={onClose} className="text-white hover:bg-indigo-700 p-1 rounded transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>
          <p className="text-sm text-indigo-100">
            {regions.length} {geoLevel} regions selected
          </p>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {/* Region list */}
          <div>
            <div className="flex items-start gap-3">
              <MapPin className="w-5 h-5 text-indigo-600 flex-shrink-0 mt-0.5" />
              <div className="w-full">
                <h3 className="font-semibold text-gray-900">{regions.length} Regions Selected</h3>
                <p className="text-sm text-gray-500 mt-1">{geoLevel} Level</p>
                <div className="mt-2 space-y-0.5 max-h-28 overflow-y-auto pr-1">
                  {regions.map(r => (
                    <p key={r.id} className="text-xs text-gray-600 truncate">• {r.name}</p>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Legend */}
          <div className="flex items-center gap-3 text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2 border border-gray-200">
            <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded bg-blue-200 border border-blue-400" /> <span className="text-blue-700 font-medium">sum</span> = total across all regions</span>
            <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded bg-amber-200 border border-amber-400" /> <span className="text-amber-700 font-medium">avg</span> = average across all regions</span>
          </div>

          {/* Key Metrics */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-gradient-to-br from-indigo-50 to-indigo-100 rounded-lg p-4 border border-indigo-200">
              <p className="text-xs font-medium text-indigo-700 mb-1">Best Rank</p>
              <p className="text-2xl font-bold text-indigo-900">#{bestRank}</p>
            </div>
            <div className="bg-gradient-to-br from-green-50 to-green-100 rounded-lg p-4 border border-green-200">
              <p className="text-xs font-medium text-green-700 mb-1">Avg Score</p>
              <p className="text-2xl font-bold text-green-900">{(avgScore * 100).toFixed(0)}%</p>
            </div>
          </div>

          {/* Customer Count */}
          <div className="flex items-center gap-3 p-4 bg-gray-50 rounded-lg border border-gray-200">
            <Users className="w-5 h-5 text-gray-600" />
            <div className="flex-1">
              <div className="flex items-center gap-1.5">
                <AggBadge type="sum" />
                <p className="text-sm font-medium text-gray-900">
                  {totalCustomers.toLocaleString()} Customers
                </p>
              </div>
              <p className="text-xs text-gray-500">Total across selected regions</p>
            </div>
          </div>

          {/* Geofence Status */}
          <div className={`flex items-center gap-3 p-4 rounded-lg border ${
            inGeofenceCount > 0 ? 'bg-purple-50 border-purple-200' : 'bg-gray-50 border-gray-200'
          }`}>
            {inGeofenceCount > 0 ? (
              <>
                <CheckCircle2 className="w-5 h-5 text-purple-600 flex-shrink-0" />
                <div>
                  <p className="text-sm font-medium text-purple-900">
                    {inGeofenceCount} of {regions.length} inside Customer Interest Zone
                  </p>
                  <p className="text-xs text-purple-700">Priority expansion area</p>
                </div>
              </>
            ) : (
              <>
                <AlertCircle className="w-5 h-5 text-gray-400 flex-shrink-0" />
                <div>
                  <p className="text-sm font-medium text-gray-700">
                    None inside Customer Interest Zone
                  </p>
                  <p className="text-xs text-gray-500">Consider for future targeting</p>
                </div>
              </>
            )}
          </div>

          {/* Aggregated Detail Sections */}
          {isLoadingDetails ? (
            <div className="space-y-4">
              <SkeletonSection label="Infrastructure" icon={Zap} rows={3} />
              <SkeletonSection label="Demographics" icon={Users} rows={3} />
              <SkeletonSection label="Mobility & Rideshare" icon={Activity} rows={2} />
              <SkeletonSection label="Costs" icon={DollarSign} rows={3} />
              <SkeletonSection label="Climate & Risk" icon={Thermometer} rows={4} />
            </div>
          ) : aggregated ? (
            <DetailSections
              details={aggregated}
              geoLevel={geoLevel}
              showAggBadges
              isAirportTract={isAirportTract}
            />
          ) : null}
        </div>
      </div>
    );
  }

  // ── Single-region mode (existing behavior) ─────────────────────────────────
  if (!region) return null;

  const getImpactColor = (impact: string) => {
    switch (impact) {
      case 'high':   return 'text-green-700 bg-green-50 border-green-200';
      case 'medium': return 'text-amber-700 bg-amber-50 border-amber-200';
      case 'low':    return 'text-red-700 bg-red-50 border-red-200';
      default:       return 'text-gray-700 bg-gray-50 border-gray-200';
    }
  };

  const getImpactIcon = (impact: string) => {
    switch (impact) {
      case 'high': return <TrendingUp className="w-4 h-4" />;
      default:     return <AlertCircle className="w-4 h-4" />;
    }
  };

  return (
    <div className="w-96 bg-white border-l border-gray-200 overflow-y-auto flex-shrink-0 shadow-xl">
      {/* Header */}
      <div className="sticky top-0 bg-indigo-600 text-white p-6 z-10">
        <div className="flex items-start justify-between mb-2">
          <h2 className="font-semibold">Region Analysis</h2>
          <button onClick={onClose} className="text-white hover:bg-indigo-700 p-1 rounded transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>
        <p className="text-sm text-indigo-100">Understanding why this region ranks high</p>
      </div>

      {/* Content */}
      <div className="p-6 space-y-6">
        {/* Region Name */}
        <div>
          <div className="flex items-start gap-3">
            <MapPin className="w-5 h-5 text-indigo-600 flex-shrink-0 mt-0.5" />
            <div>
              <h3 className="font-semibold text-gray-900">{region.name}</h3>
              <p className="text-sm text-gray-500 mt-1">{region.geoLevel} Level</p>
            </div>
          </div>
        </div>

        {/* Add to Compare Button */}
        {onAddToCompare && (
          <button
            onClick={onAddToCompare}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors"
          >
            <GitCompare className="w-4 h-4" />
            Add to Compare
          </button>
        )}

        {/* Key Metrics */}
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-gradient-to-br from-indigo-50 to-indigo-100 rounded-lg p-4 border border-indigo-200">
            <p className="text-xs font-medium text-indigo-700 mb-1">Rank</p>
            <p className="text-2xl font-bold text-indigo-900">#{region.rank}</p>
          </div>
          <div className="bg-gradient-to-br from-green-50 to-green-100 rounded-lg p-4 border border-green-200">
            <p className="text-xs font-medium text-green-700 mb-1">Score</p>
            <p className="text-2xl font-bold text-green-900">{(region.score * 100).toFixed(0)}%</p>
          </div>
        </div>

        {/* Customer Count */}
        <div className="flex items-center gap-3 p-4 bg-gray-50 rounded-lg border border-gray-200">
          <Users className="w-5 h-5 text-gray-600" />
          <div>
            <p className="text-sm font-medium text-gray-900">
              {region.customerCount.toLocaleString()} Customers
            </p>
            <p className="text-xs text-gray-500">Active in this region</p>
          </div>
        </div>

        {/* Geofence Status */}
        <div className={`flex items-center gap-3 p-4 rounded-lg border ${region.inGeofence
          ? 'bg-purple-50 border-purple-200'
          : 'bg-gray-50 border-gray-200'
        }`}>
          {region.inGeofence ? (
            <>
              <CheckCircle2 className="w-5 h-5 text-purple-600" />
              <div>
                <p className="text-sm font-medium text-purple-900">Inside Customer Interest Zone</p>
                <p className="text-xs text-purple-700">Priority expansion area</p>
              </div>
            </>
          ) : (
            <>
              <AlertCircle className="w-5 h-5 text-gray-400" />
              <div>
                <p className="text-sm font-medium text-gray-700">Outside Customer Interest Zone</p>
                <p className="text-xs text-gray-500">Consider for future targeting</p>
              </div>
            </>
          )}
        </div>

        {/* Detail Sections */}
        {isLoadingDetails ? (
          <div className="space-y-4">
            <SkeletonSection label="Infrastructure" icon={Zap} rows={3} />
            <SkeletonSection label="Demographics" icon={Users} rows={3} />
            <SkeletonSection label="Mobility & Rideshare" icon={Activity} rows={2} />
            <SkeletonSection label="Costs" icon={DollarSign} rows={3} />
            <SkeletonSection label="Climate & Risk" icon={Thermometer} rows={4} />
          </div>
        ) : region.details && (
          <DetailSections
            details={region.details}
            geoLevel={region.geoLevel}
            showAggBadges={false}
            isAirportTract={region.geoLevel.toUpperCase() === 'TRACT'}
          />
        )}

        {/* Contributing Factors */}
        {isLoadingDetails ? (
          <div>
            <div className="flex items-center gap-2 mb-3">
              <TrendingUp className="w-5 h-5 text-indigo-300 animate-pulse" />
              <div className="h-4 bg-gray-200 rounded w-44 animate-pulse" />
            </div>
            {detailsProgress >= 0 && (
              <div className="mb-3 space-y-1">
                <div className="h-1.5 w-full bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className="h-1.5 bg-indigo-400 rounded-full transition-all duration-300"
                    style={{ width: `${detailsProgress}%` }}
                  />
                </div>
                <p className="text-xs text-gray-400 tabular-nums">{detailsProgress}% loaded</p>
              </div>
            )}
            <div className="space-y-3">
              {[1, 2, 3].map(i => (
                <div key={i} className="p-4 rounded-lg border border-gray-100 animate-pulse space-y-2">
                  <div className="h-3 bg-gray-200 rounded w-40" />
                  <div className="h-3 bg-gray-100 rounded w-full" />
                  <div className="h-3 bg-gray-100 rounded w-3/4" />
                </div>
              ))}
            </div>
          </div>
        ) : region.factors && region.factors.length > 0 && (
          <div>
            <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
              <TrendingUp className="w-5 h-5 text-indigo-600" />
              Top Contributing Factors
            </h3>
            <div className="space-y-3">
              {region.factors.map((factor, index) => (
                <div key={index} className={`p-4 rounded-lg border ${getImpactColor(factor.impact)}`}>
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2">
                      {getImpactIcon(factor.impact)}
                      <h4 className="font-medium">{factor.name}</h4>
                    </div>
                    <span className="text-xs font-semibold uppercase px-2 py-1 rounded">
                      {factor.impact}
                    </span>
                  </div>
                  <p className="text-sm">{factor.description}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Additional Context */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <h4 className="text-sm font-semibold text-blue-900 mb-2">Why This Matters</h4>
          <p className="text-sm text-blue-800 leading-relaxed">
            This region scores in the top {Math.ceil((region.rank / 10) * 10)}% based on a
            combination of customer demand signals, infrastructure readiness, and risk factors.
            The factors above represent the strongest positive indicators for this location.
          </p>
        </div>
      </div>
    </div>
  );
}
