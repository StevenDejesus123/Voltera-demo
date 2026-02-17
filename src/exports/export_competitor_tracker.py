"""
Export competitor tracker CSV to JSON for frontend consumption.
"""

import csv
import json
from pathlib import Path
from typing import Any, Dict, List, Optional


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


def export_competitor_tracker(
    input_csv: Path,
    output_json: Path,
) -> Dict[str, Any]:
    """
    Convert competitor tracker CSV to JSON for frontend.

    Returns summary statistics.
    """
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

            category = row.get('Category', '').strip()
            status = row.get('Status', '').strip()
            msa = row.get('MSA', '').strip()
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
                'volteraSegment': row.get('Voltera Segment', '').strip(),
                'customerSegment': row.get('Customer Segment', '').strip(),
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
            }

            sites.append(site)

            # Track unique values for filters
            if company:
                companies.add(company)
            if category:
                categories.add(category)
            if status:
                statuses.add(status)
            if msa:
                msas.add(msa)
            if city:
                cities.add(city)
            if state:
                states.add(state)

    # Build output with sites and filter options
    output = {
        'sites': sites,
        'filters': {
            'companies': sorted(list(companies)),
            'categories': sorted(list(categories)),
            'statuses': sorted(list(statuses)),
            'msas': sorted(list(msas)),
            'cities': sorted(list(cities)),
            'states': sorted(list(states)),
        },
        'stats': {
            'totalSites': len(sites),
            'sitesWithCoords': len([s for s in sites if s['lat'] and s['lng']]),
            'companiesCount': len(companies),
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

    stats = export_competitor_tracker(input_path, output_path)
    print(f"Exported competitor tracker: {stats}")
