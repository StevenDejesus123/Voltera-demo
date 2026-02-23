/**
 * Robust MSA name matching utilities.
 *
 * MSA names come from multiple sources (CSV, Salesforce, Census rankings) and
 * differ in dash characters, state suffixes, " MSA" suffixes, and abbreviation
 * level. This module normalizes these differences for reliable matching.
 */

/**
 * Normalize an MSA name for matching:
 * - lowercase + trim
 * - convert en-dash (U+2013) and em-dash (U+2014) to regular hyphen
 * - strip trailing " msa" suffix
 */
function normalizeMSA(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\u2013|\u2014/g, '-')   // en/em dash → hyphen
    .replace(/\s+msa$/i, '');          // strip " MSA" suffix
}

/**
 * Extract the "base" of an MSA name — the part before any comma (state suffix).
 * e.g. "Nashville-Davidson-Murfreesboro-Franklin, TN" → "nashville-davidson-murfreesboro-franklin"
 */
function msaBase(normalized: string): string {
  return normalized.split(',')[0].trim();
}

/**
 * Check if two MSA names refer to the same metro area.
 *
 * Handles:
 * - Case differences
 * - En-dash / em-dash / hyphen mismatches
 * - " MSA" suffix presence/absence
 * - State suffix presence/absence (", TN" vs none)
 * - Abbreviated names ("Austin" matches "Austin-Round Rock-Georgetown, TX")
 */
export function msaNamesMatch(a: string, b: string): boolean {
  const aN = normalizeMSA(a);
  const bN = normalizeMSA(b);

  // Exact match after normalization
  if (aN === bN) return true;

  // Base match (strip state suffix)
  const aBase = msaBase(aN);
  const bBase = msaBase(bN);
  if (aBase === bBase) return true;

  // Prefix matching (handles abbreviated names like "Austin" ⊂ "Austin-Round Rock-Georgetown, TX").
  // Uses startsWith (not arbitrary substring) to avoid false positives where a city
  // name appears as a secondary/tertiary city in an unrelated MSA, e.g.
  // "Alexandria, LA" should NOT match "Washington-Arlington-Alexandria, DC-VA-MD-WV".
  if (aN.startsWith(bN) || bN.startsWith(aN)) return true;
  if (aBase.startsWith(bBase) || bBase.startsWith(aBase)) return true;

  // Primary city match: first segment before any dash
  // e.g. "seattle-tacoma-bellvue" starts with "seattle" which matches "seattle-tacoma-bellevue, wa"
  const aPrimary = aBase.split('-')[0].trim();
  const bPrimary = bBase.split('-')[0].trim();
  if (aPrimary.length >= 4 && bPrimary.length >= 4 && aPrimary === bPrimary) return true;

  return false;
}

/**
 * Check if a point (lat/lng) is within coordinate proximity of a reference
 * point. Uses a simple bounding-box check (~35 miles at mid-latitudes).
 *
 * Useful for matching sites without an MSA field to a ranked region
 * based on geographic proximity to the region's centroid.
 */
export function isNearCoordinates(
  lat: number,
  lng: number,
  refLat: number,
  refLng: number,
  threshold = 0.5,
): boolean {
  return Math.abs(lat - refLat) < threshold && Math.abs(lng - refLng) < threshold;
}
