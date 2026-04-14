import { Region, GeoLevel, RegionDetails, CompetitorSite } from '../types';
import { getPolygonsForLevel } from '../dataLoader/geoPolygons';
import union from '@turf/union';
import buffer from '@turf/buffer';
import { featureCollection, point, polygon, multiPolygon } from '@turf/helpers';
import type { Feature, Polygon, MultiPolygon, GeoJsonProperties } from 'geojson';
import { getVisibleFields, FIELD_LABELS, aggregateDetails, getVisibleAnalysis } from './analysisUtils';
import { ColorScale, getColorMode, isRankBased } from './colorScale';
import * as shpwrite from '@mapbox/shp-write';
import { getCategoryColor } from '../dataLoader/competitorLoader';

export interface ExportOptions {
  includePolygons?: boolean;
  useSmartMerge?: boolean;
  analysisData?: Map<string, RegionDetails>;
  sites?: CompetitorSite[];
  /** When set, pins are filtered to only those within these county boundaries. */
  siteCountyFilter?: Region[];
}

interface RegionAggregates {
  regionCount: number;
  regionIds: string[];
  regionNames: string[];
  avgScore: number;
  totalCustomerCount: number;
}

// ---------------------------------------------------------------------------
// Shared site pin preparation (used by GeoJSON & KML exports)
// ---------------------------------------------------------------------------

/**
 * Resolves the final list of site pins for export, applying optional county
 * boundary filtering when the export is scoped to specific counties.
 */
function resolveSitesForExport(
  rawSites: CompetitorSite[] | undefined,
  siteCountyFilter: Region[] | undefined,
): CompetitorSite[] | undefined {
  if (!rawSites || rawSites.length === 0) return undefined;
  if (siteCountyFilter && siteCountyFilter.length > 0) {
    return filterSitesToRegions(rawSites, siteCountyFilter, buildPolygonMap('County', true));
  }
  return rawSites;
}

/** Appends "-with-sites" before the extension when sites are included. */
function exportFilename(base: string, hasSites: boolean): string {
  if (!hasSites) return base;
  const dotIndex = base.lastIndexOf('.');
  return `${base.slice(0, dotIndex)}-with-sites${base.slice(dotIndex)}`;
}

/**
 * Wraps region placemarks and site pin placemarks into KML folders when both
 * are present, otherwise returns region placemarks alone.
 */
function assembleKMLContent(
  regionFolderName: string,
  regionPlacemarks: string,
  sites: CompetitorSite[] | undefined,
): string {
  if (!sites || sites.length === 0) return regionPlacemarks;
  const sitePinsKML = buildSitePinsKML(sites);
  return wrapInKMLFolder(regionFolderName, regionPlacemarks)
    + '\n' + wrapInKMLFolder('Site Locations', sitePinsKML);
}

// ---------------------------------------------------------------------------
// Public export functions
// ---------------------------------------------------------------------------

export function exportToCSV(regions: Region[], options: ExportOptions = {}): void {
  const { analysisData } = options;
  const sites = resolveSitesForExport(options.sites, options.siteCountyFilter);
  const hasSites = (sites != null && sites.length > 0);

  const typeHeader = hasSites ? ['Type'] : [];
  const baseHeaders = ['Rank', 'Region ID', 'Region Name', 'Score', 'Customer Count', 'In Geofence', 'Geo Level'];
  const siteHeaders = hasSites
    ? ['Company', 'Category', 'Status', 'MSA', 'Address', 'City', 'State', 'Zoning', 'Stalls', 'Segment', 'Opportunity', 'Utility', 'Notes']
    : [];

  // Determine analysis columns based on geo level
  const geoLevel = regions.length > 0 ? regions[0].geoLevel : undefined;
  const analysisFields = geoLevel && analysisData && analysisData.size > 0
    ? getVisibleFields(geoLevel)
    : [];
  const analysisHeaders = analysisFields.map(f => FIELD_LABELS[f] || f);

  const headers = [...typeHeader, ...baseHeaders, ...analysisHeaders, ...siteHeaders];
  const emptyRegionCols = baseHeaders.length + analysisHeaders.length;
  const emptySiteCols = siteHeaders.length;

  const rows = regions.map(region => {
    const type = hasSites ? ['region'] : [];
    const base = [
      region.rank,
      region.id,
      `"${region.name}"`,
      region.score.toFixed(4),
      region.customerCount,
      region.inGeofence ? 'Yes' : 'No',
      region.geoLevel,
    ];
    const analysis = analysisFields.map(field => {
      const val = analysisData?.get(region.id)?.[field];
      return val ?? '';
    });
    const sitePad = hasSites ? Array(emptySiteCols).fill('') : [];
    return [...type, ...base, ...analysis, ...sitePad];
  });

  // Add summary row for multi-region exports
  if (regions.length > 1 && analysisFields.length > 0 && analysisData && analysisData.size > 0) {
    const detailsList = regions.map(r => analysisData.get(r.id));
    const aggregated = aggregateDetails(detailsList);
    const avgScore = regions.reduce((s, r) => s + r.score, 0) / regions.length;
    const totalCustomers = regions.reduce((s, r) => s + r.customerCount, 0);
    const type = hasSites ? ['SUMMARY'] : [];
    const summaryBase = [
      hasSites ? '' : 'SUMMARY',
      '',
      `"${regions.length} regions aggregated"`,
      avgScore.toFixed(4),
      totalCustomers,
      '',
      geoLevel || '',
    ];
    const summaryAnalysis = analysisFields.map(field => {
      const val = aggregated[field];
      return val ?? '';
    });
    const sitePad = hasSites ? Array(emptySiteCols).fill('') : [];
    rows.push([...type, ...summaryBase, ...summaryAnalysis, ...sitePad] as any);
  }

  // Append site pin rows
  if (sites) {
    for (const s of sites) {
      if (s.lat == null || s.lng == null) continue;
      const type = ['site_pin'];
      const regionPad = Array(baseHeaders.length + analysisHeaders.length).fill('');
      const siteData = [
        `"${(s.companyName || '').replace(/"/g, '""')}"`,
        s.category || '',
        s.status || '',
        `"${(s.msa || '').replace(/"/g, '""')}"`,
        `"${(s.address || '').replace(/"/g, '""')}"`,
        s.city || '',
        s.state || '',
        s.zoning || '',
        s.totalStalls ?? '',
        s.volteraSegment || '',
        `"${(s.opportunityName || '').replace(/"/g, '""')}"`,
        s.utility || '',
        `"${(s.notes || '').replace(/"/g, '""')}"`,
      ];
      rows.push([...type, ...regionPad, ...siteData] as any);
    }
  }

  const csvContent = [
    headers.join(','),
    ...rows.map(row => row.join(','))
  ].join('\n');

  downloadFile(csvContent, exportFilename('ranking-export.csv', hasSites), 'text/csv');
}

export function exportToGeoJSON(
  regions: Region[],
  geoLevel?: GeoLevel,
  options: ExportOptions = {}
): void {
  const { useSmartMerge = false, analysisData } = options;
  const polygonMap = buildPolygonMap(geoLevel, options.includePolygons);
  const sites = resolveSitesForExport(options.sites, options.siteCountyFilter);
  const siteFeatures = buildSiteGeoJSONFeatures(sites);
  const hasSites = siteFeatures.length > 0;

  // Smart merge: union all selected polygons into one shape
  if (useSmartMerge && regions.length > 1 && polygonMap.size > 0) {
    const merged = mergePolygonsByUnion(regions, polygonMap);
    if (merged) {
      const aggregates = computeRegionAggregates(regions);
      const mergedAnalysis = buildMergedAnalysis(regions, geoLevel, analysisData);
      const features = [{
        type: 'Feature' as const,
        geometry: merged,
        properties: {
          name: `Merged ${geoLevel || 'Region'}s (${regions.length} regions)`,
          ...aggregates,
          ...(mergedAnalysis && { analysis: mergedAnalysis }),
        },
      }, ...siteFeatures];

      downloadGeoJSON(features, exportFilename('ranking-export-merged.geojson', hasSites));
      return;
    }
  }

  // Build color scale matching the UI map choropleth
  const colorMode = geoLevel ? getColorMode(geoLevel) : 'quantile';
  const colorScale = new ColorScale(regions.map(r => r.score), colorMode);
  const useRank = geoLevel ? isRankBased(geoLevel) : false;
  const totalRegions = regions.length;

  // Individual features with polygon geometry
  const features = regions.map(region => {
    const analysis = geoLevel && analysisData
      ? getVisibleAnalysis(analysisData.get(region.id), geoLevel)
      : null;
    const color = useRank
      ? colorScale.getColorByRank(region.rank, totalRegions)
      : colorScale.getColor(region.score);
    return {
      type: 'Feature' as const,
      geometry: polygonMap.get(region.id) || {
        type: 'Point',
        coordinates: [region.lng, region.lat],
      },
      properties: {
        id: region.id,
        name: region.name,
        rank: region.rank,
        score: region.score,
        color,
        customerCount: region.customerCount,
        inGeofence: region.inGeofence,
        geoLevel: region.geoLevel,
        factors: region.factors,
        ...(analysis && { analysis }),
      },
    };
  });

  downloadGeoJSON([...features, ...siteFeatures], exportFilename('ranking-export.geojson', hasSites));
}

export function exportToKML(
  regions: Region[],
  geoLevel?: GeoLevel,
  options: ExportOptions = {}
): void {
  const { useSmartMerge = false, analysisData } = options;
  const polygonMap = buildPolygonMap(geoLevel, options.includePolygons);
  const sites = resolveSitesForExport(options.sites, options.siteCountyFilter);
  const hasSites = (sites != null && sites.length > 0);

  // Build a color scale matching the UI map choropleth
  const colorMode = geoLevel ? getColorMode(geoLevel) : 'quantile';
  const colorScale = new ColorScale(regions.map(r => r.score), colorMode);
  const useRank = geoLevel ? isRankBased(geoLevel) : false;
  const totalRegions = regions.length;

  function getRegionColor(region: Region): string {
    return useRank
      ? colorScale.getColorByRank(region.rank, totalRegions)
      : colorScale.getColor(region.score);
  }

  // Smart merge: union all selected polygons into one shape
  if (useSmartMerge && regions.length > 1 && polygonMap.size > 0) {
    const merged = mergePolygonsByUnion(regions, polygonMap);
    if (merged) {
      const aggregates = computeRegionAggregates(regions);
      const regionList = regions.map(r => `- ${escapeXml(r.name)} (#${r.rank})`).join('<br/>');
      const mergedAnalysis = buildMergedAnalysis(regions, geoLevel, analysisData);
      const analysisHTML = mergedAnalysis && geoLevel
        ? buildAnalysisHTML(mergedAnalysis, geoLevel)
        : '';
      const bestRegion = [...regions].sort((a, b) => a.rank - b.rank)[0];
      const placemark = buildKMLPlacemark({
        name: escapeXml(`Merged ${geoLevel || 'Region'}s (${regions.length} regions)`),
        description: `
        <b>Type:</b> Merged Boundary<br/>
        <b>Regions:</b> ${regions.length}<br/>
        <b>Avg Score:</b> ${(aggregates.avgScore * 100).toFixed(1)}%<br/>
        <b>Total Customers:</b> ${aggregates.totalCustomerCount.toLocaleString()}<br/>
        <hr/>
        <b>Included:</b><br/>
        ${regionList}${analysisHTML}`,
        geometry: merged,
        fillColor: getRegionColor(bestRegion),
        isPolygon: true,
      });

      const content = assembleKMLContent('Merged Boundary', placemark, sites);
      downloadKML(content, 'Site Ranking Export - Merged', `${regions.length} regions merged`,
        exportFilename('ranking-export-merged.kml', hasSites));
      return;
    }
  }

  // Individual placemarks with polygon geometry
  const regionPlacemarks = regions.map(region => {
    const polygonGeometry = polygonMap.get(region.id);
    const details = analysisData?.get(region.id);
    const analysisHTML = geoLevel && details
      ? buildAnalysisHTML(details, geoLevel)
      : '';
    return buildKMLPlacemark({
      name: escapeXml(region.name),
      description: `
        <b>Rank:</b> #${region.rank}<br/>
        <b>Score:</b> ${(region.score * 100).toFixed(1)}%<br/>
        <b>Customers:</b> ${region.customerCount.toLocaleString()}<br/>
        <b>In Geofence:</b> ${region.inGeofence ? 'Yes' : 'No'}<br/>
        <b>Level:</b> ${region.geoLevel}${analysisHTML}`,
      geometry: polygonGeometry,
      fillColor: getRegionColor(region),
      isPolygon: !!polygonGeometry,
      fallbackPoint: polygonGeometry ? undefined : { lng: region.lng, lat: region.lat },
    });
  }).join('\n');

  const content = assembleKMLContent('Ranked Regions', regionPlacemarks, sites);
  downloadKML(content, 'Site Ranking Export', 'AI-ranked regions for site selection',
    exportFilename('ranking-export.kml', hasSites));
}

// Short DBF field name mapping (DBF max 10 chars per field name)
const SHP_FIELD_MAP: Partial<Record<keyof RegionDetails, string>> = {
  evStationCount:       'EV_STNS',
  airportCount:         'AIRPORTS',
  avTestingCount:       'AV_SITES',
  avTestingVehicles:    'AV_VEHS',
  population:           'POPULATION',
  populationDensity:    'POP_DENS',
  medianIncome:         'MED_INCOME',
  avgWeeklyWage:        'AVG_WAGE',
  publicTransitPct:     'TRNST_PCT',
  rideshareTrips:       'RIDE_TRIPS',
  ridesharePerCapita:   'RIDE_CAP',
  rideshareDensity:     'RIDE_DENS',
  federalFundingAmount: 'FED_FUND',
  stateFundingCount:    'ST_FUND_CT',
  gasPrice:             'GAS_PRICE',
  electricityPrice:     'ELEC_PRICE',
  snowdays:             'SNOWDAYS',
  temperature:          'TEMP',
  precipitation:        'PRECIP',
  hurricaneRisk:        'HURR_RISK',
  stormRisk:            'STORM_RISK',
  earthquakeRisk:       'EQ_RISK',
};

export async function exportToShapefile(
  regions: Region[],
  geoLevel?: GeoLevel,
  options: ExportOptions = {}
): Promise<void> {
  const { analysisData } = options;
  const polygonMap = buildPolygonMap(geoLevel, true);
  const geoLevelStr = geoLevel?.toLowerCase() ?? 'region';
  const visibleFields = geoLevel ? getVisibleFields(geoLevel) : [];

  const features = regions.map(region => {
    const rawGeom = polygonMap.get(region.id) ?? {
      type: 'Point' as const,
      coordinates: [region.lng, region.lat],
    };

    // Normalize Polygon → MultiPolygon so shp-write processes all
    // features in one pass (mixing types causes overwrite in the ZIP).
    const geom = rawGeom.type === 'Polygon'
      ? { type: 'MultiPolygon' as const, coordinates: [rawGeom.coordinates] }
      : rawGeom;

    const props: Record<string, string | number | null> = {
      REGION_ID: region.id,
      NAME: region.name.slice(0, 200),
      RANK: region.rank,
      SCORE: parseFloat(region.score.toFixed(4)),
      CUSTOMERS: region.customerCount,
      GEOFENCE: region.inGeofence ? 1 : 0,
    };

    if (analysisData && visibleFields.length > 0) {
      const details = analysisData.get(region.id);
      if (details) {
        for (const field of visibleFields) {
          const val = details[field];
          if (val != null) {
            const shortName = SHP_FIELD_MAP[field] ?? field.slice(0, 10).toUpperCase();
            props[shortName] = typeof val === 'number' ? parseFloat(val.toFixed(4)) : String(val);
          }
        }
      }
    }

    return { type: 'Feature' as const, geometry: geom, properties: props };
  });

  const shpName = `rankings_${geoLevelStr}`;
  const blob = await shpwrite.zip(
    { type: 'FeatureCollection', features } as any,
    {
      outputType: 'blob',
      compression: 'DEFLATE',
      types: { polygon: shpName },
    }
  ) as unknown as Blob;

  triggerDownload(URL.createObjectURL(blob), `rankings_${geoLevelStr}_shapefile.zip`);
}

/**
 * Export site pins as a polygon-buffer shapefile for LandVision.
 * Each pin becomes a 50 m-radius circle polygon so that LandVision's
 * polygon-only Shape Loader accepts it.
 */
export async function exportSitePinsToShapefile(
  sites: CompetitorSite[],
  siteCountyFilter?: Region[],
): Promise<void> {
  const resolved = resolveSitesForExport(sites, siteCountyFilter);
  if (!resolved || resolved.length === 0) {
    throw new Error('No site pins with valid coordinates in the selected area.');
  }

  const validSites = resolved.filter(s => s.lat != null && s.lng != null);
  if (validSites.length === 0) {
    throw new Error('No site pins with valid coordinates to export.');
  }

  const features = validSites
    .map(s => {
      const pt = point([s.lng!, s.lat!]);
      const buffered = buffer(pt, 0.05, { units: 'kilometers' });
      if (!buffered) return null;

      buffered.properties = {
        COMPANY:  (s.companyName || '').slice(0, 254),
        CATEGORY: s.category || '',
        STATUS:   (s.status || '').slice(0, 50),
        MSA:      (s.msa || '').slice(0, 100),
        ADDRESS:  (s.address || '').slice(0, 254),
        CITY:     (s.city || '').slice(0, 100),
        STATE:    (s.state || '').slice(0, 20),
        ZONING:   (s.zoning || '').slice(0, 50),
        STALLS:   s.totalStalls ?? 0,
        SEGMENT:  (s.volteraSegment || '').slice(0, 50),
        OPP_NAME: (s.opportunityName || '').slice(0, 254),
        UTILITY:  (s.utility || '').slice(0, 100),
        NOTES:    (s.notes || '').slice(0, 254),
      };

      return buffered;
    })
    .filter(Boolean);

  if (features.length === 0) {
    throw new Error('Buffer generation failed for all site pins.');
  }

  const blob = await shpwrite.zip(
    { type: 'FeatureCollection', features } as any,
    {
      outputType: 'blob',
      compression: 'DEFLATE',
      types: { polygon: 'site_pins' },
    }
  ) as unknown as Blob;

  triggerDownload(URL.createObjectURL(blob), 'site_pins_buffered.zip');
}

// ---------------------------------------------------------------------------
// Analysis helpers for export enrichment
// ---------------------------------------------------------------------------

function formatAnalysisValue(val: number): string {
  if (val >= 1000000) return `${(val / 1000000).toFixed(1)}M`;
  if (val >= 1000) return `${(val / 1000).toFixed(1)}K`;
  if (val < 1 && val > 0) return val.toFixed(3);
  return val.toLocaleString();
}

/** Renders analysis details as HTML for KML description balloons. */
function buildAnalysisHTML(details: RegionDetails | Partial<RegionDetails>, geoLevel: GeoLevel | string): string {
  const fields = getVisibleFields(geoLevel);
  const lines: string[] = [];
  for (const field of fields) {
    const val = details[field];
    if (val == null) continue;
    const label = FIELD_LABELS[field] || field;
    lines.push(`<b>${escapeXml(label)}:</b> ${formatAnalysisValue(val)}`);
  }
  if (lines.length === 0) return '';
  return `<br/><hr/><b>Region Analysis:</b><br/>${lines.join('<br/>')}`;
}

/** Builds aggregated analysis for merged/multi-region exports. */
function buildMergedAnalysis(
  regions: Region[],
  geoLevel: GeoLevel | undefined,
  analysisData: Map<string, RegionDetails> | undefined,
): Partial<RegionDetails> | null {
  if (!geoLevel || !analysisData || analysisData.size === 0) return null;
  const detailsList = regions.map(r => analysisData.get(r.id));
  return getVisibleAnalysis(aggregateDetails(detailsList), geoLevel);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function buildPolygonMap(geoLevel?: GeoLevel, includePolygons = true): Map<string, any> {
  const polygonMap = new Map<string, any>();
  if (!includePolygons || !geoLevel) return polygonMap;

  const polygonData = getPolygonsForLevel(geoLevel);
  if (!polygonData?.features) return polygonMap;

  for (const feature of polygonData.features) {
    const id = feature.properties?.id || feature.properties?.GEOID || feature.properties?.geoid;
    if (id) polygonMap.set(String(id), feature.geometry);
  }
  return polygonMap;
}

function computeRegionAggregates(regions: Region[]): RegionAggregates {
  return {
    regionCount: regions.length,
    regionIds: regions.map(r => r.id),
    regionNames: regions.map(r => r.name),
    avgScore: regions.reduce((sum, r) => sum + r.score, 0) / regions.length,
    totalCustomerCount: regions.reduce((sum, r) => sum + r.customerCount, 0),
  };
}

// ---------------------------------------------------------------------------
// GeoJSON download helper
// ---------------------------------------------------------------------------

function downloadGeoJSON(features: any[], filename: string): void {
  const geojson = { type: 'FeatureCollection', features };
  downloadFile(JSON.stringify(geojson, null, 2), filename, 'application/geo+json');
}

// ---------------------------------------------------------------------------
// KML helpers
// ---------------------------------------------------------------------------

interface KMLPlacemarkOptions {
  name: string;
  description: string;
  geometry: any;
  fillColor: string; // hex color from ColorScale (e.g. '#0F28C3')
  isPolygon: boolean;
  fallbackPoint?: { lng: number; lat: number };
}

function buildKMLPlacemark(opts: KMLPlacemarkOptions): string {
  const { name, description, geometry, fillColor, isPolygon, fallbackPoint } = opts;

  const kmlFill = hexToKMLColor(fillColor, 0x99); // semi-transparent fill
  const kmlSolid = hexToKMLColor(fillColor);       // fully opaque for icons/outlines

  let geometryKML: string;
  let styleKML: string;

  if (isPolygon && geometry) {
    geometryKML = geometryToKML(geometry);
    styleKML = `<Style>
        <PolyStyle>
          <color>${kmlFill}</color>
          <outline>1</outline>
        </PolyStyle>
        <LineStyle>
          <color>${kmlSolid}</color>
          <width>2</width>
        </LineStyle>
      </Style>`;
  } else if (fallbackPoint) {
    geometryKML = `<Point>
        <coordinates>${fallbackPoint.lng},${fallbackPoint.lat},0</coordinates>
      </Point>`;
    styleKML = `<Style>
        <IconStyle>
          <color>${kmlSolid}</color>
          <scale>1.2</scale>
        </IconStyle>
      </Style>`;
  } else {
    geometryKML = geometryToKML(geometry);
    styleKML = '';
  }

  return `
    <Placemark>
      <name>${name}</name>
      <description><![CDATA[${description}
      ]]></description>
      ${geometryKML}
      ${styleKML}
    </Placemark>`;
}

// ---------------------------------------------------------------------------
// Site pin helpers (Market Intelligence pins in KML/GeoJSON)
// ---------------------------------------------------------------------------

/** Builds GeoJSON Point features from site pins, filtering out entries without coordinates. */
function buildSiteGeoJSONFeatures(sites: CompetitorSite[] | undefined): any[] {
  if (!sites) return [];
  return sites
    .filter(s => s.lat != null && s.lng != null)
    .map(s => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [s.lng!, s.lat!] },
      properties: {
        featureType: 'site_pin',
        companyName: s.companyName,
        category: s.category,
        status: s.status,
        msa: s.msa,
        address: s.address,
        city: s.city,
        state: s.state,
        zoning: s.zoning,
        totalStalls: s.totalStalls,
        segment: s.volteraSegment,
        opportunityName: s.opportunityName,
        utility: s.utility,
        notes: s.notes,
      },
    }));
}

/** Converts #RRGGBB hex to KML's AABBGGRR color format. */
function hexToKMLColor(hex: string, alpha = 0xff): string {
  const a = alpha.toString(16).padStart(2, '0');
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return `${a}808080`;
  const r = hex.slice(1, 3);
  const g = hex.slice(3, 5);
  const b = hex.slice(5, 7);
  return `${a}${b}${g}${r}`;
}

/** Wraps KML placemarks in a toggleable Folder element. */
function wrapInKMLFolder(name: string, placemarks: string, open = true): string {
  return `<Folder>
      <name>${escapeXml(name)}</name>
      <open>${open ? 1 : 0}</open>
      ${placemarks}
    </Folder>`;
}

/** Builds a KML Point Placemark for a competitor/customer site pin. */
function buildSitePinPlacemark(site: CompetitorSite): string {
  if (site.lat == null || site.lng == null) return '';

  const name = escapeXml(site.opportunityName || site.companyName);
  const color = hexToKMLColor(getCategoryColor(site.category));
  const location = [site.city, site.state].filter(Boolean).map(escapeXml).join(', ');

  const descParts: string[] = [
    `<b>Company:</b> ${escapeXml(site.companyName)}`,
    `<b>Category:</b> ${escapeXml(site.category)}`,
    `<b>Status:</b> ${escapeXml(site.status || 'N/A')}`,
    `<b>MSA:</b> ${escapeXml(site.msa || 'N/A')}`,
  ];
  if (location) descParts.push(`<b>Location:</b> ${location}`);
  if (site.address) descParts.push(`<b>Address:</b> ${escapeXml(site.address)}`);
  if (site.zoning) descParts.push(`<b>Zoning:</b> ${escapeXml(site.zoning)}`);
  if (site.totalStalls != null) descParts.push(`<b>Total Stalls:</b> ${site.totalStalls}`);
  if (site.volteraSegment) descParts.push(`<b>Segment:</b> ${escapeXml(site.volteraSegment)}`);
  if (site.utility) descParts.push(`<b>Utility:</b> ${escapeXml(site.utility)}`);
  if (site.notes) descParts.push(`<b>Notes:</b> ${escapeXml(site.notes)}`);

  return `
    <Placemark>
      <name>${name}</name>
      <description><![CDATA[${descParts.join('<br/>')}
      ]]></description>
      <Point>
        <coordinates>${site.lng},${site.lat},0</coordinates>
      </Point>
      <Style>
        <IconStyle>
          <color>${color}</color>
          <scale>0.6</scale>
          <Icon>
            <href>http://maps.google.com/mapfiles/kml/paddle/wht-circle.png</href>
          </Icon>
        </IconStyle>
        <LabelStyle>
          <scale>0</scale>
        </LabelStyle>
      </Style>
    </Placemark>`;
}

// ---------------------------------------------------------------------------
// Geographic containment — scope site pins to exported regions
// ---------------------------------------------------------------------------

/** Ray-casting point-in-polygon test for a single ring (GeoJSON [lng, lat] order). */
function isPointInRing(lng: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const lngI = ring[i][0], latI = ring[i][1];
    const lngJ = ring[j][0], latJ = ring[j][1];
    if ((latI > lat) !== (latJ > lat) && lng < (lngJ - lngI) * (lat - latI) / (latJ - latI) + lngI) {
      inside = !inside;
    }
  }
  return inside;
}

/** Checks if a point falls within a Polygon or MultiPolygon geometry, respecting interior holes. */
function isPointInGeometry(lng: number, lat: number, geometry: any): boolean {
  if (!geometry) return false;
  if (geometry.type === 'Polygon') {
    if (!isPointInRing(lng, lat, geometry.coordinates[0])) return false;
    for (let h = 1; h < geometry.coordinates.length; h++) {
      if (isPointInRing(lng, lat, geometry.coordinates[h])) return false;
    }
    return true;
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.some((poly: number[][][]) => {
      if (!isPointInRing(lng, lat, poly[0])) return false;
      for (let h = 1; h < poly.length; h++) {
        if (isPointInRing(lng, lat, poly[h])) return false;
      }
      return true;
    });
  }
  return false;
}

/** Filters sites to only those whose coordinates fall within any of the given region polygons. */
function filterSitesToRegions(sites: CompetitorSite[], regions: Region[], polygonMap: Map<string, any>): CompetitorSite[] {
  const geometries = regions.map(r => polygonMap.get(r.id)).filter(Boolean);
  if (geometries.length === 0) return sites;
  return sites.filter(s => {
    if (s.lat == null || s.lng == null) return false;
    return geometries.some(geom => isPointInGeometry(s.lng!, s.lat!, geom));
  });
}

/** Builds KML placemarks string from site pins, skipping entries without valid coordinates. */
function buildSitePinsKML(sites: CompetitorSite[]): string {
  return sites
    .filter(s => s.lat != null && s.lng != null)
    .map(buildSitePinPlacemark)
    .join('\n');
}

function downloadKML(placemarks: string, documentName: string, documentDescription: string, filename: string): void {
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escapeXml(documentName)}</name>
    <description>${escapeXml(documentDescription)}</description>
    ${placemarks}
  </Document>
</kml>`;

  downloadFile(kml, filename, 'application/vnd.google-earth.kml+xml');
}

function coordinatesToKML(coords: number[][]): string {
  return coords.map(c => `${c[0]},${c[1]},0`).join(' ');
}

function polygonRingToKML(ring: number[][], boundary: 'outer' | 'inner'): string {
  const tag = boundary === 'outer' ? 'outerBoundaryIs' : 'innerBoundaryIs';
  return `<${tag}><LinearRing><coordinates>${coordinatesToKML(ring)}</coordinates></LinearRing></${tag}>`;
}

function singlePolygonToKML(coordinates: number[][][]): string {
  const outer = polygonRingToKML(coordinates[0], 'outer');
  const holes = coordinates.slice(1).map(ring => polygonRingToKML(ring, 'inner')).join('');
  return `<Polygon>${outer}${holes}</Polygon>`;
}

function geometryToKML(geometry: any): string {
  if (!geometry) return '';

  if (geometry.type === 'Polygon') {
    return singlePolygonToKML(geometry.coordinates);
  }

  if (geometry.type === 'MultiPolygon') {
    const polygons = geometry.coordinates.map((poly: number[][][]) => singlePolygonToKML(poly));
    return `<MultiGeometry>${polygons.join('')}</MultiGeometry>`;
  }

  if (geometry.coordinates && geometry.coordinates.length >= 2) {
    return `<Point><coordinates>${geometry.coordinates[0]},${geometry.coordinates[1]},0</coordinates></Point>`;
  }

  return '';
}

// ---------------------------------------------------------------------------
// Polygon merging (union-based)
// ---------------------------------------------------------------------------

/** Small buffer in km applied before union to close micro-gaps between adjacent tracts. */
const GAP_FILL_BUFFER_KM = 0.05; // ~50 meters

/**
 * Unions all selected region polygons into one shape.
 * Applies a tiny buffer before union to fill micro-gaps between adjacent tracts,
 * then shrinks back to restore original boundaries.
 * Disconnected groups naturally become separate parts of a MultiPolygon.
 */
function mergePolygonsByUnion(
  regions: Region[],
  polygonMap: Map<string, any>
): Polygon | MultiPolygon | null {
  const features: Feature<Polygon | MultiPolygon, GeoJsonProperties>[] = [];

  for (const r of regions) {
    const geom = polygonMap.get(r.id);
    if (!geom) continue;

    try {
      if (geom.type === 'Polygon') {
        features.push(polygon(geom.coordinates) as Feature<Polygon, GeoJsonProperties>);
      } else if (geom.type === 'MultiPolygon') {
        features.push(multiPolygon(geom.coordinates) as Feature<MultiPolygon, GeoJsonProperties>);
      }
    } catch (e) {
      console.warn('Skipping invalid polygon for region', r.id, e);
    }
  }

  if (features.length === 0) return null;
  if (features.length === 1) return features[0].geometry;

  try {
    // Buffer each polygon slightly to close micro-gaps
    const buffered = features.map(f => {
      const b = buffer(f, GAP_FILL_BUFFER_KM, { units: 'kilometers' });
      return b || f;
    });

    // Divide-and-conquer union: pair up polygons each round so the accumulated
    // geometry stays small as long as possible (O(n log n) vs O(n²) for the
    // naive sequential approach — critical for large selections like 1908 tracts).
    let layer = buffered as Feature<Polygon | MultiPolygon, GeoJsonProperties>[];
    while (layer.length > 1) {
      const next: Feature<Polygon | MultiPolygon, GeoJsonProperties>[] = [];
      for (let i = 0; i < layer.length; i += 2) {
        if (i + 1 >= layer.length) {
          next.push(layer[i]);
          continue;
        }
        try {
          const result = union(featureCollection([layer[i], layer[i + 1]]));
          next.push(result ?? layer[i]);
        } catch (e) {
          console.warn('Union failed at pair', i, e);
          next.push(layer[i]);
        }
      }
      layer = next;
    }
    let merged = layer[0];

    // Remove interior holes BEFORE shrinking — at this point the buffered union
    // is maximally connected so enclosed gaps are true interior rings that can
    // be stripped.  If we shrink first, thin connections may break, turning the
    // gap into empty space between separate MultiPolygon parts where
    // removeInteriorHoles can no longer reach it.
    const holesRemoved: Feature<Polygon | MultiPolygon, GeoJsonProperties> = {
      ...merged,
      geometry: removeInteriorHoles(merged.geometry as Polygon | MultiPolygon),
    };

    // Shrink back by the same buffer to restore original boundaries
    const shrunk = buffer(holesRemoved, -GAP_FILL_BUFFER_KM, { units: 'kilometers' });
    const finalGeom = shrunk ? shrunk.geometry as Polygon | MultiPolygon : holesRemoved.geometry;

    // Safety net: remove any new interior holes the shrink-back may have created
    return removeInteriorHoles(finalGeom);
  } catch (e) {
    console.warn('Polygon union failed, using MultiPolygon fallback', e);
  }

  // Fallback: combine all polygons into a MultiPolygon without union
  const allCoordinates: number[][][][] = [];
  for (const f of features) {
    if (f.geometry.type === 'Polygon') {
      allCoordinates.push(f.geometry.coordinates);
    } else if (f.geometry.type === 'MultiPolygon') {
      allCoordinates.push(...f.geometry.coordinates);
    }
  }

  return { type: 'MultiPolygon', coordinates: allCoordinates };
}

/**
 * Strips interior rings (holes) from polygons so that enclosed gaps
 * (unselected tracts surrounded by selected ones) get filled in.
 */
function removeInteriorHoles(geom: Polygon | MultiPolygon): Polygon | MultiPolygon {
  if (geom.type === 'Polygon') {
    // Keep only the exterior ring (index 0), drop all interior rings
    return { type: 'Polygon', coordinates: [geom.coordinates[0]] };
  }

  if (geom.type === 'MultiPolygon') {
    return {
      type: 'MultiPolygon',
      coordinates: geom.coordinates.map(poly => [poly[0]]),
    };
  }

  return geom;
}

// ---------------------------------------------------------------------------
// General utilities
// ---------------------------------------------------------------------------

function triggerDownload(url: string, filename: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  triggerDownload(URL.createObjectURL(blob), filename);
}

function escapeXml(unsafe: string | null | undefined): string {
  if (unsafe == null) return '';
  return String(unsafe).replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

