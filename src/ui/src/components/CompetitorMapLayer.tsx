import { CircleMarker, Popup, useMap } from 'react-leaflet';
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

  return (
    <CircleMarker
      center={[site.lat, site.lng]}
      radius={8}
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
          // Stop propagation so the underlying region polygon doesn't also get selected
          L.DomEvent.stopPropagation(e);
        },
        mouseover: (e) => {
          e.target.setStyle({ radius: 12, weight: 3 });
        },
        mouseout: (e) => {
          e.target.setStyle({ radius: 8, weight: 2 });
        },
      }}
    >
      <Popup
        closeButton={false}
        autoPan={true}
        className="competitor-popup"
        maxWidth={350}
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
