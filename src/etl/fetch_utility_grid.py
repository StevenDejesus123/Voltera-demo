"""
fetch_utility_grid.py — Phase 3.4 Utility Grid Data Fetcher

Downloads public utility ICA / hosting-capacity data from ArcGIS FeatureServer
REST endpoints.

Sources:
  SCE   — Southern California Edison DRPEP portal (ArcGIS FeatureServer, public)
  PG&E  — Pacific Gas & Electric GRIP portal (ArcGIS FeatureServer, public)
  LADWP — Los Angeles DWP Power Capacity layer (ArcGIS FeatureServer, public)
  SDG&E — San Diego Gas & Electric ICA map (Sempra ArcGIS Enterprise, requires
           free registration at interconnectionmap-registration-form.sdge.com).
           Set SDGE_USERNAME and SDGE_PASSWORD in .env before running.

Layers fetched per utility:
  substations          — point geometry, capacity + load fields
  ica_segments         — polyline geometry, per-section hosting capacity
  service_territory    — polygon geometry, territory boundary + aggregate metrics

Output:
  data/inputs/utility_grid/{utility}/substations.geojson
  data/inputs/utility_grid/{utility}/ica_segments.geojson
  data/inputs/utility_grid/{utility}/service_territory.geojson

Usage:
  python -m src.etl.fetch_utility_grid                  # all utilities
  python -m src.etl.fetch_utility_grid --utility sce
  python -m src.etl.fetch_utility_grid --utility pge
  python -m src.etl.fetch_utility_grid --utility sdge
"""

from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path
from typing import Optional

import psycopg2.extras
import requests
from tqdm import tqdm

from src.utils.config_utils import load_config
from src.utils.logging_utils import get_logger

# ── Project root / config ──────────────────────────────────────────────────────

PROJECT_ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH  = PROJECT_ROOT / "config" / "settings.yaml"

# ── ArcGIS REST query defaults ─────────────────────────────────────────────────

ARCGIS_PAGE_SIZE  = 1000          # records per page (ArcGIS max is typically 1000 or 2000)
ARCGIS_TIMEOUT    = 30            # seconds per HTTP request
ARCGIS_RETRY      = 3             # retries on network error
ARCGIS_RETRY_WAIT = 2.0           # seconds between retries

# ── Layer definitions ──────────────────────────────────────────────────────────

SCE_BASE = "https://drpep.sce.com/arcgis_server/rest/services/Hosted"

SCE_LAYERS: dict[str, str] = {
    "substations":       f"{SCE_BASE}/ICA_Layer/FeatureServer/0",
    "ica_segments":      f"{SCE_BASE}/ICA_Layer/FeatureServer/2",
    "service_territory": f"{SCE_BASE}/ICA_Layer/FeatureServer/6",
}

# PG&E GRIP ArcGIS REST endpoint.
# Verify the exact service URL from:
#   https://www.pge.com/en/account/programs-and-incentives/grip.html
# The pattern should be: https://services{N}.arcgis.com/{orgId}/arcgis/rest/services/...
# TODO: replace PGE_BASE with confirmed endpoint after manual service inspection.
PGE_BASE = "https://pgemapservice.pge.com/arcgis/rest/services/GRIP"  # VERIFY URL

PGE_LAYERS: dict[str, str] = {
    "substations":       f"{PGE_BASE}/GRIP_Substations/FeatureServer/0",
    "ica_segments":      f"{PGE_BASE}/GRIP_ICA/FeatureServer/0",
    "service_territory": f"{PGE_BASE}/GRIP_Territory/FeatureServer/0",
}

# LADWP — Los Angeles Department of Water and Power
# Single public ArcGIS layer: Power_Capacity (polylines, 211K segments)
# Portal: https://ladwp-power.maps.arcgis.com/apps/webappviewer/index.html?id=290be9aa52694ef39bf3088940079f62
LADWP_BASE = "https://services7.arcgis.com/ZzOj15zjzIfDG8aL/arcgis/rest/services"

LADWP_LAYERS: dict[str, str] = {
    # LADWP publishes one combined capacity layer — no separate substations or territory.
    # Service territory can be derived from the National Utility Boundary Map KMZ.
    "ica_segments": f"{LADWP_BASE}/PowerCapacity/FeatureServer/0",
}

# SDG&E — Public ArcGIS Online (no registration or token required)
# Services hosted at: https://services.arcgis.com/S0EUI1eVapjRPS5e/ArcGIS/rest/services
# Confirmed public endpoints discovered 2026-04-09.
SDGE_BASE = "https://services.arcgis.com/S0EUI1eVapjRPS5e/ArcGIS/rest/services"

SDGE_LAYERS: dict[str, str] = {
    "substations":       f"{SDGE_BASE}/ICA_MAP_PROD_Substations_VW/FeatureServer/0",
    "ica_segments":      f"{SDGE_BASE}/ICA_MAP_PROD_LoadCapacityGrids_VW/FeatureServer/0",
    "service_territory": f"{SDGE_BASE}/District_Boundary_Electric/FeatureServer/0",
}

UTILITY_LAYERS: dict[str, dict[str, str]] = {
    "sce":   SCE_LAYERS,
    "pge":   PGE_LAYERS,
    "ladwp": LADWP_LAYERS,
    "sdge":  SDGE_LAYERS,
}

# Utilities that require a session token before querying (none currently)
UTILITIES_REQUIRING_TOKEN: set[str] = set()


# ─────────────────────────────────────────────────────────────────────────────
# Token authentication (SDG&E / Sempra ArcGIS Enterprise)
# ─────────────────────────────────────────────────────────────────────────────

def get_sdge_token() -> str:
    """
    Authenticate with the Sempra ArcGIS Enterprise server and return a session
    token valid for 120 minutes.

    Reads credentials from env vars SDGE_USERNAME and SDGE_PASSWORD (set in .env).
    Raises RuntimeError if credentials are missing or auth fails.
    """
    username = os.environ.get("SDGE_USERNAME", "")
    password = os.environ.get("SDGE_PASSWORD", "")
    if not username or not password:
        raise RuntimeError(
            "SDG&E credentials not found. Set SDGE_USERNAME and SDGE_PASSWORD "
            "in your .env file. Register for free at: "
            "https://interconnectionmap-registration-form.sdge.com/"
        )
    resp = requests.post(
        f"{SDGE_BASE.rstrip('/arcgis/rest/services')}/arcgis/tokens/generateToken",
        data={
            "username":   username,
            "password":   password,
            "client":     "requestip",
            "f":          "json",
            "expiration": 120,   # minutes
        },
        timeout=ARCGIS_TIMEOUT,
    )
    resp.raise_for_status()
    data = resp.json()
    if "token" not in data:
        raise RuntimeError(f"SDG&E token request failed: {data.get('error', data)}")
    return data["token"]


# ─────────────────────────────────────────────────────────────────────────────
# ArcGIS paginated fetcher
# ─────────────────────────────────────────────────────────────────────────────

def fetch_arcgis_layer(
    layer_url: str,
    layer_name: str,
    logger,
    *,
    page_size: int = ARCGIS_PAGE_SIZE,
    extra_params: Optional[dict] = None,
) -> list[dict]:
    """
    Fetch all features from an ArcGIS FeatureServer layer using offset pagination.

    Returns a list of GeoJSON feature dicts.
    Retries on network errors with exponential back-off.
    """
    query_url = f"{layer_url}/query"
    base_params: dict = {
        "where":             "1=1",
        "outFields":         "*",
        "f":                 "geojson",
        "outSR":             "4326",        # WGS84 — consistent CRS for all outputs
        "returnGeometry":    "true",
        "resultRecordCount": page_size,
    }
    if extra_params:
        base_params.update(extra_params)

    features: list[dict] = []
    offset = 0

    with tqdm(desc=f"  {layer_name}", unit=" records", leave=False) as bar:
        while True:
            params = {**base_params, "resultOffset": offset}

            data: Optional[dict] = None
            for attempt in range(ARCGIS_RETRY):
                try:
                    resp = requests.get(query_url, params=params, timeout=ARCGIS_TIMEOUT)
                    resp.raise_for_status()
                    data = resp.json()
                    break
                except (requests.RequestException, json.JSONDecodeError) as exc:
                    if attempt < ARCGIS_RETRY - 1:
                        logger.warning(
                            "  [%s] Request failed (attempt %d/%d): %s — retrying",
                            layer_name, attempt + 1, ARCGIS_RETRY, exc,
                        )
                        time.sleep(ARCGIS_WAIT := ARCGIS_RETRY_WAIT * (attempt + 1))
                    else:
                        logger.error("  [%s] All retries exhausted: %s", layer_name, exc)
                        raise

            if data is None:
                break

            # Check for ArcGIS error block
            if "error" in data:
                err = data["error"]
                raise RuntimeError(
                    f"ArcGIS error on {layer_name}: {err.get('message')} "
                    f"(code={err.get('code')})"
                )

            page = data.get("features", [])
            if not page:
                break

            features.extend(page)
            bar.update(len(page))
            offset += len(page)

            # Some ArcGIS servers set exceededTransferLimit=true when more pages
            # exist; others omit the flag entirely. Fall back to: keep paginating
            # as long as we received a full page.
            exceeded = data.get("exceededTransferLimit")
            if exceeded is False:
                # Explicitly told we're done
                break
            if exceeded is None and len(page) < page_size:
                # Flag absent but short page → last page
                break
            # exceeded is True, or absent + full page → fetch next page

    logger.info("  [%s] %d features fetched", layer_name, len(features))
    return features


# ─────────────────────────────────────────────────────────────────────────────
# Field normalizers — SCE
# ─────────────────────────────────────────────────────────────────────────────

def _parse_voltage_kv(raw) -> Optional[float]:
    """Extract numeric kV from strings like '66/12' or '12.47 kV' or numeric."""
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        return float(raw) if raw > 0 else None
    s = str(raw).split("/")[0].strip().replace("kV", "").replace("KV", "").strip()
    try:
        return float(s)
    except ValueError:
        return None


def _to_float(val) -> Optional[float]:
    try:
        return float(val) if val is not None else None
    except (ValueError, TypeError):
        return None


def normalize_sce_substations(features: list[dict]) -> list[dict]:
    """Normalize raw SCE Substations features to standard schema."""
    out = []
    for f in features:
        p = f.get("properties") or {}
        out.append({
            **f,
            "properties": {
                # ── raw fields preserved ──────────────────────────────────────
                "raw_subst_id":          p.get("subst_id") or p.get("objectid"),
                "raw_sub_name":          p.get("sub_name"),
                "raw_substation_voltage":p.get("substation_voltage"),
                "raw_existing_gen":      p.get("existing_gen"),
                "raw_queued_gen":        p.get("queued_gen"),
                "raw_total_gen":         p.get("total_gen"),
                "raw_projected_load":    p.get("projected_load"),
                "raw_max_remain_cap":    p.get("max_remain_cap"),
                "raw_note":              p.get("note"),
                # ── normalized fields ─────────────────────────────────────────
                "utility":               "sce",
                "source_layer":          "Substations",
                "substation_id":         str(p.get("subst_id") or p.get("objectid") or ""),
                "substation_name":       (p.get("sub_name") or "").strip(),
                "system_name":           (p.get("sys_name") or "").strip(),
                "substation_type":       (p.get("sub_type") or "").strip(),
                "substation_voltage_kv": _parse_voltage_kv(p.get("substation_voltage")),
                "existing_gen_mw":       _to_float(p.get("existing_gen")),
                "queued_gen_mw":         _to_float(p.get("queued_gen")),
                "total_gen_mw":          _to_float(p.get("total_gen")),
                "projected_load_mw":     _to_float(p.get("projected_load")),
                "penetration_level":     _to_float(p.get("penetration_level")),
                "remaining_capacity_mw": _to_float(p.get("max_remain_cap")),
            },
        })
    return out


def normalize_sce_ica_segments(features: list[dict]) -> list[dict]:
    """Normalize raw SCE ICA Circuit Segments features to standard schema."""
    out = []
    for f in features:
        p = f.get("properties") or {}
        out.append({
            **f,
            "properties": {
                # ── raw fields preserved ──────────────────────────────────────
                "raw_section_id":           p.get("section_id"),
                "raw_circuit_voltage":      p.get("circuit_voltage"),
                "raw_ica_overall_load":     p.get("ica_overall_load"),
                "raw_ica_overall_pv":       p.get("ica_overall_pv"),
                "raw_uniform_generation":   p.get("uniform_generation"),
                "raw_limiting_ug_sg":       p.get("most_limiting_criteria_ug_sg"),
                "raw_limiting_lsg":         p.get("most_limiting_criteria_lsg"),
                "raw_limiting_pv_sg":       p.get("most_limiting_criteria_pv_sg"),
                # ── normalized fields ─────────────────────────────────────────
                "utility":                  "sce",
                "source_layer":             "ICA - Circuit Segments",
                "section_id":               str(p.get("section_id") or ""),
                "node_id":                  str(p.get("node_id") or ""),
                "system_name":              (p.get("system_name") or "").strip(),
                "substation_name":          (p.get("substation_name") or "").strip(),
                "circuit_name":             (p.get("circuit_name") or "").strip(),
                "substation_voltage_kv":    _parse_voltage_kv(p.get("substation_voltage")),
                "circuit_voltage_kv":       _parse_voltage_kv(p.get("circuit_voltage")),
                "phase":                    (p.get("phase") or "").strip(),
                # SCE reports ICA values in MW — convert to kW for schema consistency
                "load_hosting_capacity_kw": _to_float(p.get("ica_overall_load"))      * 1000 if _to_float(p.get("ica_overall_load"))      is not None else None,
                "pv_hosting_capacity_kw":   _to_float(p.get("ica_overall_pv"))        * 1000 if _to_float(p.get("ica_overall_pv"))        is not None else None,
                "uniform_generation_kw":    _to_float(p.get("uniform_generation"))    * 1000 if _to_float(p.get("uniform_generation"))    is not None else None,
                "load_hosting_op_flex_kw":  _to_float(p.get("ica_overall_load_op_flex")) * 1000 if _to_float(p.get("ica_overall_load_op_flex")) is not None else None,
                "pv_hosting_op_flex_kw":    _to_float(p.get("ica_overall_pv_op_flex"))   * 1000 if _to_float(p.get("ica_overall_pv_op_flex"))   is not None else None,
                "limiting_criteria_load":   (p.get("most_limiting_criteria_lsg") or "").strip(),
                "limiting_criteria_gen":    (p.get("most_limiting_criteria_ug_sg") or "").strip(),
                "limiting_criteria_pv":     (p.get("most_limiting_criteria_pv_sg") or "").strip(),
                "download_link":            p.get("download_link"),
            },
        })
    return out


def normalize_sce_territory(features: list[dict]) -> list[dict]:
    """Normalize raw SCE Service Territory features to standard schema."""
    out = []
    for f in features:
        p = f.get("properties") or {}
        out.append({
            **f,
            "properties": {
                "utility":            "sce",
                "source_layer":       "SCE Service Territory",
                "territory_id":       str(p.get("id") or p.get("objectid") or ""),
                "projected_load_mw":  _to_float(p.get("projected_load")),
                "existing_gen_mw":    _to_float(p.get("existing_gen")),
                "queued_gen_mw":      _to_float(p.get("queued_gen")),
                "penetration_level":  _to_float(p.get("penetration_level")),
            },
        })
    return out


# ── PG&E normalizers (mirrors SCE structure, field names TBD after URL verify) ──

def normalize_pge_substations(features: list[dict]) -> list[dict]:
    """Normalize PG&E Substations. Field mapping TBD — verify endpoint first."""
    out = []
    for f in features:
        p = f.get("properties") or {}
        out.append({
            **f,
            "properties": {
                "utility":               "pge",
                "source_layer":          "PG&E Substations",
                "substation_id":         str(p.get("SUB_ID") or p.get("OBJECTID") or ""),
                "substation_name":       (p.get("SUB_NAME") or p.get("SUBSTATION") or "").strip(),
                "substation_voltage_kv": _parse_voltage_kv(p.get("VOLTAGE") or p.get("SUBSTATION_VOLTAGE")),
                "projected_load_mw":     _to_float(p.get("PROJECTED_LOAD")),
                "remaining_capacity_mw": _to_float(p.get("REMAINING_CAPACITY")),
                **{f"raw_{k.lower()}": v for k, v in p.items()},
            },
        })
    return out


def normalize_pge_ica_segments(features: list[dict]) -> list[dict]:
    """Normalize PG&E ICA segments. Field mapping TBD — verify endpoint first."""
    out = []
    for f in features:
        p = f.get("properties") or {}
        out.append({
            **f,
            "properties": {
                "utility":                  "pge",
                "source_layer":             "PG&E ICA",
                "section_id":               str(p.get("LINE_SECTION_ID") or p.get("OBJECTID") or ""),
                "circuit_name":             (p.get("FEEDER") or p.get("CIRCUIT_NAME") or "").strip(),
                "circuit_voltage_kv":       _parse_voltage_kv(p.get("VOLTAGE") or p.get("CIRCUIT_VOLTAGE")),
                "load_hosting_capacity_kw": _to_float(p.get("IC_THERMAL") or p.get("LOAD_HOSTING")),
                "pv_hosting_capacity_kw":   _to_float(p.get("IC_VOLTAGE") or p.get("PV_HOSTING")),
                "limiting_criteria_load":   (p.get("MOST_LIMITING") or "").strip(),
                **{f"raw_{k.lower()}": v for k, v in p.items()},
            },
        })
    return out


def normalize_pge_territory(features: list[dict]) -> list[dict]:
    out = []
    for f in features:
        p = f.get("properties") or {}
        out.append({
            **f,
            "properties": {
                "utility":      "pge",
                "source_layer": "PG&E Service Territory",
                "territory_id": str(p.get("OBJECTID") or ""),
                **{f"raw_{k.lower()}": v for k, v in p.items()},
            },
        })
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Field normalizers — LADWP
# ─────────────────────────────────────────────────────────────────────────────

# Capacity_Range_KW field contains string ranges like "450 - 600", ">7500",
# "NO CAPACITY".  Map each to the lower bound in kW for numeric use downstream.
_LADWP_CAPACITY_LOWER_KW: dict[str, Optional[float]] = {
    "NO CAPACITY": 0.0,
    "0 - 150":     0.0,
    "150 - 300":   150.0,
    "300 - 450":   300.0,
    "450 - 600":   450.0,
    "1000-1500":   1000.0,
    "1500-2000":   1500.0,
    "2500-3000":   2500.0,
    "3000-3500":   3000.0,
    "4500-5000":   4500.0,
    "5000-5500":   5000.0,
    "5500-6000":   5500.0,
    "6000-6500":   6000.0,
    "6500-7000":   6500.0,
    "7000-7500":   7000.0,
    ">7500":       7500.0,
}

# Capacity_Status field — map to a 0-3 ordinal for scoring
_LADWP_STATUS_ORDINAL: dict[str, int] = {
    "No Capacity":     0,
    "Low Capacity":    1,
    "Medium Capacity": 2,
    "High Capacity":   3,
}


def _parse_ladwp_voltage_kv(raw: Optional[str]) -> Optional[float]:
    """Parse LADWP Voltage_Class strings like '4.8-KV' or '34.5-KV' to float."""
    if not raw:
        return None
    # format is "{value}-KV"
    s = str(raw).upper().replace("-KV", "").replace("KV", "").strip()
    try:
        return float(s)
    except ValueError:
        return None


def normalize_ladwp_ica_segments(features: list[dict]) -> list[dict]:
    """Normalize LADWP Power_Capacity features to the project standard schema."""
    out = []
    for f in features:
        p = f.get("properties") or {}

        cap_range  = p.get("Capacity_Range_KW") or ""
        cap_status = p.get("Capacity_Status") or ""
        oh_ug      = p.get("OH_UG") or ""
        voltage    = p.get("Voltage_Class") or ""

        out.append({
            **f,
            "properties": {
                # ── raw fields preserved ──────────────────────────────────────
                "raw_gisid":          p.get("GISID"),
                "raw_oh_ug":          oh_ug,
                "raw_capacity_range": cap_range,
                "raw_capacity_status":cap_status,
                "raw_voltage_class":  voltage,
                "raw_shape_length":   p.get("SHAPE__Length"),
                # ── normalized fields ─────────────────────────────────────────
                "utility":                  "ladwp",
                "source_layer":             "Power_Capacity",
                "section_id":               str(p.get("GISID") or p.get("OBJECTID") or ""),
                # Conductor type — maps directly to the three viewer filter options
                "conductor_type":           oh_ug.strip(),          # OVERHEAD CONDUCTOR | UNDERGROUND CABLE
                "capacity_range_kw":        cap_range.strip(),       # raw range string  e.g. "450 - 600"
                "capacity_status":          cap_status.strip(),      # Low | Medium | High | No Capacity
                "capacity_status_ordinal":  _LADWP_STATUS_ORDINAL.get(cap_status.strip()),  # 0-3
                "circuit_voltage_kv":       _parse_ladwp_voltage_kv(voltage),               # 4.8 | 34.5
                # Numeric capacity lower-bound — used for scoring / spatial join output
                "load_hosting_capacity_kw": _LADWP_CAPACITY_LOWER_KW.get(cap_range.strip()),
                "shape_length_m":           _to_float(p.get("SHAPE__Length")),
            },
        })
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Field normalizers — SDG&E
# ─────────────────────────────────────────────────────────────────────────────
# Field names are from ICA User Guide Rev7. Confirm exact casing via DevTools
# after registration — ArcGIS Enterprise field names are case-sensitive.

def normalize_sdge_substations(features: list[dict]) -> list[dict]:
    """
    Normalize SDG&E ICA Substations (ICA_MAP_PROD_Substations_VW).
    Confirmed field names 2026-04-09: NAME, FACILITYID, IMAP_VOLTAGE, EXIST_GEN,
    QUE_GEN, TOT_GEN, PROJ_LOAD, PENETRATION.
    remaining_capacity_mw derived as PROJ_LOAD - EXIST_GEN - QUE_GEN.
    """
    out = []
    for f in features:
        p = f.get("properties") or {}
        proj_load  = _to_float(p.get("PROJ_LOAD"))
        exist_gen  = _to_float(p.get("EXIST_GEN"))
        queued_gen = _to_float(p.get("QUE_GEN"))
        remaining  = (
            proj_load - exist_gen - queued_gen
            if all(v is not None for v in (proj_load, exist_gen, queued_gen))
            else None
        )
        out.append({
            **f,
            "properties": {
                "utility":               "sdge",
                "source_layer":          "SDG&E ICA Substations",
                "substation_id":         str(p.get("FACILITYID") or p.get("OBJECTID") or ""),
                "substation_name":       (p.get("NAME") or "").strip(),
                "substation_voltage_kv": _parse_voltage_kv(p.get("IMAP_VOLTAGE")),
                "existing_gen_mw":       exist_gen,
                "queued_gen_mw":         queued_gen,
                "total_gen_mw":          _to_float(p.get("TOT_GEN")),
                "projected_load_mw":     proj_load,
                "penetration_level":     _to_float(p.get("PENETRATION")),
                "remaining_capacity_mw": remaining,
                **{f"raw_{k.lower()}": v for k, v in p.items()},
            },
        })
    return out


def normalize_sdge_ica_segments(features: list[dict]) -> list[dict]:
    """
    Normalize SDG&E ICA Load Capacity Grids (ICA_MAP_PROD_LoadCapacityGrids_VW).
    Confirmed field names 2026-04-09: CIRCUIT_NAME, VOLTAGE, LINE_SEGMENT_NUMBER,
    ICAWOF_UNILOAD, ICAWOF_UNIGENERATION, ICAWOF_PVGENERATION, SUBID, OHUG.
    Values are in MW — multiply by 1000 to convert to kW for schema consistency.

    NOTE: LINE_SEGMENT_NUMBER is NOT unique across the dataset — the same number
    appears on unrelated segments in different substations. OBJECTID (ArcGIS
    internal row ID) is the only guaranteed unique key per feature.
    """
    out = []
    for f in features:
        p = f.get("properties") or {}
        load_mw = _to_float(p.get("ICAWOF_UNILOAD"))
        gen_mw  = _to_float(p.get("ICAWOF_UNIGENERATION"))
        pv_mw   = _to_float(p.get("ICAWOF_PVGENERATION"))
        out.append({
            **f,
            "properties": {
                "utility":                  "sdge",
                "source_layer":             "SDG&E ICA Load Capacity Grids",
                "section_id":               str(p.get("OBJECTID") or ""),
                "circuit_name":             (p.get("CIRCUIT_NAME") or "").strip(),
                "substation_name":          (p.get("SUBID") or "").strip(),
                "circuit_voltage_kv":       _to_float(p.get("VOLTAGE")),
                "conductor_type":           (p.get("OHUG") or "").strip(),
                # MW → kW (SDG&E ICA values are in MW, schema expects kW)
                "load_hosting_capacity_kw": load_mw * 1000 if load_mw is not None else None,
                "pv_hosting_capacity_kw":   pv_mw  * 1000 if pv_mw  is not None else None,
                "uniform_generation_kw":    gen_mw  * 1000 if gen_mw  is not None else None,
                **{f"raw_{k.lower()}": v for k, v in p.items()},
            },
        })
    return out


def normalize_sdge_territory(features: list[dict]) -> list[dict]:
    out = []
    for f in features:
        p = f.get("properties") or {}
        out.append({
            **f,
            "properties": {
                "utility":      "sdge",
                "source_layer": "SDG&E Service Territory",
                "territory_id": str(p.get("OBJECTID") or p.get("objectid") or ""),
                **{f"raw_{k.lower()}": v for k, v in p.items()},
            },
        })
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Database upsert helpers
# ─────────────────────────────────────────────────────────────────────────────

def _get_db_conn():
    """Return a psycopg2 connection if DATABASE_URL is set, else None."""
    try:
        from src.db.connection import get_conn
        return get_conn()
    except Exception:
        return None


def _upsert_ica_segments(features: list[dict], utility: str, conn, logger) -> int:
    """
    Bulk-upsert ICA segment features into the ica_segments table.
    Geometry stored as JSONB — no PostGIS required.
    Uses ON CONFLICT (utility, section_id) DO UPDATE so re-fetching always
    reflects the latest values from the utility API.
    Returns the number of rows upserted.
    """
    if not features:
        return 0

    # Build a dict keyed by section_id to deduplicate within the batch.
    # SDG&E (and potentially others) can return duplicate section_ids in a
    # single fetch — ON CONFLICT DO UPDATE can't handle two rows with the
    # same key in the same INSERT, so we keep the last occurrence.
    row_map: dict[str, tuple] = {}
    for f in features:
        p = f.get("properties") or {}
        geom = f.get("geometry")
        if not geom:
            continue
        sid = str(p.get("section_id") or "")
        row_map[sid] = (
            utility,
            sid,
            p.get("circuit_name") or None,
            p.get("substation_name") or None,
            p.get("circuit_voltage_kv"),
            p.get("load_hosting_capacity_kw"),
            p.get("pv_hosting_capacity_kw"),
            p.get("conductor_type") or None,
            json.dumps(geom),
        )

    rows = list(row_map.values())

    if not rows:
        return 0

    sql = """
        INSERT INTO ica_segments (
            utility, section_id, circuit_name, substation_name,
            circuit_voltage_kv, load_hosting_capacity_kw, pv_hosting_capacity_kw,
            conductor_type, geometry_geojson
        ) VALUES %s
        ON CONFLICT (utility, section_id) DO UPDATE SET
            circuit_name             = EXCLUDED.circuit_name,
            substation_name          = EXCLUDED.substation_name,
            circuit_voltage_kv       = EXCLUDED.circuit_voltage_kv,
            load_hosting_capacity_kw = EXCLUDED.load_hosting_capacity_kw,
            pv_hosting_capacity_kw   = EXCLUDED.pv_hosting_capacity_kw,
            conductor_type           = EXCLUDED.conductor_type,
            geometry_geojson         = EXCLUDED.geometry_geojson,
            fetched_at               = now()
    """
    template = "(%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)"

    BATCH = 5000
    total = 0
    with conn.cursor() as cur:
        for i in range(0, len(rows), BATCH):
            psycopg2.extras.execute_values(cur, sql, rows[i:i + BATCH], template=template)
            total += cur.rowcount
        conn.commit()

    logger.info("    DB upsert ica_segments (%s): %d rows", utility, total)
    return total


def _upsert_substations(features: list[dict], utility: str, conn, logger) -> int:
    """
    Bulk-upsert substation features into the substations table.
    Geometry stored as JSONB. lat/lng extracted for easy point lookups.
    Returns the number of rows upserted.
    """
    if not features:
        return 0

    # Deduplicate by substation_id within the batch — same pattern as ica_segments.
    row_map: dict[str, tuple] = {}
    for f in features:
        p = f.get("properties") or {}
        geom = f.get("geometry")
        if not geom:
            continue
        sid = str(p.get("substation_id") or p.get("substation_name") or "")
        coords = geom.get("coordinates", [])
        lng = coords[0] if len(coords) >= 2 else None
        lat = coords[1] if len(coords) >= 2 else None
        row_map[sid] = (
            utility,
            sid,
            p.get("substation_name") or None,
            p.get("substation_voltage_kv"),
            p.get("remaining_capacity_mw"),
            lat,
            lng,
            json.dumps(geom),
        )

    rows = list(row_map.values())

    if not rows:
        return 0

    sql = """
        INSERT INTO substations (
            utility, substation_id, substation_name,
            substation_voltage_kv, remaining_capacity_mw,
            lat, lng, geometry_geojson
        ) VALUES %s
        ON CONFLICT (utility, substation_id) DO UPDATE SET
            substation_name       = EXCLUDED.substation_name,
            substation_voltage_kv = EXCLUDED.substation_voltage_kv,
            remaining_capacity_mw = EXCLUDED.remaining_capacity_mw,
            lat                   = EXCLUDED.lat,
            lng                   = EXCLUDED.lng,
            geometry_geojson      = EXCLUDED.geometry_geojson,
            fetched_at            = now()
    """
    template = "(%s, %s, %s, %s, %s, %s, %s, %s::jsonb)"

    with conn.cursor() as cur:
        psycopg2.extras.execute_values(cur, sql, rows, template=template)
        total = cur.rowcount
        conn.commit()

    logger.info("    DB upsert substations (%s): %d rows", utility, total)
    return total


def _replace_service_territory(features: list[dict], utility: str, conn, logger) -> int:
    """
    Replace service territory rows for a utility.
    Territory has no natural unique key so we delete+insert on each fetch.
    """
    if not features:
        return 0

    rows = []
    for f in features:
        geom = f.get("geometry")
        if not geom:
            continue
        rows.append((utility, json.dumps(geom)))

    if not rows:
        return 0

    sql_delete = "DELETE FROM service_territories WHERE utility = %s"
    sql_insert = """
        INSERT INTO service_territories (utility, geometry_geojson)
        VALUES %s
    """
    template = "(%s, %s::jsonb)"

    with conn.cursor() as cur:
        cur.execute(sql_delete, (utility,))
        psycopg2.extras.execute_values(cur, sql_insert, rows, template=template)
        total = cur.rowcount
        conn.commit()

    logger.info("    DB replace service_territory (%s): %d rows", utility, total)
    return total


def _log_fetch(utility: str, layer: str, row_count: int, conn, logger) -> None:
    """Insert a row into fetch_log for audit trail."""
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO fetch_log (utility, layer, row_count) VALUES (%s, %s, %s)",
                (utility, layer, row_count),
            )
        conn.commit()
    except Exception as exc:
        logger.warning("    Could not write fetch_log: %s", exc)


# ─────────────────────────────────────────────────────────────────────────────
# Per-utility fetch orchestrators
# ─────────────────────────────────────────────────────────────────────────────

NORMALIZERS: dict[str, dict[str, callable]] = {
    "sce": {
        "substations":       normalize_sce_substations,
        "ica_segments":      normalize_sce_ica_segments,
        "service_territory": normalize_sce_territory,
    },
    "pge": {
        "substations":       normalize_pge_substations,
        "ica_segments":      normalize_pge_ica_segments,
        "service_territory": normalize_pge_territory,
    },
    "ladwp": {
        "ica_segments": normalize_ladwp_ica_segments,
    },
    "sdge": {
        "substations":       normalize_sdge_substations,
        "ica_segments":      normalize_sdge_ica_segments,
        "service_territory": normalize_sdge_territory,
    },
}


def fetch_utility(utility: str, output_dir: Path, logger) -> None:
    """
    Fetch all layers for one utility, normalize, save as GeoJSON, and upsert
    to PostgreSQL (if DATABASE_URL is configured).

    GeoJSON files are always written as a local backup regardless of DB status.
    Skips layers where the endpoint returns an error (logged as warning).
    For token-authenticated utilities (SDG&E), obtains a session token first.
    """
    layers   = UTILITY_LAYERS[utility]
    norms    = NORMALIZERS[utility]
    util_dir = output_dir / utility
    util_dir.mkdir(parents=True, exist_ok=True)

    # Open DB connection once per utility (reused across all layers).
    # If DATABASE_URL is not set or connection fails, db_conn stays None
    # and the fetch continues with GeoJSON-only output.
    db_conn = _get_db_conn()
    if db_conn:
        logger.info("  Database connection established — will upsert to Postgres")
    else:
        logger.info("  No DATABASE_URL / connection failed — writing GeoJSON only")

    logger.info("=== Fetching %s utility grid data ===", utility.upper())

    # Obtain session token for utilities that require authentication
    token: Optional[str] = None
    if utility in UTILITIES_REQUIRING_TOKEN:
        logger.info("  Authenticating with %s...", utility.upper())
        try:
            token = get_sdge_token()
            logger.info("  Token obtained successfully (valid 120 min)")
        except Exception as exc:
            logger.error(
                "  Authentication failed for %s: %s\n"
                "  Ensure SDGE_USERNAME and SDGE_PASSWORD are set in .env.\n"
                "  Register at: https://interconnectionmap-registration-form.sdge.com/",
                utility.upper(), exc,
            )
            return

    for layer_key, layer_url in layers.items():
        out_path = util_dir / f"{layer_key}.geojson"
        logger.info("  Layer: %s -> %s", layer_key, out_path.name)

        # LADWP server supports 2000 records/page; use larger page size for speed
        page_size = 2000 if utility == "ladwp" else ARCGIS_PAGE_SIZE
        extra = {"token": token} if token else None

        try:
            raw_features = fetch_arcgis_layer(
                layer_url, layer_key, logger, page_size=page_size, extra_params=extra
            )
        except Exception as exc:
            logger.warning(
                "  SKIPPED %s/%s — fetch failed: %s\n"
                "  If this is PG&E, verify the endpoint URL in UTILITY_LAYERS['pge'].\n"
                "  If this is SDG&E, verify endpoint paths via DevTools after login.",
                utility, layer_key, exc,
            )
            continue

        if not raw_features:
            logger.warning("  %s/%s returned 0 features — skipping write", utility, layer_key)
            continue

        normalized = norms[layer_key](raw_features)

        # ── 1. Always write GeoJSON backup ────────────────────────────────────
        fc = {"type": "FeatureCollection", "features": normalized}
        with open(out_path, "w", encoding="utf-8") as fp:
            json.dump(fc, fp)
        logger.info("  Saved %d features -> %s", len(normalized), out_path)

        # ── 2. Upsert to Postgres if connected ────────────────────────────────
        if db_conn:
            try:
                if layer_key == "ica_segments":
                    n = _upsert_ica_segments(normalized, utility, db_conn, logger)
                elif layer_key == "substations":
                    n = _upsert_substations(normalized, utility, db_conn, logger)
                elif layer_key == "service_territory":
                    n = _replace_service_territory(normalized, utility, db_conn, logger)
                else:
                    n = 0
                _log_fetch(utility, layer_key, n, db_conn, logger)
            except Exception as exc:
                logger.warning("  DB upsert failed for %s/%s: %s", utility, layer_key, exc)
                try:
                    db_conn.rollback()
                except Exception:
                    pass

    if db_conn:
        try:
            db_conn.close()
        except Exception:
            pass


# ─────────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────────

def main(utilities: list[str] | None = None) -> None:
    logger = get_logger("fetch_utility_grid")
    config = load_config(CONFIG_PATH)

    output_dir = PROJECT_ROOT / config["paths"].get("utility_grid_dir", "data/inputs/utility_grid")
    output_dir.mkdir(parents=True, exist_ok=True)

    targets = utilities or list(UTILITY_LAYERS.keys())
    for utility in targets:
        if utility not in UTILITY_LAYERS:
            logger.error("Unknown utility '%s'. Valid options: %s", utility, list(UTILITY_LAYERS))
            continue
        fetch_utility(utility, output_dir, logger)

    logger.info("=== Done ===")


if __name__ == "__main__":
    env_path = PROJECT_ROOT / ".env"
    if env_path.exists():
        for _line in env_path.read_text(encoding="utf-8").splitlines():
            _line = _line.strip()
            if _line and not _line.startswith("#") and "=" in _line:
                _k, _, _v = _line.partition("=")
                os.environ.setdefault(_k.strip(), _v.strip())

    parser = argparse.ArgumentParser(
        description="Fetch utility ICA / hosting-capacity data from ArcGIS FeatureServer"
    )
    parser.add_argument(
        "--utility", type=str, default=None,
        choices=list(UTILITY_LAYERS.keys()),
        help="Utility to fetch (default: all). Options: sce, pge, ladwp, sdge",
    )
    args = parser.parse_args()

    main(utilities=[args.utility] if args.utility else None)
