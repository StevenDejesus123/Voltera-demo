import { CircleMarker, Popup, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import type { CompetitorSite } from '../types';
import { getCategoryColor } from '../dataLoader/competitorLoader';
import { CompetitorDetailCard } from './CompetitorDetailCard';

interface CompetitorMapLayerProps {
  sites: CompetitorSite[];
  visible: boolean;
}

function SiteTooltip({ site }: { site: CompetitorSite }) {
  const location = [site.city, site.state].filter(Boolean).join(', ');
  return (
    <div className="text-[11px] leading-tight">
      <p className="font-semibold">{site.opportunityName || site.companyName}</p>
      {site.opportunityName && <p className="text-gray-500">{site.companyName}</p>}
      <p className="text-gray-500">{site.category}{site.status ? ` · ${site.status}` : ''}</p>
      {location && <p className="text-gray-400">{location}</p>}
    </div>
  );
}

function SitePopup({ site }: { site: CompetitorSite }) {
  const map = useMap();
  return (
    <Popup closeButton={false} autoPan={false} className="competitor-popup" maxWidth={280} minWidth={260}>
      <CompetitorDetailCard site={site} onClose={() => map.closePopup()} />
    </Popup>
  );
}

/** Renders a single site as a colored circle pin. */
function DotMarker({ site }: { site: CompetitorSite }) {
  const color = getCategoryColor(site.category);
  return (
    <CircleMarker
      center={[site.lat!, site.lng!]}
      radius={7}
      pane="markerPane"
      pathOptions={{ fillColor: color, fillOpacity: 0.9, color: '#ffffff', weight: 2, opacity: 1 }}
      eventHandlers={{
        click: (e) => L.DomEvent.stopPropagation(e),
        mouseover: (e) => e.target.setStyle({ radius: 10, weight: 3 }),
        mouseout: (e) => e.target.setStyle({ radius: 7, weight: 2 }),
      }}
    >
      <Tooltip direction="top" offset={[0, -8]} className="competitor-tooltip">
        <SiteTooltip site={site} />
      </Tooltip>
      <SitePopup site={site} />
    </CircleMarker>
  );
}

export function CompetitorMapLayer({ sites, visible }: CompetitorMapLayerProps) {
  if (!visible) return null;

  const sitesWithCoords = sites.filter(s => s.lat !== null && s.lng !== null);

  return (
    <>
      {sitesWithCoords.map(site => (
        <DotMarker key={site.id} site={site} />
      ))}
    </>
  );
}
