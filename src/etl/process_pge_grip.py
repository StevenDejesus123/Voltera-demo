"""
process_pge_grip.py — Phase 3.4 PG&E GRIP Data Processor

Converts PG&E GRIP download files (GRIP_SHP.zip + San Francisco.zip) into the
three GeoJSON files expected by generate_grid_features.py:

  data/inputs/utility_grid/pge/ica_segments.geojson
  data/inputs/utility_grid/pge/substations.geojson
  data/inputs/utility_grid/pge/service_territory.geojson

Data sources used
─────────────────
  GRIP_SHP/LGP_SHP.zip          — LGPProcessedDeltaData (_0 … _14)
      Tabular ICA values per line section (all of PG&E, scenario 90 pre-filtered)
      Columns: linesecid, feederid, division, gica_MM_HH (12 months × 24 hours)

  GRIP_SHP/GRIP_SHP.zip         — ICAEstimatedCapacitySummary.shp
      Line section polyline geometry for all of PG&E (1.28 M rows)
      Join key: csv_linese → linesecid

  GRIP_SHP/GRIP_SHP.zip         — EDSubstations.shp
      Distribution substation point locations (705 substations, full PG&E)

  data/National Utility Boundary Map.kmz  (client-provided)
      Service territory polygon for PG&E, used for in_pge_territory flag

ICA capacity aggregation
────────────────────────
  load_hosting_capacity_kw = mean of all 288 gica_MM_HH values (12 × 24)
      Sections with frequent grid congestion (many 0-kW hours) score low;
      sections with consistent headroom score high. Better for ranking than
      min (which is nearly always 0) or max (which ignores congestion).

  pv_hosting_capacity_kw = NaN (not present in LGP layer; use GICA CSVs if needed)

Usage
─────
  python -m src.etl.process_pge_grip
  python -m src.etl.process_pge_grip --skip-territory
"""

from __future__ import annotations

import argparse
import io
import os
import shutil
import tempfile
import zipfile
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd

from src.utils.logging_utils import get_logger

# ── Paths ──────────────────────────────────────────────────────────────────────

PROJECT_ROOT = Path(__file__).resolve().parents[2]

PGE_DIR         = PROJECT_ROOT / "data" / "inputs" / "utility_grid" / "pge"
GRIP_SHP_ZIP    = PGE_DIR / "GRIP_SHP.zip"
KMZ_PATH        = PROJECT_ROOT / "data" / "National Utility Boundary Map.kmz"

OUT_ICA         = PGE_DIR / "ica_segments.geojson"
OUT_SUBST       = PGE_DIR / "substations.geojson"
OUT_TERRITORY   = PGE_DIR / "service_territory.geojson"

# ── Helpers ────────────────────────────────────────────────────────────────────

def _extract_layer_to_tmpdir(
    inner_zip_bytes: bytes,
    layer_name: str,
    prefix: str = "GRIP_SHP/",
) -> str | None:
    """
    Extract all files for `layer_name` from an in-memory zip to a temp directory.
    Returns the temp dir path (caller must shutil.rmtree it), or None if not found.
    """
    tmpdir = tempfile.mkdtemp()
    found = False
    with zipfile.ZipFile(io.BytesIO(inner_zip_bytes)) as inner:
        for fname in inner.namelist():
            base = fname.replace(prefix, "")
            if base.startswith(layer_name + "."):
                data = inner.read(fname)
                out_path = os.path.join(tmpdir, base)
                os.makedirs(os.path.dirname(out_path), exist_ok=True)
                with open(out_path, "wb") as f:
                    f.write(data)
                found = True
    if not found:
        shutil.rmtree(tmpdir)
        return None
    return tmpdir


def _read_shapefile_from_zip(inner_zip_bytes: bytes, layer_name: str, prefix: str = "GRIP_SHP/") -> gpd.GeoDataFrame | None:
    """Read a shapefile layer from an in-memory zip bytes."""
    tmpdir = _extract_layer_to_tmpdir(inner_zip_bytes, layer_name, prefix)
    if tmpdir is None:
        return None
    try:
        shp_path = os.path.join(tmpdir, layer_name + ".shp")
        if not os.path.exists(shp_path):
            return None
        return gpd.read_file(shp_path)
    finally:
        shutil.rmtree(tmpdir)


# ── Step 1: Aggregate LGP tabular ICA data ────────────────────────────────────

def _load_lgp_data(lgp_zip_bytes: bytes, logger) -> pd.DataFrame:
    """
    Read all LGPProcessedDeltaData parts from LGP_SHP.zip.
    Aggregate per linesecid: mean of all gica_MM_HH columns → load_hosting_capacity_kw.
    Returns a DataFrame with columns: linesecid, feederid, division, load_hosting_capacity_kw.
    """
    # Column names for all 12 months × 24 hours
    gica_cols = [f"gica_{m:02d}_{h:02d}" for m in range(1, 13) for h in range(24)]

    parts: list[pd.DataFrame] = []

    with zipfile.ZipFile(io.BytesIO(lgp_zip_bytes)) as lgp_zip:
        layer_names = sorted(set(
            n.replace("LGP_SHP/", "").rsplit(".", 1)[0]
            for n in lgp_zip.namelist()
            if n.startswith("LGP_SHP/LGPProcessedDeltaData") and "." in n
        ))

    logger.info("  Found %d LGP layer(s): %s", len(layer_names), layer_names)

    for layer_name in layer_names:
        tmpdir = _extract_layer_to_tmpdir(lgp_zip_bytes, layer_name, prefix="LGP_SHP/")
        if tmpdir is None:
            logger.warning("  Could not extract %s — skipping", layer_name)
            continue
        try:
            shp_path = os.path.join(tmpdir, layer_name + ".shp")
            if not os.path.exists(shp_path):
                logger.warning("  .shp not found for %s — skipping", layer_name)
                continue
            gdf = gpd.read_file(shp_path)
            logger.info("  Loaded %s: %d rows", layer_name, len(gdf))

            # Keep only relevant columns
            keep = ["linesecid", "feederid", "division", "loadscenar"] + [
                c for c in gica_cols if c in gdf.columns
            ]
            df = pd.DataFrame(gdf[keep])
            parts.append(df)
        finally:
            shutil.rmtree(tmpdir)

    if not parts:
        logger.error("No LGP data loaded — ica_segments.geojson will be empty")
        return pd.DataFrame(columns=["linesecid", "feederid", "division", "load_hosting_capacity_kw"])

    combined = pd.concat(parts, ignore_index=True)
    logger.info("  Total LGP rows before aggregation: %d", len(combined))

    # Filter to scenario 90 (should already be pre-filtered, but guard anyway)
    scen_col = "loadscenar"
    if scen_col in combined.columns:
        combined = combined[combined[scen_col].astype(str) == "90"]
        logger.info("  Rows after scenario-90 filter: %d", len(combined))

    # Identify which gica columns are actually present
    present_gica = [c for c in gica_cols if c in combined.columns]
    if not present_gica:
        logger.error("No gica_MM_HH columns found in LGP data")
        return pd.DataFrame(columns=["linesecid", "feederid", "division", "load_hosting_capacity_kw"])

    logger.info("  Using %d gica_MM_HH columns for aggregation", len(present_gica))

    # Aggregate: mean of all 288 hour/month ICA values per line section.
    # Clip negatives to 0 first — negative values mean the section is already
    # over capacity (constraint violation); they should count as 0 headroom.
    # This gives a "typical hourly headroom" metric — penalises sections
    # that are frequently at capacity (many 0-kW hours).
    combined[present_gica] = combined[present_gica].clip(lower=0)
    combined["load_hosting_capacity_kw"] = combined[present_gica].mean(axis=1)

    # One row per linesecid (take first feederid/division if duplicated)
    agg = (
        combined[["linesecid", "feederid", "division", "load_hosting_capacity_kw"]]
        .groupby("linesecid", sort=False)
        .agg(
            feederid=("feederid", "first"),
            division=("division", "first"),
            load_hosting_capacity_kw=("load_hosting_capacity_kw", "mean"),
        )
        .reset_index()
    )
    logger.info(
        "  Aggregated to %d unique line sections. "
        "Capacity: min=%.0f  median=%.0f  max=%.0f kW",
        len(agg),
        agg["load_hosting_capacity_kw"].min(),
        agg["load_hosting_capacity_kw"].median(),
        agg["load_hosting_capacity_kw"].max(),
    )
    return agg


# ── Step 2: Join LGP aggregates to ICAEstimatedCapacitySummary geometry ───────

def _build_ica_segments(grip_zip_bytes: bytes, lgp_agg: pd.DataFrame, logger) -> gpd.GeoDataFrame | None:
    """
    Load ICAEstimatedCapacitySummary shapefile, inner-join with lgp_agg on
    csv_linese = linesecid, return GeoDataFrame formatted for generate_grid_features.py.
    """
    logger.info("  Loading ICAEstimatedCapacitySummary shapefile (~1.28M rows) …")
    geom_gdf = _read_shapefile_from_zip(grip_zip_bytes, "ICAEstimatedCapacitySummary")
    if geom_gdf is None:
        logger.error("ICAEstimatedCapacitySummary not found in GRIP_SHP.zip")
        return None

    logger.info("  Loaded %d geometry rows (CRS: %s)", len(geom_gdf), geom_gdf.crs)

    # Ensure join keys are strings
    geom_gdf["csv_linese"] = geom_gdf["csv_linese"].astype(str).str.strip()
    lgp_agg["linesecid"]   = lgp_agg["linesecid"].astype(str).str.strip()

    # Inner join: only keep sections that have LGP capacity data
    merged = geom_gdf.merge(
        lgp_agg[["linesecid", "load_hosting_capacity_kw"]],
        left_on="csv_linese",
        right_on="linesecid",
        how="inner",
    )
    logger.info(
        "  Joined: %d / %d geometry rows matched LGP data",
        len(merged), len(geom_gdf),
    )

    # Build output GDF matching the schema expected by generate_grid_features.py
    out = gpd.GeoDataFrame(
        {
            "section_id":                merged["csv_linese"],
            "circuit_name":              merged["feederid"].fillna(""),
            "division":                  merged["division"].fillna(""),
            "load_hosting_capacity_kw":  merged["load_hosting_capacity_kw"].round(1),
            "pv_hosting_capacity_kw":    np.nan,   # not available from LGP layer
            "circuit_voltage_kv":        np.nan,   # not in ICA layer
            "utility":                   "pge",
        },
        geometry=merged.geometry,
        crs=geom_gdf.crs,
    )

    logger.info(
        "  ICA segments built: %d rows  CRS: %s",
        len(out), out.crs,
    )
    return out


# ── Step 3: Build substations GeoDataFrame ────────────────────────────────────

def _build_substations(grip_zip_bytes: bytes, logger) -> gpd.GeoDataFrame | None:
    """
    Load EDSubstations.shp and format for generate_grid_features.py.
    Fields: substation_name, substation_voltage_kv, remaining_capacity_mw (NaN), utility.
    """
    logger.info("  Loading EDSubstations shapefile …")
    gdf = _read_shapefile_from_zip(grip_zip_bytes, "EDSubstations")
    if gdf is None:
        logger.error("EDSubstations not found in GRIP_SHP.zip")
        return None

    logger.info("  Loaded %d substations (CRS: %s)", len(gdf), gdf.crs)

    def _parse_voltage(v) -> float:
        """Parse voltage string/number to float kV."""
        try:
            return float(str(v).split("/")[0].replace("kV", "").strip())
        except (ValueError, AttributeError):
            return np.nan

    out = gpd.GeoDataFrame(
        {
            "substation_name":       gdf["Substation"].fillna(""),
            "substation_voltage_kv": gdf["Voltage_kV"].apply(_parse_voltage),
            "remaining_capacity_mw": np.nan,  # not available in EDSubstations
            "existing_dg_kw":        pd.to_numeric(gdf.get("Existing_D"), errors="coerce"),
            "queued_dg_kw":          pd.to_numeric(gdf.get("Queued_DG"),  errors="coerce"),
            "division":              gdf.get("Division", pd.Series(dtype=str)).fillna(""),
            "utility":               "pge",
        },
        geometry=gdf.geometry,
        crs=gdf.crs,
    )

    logger.info(
        "  Substations built: %d rows  voltage range: %.0f–%.0f kV",
        len(out),
        out["substation_voltage_kv"].min(),
        out["substation_voltage_kv"].max(),
    )
    return out


# ── Step 4: Service territory from client KMZ ─────────────────────────────────

def _build_service_territory(logger) -> gpd.GeoDataFrame | None:
    """
    Extract PG&E's service territory polygon from the client-provided KMZ.
    Filters by exact utility name 'PACIFIC GAS & ELECTRIC CO.'
    """
    if not KMZ_PATH.exists():
        logger.warning("  KMZ not found at %s — skipping service territory", KMZ_PATH)
        return None

    logger.info("  Reading National Utility Boundary Map KMZ …")

    with zipfile.ZipFile(KMZ_PATH, "r") as z:
        kml_files = [n for n in z.namelist() if n.lower().endswith(".kml")]
        if not kml_files:
            logger.error("No .kml found inside the KMZ")
            return None

        tmpdir = tempfile.mkdtemp()
        try:
            kml_path = os.path.join(tmpdir, "territory.kml")
            with z.open(kml_files[0]) as src, open(kml_path, "wb") as dst:
                dst.write(src.read())
            gdf = gpd.read_file(kml_path, engine="pyogrio")
        finally:
            shutil.rmtree(tmpdir)

    logger.info("  KMZ loaded: %d records", len(gdf))

    name_col = next((c for c in ["Name", "name", "NAME"] if c in gdf.columns), None)
    if not name_col:
        logger.warning("  No name column found in KMZ — cannot filter to PG&E")
        return None

    pge = gdf[gdf[name_col].str.contains("Pacific Gas", case=False, na=False)].copy()

    if pge.empty:
        logger.warning("  No PG&E record found in KMZ")
        return None

    logger.info("  Found %d PG&E territory record(s)", len(pge))

    territory = pge[["geometry"]].copy()
    territory["utility"] = "pge"
    territory = territory.to_crs("EPSG:4326")
    return territory


# ── Main ───────────────────────────────────────────────────────────────────────

def main(skip_territory: bool = False) -> None:
    logger = get_logger("process_pge_grip")

    if not GRIP_SHP_ZIP.exists():
        logger.error("GRIP_SHP.zip not found at %s", GRIP_SHP_ZIP)
        return

    PGE_DIR.mkdir(parents=True, exist_ok=True)

    # Read the outer zip once and extract both inner zips into memory
    logger.info("=== Reading GRIP_SHP.zip ===")
    with zipfile.ZipFile(GRIP_SHP_ZIP, "r") as outer:
        grip_bytes = outer.read("GRIP_SHP/GRIP_SHP.zip")
        lgp_bytes  = outer.read("GRIP_SHP/LGP_SHP.zip")

    # ── 1. Aggregate LGP ICA data ─────────────────────────────────────────────
    logger.info("=== Step 1: Aggregate LGP ICA data (all PG&E divisions) ===")
    lgp_agg = _load_lgp_data(lgp_bytes, logger)

    # ── 2. Build ica_segments.geojson ─────────────────────────────────────────
    logger.info("=== Step 2: Build ica_segments.geojson ===")
    ica_gdf = _build_ica_segments(grip_bytes, lgp_agg, logger)
    if ica_gdf is not None and not ica_gdf.empty:
        ica_gdf.to_file(OUT_ICA, driver="GeoJSON")
        logger.info("  Written: %s  (%d features)", OUT_ICA, len(ica_gdf))
    else:
        logger.error("  ICA segments empty — skipping write")

    # ── 3. Build substations.geojson ──────────────────────────────────────────
    logger.info("=== Step 3: Build substations.geojson ===")
    subst_gdf = _build_substations(grip_bytes, logger)
    if subst_gdf is not None and not subst_gdf.empty:
        subst_gdf.to_file(OUT_SUBST, driver="GeoJSON")
        logger.info("  Written: %s  (%d features)", OUT_SUBST, len(subst_gdf))
    else:
        logger.error("  Substations empty — skipping write")

    # ── 4. Build service_territory.geojson ────────────────────────────────────
    if skip_territory:
        logger.info("=== Step 4: Skipping service territory (--skip-territory) ===")
    else:
        logger.info("=== Step 4: Build service_territory.geojson from KMZ ===")
        terr_gdf = _build_service_territory(logger)
        if terr_gdf is not None and not terr_gdf.empty:
            terr_gdf.to_file(OUT_TERRITORY, driver="GeoJSON")
            logger.info("  Written: %s  (%d feature(s))", OUT_TERRITORY, len(terr_gdf))
        else:
            logger.warning(
                "  Could not build service territory — in_pge_territory will be 0 everywhere. "
                "Re-run without --skip-territory once KMZ is available."
            )

    logger.info("=== Done. Run generate_grid_features.py to update grid_features_tract.csv ===")


if __name__ == "__main__":
    env_path = PROJECT_ROOT / ".env"
    if env_path.exists():
        for _line in env_path.read_text(encoding="utf-8").splitlines():
            _line = _line.strip()
            if _line and not _line.startswith("#") and "=" in _line:
                _k, _, _v = _line.partition("=")
                os.environ.setdefault(_k.strip(), _v.strip())

    parser = argparse.ArgumentParser(
        description="Process PG&E GRIP downloads into GeoJSON files for generate_grid_features.py"
    )
    parser.add_argument(
        "--skip-territory",
        action="store_true",
        default=False,
        help="Skip service territory extraction from KMZ (faster; in_pge_territory will be 0)",
    )
    args = parser.parse_args()
    main(skip_territory=args.skip_territory)
