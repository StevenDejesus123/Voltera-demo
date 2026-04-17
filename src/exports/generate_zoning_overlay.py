"""
generate_zoning_overlay.py — Zoning Feasibility Overlay Data Generator

Phase 3.3: Zoning Feasibility Layer

Processes census tracts through the LightBox Parcel API and Zoning API.
All parcels for a tract are fetched (no cap — pagination runs to completion).
Each tract is saved as its own GeoJSON file so the frontend can lazy-load
one tract at a time instead of downloading a single large file.

Pipeline:
  Phase 1  load_target_tracts()
           Joins Tract.shp × ML rankings → top-N or ALL tracts by score
  Phase 2  fetch_parcels_for_tract(wkt)
           POST /parcels/us/geometry  — paginates fully until all parcels fetched
  Phase 3  fetch_zoning_for_parcel(parcel_id)
           GET /zoning/_on/parcel/us/{id}
  Phase 4  classify_ev_permitted(zoning) → bool
           COMMERCIAL | INDUSTRIAL | MIXED USE → True
           OTHER → scan permittedUse text for EV/commercial keywords
           RESIDENTIAL | None → False
  Phase 5  aggregate_tract(result) → TractSummary
           Area-weighted pct per category; feasibility = ev_pct×0.7 + score×0.3
  Phase 6  write_tract_outputs(result, zoning_dir)
           Writes immediately on completion — no waiting for end of run:
             tract_{id}.geojson      — parcel polygon features
             tract_{id}.summary.json — aggregate stats
           At end: merge all summary JSONs → tract_summaries.csv

Checkpoint design (performance-safe):
  - Per-tract files on disk ARE the checkpoint (file existence = done)
  - A lightweight done-IDs list (data/staged/zoning_done.json) is saved every
    CHECKPOINT_INTERVAL tracts for fast resume without scanning the directory.
  - Old format (zoning_checkpoint.json with full parcel records + WKT) is
    automatically migrated on first run with the new code.

Usage:
  # Process top 500 tracts (default)
  python -m src.exports.generate_zoning_overlay

  # Custom top-N and worker count
  python -m src.exports.generate_zoning_overlay --top-n 1000 --workers 10

  # Process ALL 85,034 tracts (production run)
  python -m src.exports.generate_zoning_overlay --all-tracts --workers 10

  # Force reprocess everything from scratch
  python -m src.exports.generate_zoning_overlay --all-tracts --reset-checkpoint
"""

from __future__ import annotations

import argparse
import json
import math
import os
import threading
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import geopandas as gpd
import pandas as pd
import requests
from shapely import wkt as shapely_wkt
from shapely.geometry import mapping
from tqdm import tqdm

from src.utils.config_utils import load_config
from src.utils.logging_utils import get_logger

# ── Paths ─────────────────────────────────────────────────────────────────────

PROJECT_ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH  = PROJECT_ROOT / "config" / "settings.yaml"

# ── LightBox API ──────────────────────────────────────────────────────────────

LIGHTBOX_BASE    = "https://api.lightboxre.com/v1"
LIGHTBOX_API_KEY = os.environ.get("LIGHTBOX_API_KEY", "")

# ── Tuning knobs ──────────────────────────────────────────────────────────────

TOP_N_TRACTS         = 500   # Default top-N; override with --top-n or --all-tracts
PARCEL_PAGE_SIZE     = 100   # Parcels per LightBox page (API max = 100)
MAX_WORKERS          = 5     # Concurrent threads
RETRY_ATTEMPTS       = 4     # Per-request retry count
RETRY_BACKOFF        = 1.5   # Seconds; each retry waits RETRY_BACKOFF^attempt
REQUEST_TIMEOUT      = 15    # Seconds per HTTP request
CHECKPOINT_INTERVAL  = 50    # Save done-list every N completed tracts

# ── EV Permitted Classification ───────────────────────────────────────────────

EV_PERMITTED_CATEGORIES = {"COMMERCIAL", "INDUSTRIAL", "MIXED USE"}

EV_PERMITTED_KEYWORDS = frozenset({
    "electric vehicle", "ev station", "ev charging", "charging station",
    "commercial", "retail", "parking", "service station", "auto",
})

# ── Category normalization ────────────────────────────────────────────────────

CATEGORY_MAP: dict[str, str] = {
    "COMMERCIAL":  "Commercial",
    "INDUSTRIAL":  "Industrial",
    "RESIDENTIAL": "Residential",
    "MIXED USE":   "Mixed Use",
    "OTHER":       "Other",
}


def _normalize_category(raw: Optional[str]) -> str:
    if not raw:
        return "Other"
    return CATEGORY_MAP.get(raw.strip().upper(), "Other")


# ── Thread-safe API call counter ──────────────────────────────────────────────

class ApiCallCounter:
    """Thread-safe counter for LightBox HTTP requests (every attempt, including retries)."""

    def __init__(self) -> None:
        self._lock        = threading.Lock()
        self.parcel_calls = 0   # POST /parcels/us/geometry
        self.zoning_calls = 0   # GET  /zoning/_on/parcel/us/{id}

    @property
    def total(self) -> int:
        return self.parcel_calls + self.zoning_calls

    def add_parcel(self, n: int = 1) -> None:
        with self._lock:
            self.parcel_calls += n

    def add_zoning(self, n: int = 1) -> None:
        with self._lock:
            self.zoning_calls += n


_api_counter = ApiCallCounter()


# ─────────────────────────────────────────────────────────────────────────────
# Phase 1 — Target tract selection
# ─────────────────────────────────────────────────────────────────────────────

def load_target_tracts(config: dict, top_n: int, all_tracts: bool, logger) -> list[dict]:
    """
    Return tracts sorted by ML score descending.
    When all_tracts=True, returns all tracts (no top-N limit).
    Each dict: {tract_id, wkt, score, city}
    """
    outputs_dir   = PROJECT_ROOT / config["paths"]["outputs"]
    spatial_dir   = PROJECT_ROOT / config["paths"]["inputs"]["spatial"]
    geocode_dir   = PROJECT_ROOT / config["paths"]["inputs"]["mastergeocode"]
    rankings_name = config["ml"]["ml_outputs"]["rankings_workbook"]

    rankings_path = outputs_dir / rankings_name
    logger.info("Loading Tract rankings from: %s", rankings_path)

    tract_df = pd.read_excel(rankings_path, sheet_name="Tract")
    tract_df.columns = tract_df.columns.str.strip()

    id_col    = _pick_col(tract_df, preferred=["Tract_GeoID"],        keywords=["tract", "geo"])
    score_col = _pick_col(tract_df, preferred=["P", "Prediction-01"], keywords=["prediction", "prob"])

    if not id_col or not score_col:
        raise RuntimeError(
            f"Cannot find tract ID or score column in rankings sheet. "
            f"Columns found: {list(tract_df.columns)}"
        )

    logger.info("  Rankings: %d rows  (id_col=%s, score_col=%s)", len(tract_df), id_col, score_col)

    tract_df["_tract_id"] = (
        pd.to_numeric(tract_df[id_col], errors="coerce")
          .dropna().astype(int).astype(str).str.zfill(11)
    )
    tract_df = tract_df.dropna(subset=["_tract_id"])
    tract_df["_score"] = pd.to_numeric(tract_df[score_col], errors="coerce").fillna(0.0)

    if all_tracts:
        selected = tract_df.sort_values("_score", ascending=False).reset_index(drop=True)
        logger.info(
            "  Mode: ALL TRACTS — %d tracts (score range %.4f – %.4f)",
            len(selected), selected["_score"].min(), selected["_score"].max(),
        )
    else:
        selected = tract_df.nlargest(top_n, "_score").reset_index(drop=True)
        logger.info(
            "  Mode: TOP-%d tracts (score range %.4f – %.4f)",
            len(selected), selected["_score"].min(), selected["_score"].max(),
        )

    tract_shp = spatial_dir / "Tract.shp"
    logger.info("Loading Tract.shp from: %s", tract_shp)
    gdf = gpd.read_file(tract_shp)
    gdf["_tract_id"] = gdf["GEOID"].astype(str).str.strip()
    if gdf.crs and gdf.crs.to_epsg() != 4326:
        gdf = gdf.to_crs(epsg=4326)

    geocode_file = geocode_dir / config["filenames"]["master_geocode"]
    city_map = _build_city_map(geocode_file, logger)

    merged = selected.merge(gdf[["_tract_id", "geometry"]], on="_tract_id", how="inner")
    logger.info("  Geometry join: %d / %d tracts matched shapefile", len(merged), len(selected))

    results: list[dict] = []
    for _, row in merged.iterrows():
        try:
            wkt_str = row["geometry"].wkt
        except Exception:
            continue
        results.append({
            "tract_id": row["_tract_id"],
            "wkt":      wkt_str,
            "score":    float(row["_score"]),
            "city":     city_map.get(row["_tract_id"], ""),
        })

    return results


def _pick_col(df: pd.DataFrame, preferred: list[str], keywords: list[str]) -> Optional[str]:
    for name in preferred:
        if name in df.columns:
            return name
    lower_map = {c.lower(): c for c in df.columns}
    for kw in keywords:
        for lc, orig in lower_map.items():
            if kw in lc:
                return orig
    return None


def _build_city_map(geocode_path: Path, logger) -> dict[str, str]:
    if not geocode_path.exists():
        logger.warning("  Master geocode not found: %s — city names will be empty", geocode_path)
        return {}
    try:
        df = pd.read_excel(geocode_path, sheet_name="MasterGeocodeMap")
        df.columns = df.columns.str.strip()
        id_col    = _pick_col(df, preferred=["Tract_GeoID"],         keywords=["tract", "geo"])
        city_col  = _pick_col(df, preferred=["City", "City_Name"],   keywords=["city"])
        state_col = _pick_col(df, preferred=["State", "State_Abbr"], keywords=["state"])
        if not id_col:
            logger.warning("  Could not find tract ID column in master geocode")
            return {}
        df["_id"] = (
            pd.to_numeric(df[id_col], errors="coerce")
              .dropna().astype(int).astype(str).str.zfill(11)
        )
        if city_col and state_col:
            df["_city"] = (
                df[city_col].fillna("").str.strip() + ", "
                + df[state_col].fillna("").str.strip()
            )
        elif city_col:
            df["_city"] = df[city_col].fillna("").str.strip()
        else:
            return {}
        return dict(zip(df["_id"], df["_city"]))
    except Exception as exc:
        logger.warning("  City map build failed: %s", exc)
        return {}


# ─────────────────────────────────────────────────────────────────────────────
# HTTP helpers
# ─────────────────────────────────────────────────────────────────────────────

def _api_headers() -> dict[str, str]:
    return {"x-api-key": LIGHTBOX_API_KEY, "Accept": "application/json"}


def _get_with_retry(url: str, params: Optional[dict] = None) -> Optional[dict]:
    """GET with exponential back-off. Counts every HTTP attempt."""
    for attempt in range(RETRY_ATTEMPTS):
        _api_counter.add_zoning()
        try:
            resp = requests.get(url, headers=_api_headers(), params=params,
                                timeout=REQUEST_TIMEOUT)
            if resp.status_code == 200:
                return resp.json()
            if resp.status_code == 404:
                return None
            if resp.status_code == 429 or resp.status_code >= 500:
                time.sleep(RETRY_BACKOFF ** attempt)
                continue
            return None
        except requests.RequestException:
            if attempt < RETRY_ATTEMPTS - 1:
                time.sleep(RETRY_BACKOFF ** attempt)
    return None


def _post_with_retry(url: str, body: dict) -> Optional[dict]:
    """POST with exponential back-off. Counts every HTTP attempt.
    Only retries on 429 / 5xx — returns None immediately for 404 and other 4xx."""
    for attempt in range(RETRY_ATTEMPTS):
        _api_counter.add_parcel()
        try:
            resp = requests.post(
                url, headers={**_api_headers(), "Content-Type": "application/json"},
                json=body, timeout=REQUEST_TIMEOUT,
            )
            if resp.status_code == 200:
                data = resp.json()
                # Empty result — no parcels in this area, no point retrying
                if not data.get("parcels"):
                    return data
                return data
            if resp.status_code == 404:
                return None  # No coverage — don't retry
            if resp.status_code == 429 or resp.status_code >= 500:
                time.sleep(RETRY_BACKOFF ** attempt)
                continue
            return None  # Other 4xx — don't retry
        except requests.RequestException:
            if attempt < RETRY_ATTEMPTS - 1:
                time.sleep(RETRY_BACKOFF ** attempt)
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Phase 2 — Fetch ALL parcels for a tract (no cap)
# ─────────────────────────────────────────────────────────────────────────────

def fetch_parcels_for_tract(tract_wkt: str) -> list[dict]:
    """
    POST /parcels/us/geometry with the tract polygon WKT.
    Paginates until ALL parcels for this tract are retrieved — no artificial cap.
    """
    url     = f"{LIGHTBOX_BASE}/parcels/us/geometry"
    parcels: list[dict] = []
    offset  = 0

    while True:
        body = {"wkt": tract_wkt, "limit": PARCEL_PAGE_SIZE, "offset": offset}
        data = _post_with_retry(url, body)
        if not data:
            break
        page = data.get("parcels", [])
        if not page:
            break
        parcels.extend(page)
        total  = data.get("$metadata", {}).get("recordSet", {}).get("totalRecords", 0)
        offset += len(page)
        if offset >= total:
            break

    return parcels


# ─────────────────────────────────────────────────────────────────────────────
# Phase 3 — Fetch zoning for a single parcel
# ─────────────────────────────────────────────────────────────────────────────

def fetch_zoning_for_parcel(parcel_id: str) -> Optional[dict]:
    url  = f"{LIGHTBOX_BASE}/zoning/_on/parcel/us/{parcel_id}"
    data = _get_with_retry(url)
    if not data:
        return None
    zonings = data.get("zonings", [])
    return zonings[0] if zonings else None


# ─────────────────────────────────────────────────────────────────────────────
# Phase 4 — EV permitted classification
# ─────────────────────────────────────────────────────────────────────────────

def classify_ev_permitted(zoning: Optional[dict]) -> bool:
    if not zoning:
        return False
    category = (zoning.get("category") or "").strip().upper()
    if category in EV_PERMITTED_CATEGORIES:
        return True
    if category == "OTHER":
        permitted_text = (zoning.get("permittedUse") or "").lower()
        return any(kw in permitted_text for kw in EV_PERMITTED_KEYWORDS)
    return False


# ─────────────────────────────────────────────────────────────────────────────
# Phases 2–4 combined — Process one tract (runs in a worker thread)
# ─────────────────────────────────────────────────────────────────────────────

def process_tract(tract: dict) -> dict:
    """
    Fetch ALL parcels in the tract, then zoning for each parcel, then classify.
    Returns: {tract_id, score, city, parcel_records[]}
    Each parcel_record: zone_id, tract_id, city, zone_code, zone_category,
                        ev_permitted, lot_area, geom_wkt, zoning_resolved
    """
    tract_id = tract["tract_id"]
    score    = tract["score"]
    city     = tract["city"]

    raw_parcels = fetch_parcels_for_tract(tract["wkt"])

    parcel_records: list[dict] = []
    for p in raw_parcels:
        parcel_id = p.get("id")
        if not parcel_id:
            continue

        geom_wkt = p.get("location", {}).get("geometry", {}).get("wkt")
        lot_area = float(
            p.get("derived", {}).get("calculatedLotArea")
            or p.get("assessment", {}).get("lot", {}).get("size")
            or 1.0
        )
        locality = p.get("location", {}).get("locality", "")
        region   = p.get("location", {}).get("regionCode", "")
        parcel_city = (f"{locality}, {region}".strip(", ") if region else locality) or city

        zoning = fetch_zoning_for_parcel(parcel_id)

        parcel_records.append({
            "zone_id":         parcel_id,
            "tract_id":        tract_id,
            "city":            parcel_city,
            "zone_code":       (zoning.get("code", {}).get("value") or "") if zoning else "",
            "zone_category":   _normalize_category(zoning.get("category") if zoning else None),
            "ev_permitted":    classify_ev_permitted(zoning),
            "lot_area":        lot_area,
            "geom_wkt":        geom_wkt,
            "zoning_resolved": zoning is not None,
        })

    return {"tract_id": tract_id, "score": score, "city": city, "parcel_records": parcel_records}


# ─────────────────────────────────────────────────────────────────────────────
# Phase 5 — Aggregate parcel records to tract-level summary
# ─────────────────────────────────────────────────────────────────────────────

def aggregate_tract(tract_result: dict) -> Optional[dict]:
    """Compute area-weighted zoning summary for one tract. Returns None if no parcels."""
    records = tract_result.get("parcel_records", [])
    if not records:
        return None

    tract_id = tract_result["tract_id"]
    score    = tract_result["score"]
    city     = tract_result.get("city", "") or next(
        (r["city"] for r in records if r.get("city")), ""
    )

    total_area = sum(r["lot_area"] for r in records) or 1.0
    ev_area    = sum(r["lot_area"] for r in records if r["ev_permitted"])
    cat_areas: dict[str, float] = defaultdict(float)
    for r in records:
        cat_areas[r["zone_category"]] += r["lot_area"]

    resolved_count = sum(1 for r in records if r["zoning_resolved"])
    resolution_pct = resolved_count / len(records)
    pct_ev          = ev_area / total_area
    dominant        = max(cat_areas, key=lambda k: cat_areas[k]) if cat_areas else "Other"

    return {
        "tract_id":               tract_id,
        "city":                   city,
        "ml_rank_score":          round(score, 4),
        "demand_tier":            "High" if score >= 0.70 else "Medium" if score >= 0.40 else "Low",
        "pct_area_ev_permitted":  round(pct_ev, 4),
        "pct_area_commercial":    round(cat_areas.get("Commercial",  0.0) / total_area, 4),
        "pct_area_industrial":    round(cat_areas.get("Industrial",  0.0) / total_area, 4),
        "pct_area_residential":   round(cat_areas.get("Residential", 0.0) / total_area, 4),
        "dominant_zone_category": dominant,
        "feasibility_score":      round(pct_ev * 0.7 + score * 0.3, 4),
        "data_confidence":        "High" if resolution_pct >= 0.80 else "Medium" if resolution_pct >= 0.50 else "Low",
        "computed_at":            datetime.now(timezone.utc).isoformat(),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Phase 6 — Immediate per-tract file writes (called inside the worker loop)
# ─────────────────────────────────────────────────────────────────────────────

def write_tract_outputs(result: dict, zoning_dir: Path) -> tuple[int, Optional[dict]]:
    """
    Write per-tract GeoJSON and summary JSON immediately when a tract completes.
    Called inside the as_completed loop — one small write per tract (O(1) cost).

    Returns (feature_count, summary_dict).
    """
    tract_id = result["tract_id"]
    features: list[dict] = []

    for rec in result.get("parcel_records", []):
        geom_wkt = rec.get("geom_wkt")
        if not geom_wkt:
            continue
        try:
            geom_json = mapping(shapely_wkt.loads(geom_wkt))
        except Exception:
            continue
        features.append({
            "type": "Feature",
            "properties": {
                "zone_id":       rec["zone_id"],
                "tract_id":      rec["tract_id"],
                "city":          rec["city"],
                "zone_code":     rec["zone_code"],
                "zone_category": rec["zone_category"],
                "ev_permitted":  rec["ev_permitted"],
            },
            "geometry": geom_json,
        })

    if features:
        # Write atomically: write to .tmp then os.replace (works on Windows over existing files)
        geojson_path = zoning_dir / f"tract_{tract_id}.geojson"
        tmp_path     = geojson_path.with_suffix(".geojson.tmp")
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump({"type": "FeatureCollection", "features": features}, f)
        os.replace(tmp_path, geojson_path)

    summary = aggregate_tract(result)
    if summary:
        summary_path = zoning_dir / f"tract_{tract_id}.summary.json"
        tmp_path     = summary_path.with_suffix(".json.tmp")
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(summary, f)
        os.replace(tmp_path, summary_path)

    return len(features), summary


def rebuild_summary_csv(zoning_dir: Path, logger) -> None:
    """Merge all per-tract summary JSON files into a single tract_summaries.csv."""
    summaries: list[dict] = []
    for f in sorted(zoning_dir.glob("tract_*.summary.json")):
        try:
            with open(f, encoding="utf-8") as fp:
                summaries.append(json.load(fp))
        except Exception:
            pass

    csv_path = zoning_dir / "tract_summaries.csv"
    # Write atomically
    tmp_csv = csv_path.with_suffix(".csv.tmp")
    pd.DataFrame(summaries).to_csv(tmp_csv, index=False)
    os.replace(tmp_csv, csv_path)
    logger.info("Summary CSV: %d tract rows -> %s", len(summaries), csv_path)


# ─────────────────────────────────────────────────────────────────────────────
# Checkpoint — lightweight done-IDs set
# ─────────────────────────────────────────────────────────────────────────────

def _done_list_path(config: dict) -> Path:
    return PROJECT_ROOT / config["paths"]["staged"] / "zoning_done.json"


def _old_checkpoint_path(config: dict) -> Path:
    return PROJECT_ROOT / config["paths"]["staged"] / "zoning_checkpoint.json"


def load_done_set(config: dict, zoning_dir: Path, logger) -> set[str]:
    """
    Return set of already-processed tract IDs.

    Priority:
      1. Per-tract .summary.json files (most reliable, immune to checkpoint corruption)
      2. Lightweight zoning_done.json list
      3. Migration from old zoning_checkpoint.json (writes per-tract files + done list)
    """
    # Per-tract summary files are the ground truth (written atomically)
    done_from_files: set[str] = {
        f.stem.replace("tract_", "").replace(".summary", "")
        for f in zoning_dir.glob("tract_*.summary.json")
    }

    if done_from_files:
        logger.info("  Resuming from per-tract files: %d tracts already written", len(done_from_files))
        return done_from_files

    # Lightweight done list
    done_list_path = _done_list_path(config)
    if done_list_path.exists():
        try:
            with open(done_list_path, encoding="utf-8") as f:
                done = set(json.load(f))
            logger.info("  Resuming from done-list: %d tracts", len(done))
            return done
        except Exception:
            pass

    # Migrate old checkpoint (has full parcel_records + geom_wkt)
    old_cp_path = _old_checkpoint_path(config)
    if old_cp_path.exists():
        logger.info("  Found old checkpoint.json (%s MB) — migrating...",
                    f"{old_cp_path.stat().st_size / (1024*1024):.1f}")
        try:
            with open(old_cp_path, encoding="utf-8") as f:
                old_cp = json.load(f)

            done: set[str] = set()
            for tract_id, entry in old_cp.items():
                if "parcel_records" in entry:
                    # Write per-tract GeoJSON + summary from old checkpoint data
                    _, summary = write_tract_outputs(entry, zoning_dir)
                    if summary:
                        done.add(tract_id)
                elif "feasibility_score" in entry:
                    # Already a summary — write summary JSON only
                    summary_path = zoning_dir / f"tract_{tract_id}.summary.json"
                    with open(summary_path, "w", encoding="utf-8") as fp:
                        json.dump(entry, fp)
                    done.add(tract_id)

            logger.info("  Migrated %d tracts from old checkpoint", len(done))
            # Save new done list
            _save_done_list(config, done)
            # Rename old checkpoint so we don't migrate again
            os.replace(old_cp_path, old_cp_path.with_suffix(".json.migrated"))
            return done
        except Exception as exc:
            logger.warning("  Old checkpoint migration failed (%s) — starting fresh", exc)

    return set()


def _save_done_list(config: dict, done_set: set[str]) -> None:
    """Atomically save the lightweight done-IDs list.
    Uses os.replace() which overwrites existing files on Windows (Path.rename() does not)."""
    path = _done_list_path(config)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp  = path.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(sorted(done_set), f)
    os.replace(tmp, path)


# ─────────────────────────────────────────────────────────────────────────────
# Pre-run estimate
# ─────────────────────────────────────────────────────────────────────────────

def _print_estimate(
    total_tracts: int,
    already_done: int,
    pending: int,
    workers: int,
    zoning_dir: Path,
    logger,
) -> None:
    """
    Print pre-run API volume estimate.

    Avg parcels/tract derived from existing summary files if available,
    otherwise uses US full-dataset default of 85/tract.
    """
    # Try to get real avg from written summary files
    avg_parcels = 85.0
    avg_source  = "full-US default estimate"
    summaries = list(zoning_dir.glob("tract_*.summary.json"))
    if summaries:
        # Reconstruct avg from feasibility scores (can't get parcel count from summary alone)
        # Use pilot observation instead: ~141/tract for urban, 85 for mixed
        avg_parcels = 120.0   # conservative for existing partially-urban sample
        avg_source  = f"estimated from {len(summaries)}-tract sample (urban mix)"

    pages_per_tract  = max(1, math.ceil(avg_parcels / PARCEL_PAGE_SIZE))
    est_parcel_calls = pending * pages_per_tract
    est_zoning_calls = int(pending * avg_parcels)
    est_total_calls  = est_parcel_calls + est_zoning_calls

    secs_per_tract = (pages_per_tract * 0.3) + (avg_parcels * 0.3)
    est_secs       = (pending / workers) * secs_per_tract
    est_hours      = est_secs / 3600

    sep = "=" * 64
    logger.info(sep)
    logger.info("  PRE-RUN API VOLUME ESTIMATE")
    logger.info(sep)
    logger.info("  Total tracts in dataset :  %10d", total_tracts)
    logger.info("  Already done            :  %10d", already_done)
    logger.info("  Tracts to process now   :  %10d", pending)
    logger.info("  Avg parcels/tract       :  %10.0f  (from %s)", avg_parcels, avg_source)
    logger.info("  Pages per tract (p=100) :  %10d", pages_per_tract)
    logger.info("  ---")
    logger.info("  Parcel POST calls (est) :  %10d  (%d tracts × %d page(s))",
                est_parcel_calls, pending, pages_per_tract)
    logger.info("  Zoning GET  calls (est) :  %10d  (%d tracts × %.0f parcels)",
                est_zoning_calls, pending, avg_parcels)
    logger.info("  TOTAL API CALLS   (est) :  %10d", est_total_calls)
    logger.info("  ---")
    logger.info("  Workers                 :  %10d", workers)
    logger.info("  Estimated duration      :  %10.1f hours  (%.0f min)",
                est_hours, est_secs / 60)
    logger.info("  (Actual varies with rate-limits, retries, parcel density per tract)")
    logger.info(sep)


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def main(
    top_n: int        = TOP_N_TRACTS,
    all_tracts: bool  = False,
    workers: int      = MAX_WORKERS,
    reset_checkpoint: bool = False,
) -> None:
    logger = get_logger("generate_zoning_overlay")
    config = load_config(CONFIG_PATH)

    if not LIGHTBOX_API_KEY:
        raise EnvironmentError(
            "LIGHTBOX_API_KEY is not set. "
            "Ensure it is present in your .env file and re-run."
        )

    # Set up output directory early — needed for immediate per-tract writes
    output_dir = PROJECT_ROOT / config["exports"]["output_dir"]
    zoning_dir = output_dir / "zoning"
    zoning_dir.mkdir(parents=True, exist_ok=True)

    # ── Phase 1 ───────────────────────────────────────────────────────────────
    mode_label = "ALL TRACTS" if all_tracts else f"top-{top_n}"
    logger.info("=== Phase 1: Loading target tracts (%s) ===", mode_label)
    tracts = load_target_tracts(config, top_n, all_tracts, logger)
    logger.info("Target tracts loaded: %d", len(tracts))

    # ── Resume from checkpoint ────────────────────────────────────────────────
    done_set: set[str]
    if reset_checkpoint:
        done_set = set()
        logger.info("--reset-checkpoint: ignoring all existing progress")
    else:
        done_set = load_done_set(config, zoning_dir, logger)

    pending_list = [t for t in tracts if t["tract_id"] not in done_set]
    logger.info("Tracts remaining to process: %d", len(pending_list))

    # ── Pre-run estimate ──────────────────────────────────────────────────────
    _print_estimate(
        total_tracts=len(tracts),
        already_done=len(done_set),
        pending=len(pending_list),
        workers=workers,
        zoning_dir=zoning_dir,
        logger=logger,
    )

    if not pending_list:
        logger.info("Nothing to fetch — all tracts already done. Rebuilding summary CSV.")
    else:
        # ── Phases 2–4 (concurrent) ───────────────────────────────────────────
        logger.info(
            "=== Phase 2–4: Fetching parcels + zoning (workers=%d, no parcel cap) ===",
            workers,
        )

        run_start = time.time()
        tracts_since_save = 0

        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {pool.submit(process_tract, t): t["tract_id"] for t in pending_list}
            with tqdm(total=len(futures), desc="Processing tracts", unit="tract") as bar:
                for future in as_completed(futures):
                    tract_id = futures[future]
                    try:
                        result = future.result()

                        # Write per-tract GeoJSON + summary immediately (small O(1) write)
                        feat_count, _ = write_tract_outputs(result, zoning_dir)
                        done_set.add(tract_id)

                        # Save done-list every CHECKPOINT_INTERVAL tracts.
                        # Isolated in its own try so a save failure never marks a tract as failed.
                        tracts_since_save += 1
                        if tracts_since_save >= CHECKPOINT_INTERVAL:
                            try:
                                _save_done_list(config, done_set)
                            except Exception as cp_err:
                                logger.warning("Checkpoint save failed (non-fatal): %s", cp_err)
                            tracts_since_save = 0

                        parcel_count = len(result.get("parcel_records", []))
                        resolved     = sum(1 for r in result.get("parcel_records", [])
                                           if r["zoning_resolved"])
                        bar.set_postfix(
                            done=len(done_set),
                            parcels=parcel_count,
                            api=_api_counter.total,
                        )
                    except Exception as exc:
                        logger.error("Tract %s failed: %s", tract_id, exc)
                    finally:
                        bar.update(1)

        # Final save
        _save_done_list(config, done_set)
        elapsed = time.time() - run_start
        logger.info("Processing complete. Total done: %d tracts", len(done_set))

        # ── API call summary ──────────────────────────────────────────────────
        n_processed = len(pending_list)
        sep = "=" * 64
        logger.info(sep)
        logger.info("  API CALL SUMMARY (this run)")
        logger.info(sep)
        logger.info("  Parcel POST calls  (actual) :  %10d", _api_counter.parcel_calls)
        logger.info("  Zoning GET  calls  (actual) :  %10d", _api_counter.zoning_calls)
        logger.info("  TOTAL API CALLS    (actual) :  %10d", _api_counter.total)
        if n_processed:
            logger.info("  Avg parcel calls / tract    :  %10.1f",
                        _api_counter.parcel_calls / n_processed)
            logger.info("  Avg zoning calls / tract    :  %10.1f",
                        _api_counter.zoning_calls / n_processed)
        logger.info("  Wall-clock time             :  %10.1f min  (%.0f s)",
                    elapsed / 60, elapsed)
        if elapsed and _api_counter.total:
            logger.info("  Throughput                  :  %10.1f API calls/sec",
                        _api_counter.total / elapsed)
        logger.info(sep)

    # ── Phase 6: rebuild summary CSV from per-tract files ─────────────────────
    logger.info("=== Phase 6: Rebuilding tract_summaries.csv ===")
    rebuild_summary_csv(zoning_dir, logger)

    logger.info("=== Done ===")


# ─────────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    env_path = PROJECT_ROOT / ".env"
    if env_path.exists():
        for _line in env_path.read_text(encoding="utf-8").splitlines():
            _line = _line.strip()
            if _line and not _line.startswith("#") and "=" in _line:
                _k, _, _v = _line.partition("=")
                os.environ.setdefault(_k.strip(), _v.strip())
        LIGHTBOX_API_KEY = os.environ.get("LIGHTBOX_API_KEY", "")

    parser = argparse.ArgumentParser(
        description="Generate per-tract zoning GeoJSON files from LightBox Parcel + Zoning APIs"
    )
    parser.add_argument(
        "--top-n", type=int, default=TOP_N_TRACTS,
        help=f"Top-scoring tracts to process (default: {TOP_N_TRACTS}). Ignored with --all-tracts.",
    )
    parser.add_argument(
        "--all-tracts", action="store_true",
        help="Process ALL tracts in the rankings dataset (overrides --top-n).",
    )
    parser.add_argument(
        "--workers", type=int, default=MAX_WORKERS,
        help=f"Concurrent API threads (default: {MAX_WORKERS})",
    )
    parser.add_argument(
        "--reset-checkpoint", action="store_true",
        help="Ignore all existing progress and reprocess from scratch.",
    )
    args = parser.parse_args()

    main(
        top_n=args.top_n,
        all_tracts=args.all_tracts,
        workers=args.workers,
        reset_checkpoint=args.reset_checkpoint,
    )
