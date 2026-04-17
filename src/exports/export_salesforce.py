"""
Export Salesforce data for frontend consumption.

Queries Sales + Real Estate Opportunities from Salesforce, normalizes MSA names,
and outputs:
  1. RE sites as CompetitorSite-compatible dicts (category: "Customer") for merging
     into the competitor tracker JSON
  2. MSA customer summaries from Sales Opportunities (for logo display + customer counts)
  3. salesforceData.json with MSA summaries, stats, and lastUpdated timestamp

Requires .env with SF_CONSUMER_KEY, SF_CONSUMER_SECRET, SF_DOMAIN.
Falls back gracefully if Salesforce is unreachable.
"""

import json
import re
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from dotenv import load_dotenv

from src.utils.logging_utils import get_logger

logger = get_logger(__name__)

load_dotenv()

# RE Opportunity stages included in the SOQL query and shown on the map.
# Order matches the frontend STAGE_ORDER in CompetitorTrackerPanel.tsx.
_ACTIVE_RE_STAGES: Tuple[str, ...] = (
    "Market Search",
    "Short List",
    "LOI Negotiation",
    "PSA/Lease Negotiation",
    "Inspection Period",
    "Unsolicited Offer Sent",
    "Off Market Target",
    "Closed Won",
)


def normalize_msa(sf_msa: str) -> str:
    """Normalize MSA name: strip ' MSA' suffix, convert en/em dashes to hyphens."""
    if not sf_msa:
        return ""
    normalized = sf_msa.strip()
    if normalized.endswith(" MSA"):
        normalized = normalized[:-4]
    # Normalize en dash (U+2013) and em dash (U+2014) to regular hyphen
    normalized = normalized.replace('\u2013', '-').replace('\u2014', '-')
    return normalized


def _connect_salesforce():
    """Connect to Salesforce using Client Credentials OAuth2."""
    consumer_key = os.environ.get("SF_CONSUMER_KEY")
    consumer_secret = os.environ.get("SF_CONSUMER_SECRET")
    domain = os.environ.get("SF_DOMAIN")

    if not all([consumer_key, consumer_secret, domain]):
        raise EnvironmentError(
            "Missing Salesforce credentials. Set SF_CONSUMER_KEY, SF_CONSUMER_SECRET, SF_DOMAIN in .env"
        )

    from simple_salesforce import Salesforce

    sf = Salesforce(
        consumer_key=consumer_key,
        consumer_secret=consumer_secret,
        domain=domain,
    )
    logger.info("Connected to Salesforce: %s", sf.sf_instance)
    return sf


def _query_sales_opportunities(sf) -> List[Dict[str, Any]]:
    """Query Sales Opportunities for MSA-level customer presence."""
    soql = (
        "SELECT "
        "  Id, Name, StageName, Account.Name, Account.Id, "
        "  Local_MSA__c, Customer_Segment__c, Voltera_Segment__c, "
        "  X4Cs_Score__c, of_Locations_Desired__c, RecordType.Name "
        "FROM Opportunity "
        "WHERE RecordType.Name = 'Sales' "
        "  AND StageName NOT IN ('Closed Lost', 'Closed Eliminated') "
        "  AND Local_MSA__c != null "
        "ORDER BY Local_MSA__c, Account.Name"
    )
    result = sf.query_all(soql)
    records = result.get("records", [])
    logger.info("Sales Opportunities fetched: %d records", len(records))
    return records


def _query_re_opportunities(sf) -> List[Dict[str, Any]]:
    """Query Real Estate Opportunities for pin-level sites."""
    stages_clause = ", ".join(f"'{s}'" for s in _ACTIVE_RE_STAGES)
    soql = (
        "SELECT "
        "  Id, Name, StageName, Account.Name, Account.Id, "
        "  Target_Customer__c, "
        "  MSA__c, Local_MSA__c, "
        "  Geolocation__Latitude__s, Geolocation__Longitude__s, "
        "  Opportunity_Address__c, Street__c, City__c, State__c, Zip_Code__c, "
        "  Total_Acres__c, Zoning_Category__c, EV_Permitted__c, "
        "  Test_Fit_Charger_Count__c, Test_Fit_EV_Charging_Stall_Count__c, "
        "  of_Required_Stalls__c, Charger_Power_Level__c, "
        "  Parent_Sales_Opportunity__c, Customer_Segment__c, Voltera_Segment__c, "
        "  AHJ__c, Real_Estate_Price_Total__c, Utility_Company__c, Serving_Utility__c, "
        "  PSA_Lease_Signature__c, Initial_Inspection_Period__c, "
        "  Initial_Earnest_Money__c, Inspection_Period_Start__c, "
        "  Inspection_Period_End__c, Closing__c, "
        "  DD_Extension__c, DD_ExtensionDetails__c, "
        "  Outside_Closing_Date__c, "
        "  RecordType.Name "
        "FROM Opportunity "
        "WHERE RecordType.Name IN ('Real Estate', 'Real Estate Portfolio Partnership') "
        f"  AND StageName IN ({stages_clause}) "
        "  AND Geolocation__Latitude__s != null "
        "ORDER BY MSA__c, Target_Customer__c"
    )
    result = sf.query_all(soql)
    records = result.get("records", [])
    logger.info("Real Estate Opportunities fetched: %d records", len(records))
    return records


def _split_customers(raw: str) -> List[str]:
    """Split multi-customer Target_Customer__c values on comma/semicolon/slash."""
    if not raw:
        return []
    # Split on comma, semicolon, or slash; strip whitespace; filter empty
    parts = re.split(r"[,;/]+", raw)
    return [p.strip() for p in parts if p.strip()]


# ── Customer name normalization ──────────────────────────────────────────────

_CUSTOMER_ALIASES: Dict[str, str] = {
    # Casing normalization
    "IONNA": "Ionna",
    "WattEv": "WattEV",
    "TARTA": "TARTA",
    "Mercedes Benz": "Mercedes-Benz",
    # Branded network variations
    "(Branded Network)": "Branded Networks",
    "Port (Thesis)": "Thesis (Port)",
    # Uber variations
    "Uber - Jan 2025 Drive By": "Uber",
    "Uber Charging + Maintenance Facility": "Uber",
    "Uber Charging Only": "Uber",
    "Uber Maintenance Facility": "Uber",
    "Uber Zoox": "Uber",
    "LOI signed by Uber (Moove Spain)": "Uber",
    # Waymo variations
    "Waymo - Lease": "Waymo",
    # Cruise variations — sublease target is the actual customer
    "Cruise - Sublease to Moove.io": "Moove.io",
    "Cruise - Sublease to Waymo": "Waymo",
    "Pending Cruise Outcome": "Cruise",
}

# Names to drop entirely — test accounts and data-entry junk.
_SKIP_CUSTOMERS: Set[str] = {
    "DCS TEST ACCOUNT",
    "DCS Test",
    # Numeric junk / fragments
    "11",
    "2025",
    # Notes pasted into the field (split on "/" produces this fragment)
    "Actively Listed for sale since 4",
}


# ── Segment normalization ──────────────────────────────────────────────────────
#
# Maps Salesforce segment values to canonical forms, handling dash vs space inconsistencies.
# These names must match those expected by the frontend normalizeSegmentName function.

_SEGMENT_ALIASES: Dict[str, str] = {
    # Dash vs space inconsistencies
    "Light Duty Goods": "Light Duty-Goods",
    "Light Duty People": "Light Duty-People",
    "Light Duty Networks": "Light Duty-Networks",
    "Heavy Duty Goods": "Heavy Duty-Goods",
    "Heavy Duty People": "Heavy Duty-People",
    "Heavy Duty Networks": "Heavy Duty-Networks",
}

_SKIP_SEGMENTS: Set[str] = {"0"}


def _normalize_segment(raw: str) -> str:
    """
    Normalize a Customer_Segment__c or Voltera_Segment__c value from Salesforce.

    Applies aliases to map variants to canonical names, skips invalid values.
    Returns empty string if value is empty or in skip list.
    """
    val = raw.strip()
    if not val or val in _SKIP_SEGMENTS:
        return ""
    return _SEGMENT_ALIASES.get(val, val)


def _normalize_customer_name(name: str) -> Optional[str]:
    """Normalize a customer name using aliases. Returns None to skip."""
    if name in _SKIP_CUSTOMERS:
        return None
    return _CUSTOMER_ALIASES.get(name, name)


def _normalize_and_deduplicate(customers: List[str]) -> List[str]:
    """Normalize customer names, drop skipped names, and deduplicate."""
    seen: Set[str] = set()
    result: List[str] = []
    for name in customers:
        normalized = _normalize_customer_name(name)
        if normalized is None or normalized in seen:
            continue
        seen.add(normalized)
        result.append(normalized)
    return result


def _build_re_sites(re_records: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Convert RE Opportunity records into CompetitorSite-compatible dicts.

    These are injected into competitorTracker.json with category "Customer".
    Multi-customer Target_Customer__c values are split into separate entries
    (one pin per customer, same location).
    """
    sites = []
    for rec in re_records:
        lat = rec.get("Geolocation__Latitude__s")
        lng = rec.get("Geolocation__Longitude__s")

        if lat is None or lng is None:
            continue

        msa_raw = rec.get("MSA__c") or rec.get("Local_MSA__c") or ""
        msa = normalize_msa(msa_raw)

        # Split multi-customer values; fall back to "TBD"
        target_customer = (rec.get("Target_Customer__c") or "").strip()
        customers = _split_customers(target_customer)
        if not customers:
            customers = ["TBD"]

        customers = _normalize_and_deduplicate(customers) or ["TBD"]

        opp_name = rec.get("Name") or ""
        charger_count = rec.get("Test_Fit_Charger_Count__c")
        stall_count = rec.get("Test_Fit_EV_Charging_Stall_Count__c") or rec.get("of_Required_Stalls__c")
        re_price = rec.get("Real_Estate_Price_Total__c")
        parsed_stalls = int(stall_count) if stall_count else None
        parsed_chargers = int(charger_count) if charger_count else None

        for company_name in customers:
            site = {
                "id": f"sf-re-{len(sites)}",
                "companyName": company_name,
                "category": "Customer",
                "status": rec.get("StageName", "Unknown"),
                "volteraSegment": _normalize_segment(rec.get("Voltera_Segment__c") or ""),
                "customerSegment": _normalize_segment(rec.get("Customer_Segment__c") or ""),
                "msa": msa,
                "address": rec.get("Street__c") or rec.get("Opportunity_Address__c") or "",
                "city": rec.get("City__c") or "",
                "state": rec.get("State__c") or "",
                "lat": lat,
                "lng": lng,
                "siteAcres": rec.get("Total_Acres__c"),
                "siteSF": None,
                "buildingSize": None,
                "purchaser": "",
                "purchaseDate": "",
                "lastSalePrice": None,
                "purchasePriceSF": None,
                "annualRent": None,
                "zoning": rec.get("Zoning_Category__c") or "",
                "totalStalls": parsed_stalls,
                "numChargers": parsed_chargers,
                "chargerSize": rec.get("Charger_Power_Level__c") or "",
                "amenityNotes": "",
                "targetGoLive": "",
                "notes": opp_name,
                "source": "salesforce",
                # Salesforce-enriched fields
                "opportunityName": opp_name,
                "ahj": rec.get("AHJ__c") or "",
                "rePriceTotal": float(re_price) if re_price else None,
                "evChargingStallCount": parsed_stalls,
                "utility": rec.get("Utility_Company__c") or rec.get("Serving_Utility__c") or "",
                "psaLeaseSignature": rec.get("PSA_Lease_Signature__c") or "",
                "initialInspectionPeriod": rec.get("Initial_Inspection_Period__c"),
                "initialEarnestMoney": rec.get("Initial_Earnest_Money__c"),
                "inspectionPeriodStart": rec.get("Inspection_Period_Start__c") or "",
                "inspectionPeriodEnd": rec.get("Inspection_Period_End__c") or "",
                "initialClosingDate": rec.get("Closing__c") or "",
                "ipExtensionEndDate": rec.get("DD_Extension__c") or "",
                "ipExtensionOptionDetails": rec.get("DD_ExtensionDetails__c") or "",
                "outsideClosingDate": rec.get("Outside_Closing_Date__c") or "",
            }
            sites.append(site)

    logger.info("Built %d Customer sites from RE Opportunities", len(sites))
    return sites


def _build_msa_summaries(
    sales_records: List[Dict[str, Any]],
    re_sites: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """
    Build per-MSA customer summaries from Sales Opportunities.

    Returns a dict keyed by normalized MSA name with account names, counts, etc.
    """
    summaries: Dict[str, Dict[str, Any]] = {}

    def _ensure_msa(msa: str) -> Dict[str, Any]:
        """Get or create a summary entry for the given MSA."""
        return summaries.setdefault(msa, {
            "msa": msa,
            "accounts": [],
            "accountCount": 0,
            "opportunityCount": 0,
            "siteCount": 0,
        })

    # Segments that count toward the MSA customer total.
    # Pete: "I only want these counts to be for accounts that are segmented
    # as AV-Ridehail or Non-AV Ridehail."
    _COUNTED_SEGMENTS = {"Autonomous Vehicles", "Ride Hail (Non-AV)"}

    # From Sales Opportunities -- accounts interested in each MSA
    for rec in sales_records:
        account = rec.get("Account") or {}
        account_name = account.get("Name", "")
        msa_raw = rec.get("Local_MSA__c") or ""
        msa = normalize_msa(msa_raw)

        if not msa or not account_name:
            continue

        # Skip placeholder accounts (e.g. "Thesis Place Holder - Class 1-3")
        if "thesis" in account_name.lower():
            continue

        # Only count accounts in the target segments
        segment = (rec.get("Customer_Segment__c") or "").strip()
        if segment not in _COUNTED_SEGMENTS:
            continue

        entry = _ensure_msa(msa)
        if account_name not in entry["accounts"]:
            entry["accounts"].append(account_name)
        entry["opportunityCount"] += 1

    # Count RE sites per MSA
    for site in re_sites:
        msa = site.get("msa", "")
        if msa:
            _ensure_msa(msa)["siteCount"] += 1

    # Set final account counts
    for msa_data in summaries.values():
        msa_data["accountCount"] = len(msa_data["accounts"])

    logger.info("Built MSA summaries for %d MSAs", len(summaries))
    return summaries


def export_salesforce(
    output_json: Path,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """
    Main export function. Connects to SF, queries data, writes salesforceData.json.

    Returns:
        (re_sites, salesforce_data) — RE sites as CompetitorSite dicts + full output data

    Raises nothing on SF failure — returns empty data and logs warning.
    """
    try:
        sf = _connect_salesforce()
        sales_records = _query_sales_opportunities(sf)
        re_records = _query_re_opportunities(sf)
    except Exception as e:
        logger.warning("Salesforce connection/query failed: %s", str(e))
        logger.warning("Writing empty salesforceData.json — competitor tracker will use CSV data")
        empty_data = {
            "msaSummaries": {},
            "stats": {
                "salesOpportunities": 0,
                "reOpportunities": 0,
                "pipelineSites": 0,
                "msaCount": 0,
            },
            "lastUpdated": datetime.now(timezone.utc).isoformat(),
            "error": str(e),
        }
        output_json.parent.mkdir(parents=True, exist_ok=True)
        with open(output_json, "w", encoding="utf-8") as f:
            json.dump(empty_data, f, indent=2)
        return [], empty_data

    re_sites = _build_re_sites(re_records)
    msa_summaries = _build_msa_summaries(sales_records, re_sites)

    salesforce_data = {
        "msaSummaries": msa_summaries,
        "stats": {
            "salesOpportunities": len(sales_records),
            "reOpportunities": len(re_records),
            "pipelineSites": len(re_sites),
            "msaCount": len(msa_summaries),
        },
        "lastUpdated": datetime.now(timezone.utc).isoformat(),
    }

    output_json.parent.mkdir(parents=True, exist_ok=True)
    with open(output_json, "w", encoding="utf-8") as f:
        json.dump(salesforce_data, f, indent=2)

    logger.info("Salesforce data exported to %s", output_json)
    logger.info(
        "  Stats: %d sales opps, %d RE opps, %d SF sites, %d MSAs",
        len(sales_records),
        len(re_records),
        len(re_sites),
        len(msa_summaries),
    )

    return re_sites, salesforce_data


def get_salesforce_re_sites(output_json: Path) -> List[Dict[str, Any]]:
    """
    Convenience function: export SF data and return just the RE sites
    for merging into competitor tracker.

    Returns empty list if SF is unreachable.
    """
    re_sites, _ = export_salesforce(output_json)
    return re_sites


if __name__ == "__main__":
    output_path = Path("data/exports/salesforceData.json")
    re_sites, data = export_salesforce(output_path)
    print(f"\nExported Salesforce data:")
    print(f"  Salesforce sites: {len(re_sites)}")
    print(f"  Stats: {json.dumps(data.get('stats', {}), indent=2)}")
