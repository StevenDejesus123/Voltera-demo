import { useEffect, useRef } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';

export interface CircuitFeature {
  id: string;
  utility: string;
  circuitName: string;
  substationName: string;
  voltageKv: number | null;
  loadAvailKw: number | null;
  pvHostingKw: number | null;
  coords: number[][][];   // array of lines, each line is [[lng, lat], ...]
}

// ── Load availability → color ─────────────────────────────────────────────
function loadColor(kw: number | null): string {
  if (kw == null || kw <= 0) return '#ef4444';   // red
  if (kw < 1000)             return '#f97316';   // orange
  if (kw < 5000)             return '#eab308';   // yellow
  return '#22c55e';                              // green
}

function loadLabel(kw: number | null): string {
  if (kw == null) return 'N/A';
  if (kw >= 1000) return `${(kw / 1000).toFixed(1)} MW`;
  return `${Math.round(kw)} kW`;
}

/** Treat empty string, "nan", "none", "null" as absent — artifacts from Python NaN serialization. */
function blank(s: string | null | undefined): boolean {
  if (!s) return true;
  const l = s.trim().toLowerCase();
  return l === 'nan' || l === 'none' || l === 'null';
}

function tooltipHtml(c: CircuitFeature): string {
  const color = loadColor(c.loadAvailKw);
  return `
    <div style="font-size:11px;line-height:1.5;min-width:180px">
      <p style="font-weight:600;color:#1f2937;margin:0 0 1px">${blank(c.circuitName) ? 'Unnamed Circuit' : c.circuitName}</p>
      <p style="color:#6b7280;font-size:10px;text-transform:uppercase;letter-spacing:.05em;margin:0 0 4px">
        ${c.utility.toUpperCase()}${!blank(c.substationName) ? ` · ${c.substationName}` : ''}
      </p>
      <p style="color:#4b5563;margin:0">
        Load Availability: <span style="font-weight:600;color:${color}">${loadLabel(c.loadAvailKw)}</span>
      </p>
      ${c.voltageKv != null ? `<p style="color:#4b5563;margin:0">Voltage: <span style="font-weight:500">${c.voltageKv} kV (Distribution)</span></p>` : ''}
      ${c.pvHostingKw != null ? `<p style="color:#4b5563;margin:0">PV Hosting: <span style="font-weight:500">${loadLabel(c.pvHostingKw)}</span></p>` : ''}
      <div style="margin-top:5px;padding-top:4px;border-top:1px solid #f3f4f6;font-size:10px;color:#9ca3af">
        <span style="color:#22c55e">━</span> &gt;5 MW &nbsp;
        <span style="color:#eab308">━</span> 1–5 MW &nbsp;
        <span style="color:#f97316">━</span> &lt;1 MW &nbsp;
        <span style="color:#ef4444">━</span> None
      </div>
    </div>`;
}

// ── Component ──────────────────────────────────────────────────────────────
interface CircuitMapLayerProps {
  circuits: CircuitFeature[];
  visible?: boolean;
}

export function CircuitMapLayer({ circuits, visible = true }: CircuitMapLayerProps) {
  const map = useMap();
  const layersRef = useRef<L.Polyline[]>([]);

  useEffect(() => {
    // Ensure a dedicated pane exists above the choropleth canvas (overlayPane z=400)
    // but below markerPane (z=600) so substation pins always render and receive clicks on top.
    if (!map.getPane('circuitPane')) {
      const pane = map.createPane('circuitPane');
      pane.style.zIndex = '450';
    }

    // Remove previous layers
    layersRef.current.forEach(l => l.remove());
    layersRef.current = [];

    if (!visible || !circuits || circuits.length === 0) return;

    const newLayers: L.Polyline[] = [];

    for (const c of circuits) {
      if (!c.coords || c.coords.length === 0) continue;

      const color = loadColor(c.loadAvailKw);

      for (const line of c.coords) {
        if (line.length < 2) continue;

        const latLngs = line.map(([lng, lat]) => [lat, lng] as [number, number]);

        const poly = L.polyline(latLngs, {
          color,
          weight: 2,
          opacity: 0.7,
          interactive: true,
          pane: 'circuitPane',
        });

        // Brighten on hover so interaction is clearly intentional
        poly.on('mouseover', () => poly.setStyle({ weight: 4, opacity: 1.0 }));
        poly.on('mouseout',  () => poly.setStyle({ weight: 2, opacity: 0.7 }));

        poly.bindTooltip(tooltipHtml(c), {
          sticky: true,
          direction: 'top',
          offset: [0, -6],
        });

        poly.addTo(map);
        newLayers.push(poly);
      }
    }

    layersRef.current = newLayers;

    return () => {
      newLayers.forEach(l => l.remove());
      layersRef.current = [];
    };
  }, [map, circuits, visible]);

  return null;
}
