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

export type CircuitColorMode = 'capacity' | 'voltage';

// ── Load availability → color ─────────────────────────────────────────────
function loadColor(kw: number | null): string {
  if (kw == null || kw <= 0) return '#ef4444';   // red
  if (kw < 1000)             return '#f97316';   // orange
  if (kw < 5000)             return '#eab308';   // yellow
  return '#22c55e';                              // green
}

// ── Voltage band → color ──────────────────────────────────────────────────
function voltageColor(kv: number | null): string {
  if (kv == null)  return '#d0d0d0';  // light gray (unknown)
  if (kv < 5)      return '#d0d0d0';  // light gray  < 5 kV
  if (kv < 15)     return '#707070';  // dark gray   5–15 kV
  if (kv < 25)     return '#7ec8e3';  // light blue  15–25 kV
  return '#0078d4';                   // bright blue 25+ kV
}

function circuitColor(c: CircuitFeature, mode: CircuitColorMode): string {
  return mode === 'voltage' ? voltageColor(c.voltageKv) : loadColor(c.loadAvailKw);
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

function tooltipHtml(c: CircuitFeature, mode: CircuitColorMode): string {
  const color = loadColor(c.loadAvailKw);
  const legend = mode === 'voltage'
    ? `<div style="margin-top:5px;padding-top:4px;border-top:1px solid #f3f4f6;font-size:10px;color:#9ca3af">
        <span style="color:#0078d4">━</span> 25+ kV &nbsp;
        <span style="color:#7ec8e3">━</span> 15–25 kV &nbsp;
        <span style="color:#707070">━</span> 5–15 kV &nbsp;
        <span style="color:#d0d0d0">━</span> &lt;5 kV
      </div>`
    : `<div style="margin-top:5px;padding-top:4px;border-top:1px solid #f3f4f6;font-size:10px;color:#9ca3af">
        <span style="color:#22c55e">━</span> &gt;5 MW &nbsp;
        <span style="color:#eab308">━</span> 1–5 MW &nbsp;
        <span style="color:#f97316">━</span> &lt;1 MW &nbsp;
        <span style="color:#ef4444">━</span> None
      </div>`;
  return `
    <div style="font-size:11px;line-height:1.5;min-width:180px">
      <p style="font-weight:600;color:#1f2937;margin:0 0 1px">${blank(c.circuitName) ? 'Unnamed Circuit' : c.circuitName}</p>
      <p style="color:#6b7280;font-size:10px;text-transform:uppercase;letter-spacing:.05em;margin:0 0 4px">
        ${c.utility.toUpperCase()}${!blank(c.substationName) ? ` · ${c.substationName}` : ''}
      </p>
      <p style="color:#4b5563;margin:0">
        Load Availability: <span style="font-weight:600;color:${color}">${loadLabel(c.loadAvailKw)}</span>
      </p>
      ${c.voltageKv != null ? `<p style="color:#4b5563;margin:0">Voltage: <span style="font-weight:500">${c.voltageKv} kV</span></p>` : ''}
      ${c.pvHostingKw != null ? `<p style="color:#4b5563;margin:0">PV Hosting: <span style="font-weight:500">${loadLabel(c.pvHostingKw)}</span></p>` : ''}
      ${legend}
      <p style="margin:4px 0 0;font-size:10px;color:#9ca3af;font-style:italic">Click to highlight full feeder</p>
    </div>`;
}

// ── Component ──────────────────────────────────────────────────────────────
interface CircuitMapLayerProps {
  circuits: CircuitFeature[];
  visible?: boolean;
  selectedFeeder?: SelectedFeeder | null;
  onFeederClick?: (feeder: SelectedFeeder) => void;
  colorMode?: CircuitColorMode;
}

interface PolylineEntry {
  poly: L.Polyline;
  circuit: CircuitFeature;
}

function baseStyle(c: CircuitFeature, sf: SelectedFeeder | null, mode: CircuitColorMode): L.PathOptions {
  const color = circuitColor(c, mode);
  if (!sf) return { weight: 2, opacity: 0.7, color };
  const isThis = sf.utility === c.utility && sf.circuitName === c.circuitName;
  return isThis
    ? { weight: 5, opacity: 1.0, color }
    : { weight: 1, opacity: 0.18, color };
}

export function CircuitMapLayer({
  circuits,
  visible = true,
  selectedFeeder = null,
  onFeederClick,
  colorMode = 'capacity',
}: CircuitMapLayerProps) {
  const map = useMap();
  const entriesRef = useRef<PolylineEntry[]>([]);
  // Use refs so event handler closures always read the latest values
  const selectedFeederRef = useRef<SelectedFeeder | null>(selectedFeeder);
  selectedFeederRef.current = selectedFeeder;
  const colorModeRef = useRef<CircuitColorMode>(colorMode);
  colorModeRef.current = colorMode;

  // ── Build/rebuild polylines when circuits, visibility, or colorMode change ─
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
    const mode = colorModeRef.current;

    for (const c of circuits) {
      if (!c.coords || c.coords.length === 0) continue;

      for (const line of c.coords) {
        if (line.length < 2) continue;

        const latLngs = line.map(([lng, lat]) => [lat, lng] as [number, number]);

        const poly = L.polyline(latLngs, {
          ...baseStyle(c, sf, mode),
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
          poly.setStyle(baseStyle(c, selectedFeederRef.current, colorModeRef.current));
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

        poly.bindTooltip(tooltipHtml(c, mode), {
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
  }, [map, circuits, visible, colorMode]);

  // ── Re-style all existing polylines when selection or colorMode changes ───
  useEffect(() => {
    for (const { poly, circuit } of entriesRef.current) {
      poly.setStyle(baseStyle(circuit, selectedFeeder, colorMode));
    }
  }, [selectedFeeder, colorMode]);

  return null;
}
