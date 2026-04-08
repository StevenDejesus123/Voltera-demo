import { useEffect, useRef } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';

export interface SelectedFeeder {
  utility: string;
  circuitName: string;
  substationName: string;
  loadAvailKw: number | null;
}

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
      <p style="margin:4px 0 0;font-size:10px;color:#9ca3af;font-style:italic">Click to highlight full feeder</p>
    </div>`;
}

// ── Component ──────────────────────────────────────────────────────────────
interface CircuitMapLayerProps {
  circuits: CircuitFeature[];
  visible?: boolean;
  selectedFeeder?: SelectedFeeder | null;
  onFeederClick?: (feeder: SelectedFeeder) => void;
}

interface PolylineEntry {
  poly: L.Polyline;
  circuit: CircuitFeature;
}

function baseStyle(c: CircuitFeature, sf: SelectedFeeder | null): L.PathOptions {
  if (!sf) return { weight: 2, opacity: 0.7, color: loadColor(c.loadAvailKw) };
  const isThis = sf.utility === c.utility && sf.circuitName === c.circuitName;
  return isThis
    ? { weight: 5, opacity: 1.0, color: loadColor(c.loadAvailKw) }
    : { weight: 1, opacity: 0.18, color: loadColor(c.loadAvailKw) };
}

export function CircuitMapLayer({
  circuits,
  visible = true,
  selectedFeeder = null,
  onFeederClick,
}: CircuitMapLayerProps) {
  const map = useMap();
  const entriesRef = useRef<PolylineEntry[]>([]);
  // Use a ref so event handler closures always read the latest value
  const selectedFeederRef = useRef<SelectedFeeder | null>(selectedFeeder);
  selectedFeederRef.current = selectedFeeder;

  // ── Build/rebuild polylines when circuits or visibility change ────────────
  useEffect(() => {
    if (!map.getPane('circuitPane')) {
      const pane = map.createPane('circuitPane');
      pane.style.zIndex = '450';
    }

    entriesRef.current.forEach(e => e.poly.remove());
    entriesRef.current = [];

    if (!visible || !circuits || circuits.length === 0) return;

    const newEntries: PolylineEntry[] = [];
    const sf = selectedFeederRef.current;

    for (const c of circuits) {
      if (!c.coords || c.coords.length === 0) continue;

      for (const line of c.coords) {
        if (line.length < 2) continue;

        const latLngs = line.map(([lng, lat]) => [lat, lng] as [number, number]);

        const poly = L.polyline(latLngs, {
          ...baseStyle(c, sf),
          interactive: true,
          pane: 'circuitPane',
        });

        poly.on('mouseover', () => {
          const cur = selectedFeederRef.current;
          const isThis = !cur || (cur.utility === c.utility && cur.circuitName === c.circuitName);
          if (isThis) {
            poly.setStyle({ weight: cur ? 7 : 4, opacity: 1.0 });
          }
          // Don't brighten dimmed segments that belong to a different feeder
        });

        poly.on('mouseout', () => {
          poly.setStyle(baseStyle(c, selectedFeederRef.current));
        });

        poly.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          onFeederClick?.({
            utility: c.utility,
            circuitName: c.circuitName,
            substationName: c.substationName,
            loadAvailKw: c.loadAvailKw,
          });
        });

        poly.bindTooltip(tooltipHtml(c), {
          sticky: true,
          direction: 'top',
          offset: [0, -6],
        });

        poly.addTo(map);
        newEntries.push({ poly, circuit: c });
      }
    }

    entriesRef.current = newEntries;

    return () => {
      newEntries.forEach(e => e.poly.remove());
      entriesRef.current = [];
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, circuits, visible]);

  // ── Re-style all existing polylines when selection changes ────────────────
  useEffect(() => {
    for (const { poly, circuit } of entriesRef.current) {
      poly.setStyle(baseStyle(circuit, selectedFeeder));
    }
  }, [selectedFeeder]);

  return null;
}
