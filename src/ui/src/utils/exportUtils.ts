import { Region, GeoLevel, RegionDetails } from '../types';
import { getPolygonsForLevel } from '../dataLoader/geoPolygons';
import union from '@turf/union';
import buffer from '@turf/buffer';
import { featureCollection, polygon, multiPolygon } from '@turf/helpers';
import type { Feature, Polygon, MultiPolygon, GeoJsonProperties } from 'geojson';
import { getVisibleFields, FIELD_LABELS, aggregateDetails, getVisibleAnalysis } from './analysisUtils';

export interface ExportOptions {
  includePolygons?: boolean;
  useSmartMerge?: boolean;
  analysisData?: Map<string, RegionDetails>;
}

interface RegionAggregates {
  regionCount: number;
  regionIds: string[];
  regionNames: string[];
  avgScore: number;
  totalCustomerCount: number;
}

// ---------------------------------------------------------------------------
// Public export functions
// ---------------------------------------------------------------------------

export function exportToCSV(regions: Region[], options: ExportOptions = {}): void {
  const { analysisData } = options;
  const baseHeaders = ['Rank', 'Region ID', 'Region Name', 'Score', 'Customer Count', 'In Geofence', 'Geo Level'];

  // Determine analysis columns based on geo level
  const geoLevel = regions.length > 0 ? regions[0].geoLevel : undefined;
  const analysisFields = geoLevel && analysisData && analysisData.size > 0
    ? getVisibleFields(geoLevel)
    : [];
  const analysisHeaders = analysisFields.map(f => FIELD_LABELS[f] || f);

  const headers = [...baseHeaders, ...analysisHeaders];

  const rows = regions.map(region => {
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
    return [...base, ...analysis];
  });

  // Add summary row for multi-region exports
  if (regions.length > 1 && analysisFields.length > 0 && analysisData && analysisData.size > 0) {
    const detailsList = regions.map(r => analysisData.get(r.id));
    const aggregated = aggregateDetails(detailsList);
    const avgScore = regions.reduce((s, r) => s + r.score, 0) / regions.length;
    const totalCustomers = regions.reduce((s, r) => s + r.customerCount, 0);
    const summaryBase = [
      'SUMMARY',
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
    rows.push([...summaryBase, ...summaryAnalysis] as any);
  }

  const csvContent = [
    headers.join(','),
    ...rows.map(row => row.join(','))
  ].join('\n');

  downloadFile(csvContent, 'ranking-export.csv', 'text/csv');
}

export function exportToGeoJSON(
  regions: Region[],
  geoLevel?: GeoLevel,
  options: ExportOptions = {}
): void {
  const { useSmartMerge = false, analysisData } = options;
  const polygonMap = buildPolygonMap(geoLevel, options.includePolygons);

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
      }];

      downloadGeoJSON(features, 'ranking-export-merged.geojson');
      return;
    }
  }

  // Individual features with polygon geometry
  const features = regions.map(region => {
    const analysis = geoLevel && analysisData
      ? getVisibleAnalysis(analysisData.get(region.id), geoLevel)
      : null;
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
        customerCount: region.customerCount,
        inGeofence: region.inGeofence,
        geoLevel: region.geoLevel,
        factors: region.factors,
        ...(analysis && { analysis }),
      },
    };
  });

  downloadGeoJSON(features, 'ranking-export.geojson');
}

export function exportToKML(
  regions: Region[],
  geoLevel?: GeoLevel,
  options: ExportOptions = {}
): void {
  const { useSmartMerge = false, analysisData } = options;
  const polygonMap = buildPolygonMap(geoLevel, options.includePolygons);

  // Smart merge: union all selected polygons into one shape
  if (useSmartMerge && regions.length > 1 && polygonMap.size > 0) {
    const merged = mergePolygonsByUnion(regions, polygonMap);
    if (merged) {
      const aggregates = computeRegionAggregates(regions);
      const regionList = regions.map(r => `- ${r.name} (#${r.rank})`).join('<br/>');
      const mergedAnalysis = buildMergedAnalysis(regions, geoLevel, analysisData);
      const analysisHTML = mergedAnalysis && geoLevel
        ? buildAnalysisHTML(mergedAnalysis, geoLevel)
        : '';
      const placemark = buildKMLPlacemark({
        name: `Merged ${geoLevel || 'Region'}s (${regions.length} regions)`,
        description: `
        <b>Type:</b> Merged Boundary<br/>
        <b>Regions:</b> ${regions.length}<br/>
        <b>Avg Score:</b> ${(aggregates.avgScore * 100).toFixed(1)}%<br/>
        <b>Total Customers:</b> ${aggregates.totalCustomerCount.toLocaleString()}<br/>
        <hr/>
        <b>Included:</b><br/>
        ${regionList}${analysisHTML}`,
        geometry: merged,
        score: aggregates.avgScore,
        isPolygon: true,
      });

      downloadKML(placemark, 'Site Ranking Export - Merged', `${regions.length} regions merged`, 'ranking-export-merged.kml');
      return;
    }
  }

  // Individual placemarks with polygon geometry
  const placemarks = regions.map(region => {
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
      score: region.score,
      isPolygon: !!polygonGeometry,
      fallbackPoint: polygonGeometry ? undefined : { lng: region.lng, lat: region.lat },
    });
  }).join('\n');

  downloadKML(placemarks, 'Site Ranking Export', 'AI-ranked regions for site selection', 'ranking-export.kml');
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
  score: number;
  isPolygon: boolean;
  fallbackPoint?: { lng: number; lat: number };
}

function buildKMLPlacemark(opts: KMLPlacemarkOptions): string {
  const { name, description, geometry, score, isPolygon, fallbackPoint } = opts;

  let geometryKML: string;
  let styleKML: string;

  if (isPolygon && geometry) {
    geometryKML = geometryToKML(geometry);
    styleKML = `<Style>
        <PolyStyle>
          <color>${getKMLPolygonColor(score)}</color>
          <outline>1</outline>
        </PolyStyle>
        <LineStyle>
          <color>ff000000</color>
          <width>2</width>
        </LineStyle>
      </Style>`;
  } else if (fallbackPoint) {
    geometryKML = `<Point>
        <coordinates>${fallbackPoint.lng},${fallbackPoint.lat},0</coordinates>
      </Point>`;
    styleKML = `<Style>
        <IconStyle>
          <color>${getKMLColor(score)}</color>
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

function downloadKML(placemarks: string, documentName: string, documentDescription: string, filename: string): void {
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${documentName}</name>
    <description>${documentDescription}</description>
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

    // Iteratively union all buffered polygons
    let merged: Feature<Polygon | MultiPolygon, GeoJsonProperties> = buffered[0] as Feature<Polygon | MultiPolygon, GeoJsonProperties>;
    for (let i = 1; i < buffered.length; i++) {
      try {
        const result = union(featureCollection([merged, buffered[i] as Feature<Polygon | MultiPolygon, GeoJsonProperties>]));
        if (result) merged = result;
      } catch (e) {
        console.warn('Union failed for polygon', i, e);
      }
    }

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

function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&'"]/g, (c) => {
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

function getKMLColor(score: number): string {
  if (score >= 0.9) return 'ff00ff00';
  if (score >= 0.8) return 'ffff0000';
  if (score >= 0.7) return 'ff00a5ff';
  return 'ff0000ff';
}

function getKMLPolygonColor(score: number): string {
  if (score >= 0.9) return '8000ff00';
  if (score >= 0.8) return '80ff0000';
  if (score >= 0.7) return '8000a5ff';
  return '800000ff';
}
