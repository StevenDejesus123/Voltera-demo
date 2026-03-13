/**
 * Dynamic choropleth color scale for EV site-selection maps.
 *
 * Two coloring strategies by geo level:
 *
 *   MSA    → Score-based quantile (equal-count)
 *              Colors by actual probability score, 6 equal-count bins.
 *              MSA scores have more spread, so score-based works well here.
 *
 *   County → Rank-based asymmetric
 *   Tract     Colors by RANK POSITION within the visible set (not score).
 *              Tract/county scores are inherently very low (0.02–0.15 range)
 *              and cluster tightly, so score-based coloring makes most regions
 *              appear gray. Rank-based coloring always distributes the 6 colors
 *              across the visible regions, showing relative performance:
 *
 *              Band 5  top  5 %   deep blue   (prime candidates)
 *              Band 4   5–15 %    medium blue
 *              Band 3  15–30 %    light blue
 *              Band 2  30–50 %    gold/yellow
 *              Band 1  50–75 %    light beige
 *              Band 0  bottom 25% gray          (de-emphasised)
 *
 *              Because GeoMapView only receives the regions it is rendering
 *              (e.g. tracts for the selected county), "local" normalization is
 *              automatic — no extra step needed.
 */

export type ColorMode = 'quantile' | 'asymmetric';

/** 6-band palette: index 0 = lowest/worst, index 5 = highest/best. */
export const BAND_COLORS = [
  '#A5B3C0', // Band 0: bottom 25%       — gray (de-emphasised)
  '#F2DFCC', // Band 1: below avg 50-75% — light beige
  '#FFD183', // Band 2: avg 30-50%       — gold/yellow
  '#8AB3FF', // Band 3: above avg 15-30% — light blue
  '#4C74EA', // Band 4: top 5-15%        — medium blue
  '#0F28C3', // Band 5: top 5%           — deep blue (prime candidates)
] as const;

/** Human-readable label for each band (index 0 = worst). */
export const BAND_LABELS = [
  'Bottom 25 %',
  'Below avg',
  'Average',
  'Above avg',
  'Top 15 %',
  'Top 5 %',
] as const;

// Asymmetric percentile thresholds (cumulative from the bottom).
// 5 breakpoints → 6 bands.
const ASYMMETRIC_P = [0.25, 0.50, 0.70, 0.85, 0.95];

// Equal-count (quantile) break percentiles for MSA score-based mode.
const QUANTILE_P = [1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6];

// Fixed rank-band legend rows (best → worst). Used for County/Tract.
// These never change because rank distribution is always uniform.
export const RANK_LEGEND_ROWS: ReadonlyArray<{
  band: number; color: string; label: string; range: string;
}> = [
  { band: 5, color: BAND_COLORS[5], label: 'Top 5 %',     range: ''         },
  { band: 4, color: BAND_COLORS[4], label: 'Top 15 %',    range: '5–15 %'   },
  { band: 3, color: BAND_COLORS[3], label: 'Above avg',   range: '15–30 %'  },
  { band: 2, color: BAND_COLORS[2], label: 'Average',     range: '30–50 %'  },
  { band: 1, color: BAND_COLORS[1], label: 'Below avg',   range: '50–75 %'  },
  { band: 0, color: BAND_COLORS[0], label: 'Bottom 25 %', range: ''         },
];

/** Linear interpolation of a percentile value in a sorted array. */
function lerp(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const raw = Math.max(0, Math.min(sorted.length - 1, p * (sorted.length - 1)));
  const lo = Math.floor(raw);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (raw - lo);
}

export class ColorScale {
  /**
   * 5 ascending score breakpoints (used only for MSA score-based mode).
   * breaks[0] = upper edge of Band 0, breaks[4] = lower edge of Band 5.
   */
  readonly breaks: readonly number[];
  readonly mode: ColorMode;

  constructor(scores: number[], mode: ColorMode) {
    this.mode = mode;

    const valid = scores.filter((s) => typeof s === 'number' && isFinite(s));

    if (mode === 'quantile' && valid.length >= 2) {
      const sorted = [...valid].sort((a, b) => a - b);
      this.breaks = QUANTILE_P.map((p) => lerp(sorted, p));
    } else {
      // Asymmetric / fallback: use fixed proportional breaks.
      // For rank-based coloring (County/Tract) these breaks are not used for
      // color lookup — getColorByRank() is called instead.
      this.breaks = ASYMMETRIC_P;
    }
  }

  /** Returns the band index (0 = worst … 5 = best) for a given score value. */
  getBand(score: number): number {
    for (let i = 0; i < this.breaks.length; i++) {
      if (score <= this.breaks[i]) return i;
    }
    return 5;
  }

  /** Score-based color — use for MSA level only. */
  getColor(score: number): string {
    return BAND_COLORS[this.getBand(score)];
  }

  /**
   * Rank-based color for County / Tract levels.
   * rank=1 = best region, rank=total = worst region.
   *
   * Converts rank position to a uniform [0, 1] percentile then applies the
   * asymmetric thresholds.  This always distributes colors across the visible
   * set regardless of how tightly clustered the probability scores are.
   */
  getColorByRank(rank: number, total: number): string {
    if (total <= 1) return BAND_COLORS[5];
    const pctFromBottom = (total - rank) / (total - 1); // 0 = worst, 1 = best
    for (let i = 0; i < ASYMMETRIC_P.length; i++) {
      if (pctFromBottom <= ASYMMETRIC_P[i]) return BAND_COLORS[i];
    }
    return BAND_COLORS[5];
  }

  /**
   * Score-based legend rows (MSA), ordered best → worst.
   * Each row: { band, color, label, lo (%), hi (%) }.
   */
  getLegendRows(): Array<{ band: number; color: string; label: string; lo: number; hi: number }> {
    const rows = [];
    for (let band = 5; band >= 0; band--) {
      const lo = band === 0 ? 0 : (this.breaks[band - 1] ?? 0);
      const hi = band === 5 ? 1 : (this.breaks[band] ?? 1);
      rows.push({
        band,
        color: BAND_COLORS[band],
        label: BAND_LABELS[band],
        lo: Math.round(lo * 100),
        hi: Math.round(hi * 100),
      });
    }
    return rows;
  }
}

/** Returns the appropriate classification mode for a given geo level. */
export function getColorMode(geoLevel: string): ColorMode {
  return geoLevel === 'MSA' ? 'quantile' : 'asymmetric';
}

/** True when the geo level should use rank-based coloring. */
export function isRankBased(geoLevel: string): boolean {
  return geoLevel !== 'MSA';
}
