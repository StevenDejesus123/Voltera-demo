/**
 * Rule-based grid readiness insights for EV deployment business context.
 * Translates raw substation/ICA numbers into plain-language assessments.
 */

import type { SubstationFeature } from '../types';

// ── EV Charging Reference Constants ──────────────────────────────────────────
const L2_KW        = 19.2;   // Level 2 charger (kW)
const DCFC_50_KW   = 50;     // DC fast charger standard (kW)
const DCFC_150_KW  = 150;    // DC fast charger high-power (kW)
const DCFC_350_KW  = 350;    // Hypercharger (kW)

function mwToChargers(mw: number): { l2: number; dcfc50: number; dcfc150: number } {
  const kw = mw * 1000;
  return {
    l2:     Math.floor(kw / L2_KW),
    dcfc50: Math.floor(kw / DCFC_50_KW),
    dcfc150: Math.floor(kw / DCFC_150_KW),
  };
}

// ── Types ────────────────────────────────────────────────────────────────────
export type InsightLevel = 'strong' | 'moderate' | 'limited' | 'critical';

export interface GridInsight {
  level:          InsightLevel;
  headline:       string;
  capacity:       string | null;
  access:         string | null;
  voltage:        string | null;
  territory:      string | null;
  recommendation: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function capacityInsight(mw: number | null | undefined): { text: string; level: InsightLevel } | null {
  if (mw == null) return null;

  if (mw <= 0) return {
    level: 'critical',
    text: 'No remaining load availability on nearest substation. Any new EV load will require a formal utility upgrade study (typically 6–18 months and $50K–$500K+ depending on scope).',
  };

  const { l2, dcfc50, dcfc150 } = mwToChargers(mw);

  if (mw < 0.1) return {
    level: 'critical',
    text: `Only ${(mw * 1000).toFixed(0)} kW available — enough for ${l2} Level 2 charger${l2 !== 1 ? 's' : ''} at most. Insufficient for meaningful fleet charging without a grid upgrade.`,
  };
  if (mw < 1) return {
    level: 'limited',
    text: `${mw.toFixed(2)} MW available — supports roughly ${dcfc50} DC fast charger${dcfc50 !== 1 ? 's' : ''} (50 kW) or ${l2} Level 2 ports. Suitable for a small pilot, not a full depot.`,
  };
  if (mw < 5) return {
    level: 'moderate',
    text: `${mw.toFixed(1)} MW available — can power a mid-size depot (~${dcfc50} × 50 kW DCFCs or ${l2} L2 ports). Adequate for a 20–40 vehicle fleet.`,
  };
  if (mw < 15) return {
    level: 'strong',
    text: `${mw.toFixed(1)} MW available — strong capacity for a large fleet depot (~${dcfc150} × 150 kW chargers). Supports 100+ EV operation without upgrade.`,
  };
  return {
    level: 'strong',
    text: `${mw.toFixed(1)} MW available — exceptional grid headroom. Suitable for a major EV hub, megawatt charging, or multi-tenant depot (${dcfc150}+ × 150 kW chargers).`,
  };
}

function accessInsight(distM: number | null | undefined): string | null {
  if (distM == null) return null;
  const km = distM / 1000;
  if (km < 0.5) return `Substation is ${Math.round(distM)} m away — on-site or adjacent. Minimal grid extension cost, fastest interconnection timeline.`;
  if (km < 2)   return `${km.toFixed(1)} km to nearest substation — short service extension, low additional infrastructure cost (~$50K–$150K estimate).`;
  if (km < 5)   return `${km.toFixed(1)} km to substation — moderate grid extension. Budget for additional distribution line cost (~$150K–$500K). Request a Preliminary Design Study from the utility.`;
  if (km < 10)  return `${km.toFixed(1)} km to nearest substation — significant distance. Grid extension alone may cost $500K+. Evaluate whether adjacent sites within 2–3 km offer equivalent site attributes.`;
  return `${km.toFixed(1)} km to nearest substation — very high grid extension cost likely. Prioritize identifying a closer interconnection point or factor in substantial infrastructure investment.`;
}

function voltageInsight(kv: number | null | undefined): string | null {
  if (kv == null) return null;
  if (kv <= 33)  return `${kv} kV distribution voltage — standard for direct EV charging connection. Straightforward utility interconnection process.`;
  if (kv <= 115) return `${kv} kV sub-transmission — a step-down transformer will be required to connect EV charging infrastructure, adding cost and permitting time.`;
  return `${kv} kV transmission voltage — not suitable for direct EV charging connection. A distribution-level interconnection point must be identified separately.`;
}

function territoryInsight(
  sce: number | undefined,
  pge: number | undefined,
  ladwp: number | undefined,
): string | null {
  const labels: string[] = [];
  if (sce === 1)   labels.push('SCE');
  if (pge === 1)   labels.push('PG&E');
  if (ladwp === 1) labels.push('LADWP');
  if (labels.length === 0) return null;
  const util = labels.join(' / ');
  if (labels.includes('SCE'))   return `${util} territory — SCE's Rule 21 process and ICA map data are publicly available. Expect 3–6 months for a straightforward interconnection application.`;
  if (labels.includes('PG&E'))  return `${util} territory — PG&E publishes circuit-level ICA data. Interconnection timelines vary by circuit load; budget 4–8 months for full approval.`;
  if (labels.includes('LADWP')) return `${util} territory — LADWP is a municipal utility with its own interconnection process, typically faster than IOUs but less transparent ICA data.`;
  return null;
}

function overallLevel(
  capLevel: InsightLevel | null,
  distM: number | null | undefined,
): InsightLevel {
  if (capLevel === 'critical') return 'critical';
  const km = distM != null ? distM / 1000 : null;
  if (capLevel === 'strong' && (km == null || km < 3)) return 'strong';
  if (capLevel === 'strong' && km != null && km < 8)   return 'moderate';
  if (capLevel === 'moderate') return km != null && km < 5 ? 'moderate' : 'limited';
  if (capLevel === 'limited')  return 'limited';
  return 'moderate';
}

function recommendation(level: InsightLevel, capMw: number | null | undefined, distM: number | null | undefined): string {
  const km = distM != null ? distM / 1000 : null;
  switch (level) {
    case 'strong':
      return 'High-priority site for EV deployment. Initiate a Preliminary Design Study (PDS) with the utility to confirm capacity and get a cost estimate. Timeline to energize: 12–18 months.';
    case 'moderate':
      return km != null && km > 5
        ? 'Viable site but grid distance adds cost. Commission a feasibility study comparing this site vs. alternatives within 3 km. Request a Rule 21 pre-application from the utility.'
        : 'Solid grid foundation. Submit a Rule 21 or equivalent interconnection pre-application to confirm costs. Plan for a 12–24 month development timeline.';
    case 'limited':
      return 'Grid investment required. Budget for a Distribution System Study ($50K–$200K) and factor in 18–24+ month utility upgrade lead time. Consider phasing deployment to match utility upgrade schedule.';
    case 'critical':
      return capMw != null && capMw <= 0
        ? 'Grid upgrade mandatory before deployment. Engage utility early to co-fund infrastructure improvements or explore third-party financing (USAC, NEVI, IRA incentives may offset costs).'
        : 'Significant grid barriers. Evaluate alternative sites or initiate a long-term utility partnership for infrastructure development. Not recommended for near-term deployment.';
  }
}

function headline(level: InsightLevel): string {
  switch (level) {
    case 'strong':   return 'Strong grid access — ready for EV deployment';
    case 'moderate': return 'Moderate grid readiness — investment required';
    case 'limited':  return 'Limited grid capacity — upgrade study needed';
    case 'critical': return 'Critical grid barriers — significant obstacles to deployment';
  }
}

// ── Main Export ───────────────────────────────────────────────────────────────
export function generateGridInsight(
  details: Record<string, any>,
  nearbySubstations?: SubstationFeature[] | null,
): GridInsight {
  const nearest = nearbySubstations?.[0];

  // Prefer nearest-substation data, fall back to ICA/generic detail fields
  const capacityMw = nearest?.capacityMw ?? details.substationCapacity ?? details.gridLoadCapacity;
  const distM      = nearest?.distM      ?? details.substationDist;
  const voltageKv  = nearest?.voltageKv  ?? details.substationVoltageKv;

  const capResult   = capacityInsight(capacityMw);
  const level       = overallLevel(capResult?.level ?? null, distM);

  return {
    level,
    headline: headline(level),
    capacity:       capResult?.text ?? null,
    access:         accessInsight(distM),
    voltage:        voltageInsight(voltageKv),
    territory:      territoryInsight(details.sceTerritory, details.pgeTerritory, details.ladwpTerritory),
    recommendation: recommendation(level, capacityMw, distM),
  };
}
