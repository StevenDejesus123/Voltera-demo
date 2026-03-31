import { useEffect, useRef } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import type { SubstationFeature } from '../types';

// ── CSS injected once ──────────────────────────────────────────────────────────
let _cssInjected = false;
function ensureCSS() {
  if (_cssInjected || typeof document === 'undefined') return;
  _cssInjected = true;
  const s = document.createElement('style');
  s.textContent = `
    @keyframes ss-pulse {
      0%,100% { filter: drop-shadow(0 0 2px var(--ss-c)); opacity:.9; }
      50%      { filter: drop-shadow(0 0 8px var(--ss-c)) drop-shadow(0 0 14px var(--ss-c)); opacity:1; }
    }
    @keyframes ss-pulse-hl {
      0%,100% { filter: drop-shadow(0 0 4px var(--ss-c)) drop-shadow(0 0 2px #fff); opacity:1; }
      50%      { filter: drop-shadow(0 0 14px var(--ss-c)) drop-shadow(0 0 8px #fff) drop-shadow(0 0 20px var(--ss-c)); opacity:1; }
    }
    .ss-near { animation: ss-pulse    2s  ease-in-out infinite; }
    .ss-hl   { animation: ss-pulse-hl 0.9s ease-in-out infinite; }
  `;
  document.head.appendChild(s);
}

// ── Voltage level ──────────────────────────────────────────────────────────────
type VoltageLevel = 'distribution' | 'subtransmission' | 'transmission' | 'unknown';

function voltageLevel(kv: number | null): VoltageLevel {
  if (kv == null) return 'unknown';
  if (kv <= 33)   return 'distribution';
  if (kv <= 115)  return 'subtransmission';
  return 'transmission';
}

// ── Capacity → color ───────────────────────────────────────────────────────────
function capacityColor(mw: number | null, vl: VoltageLevel): string {
  if (vl === 'transmission') return '#9ca3af'; // gray — not suitable for direct EV connection
  if (mw == null || mw <= 0) return '#ef4444';
  if (mw < 1)                return '#ef4444';
  if (mw < 5)                return '#f97316';
  if (mw <= 10)              return '#eab308';
  return '#22c55e';
}

function capacityLabel(mw: number | null): string {
  if (mw == null) return 'N/A';
  return `${mw.toFixed(1)} MW`;
}

function formatDist(m: number | null | undefined): string {
  if (m == null) return '';
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

// ── Icon factory ───────────────────────────────────────────────────────────────
type PinState = 'nearby' | 'highlighted' | 'normal';

function makeIcon(
  color: string,
  state: PinState,
  vl: VoltageLevel,
  hasOverride: boolean,
): L.DivIcon {
  const size   = state === 'highlighted' ? 22 : state === 'nearby' ? 16 : 14;
  const cls    = state === 'highlighted' ? 'ss-hl' : state === 'nearby' ? 'ss-near' : '';

  // Sub-transmission gets amber stroke to signal "step-down required"
  const stroke      = vl === 'subtransmission' ? '#f59e0b' : 'rgba(255,255,255,0.85)';
  const strokeWidth = state === 'highlighted' ? 2 : vl === 'subtransmission' ? 1.8 : 1.2;

  // Override badge — small "V" circle overlaid top-right of the triangle
  const badge = hasOverride
    ? `<div style="position:absolute;top:-5px;right:-5px;width:11px;height:11px;background:#fff;border-radius:50%;border:1.5px solid #6366f1;display:flex;align-items:center;justify-content:center;font-size:7px;font-weight:800;color:#4f46e5;line-height:1;font-family:sans-serif">V</div>`
    : '';

  const html = `
    <div class="${cls}" style="position:relative;--ss-c:${color};width:${size}px;height:${size}px;line-height:0">
      <svg width="${size}" height="${size}" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
        <polygon points="10,1 19,19 1,19"
          fill="${color}"
          stroke="${stroke}"
          stroke-width="${strokeWidth}"
          stroke-linejoin="round"
        />
      </svg>
      ${badge}
    </div>`;

  return L.divIcon({
    html,
    className: '',
    iconSize:   [size, size],
    iconAnchor: [size / 2, size],
    tooltipAnchor: [0, -size],
  });
}

function makeTooltipHtml(s: SubstationFeature): string {
  const vl    = voltageLevel(s.voltageKv);
  const color = capacityColor(s.capacityMw, vl);

  const voltageNote =
    vl === 'transmission'
      ? `<p style="color:#9ca3af;font-size:10px;margin:2px 0 0">⚠ Transmission-level — not suitable for direct EV connection</p>`
      : vl === 'subtransmission'
      ? `<p style="color:#f59e0b;font-size:10px;margin:2px 0 0">⚡ Sub-transmission — step-down transformer required</p>`
      : '';

  const overrideNote = s.hasOverride
    ? `<p style="color:#4f46e5;font-size:10px;margin:4px 0 0;padding-top:4px;border-top:1px solid #e0e7ff">
        <strong style="color:#4f46e5">V</strong> Voltera override${s.overrideLastVerified ? ` · verified ${s.overrideLastVerified}` : ''}
        ${s.overrideNotes ? `<br><em>${s.overrideNotes}</em>` : ''}
       </p>`
    : '';

  return `
    <div style="font-size:11px;line-height:1.5;min-width:170px">
      <p style="font-weight:600;color:#1f2937;margin:0 0 1px">${s.name || 'Unnamed Substation'}</p>
      <p style="color:#6b7280;font-size:10px;text-transform:uppercase;letter-spacing:.05em;margin:0 0 4px">${s.utility || ''}</p>
      <p style="color:#4b5563;margin:0">Load Availability: <span style="font-weight:500;color:${color}">${capacityLabel(s.capacityMw)}</span></p>
      ${s.voltageKv != null ? `<p style="color:#4b5563;margin:0">Voltage: <span style="font-weight:500">${s.voltageKv} kV</span></p>` : ''}
      ${voltageNote}
      ${s.distM != null ? `<p style="color:#4b5563;margin:0">Distance: <span style="font-weight:500">${formatDist(s.distM)}</span></p>` : ''}
      <div style="margin-top:6px;padding-top:4px;border-top:1px solid #f3f4f6;display:flex;gap:8px;font-size:10px;color:#9ca3af">
        <span><span style="color:#22c55e">▲</span> &gt;10 MW</span>
        <span><span style="color:#eab308">▲</span> 5–10</span>
        <span><span style="color:#f97316">▲</span> 1–5</span>
        <span><span style="color:#ef4444">▲</span> 0</span>
        <span><span style="color:#9ca3af">▲</span> TX</span>
      </div>
      ${overrideNote}
    </div>`;
}

// ── Layer ──────────────────────────────────────────────────────────────────────
interface SubstationMapLayerProps {
  substations: SubstationFeature[];
  nearbySubstationIds?: Set<string>;
  emphasizedIds?: Set<string>;       // from utility/capacity/voltage filter — empty = all normal
  highlightedId?: string | null;
  onClickSubstation?: (s: SubstationFeature) => void;
}

export function SubstationMapLayer({
  substations,
  nearbySubstationIds,
  emphasizedIds,
  highlightedId,
  onClickSubstation,
}: SubstationMapLayerProps) {
  const map = useMap();
  const onClickRef = useRef(onClickSubstation);
  onClickRef.current = onClickSubstation;

  useEffect(() => { ensureCSS(); }, []);

  // Rebuild all markers whenever inputs change.
  // Cleanup explicitly removes every marker — no stale Leaflet nodes possible.
  useEffect(() => {
    if (!map || !substations || substations.length === 0) return;

    const nearbyIds = nearbySubstationIds ?? new Set<string>();
    // emphasizedIds: empty set = no active filter (all normal); non-empty = dim non-members
    const filterActive = (emphasizedIds?.size ?? 0) > 0;

    function pinState(s: SubstationFeature): PinState {
      if (s.id === highlightedId) return 'highlighted';
      if (nearbyIds.has(s.id))    return 'nearby';
      return 'normal';
    }

    const visible = substations.filter(s => s.lat != null && s.lng != null);

    // Sort: normal → nearby → highlighted (higher z-index last)
    const sorted = [...visible].sort((a, b) => {
      const order: Record<PinState, number> = { normal: 0, nearby: 1, highlighted: 2 };
      return order[pinState(a)] - order[pinState(b)];
    });

    const markers: L.Marker[] = sorted.map(s => {
      const state  = pinState(s);
      const vl     = voltageLevel(s.voltageKv);
      const color  = capacityColor(s.capacityMw, vl);
      const icon   = makeIcon(color, state, vl, !!s.hasOverride);
      const size   = state === 'highlighted' ? 22 : state === 'nearby' ? 16 : 14;

      // Dim if filter active and this substation is not in the emphasized set
      const isEmphasized = !filterActive || emphasizedIds!.has(s.id);
      const opacity = isEmphasized ? 1.0 : 0.25;

      const marker = L.marker([s.lat, s.lng], {
        icon,
        zIndexOffset: state === 'highlighted' ? 2000 : state === 'nearby' ? 1000 : 0,
      });
      marker.setOpacity(opacity);

      marker.bindTooltip(makeTooltipHtml(s), {
        direction: 'top',
        offset: [0, -size],
      });

      marker.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        onClickRef.current?.(s);
      });

      marker.addTo(map);
      return marker;
    });

    return () => {
      markers.forEach(m => m.remove());
    };
  }, [map, substations, nearbySubstationIds, emphasizedIds, highlightedId]);

  return null;
}
