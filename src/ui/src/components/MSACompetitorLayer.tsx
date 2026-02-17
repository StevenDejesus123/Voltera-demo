import { useMemo, useState, useEffect } from 'react';
import { Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import type { Region } from '../types';
import { getMSACompetitorSummaries, getCategoryColor, type MSACompetitorSummary, loadCompetitorData } from '../dataLoader/competitorLoader';

interface MSACompetitorLayerProps {
  regions: Region[];
  visible: boolean;
}

/**
 * Company logo configuration.
 * Maps company names to logo file paths in /logos/ folder.
 */
const COMPANY_LOGOS: Record<string, string> = {
  'AlphaStruxure': '/logos/alphastruxure.png',
  'Alto': '/logos/alto.png',
  'Cruise': '/logos/cruise.png',
  'Electrify America & 4Gen Logistics': '/logos/electrify-america.png',
  'EVgo': '/logos/evgo.png',
  'Forum Mobility': '/logos/forum-mobility.png',
  'Greenlane': '/logos/greenlane.png',
  'Moove': '/logos/moove.png',
  'Motional': '/logos/motional.png',
  'Prologis': '/logos/prologis.png',
  'Revel': '/logos/revel.png',
  'Terawatt': '/logos/terawatt.png',
  'Uber': '/logos/uber.png',
  'WattEV': '/logos/wattev.png',
  'WattEv': '/logos/wattev.png',
  'Waymo': '/logos/waymo.png',
  'Zeem': '/logos/zeem.png',
  'Zoox': '/logos/zoox.png',
};

/** Get initials from company name (first 2 letters or first letter of each word) */
function getCompanyInitials(name: string): string {
  const words = name.trim().split(/\s+/);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return name.substring(0, 2).toUpperCase();
}

/** Get a consistent color for a company based on its name */
function getCompanyColor(name: string): string {
  const colors = [
    '#3B82F6', // blue
    '#10B981', // green
    '#F59E0B', // amber
    '#EF4444', // red
    '#8B5CF6', // purple
    '#EC4899', // pink
    '#06B6D4', // cyan
    '#F97316', // orange
    '#6366F1', // indigo
    '#14B8A6', // teal
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

/** Creates a custom icon with company logos for MSA markers */
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

  // Group sites by company for popup
  const sitesByCompany = new Map<string, number>();
  for (const site of summary.sites) {
    sitesByCompany.set(site.companyName, (sitesByCompany.get(site.companyName) ?? 0) + 1);
  }

  // Sort by site count descending
  const companiesSorted = [...sitesByCompany.entries()].sort((a, b) => b[1] - a[1]);

  return (
    <Marker position={[region.lat, region.lng]} icon={icon}>
      <Popup closeButton={true} maxWidth={350} className="msa-competitor-popup">
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

export function MSACompetitorLayer({ regions, visible }: MSACompetitorLayerProps) {
  // State to trigger re-render when competitor data loads
  const [dataLoaded, setDataLoaded] = useState(false);

  useEffect(() => {
    // Trigger load if not already loaded
    loadCompetitorData();

    // Listen for data load event
    const handleLoaded = () => setDataLoaded(true);
    window.addEventListener('competitor:loaded', handleLoaded);

    return () => window.removeEventListener('competitor:loaded', handleLoaded);
  }, []);

  const summaries = useMemo(() => getMSACompetitorSummaries(), [dataLoaded]);

  // Match MSA regions to competitor summaries by name
  const matchedMSAs = useMemo(() => {
    const matches: { region: Region; summary: MSACompetitorSummary }[] = [];

    for (const region of regions) {
      // Try to match by MSA name (normalize for comparison)
      const regionNameNorm = region.name.toLowerCase().trim();

      for (const [msaName, summary] of summaries) {
        const msaNameNorm = msaName.toLowerCase().trim();

        // Check for partial match (MSA names in competitor data might be abbreviated)
        if (
          regionNameNorm.includes(msaNameNorm) ||
          msaNameNorm.includes(regionNameNorm) ||
          regionNameNorm === msaNameNorm
        ) {
          matches.push({ region, summary });
          break;
        }
      }
    }

    return matches;
  }, [regions, summaries]);

  if (!visible) return null;

  return (
    <>
      {matchedMSAs.map(({ region, summary }) => (
        <MSACompetitorMarker key={region.id} region={region} summary={summary} />
      ))}
    </>
  );
}
