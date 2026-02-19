import { CircleMarker, Popup, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import type { CompetitorSite } from '../types';
import { getCategoryColor } from '../dataLoader/competitorLoader';
import { CompetitorDetailCard } from './CompetitorDetailCard';

interface CompetitorMapLayerProps {
  sites: CompetitorSite[];
  visible: boolean;
}

function CompetitorMarker({ site }: { site: CompetitorSite }) {
  const map = useMap();

  if (site.lat === null || site.lng === null) return null;

  const color = getCategoryColor(site.category);
  const location = [site.city, site.state].filter(Boolean).join(', ');

  return (
    <CircleMarker
      center={[site.lat, site.lng]}
      radius={7}
      pane="markerPane"
      pathOptions={{
        fillColor: color,
        fillOpacity: 0.9,
        color: '#ffffff',
        weight: 2,
        opacity: 1,
      }}
      eventHandlers={{
        click: (e) => {
          L.DomEvent.stopPropagation(e);
        },
        mouseover: (e) => {
          e.target.setStyle({ radius: 10, weight: 3 });
        },
        mouseout: (e) => {
          e.target.setStyle({ radius: 7, weight: 2 });
        },
      }}
    >
      {/* Hover tooltip — bare minimum */}
      <Tooltip
        direction="top"
        offset={[0, -8]}
        className="competitor-tooltip"
      >
        <div className="text-[11px] leading-tight">
          <p className="font-semibold">{site.companyName}</p>
          <p className="text-gray-500">{site.category}{site.status ? ` · ${site.status}` : ''}</p>
          {location && <p className="text-gray-400">{location}</p>}
        </div>
      </Tooltip>

      {/* Click popup — compact detail card */}
      <Popup
        closeButton={false}
        autoPan={false}
        className="competitor-popup"
        maxWidth={240}
        minWidth={220}
      >
        <CompetitorDetailCard site={site} onClose={() => map.closePopup()} />
      </Popup>
    </CircleMarker>
  );
}

export function CompetitorMapLayer({ sites, visible }: CompetitorMapLayerProps) {
  if (!visible) return null;

  const sitesWithCoords = sites.filter(s => s.lat !== null && s.lng !== null);

  return (
    <>
      {sitesWithCoords.map(site => (
        <CompetitorMarker key={site.id} site={site} />
      ))}
    </>
  );
}
