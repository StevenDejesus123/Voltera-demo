import { useMemo } from 'react';
import { Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import type { Region, CompetitorSite } from '../types';
import { getCategoryColor, type MSACompetitorSummary, COMPANY_LOGOS, getCompanyInitials, getCompanyColor } from '../dataLoader/competitorLoader';
import { msaNamesMatch, isNearCoordinates } from '../utils/msaMatch';

interface MSACompetitorLayerProps {
  regions: Region[];
  sites: CompetitorSite[];
  visible: boolean;
}

type RegionMatch = { region: Region; summary: MSACompetitorSummary };

/** Build an MSACompetitorSummary from a list of sites, companies sorted by site count descending (TBD always last). */
function buildSummary(msaName: string, sites: CompetitorSite[]): MSACompetitorSummary {
  const counts = new Map<string, number>();
  for (const s of sites) counts.set(s.companyName, (counts.get(s.companyName) ?? 0) + 1);
  const companies = [...counts.entries()]
    .sort((a, b) => {
      // TBD always last
      if (a[0] === 'TBD') return 1;
      if (b[0] === 'TBD') return -1;
      return b[1] - a[1];
    })
    .map(([name]) => name);

  return {
    msa: msaName,
    categories: [...new Set(sites.map(s => s.category))],
    companies,
    siteCount: sites.length,
    sites,
  };
}

/** Merge additional sites into an existing match's summary, re-sorting companies by site count. */
function mergeSitesInto(match: RegionMatch, extraSites: CompetitorSite[]): void {
  const allSites = [...match.summary.sites, ...extraSites];
  match.summary = buildSummary(match.summary.msa, allSites);
}

/** Create a synthetic Region for sites that don't match any ranked region. */
function createSyntheticRegion(msaName: string, sites: CompetitorSite[]): Region | null {
  const withCoords = sites.filter(s => s.lat != null && s.lng != null);
  if (withCoords.length === 0) return null;
  const avgLat = withCoords.reduce((sum, s) => sum + s.lat!, 0) / withCoords.length;
  const avgLng = withCoords.reduce((sum, s) => sum + s.lng!, 0) / withCoords.length;
  return {
    id: `competitor-msa-${msaName}`,
    name: msaName,
    geoLevel: 'MSA' as const,
    rank: 0,
    score: 0,
    customerCount: 0,
    inGeofence: false,
    lat: avgLat,
    lng: avgLng,
    factors: [],
  };
}

/** Check if a site belongs to a region by MSA name or coordinate proximity. */
function siteBelongsToRegion(site: CompetitorSite, region: Region): boolean {
  if (site.msa && msaNamesMatch(site.msa, region.name)) return true;
  if (!site.msa && site.lat != null && site.lng != null) {
    return isNearCoordinates(site.lat, site.lng, region.lat, region.lng);
  }
  return false;
}

/** Creates a custom icon with company logos for MSA markers. */
function createMSALogoIcon(summary: MSACompetitorSummary): L.DivIcon {
  // Get unique companies (limit to 5 for display)
  const companies = summary.companies.slice(0, 5);
  const hasMore = summary.companies.length > 5;

  const logoElements = companies
    .map(company => {
      const logoUrl = COMPANY_LOGOS[company];
      const color = getCompanyColor(company);
      const initials = getCompanyInitials(company);

      if (logoUrl) {
        // Use actual logo image
        return `
          <div style="
            width: 28px;
            height: 28px;
            border-radius: 50%;
            overflow: hidden;
            border: 2px solid white;
            box-shadow: 0 1px 3px rgba(0,0,0,0.2);
            background: white;
            flex-shrink: 0;
          " title="${company}">
            <img src="${logoUrl}" alt="${company}" style="width:100%;height:100%;object-fit:contain;" />
          </div>
        `;
      } else {
        // Fallback to colored circle with initials
        return `
          <div style="
            width: 28px;
            height: 28px;
            border-radius: 50%;
            background: ${color};
            border: 2px solid white;
            box-shadow: 0 1px 3px rgba(0,0,0,0.2);
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-size: 10px;
            font-weight: 600;
            flex-shrink: 0;
          " title="${company}">
            ${initials}
          </div>
        `;
      }
    })
    .join('');

  const moreIndicator = hasMore
    ? `<div style="
        width: 28px;
        height: 28px;
        border-radius: 50%;
        background: #6B7280;
        border: 2px solid white;
        box-shadow: 0 1px 3px rgba(0,0,0,0.2);
        display: flex;
        align-items: center;
        justify-content: center;
        color: white;
        font-size: 10px;
        font-weight: 600;
        flex-shrink: 0;
      ">+${summary.companies.length - 5}</div>`
    : '';

  const width = Math.min(companies.length + (hasMore ? 1 : 0), 6) * 24 + 16;

  return L.divIcon({
    className: 'msa-competitor-logo-marker',
    html: `
      <div style="
        display: flex;
        gap: -8px;
        padding: 6px 10px;
        background: white;
        border-radius: 20px;
        box-shadow: 0 3px 10px rgba(0,0,0,0.25);
        border: 1px solid #e5e7eb;
        align-items: center;
        cursor: pointer;
      ">
        <div style="display:flex; margin-left:-4px;">
          ${logoElements}
          ${moreIndicator}
        </div>
      </div>
    `,
    iconSize: [width, 44],
    iconAnchor: [width / 2, 22],
    popupAnchor: [0, -22],
  });
}

function MSACompetitorMarker({ region, summary }: { region: Region; summary: MSACompetitorSummary }) {
  const icon = useMemo(() => createMSALogoIcon(summary), [summary]);

  if (!region.lat || !region.lng) return null;

  // Group sites by company for popup, using the same order as the logo bubble (sorted by site count, TBD last)
  const sitesByCompany = new Map<string, number>();
  for (const site of summary.sites) {
    sitesByCompany.set(site.companyName, (sitesByCompany.get(site.companyName) ?? 0) + 1);
  }
  const companiesSorted = summary.companies
    .filter(c => sitesByCompany.has(c))
    .map(c => [c, sitesByCompany.get(c)!] as [string, number]);

  return (
    <Marker position={[region.lat, region.lng]} icon={icon}>
      <Popup closeButton={true} maxWidth={350} autoPan={false} className="msa-competitor-popup">
        <div style={{ minWidth: 220 }}>
          <h3 style={{ margin: '0 0 8px 0', fontSize: 14, fontWeight: 600, color: '#1f2937' }}>
            {region.name}
          </h3>
          <p style={{ margin: '0 0 12px 0', fontSize: 12, color: '#6b7280' }}>
            {summary.siteCount} site{summary.siteCount !== 1 ? 's' : ''} from {summary.companies.length} compan{summary.companies.length !== 1 ? 'ies' : 'y'}
          </p>

          {/* Companies list with logos/initials */}
          <div style={{ maxHeight: 200, overflowY: 'auto' }}>
            {companiesSorted.map(([company, count]) => {
              const logoUrl = COMPANY_LOGOS[company];
              const color = getCompanyColor(company);
              const initials = getCompanyInitials(company);
              const category = summary.sites.find(s => s.companyName === company)?.category ?? 'Unknown';

              return (
                <div
                  key={company}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '6px 0',
                    borderBottom: '1px solid #f3f4f6',
                  }}
                >
                  {logoUrl ? (
                    <div style={{
                      width: 32,
                      height: 32,
                      borderRadius: '50%',
                      overflow: 'hidden',
                      border: '2px solid #e5e7eb',
                      background: 'white',
                      flexShrink: 0,
                    }}>
                      <img src={logoUrl} alt={company} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                    </div>
                  ) : (
                    <div style={{
                      width: 32,
                      height: 32,
                      borderRadius: '50%',
                      background: color,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: 'white',
                      fontSize: 11,
                      fontWeight: 600,
                      flexShrink: 0,
                    }}>
                      {initials}
                    </div>
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 500, color: '#1f2937', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {company}
                    </div>
                    <div style={{ fontSize: 10, color: '#6b7280' }}>
                      <span style={{
                        display: 'inline-block',
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        background: getCategoryColor(category),
                        marginRight: 4,
                      }} />
                      {category} · {count} site{count !== 1 ? 's' : ''}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </Popup>
    </Marker>
  );
}

export function MSACompetitorLayer({ regions, sites, visible }: MSACompetitorLayerProps) {
  // Build MSA summaries from the same sites array that County/Tract use.
  //
  // Pass 1: Match sites to ranked regions by MSA name or coordinate proximity.
  //   Sites without coords can still match by MSA name (the cluster uses the
  //   region's centroid, not the site's coordinates).
  //
  // Pass 2: Group remaining unmatched sites by MSA name. If the MSA name
  //   fuzzy-matches an already-matched region, merge into it. Otherwise create
  //   a synthetic region (requires at least one site with coords for centroid).
  const matchedMSAs = useMemo(() => {
    if (sites.length === 0) return [];

    const matches: RegionMatch[] = [];
    const assignedSiteIds = new Set<string>();

    // Pass 1: assign sites to ranked regions
    for (const region of regions) {
      if (!region.lat || !region.lng) continue;

      const regionSites = sites.filter(site => {
        if (assignedSiteIds.has(site.id)) return false;
        return siteBelongsToRegion(site, region);
      });

      for (const s of regionSites) assignedSiteIds.add(s.id);
      if (regionSites.length === 0) continue;

      matches.push({ region, summary: buildSummary(region.name, regionSites) });
    }

    // Pass 2: handle unmatched sites with MSA info
    const unmatchedByMSA = new Map<string, CompetitorSite[]>();
    for (const site of sites) {
      if (assignedSiteIds.has(site.id) || !site.msa) continue;
      const arr = unmatchedByMSA.get(site.msa) ?? [];
      arr.push(site);
      unmatchedByMSA.set(site.msa, arr);
    }

    for (const [msaName, msaSites] of unmatchedByMSA) {
      const existingMatch = matches.find(m => msaNamesMatch(m.region.name, msaName));

      if (existingMatch) {
        mergeSitesInto(existingMatch, msaSites);
        continue;
      }

      const syntheticRegion = createSyntheticRegion(msaName, msaSites);
      if (!syntheticRegion) continue;
      matches.push({ region: syntheticRegion, summary: buildSummary(msaName, msaSites) });
    }

    return matches;
  }, [sites, regions]);

  if (!visible) return null;

  return (
    <>
      {matchedMSAs.map(({ region, summary }) => (
        <MSACompetitorMarker key={region.id} region={region} summary={summary} />
      ))}
    </>
  );
}
