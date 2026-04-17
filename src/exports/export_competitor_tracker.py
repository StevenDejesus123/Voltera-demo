"""
Export competitor tracker CSV to JSON for frontend consumption.

When Salesforce integration is available, merges SF Real Estate Opportunity sites
as "Customer" category entries and removes duplicate "Voltera" rows from the CSV
(SF is authoritative for those).
"""

import csv
import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

from src.exports.export_salesforce import normalize_msa, _normalize_segment as _sf_normalize_segment

logger = logging.getLogger(__name__)

# CSV company name normalization — fix casing inconsistencies in Pete's spreadsheet.
_CSV_COMPANY_ALIASES: Dict[str, str] = {
    'WattEv': 'WattEV',
}

# Default values for Salesforce-enriched fields (absent in CSV rows).
_SF_FIELD_DEFAULTS: Dict[str, Any] = {
    'opportunityName': '',
    'ahj': '',
    'rePriceTotal': None,
    'evChargingStallCount': None,
    'utility': '',
    'psaLeaseSignature': '',
    'initialInspectionPeriod': None,
    'initialEarnestMoney': None,
    'inspectionPeriodStart': '',
    'inspectionPeriodEnd': '',
    'initialClosingDate': '',
    'ipExtensionEndDate': '',
    'ipExtensionOptionDetails': '',
    'outsideClosingDate': '',
}


def _normalize_segment(val: str) -> str:
    """Normalize segment names to canonical form for consistent dash formatting."""
    return _sf_normalize_segment(val)


def parse_float(val: str) -> Optional[float]:
    """Parse a float from a string, handling various formats."""
    if not val or val.strip() in ('', 'N/A', 'TBD'):
        return None
    try:
        # Remove currency symbols, commas, spaces
        cleaned = val.replace('$', '').replace(',', '').replace(' ', '').strip()
        return float(cleaned)
    except (ValueError, TypeError):
        return None


def parse_int(val: str) -> Optional[int]:
    """Parse an int from a string."""
    if not val or val.strip() in ('', 'N/A', 'TBD'):
        return None
    try:
        cleaned = val.replace(',', '').replace(' ', '').strip()
        return int(float(cleaned))
    except (ValueError, TypeError):
        return None


def _load_sf_sites(sf_json: Path) -> List[Dict[str, Any]]:
    """
    Run SF export and return Customer sites for merging.

    Returns empty list if SF is unavailable or fails.
    """
    try:
        from src.exports.export_salesforce import get_salesforce_re_sites
        sites = get_salesforce_re_sites(sf_json)
        if sites:
            logger.info("Loaded %d Customer sites from Salesforce", len(sites))
        return sites
    except Exception as e:
        logger.warning("Salesforce export unavailable, using CSV data only: %s", str(e))
        return []


def export_competitor_tracker(
    input_csv: Path,
    output_json: Path,
    sf_json: Optional[Path] = None,
) -> Dict[str, Any]:
    """
    Convert competitor tracker CSV to JSON for frontend.

    If sf_json is provided, also queries Salesforce for Customer sites,
    deduplicates Voltera rows, and merges SF sites into the output.

    Returns summary statistics.
    """
    # Try to get SF Customer sites
    sf_sites: List[Dict[str, Any]] = []
    if sf_json is not None:
        sf_sites = _load_sf_sites(sf_json)

    sites: List[Dict[str, Any]] = []
    companies: set = set()
    categories: set = set()
    statuses: set = set()
    msas: set = set()
    cities: set = set()
    states: set = set()

    with open(input_csv, 'r', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)

        for idx, row in enumerate(reader):
            company = row.get('Company Name', '').strip()
            if not company:
                continue
            company = _CSV_COMPANY_ALIASES.get(company, company)

            category = row.get('Category', '').strip()

            # Dedup: skip "Voltera" rows when SF data is available
            # (SF is authoritative for Voltera sites)
            if sf_sites and category == 'Voltera':
                continue

            status = row.get('Status', '').strip()
            msa = normalize_msa(row.get('MSA', '').strip())
            city = row.get('City', '').strip()
            state = row.get('State', '').strip()

            # Parse coordinates
            lat = parse_float(row.get('Lat', ''))
            lng = parse_float(row.get('Long', ''))

            # Build site object
            site = {
                'id': f'site-{idx}',
                'companyName': company,
                'category': category or 'Unknown',
                'status': status or 'Unknown',
                'volteraSegment': _normalize_segment(row.get('Voltera Segment', '').strip()),
                'customerSegment': _normalize_segment(row.get('Customer Segment', '').strip()),
                'msa': msa,
                'address': row.get('Address Confirmed', '').strip(),
                'city': city,
                'state': state,
                'lat': lat,
                'lng': lng,
                'siteAcres': parse_float(row.get('Site Size (acres)', '')),
                'siteSF': parse_int(row.get('Site Size (SF)', '')),
                'buildingSize': parse_int(row.get('Building Size', '')),
                'purchaser': row.get('Purchaser', '').strip(),
                'purchaseDate': row.get('Purchase Date', '').strip(),
                'lastSalePrice': parse_float(row.get('Last Sale Price', '')),
                'purchasePriceSF': parse_float(row.get(' Purchase Price/SF ', '')),
                'annualRent': parse_float(row.get('Annual Rent', '')),
                'zoning': row.get('Zoning', '').strip(),
                'totalStalls': parse_int(row.get('Total Stalls', '')),
                'numChargers': parse_int(row.get('# of Chargers', '')),
                'chargerSize': row.get('Charger Size', '').strip(),
                'amenityNotes': row.get('Amenity Notes', '').strip(),
                'targetGoLive': row.get('Target Go-Live', '').strip(),
                'notes': row.get('Notes', '').strip(),
                'source': row.get('Source', '').strip(),
                **_SF_FIELD_DEFAULTS,
            }

            sites.append(site)

            # Track unique values for filters (skip empty strings)
            companies.add(company)  # already guaranteed non-empty
            for val, bucket in [(category, categories), (status, statuses),
                                (msa, msas), (city, cities), (state, states)]:
                if val:
                    bucket.add(val)

    # Inject SF Customer sites into merged output
    if sf_sites:
        sites.extend(sf_sites)
        categories.add('Customer')
        for site in sf_sites:
            companies.add(site['companyName'])
            for key, bucket in [('status', statuses), ('msa', msas),
                                ('city', cities), ('state', states)]:
                if site.get(key):
                    bucket.add(site[key])

    # Build output with sites and filter options
    output = {
        'sites': sites,
        'filters': {
            'companies': sorted(companies),
            'categories': sorted(categories),
            'statuses': sorted(statuses),
            'msas': sorted(msas),
            'cities': sorted(cities),
            'states': sorted(states),
        },
        'stats': {
            'totalSites': len(sites),
            'sitesWithCoords': len([s for s in sites if s['lat'] and s['lng']]),
            'companiesCount': len(companies),
            'pipelineSites': len(sf_sites),
        }
    }

    # Write JSON
    output_json.parent.mkdir(parents=True, exist_ok=True)
    with open(output_json, 'w', encoding='utf-8') as f:
        json.dump(output, f, indent=2)

    return output['stats']


if __name__ == '__main__':
    input_path = Path('data/inputs/Competitor Tracker.csv')
    output_path = Path('data/exports/competitorTracker.json')
    sf_path = Path('data/exports/salesforceData.json')

    stats = export_competitor_tracker(input_path, output_path, sf_json=sf_path)
    print(f"Exported competitor tracker: {stats}")
