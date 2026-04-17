"""
Aggregates tract-level site interaction outputs into higher-level geographic summaries.

This module consumes tract–site interaction outputs and produces aggregated
metrics at the tract, county, and MSA levels across configured buffer ranges.
The aggregations replicate legacy Tableau Prep logic and are designed to be
schema-stable for downstream ETL and modeling steps.

Key responsibilities:
- Aggregate interaction counts across buffer distances
- Roll up tract-level results to county and MSA geographies
- Enforce expected output schemas
- Produce Excel-ready outputs for downstream consumption

This module intentionally preserves legacy (Tableau prep) column naming conventions
for reproducability and to maintain compatibility with existing downstream pipelines.
"""


from __future__ import annotations

from pathlib import Path
from typing import Dict, List, Sequence

import pandas as pd

from src.utils.io_utils import read_csv
from src.utils.logging_utils import get_logger

logger = get_logger("aggregations")

BUFFERS: List[int] = [0, 1, 2, 3, 5, 25, 75, 100]


# ---------------------------------------------------------------------
# Internal helper functions
# ---------------------------------------------------------------------

def _require_columns(df: pd.DataFrame, required: Sequence[str], context: str) -> None:
    missing = [c for c in required if c not in df.columns]
    if missing:
        logger.error("[%s] Missing required columns: %s", context, missing)
        raise KeyError(f"[{context}] Missing required columns: {missing}")


def _require_file(path: Path, context: str) -> None:
    if not path.exists():
        logger.error("[%s] Required input file not found: %s", context, path)
        raise FileNotFoundError(f"[{context}] Required input file not found: {path}")


# ---------------------------------------------------------------------
# Function to aggregate site count, stall count at Tract Level
# ---------------------------------------------------------------------

def _build_tract_agg_for_buffer(
    buffer_miles: int,
    df_tract_site_interactions: pd.DataFrame,
    df_sites: pd.DataFrame,
) -> pd.DataFrame:
    """Return tract-level aggregation for a single buffer radius."""

    # 1) filter to buffer & make tract–site pairs
    pairs = (
        df_tract_site_interactions.loc[
            df_tract_site_interactions["Cover_Range"] == buffer_miles,
            ["Geoid", "Index_ID"],
        ]
        .rename(columns={"Geoid": "Tract_GeoID"})
        .copy()
    )

    pairs["Tract_GeoID"] = pairs["Tract_GeoID"].astype(str).str.zfill(11)
    pairs["Index_ID"] = pairs["Index_ID"].astype(str)
    pairs = pairs.drop_duplicates(subset=["Tract_GeoID", "Index_ID"])

    # 2) site metadata
    site_cols = [
        "Index_ID",
        "Site-Type",
        "Customer Segment",
        "Interested Party",
        "#_Stalls_Filled",
    ]
    site_meta = df_sites[site_cols].copy()
    site_meta["Index_ID"] = site_meta["Index_ID"].astype(str)
    site_meta["#_Stalls_Filled"] = pd.to_numeric(
        site_meta["#_Stalls_Filled"], errors="coerce"
    ).fillna(0)

    pairs_enriched = pairs.merge(
        site_meta, on="Index_ID", how="left", validate="many_to_one"
    )

    # 3) aggregate
    tract_agg = (
        pairs_enriched.groupby(
            ["Tract_GeoID", "Site-Type", "Customer Segment", "Interested Party"],
            dropna=False,
        )
        .agg(
            Number_Customer_Sites=("Index_ID", "nunique"),
            Total_Num_Stalls=("#_Stalls_Filled", "sum"),
        )
        .reset_index()
    )

    # 4) rename + add Range_Cover + reorder
    tract_agg = tract_agg.rename(
        columns={
            "Tract_GeoID": "Tract_Geoid",
            "Number_Customer_Sites": "Number of Customer Sites",
            "Total_Num_Stalls": "Total_#_Stalls",
        }
    )
    tract_agg["Range_Cover"] = buffer_miles

    tract_agg = tract_agg[
        [
            "Range_Cover",
            "Tract_Geoid",
            "Number of Customer Sites",
            "Site-Type",
            "Customer Segment",
            "Interested Party",
            "Total_#_Stalls",
        ]
    ]

    return tract_agg


# ---------------------------------------------------------------------
# Function to aggregate at County Level
# ---------------------------------------------------------------------

def _build_county_agg_for_buffer(
    buffer_miles: int,
    df_tract_site_interactions: pd.DataFrame,
    df_sites: pd.DataFrame,
) -> pd.DataFrame:
    """Return county-level aggregation for a single buffer radius."""

    # 1) tract–site pairs for this buffer
    pairs = (
        df_tract_site_interactions.loc[
            df_tract_site_interactions["Cover_Range"] == buffer_miles,
            ["Geoid", "Index_ID"],
        ]
        .rename(columns={"Geoid": "Tract_GeoID"})
        .copy()
    )
    pairs["Tract_GeoID"] = pairs["Tract_GeoID"].astype(str).str.zfill(11)
    pairs["Index_ID"] = pairs["Index_ID"].astype(str)
    pairs = pairs.drop_duplicates(["Tract_GeoID", "Index_ID"])

    # 2) derive county IDs from Tract IDs
    county_pairs = pairs.copy()
    county_pairs["County_GeoID"] = county_pairs["Tract_GeoID"].str[:5]
    county_pairs = county_pairs.drop_duplicates(["County_GeoID", "Index_ID"])

    # 3) site metadata
    site_cols = [
        "Index_ID",
        "Site-Type",
        "Customer Segment",
        "Interested Party",
        "#_Stalls_Filled",
    ]
    site_meta = df_sites[site_cols].copy()
    site_meta["Index_ID"] = site_meta["Index_ID"].astype(str)
    site_meta["#_Stalls_Filled"] = pd.to_numeric(
        site_meta["#_Stalls_Filled"], errors="coerce"
    ).fillna(0)

    county_pairs_enriched = county_pairs.merge(
        site_meta, on="Index_ID", how="left", validate="many_to_one"
    )

    # 4) aggregate
    county_agg = (
        county_pairs_enriched.groupby(
            ["County_GeoID", "Site-Type", "Customer Segment", "Interested Party"],
            dropna=False,
        )
        .agg(
            Count_Customer_Sites=("Index_ID", "nunique"),
            Total_Stalls_Filled=("#_Stalls_Filled", "sum"),
        )
        .reset_index()
    )

    # 5) final schema
    county_agg["Range_Cover"] = buffer_miles
    county_agg = county_agg[
        [
            "Range_Cover",
            "County_GeoID",
            "Count_Customer_Sites",
            "Site-Type",
            "Customer Segment",
            "Interested Party",
            "Total_Stalls_Filled",
        ]
    ]

    return county_agg


# ---------------------------------------------------------------------
# Function to map MSA with county id
# ---------------------------------------------------------------------

def _build_msa_map(df_geocodemap: pd.DataFrame) -> pd.DataFrame:
    """Build static County_GeoID --> MSA_Name lookup."""

    msa_map = (
        df_geocodemap.loc[
            ~df_geocodemap["Metropolitan Division Code"].isna(),
            ["CLEAN_County Geoid", "Metropolitan Division Code"],
        ]
        .rename(
            columns={
                "CLEAN_County Geoid": "County_GeoID",
                "Metropolitan Division Code": "MSA_Name",
            }
        )
        .copy()
    )
    msa_map["County_GeoID"] = msa_map["County_GeoID"].astype(str).str.zfill(5)
    msa_map = msa_map.drop_duplicates(["County_GeoID", "MSA_Name"])

    return msa_map


# ---------------------------------------------------------------------
# Function to aggregate at MSA Level
# ---------------------------------------------------------------------

def _build_msa_agg_for_buffer(
    buffer_miles: int,
    df_tract_site_interactions: pd.DataFrame,
    df_sites: pd.DataFrame,
    msa_map: pd.DataFrame,
) -> pd.DataFrame:
    """Return MSA-level aggregation for a single buffer radius."""

    # 1) tract–site pairs for this buffer
    pairs = (
        df_tract_site_interactions.loc[
            df_tract_site_interactions["Cover_Range"] == buffer_miles,
            ["Geoid", "Index_ID"],
        ]
        .rename(columns={"Geoid": "Tract_GeoID"})
        .copy()
    )
    pairs["Tract_GeoID"] = pairs["Tract_GeoID"].astype(str).str.zfill(11)
    pairs["Index_ID"] = pairs["Index_ID"].astype(str)
    pairs = pairs.drop_duplicates(["Tract_GeoID", "Index_ID"])

    # 2) map to county --> MSA
    msa_pairs = pairs.copy()
    msa_pairs["County_GeoID"] = msa_pairs["Tract_GeoID"].str[:5]
    msa_pairs["County_GeoID"] = msa_pairs["County_GeoID"].astype(str).str.zfill(5)

    msa_pairs = msa_pairs.merge(msa_map, on="County_GeoID", how="left")
    msa_pairs = msa_pairs.dropna(subset=["MSA_Name"])

    # unique (MSA, site) combos
    msa_pairs = msa_pairs.drop_duplicates(["MSA_Name", "Index_ID"])

    # 3) site metadata
    site_cols = [
        "Index_ID",
        "Site-Type",
        "Customer Segment",
        "Interested Party",
        "#_Stalls_Filled",
    ]
    site_meta = df_sites[site_cols].copy()
    site_meta["Index_ID"] = site_meta["Index_ID"].astype(str)
    site_meta["#_Stalls_Filled"] = pd.to_numeric(
        site_meta["#_Stalls_Filled"], errors="coerce"
    ).fillna(0)

    msa_pairs_enriched = msa_pairs.merge(
        site_meta, on="Index_ID", how="left", validate="many_to_one"
    )

    # 4) aggregate to MSA-level
    msa_agg = (
        msa_pairs_enriched.groupby(
            ["MSA_Name", "Site-Type", "Customer Segment", "Interested Party"],
            dropna=False,
        )
        .agg(
            Count_Customer_Sites=("Index_ID", "nunique"),
            Total_Stalls_Filled=("#_Stalls_Filled", "sum"),
        )
        .reset_index()
    )

    # 5) final schema
    msa_agg["Range_Cover"] = buffer_miles
    msa_agg = msa_agg[
        [
            "Range_Cover",
            "MSA_Name",
            "Count_Customer_Sites",
            "Site-Type",
            "Customer Segment",
            "Interested Party",
            "Total_Stalls_Filled",
        ]
    ]

    # rename to match Tableau: "Metropolitan Division Code"
    msa_agg = msa_agg.rename(columns={"MSA_Name": "Metropolitan Division Code"})

    return msa_agg


# ---------------------------------------------------------------------
# Main function to aggregate for all spatial levels for all buffer radii
# ---------------------------------------------------------------------

def run_aggregations(config: Dict) -> str:
    """
    Main entrypoint for Step 3.4 - Aggregations (Tract / County / MSA).

    Returns
    -------
    str
        Path to final Excel workbook with Tract / County / MSA sheets.
    """

    logger.info("Starting Step 3.4 - Aggregations (Tract / County / MSA)")

    # --- Resolve paths from config ---
    paths = config["paths"]
    filenames = config["filenames"]

    staged_dir = Path(paths["staged"])
    mastergeo_dir = Path(paths["inputs"]["mastergeocode"])

    #Input files
    tract_site_path = staged_dir / filenames["tract_site_interactions_refactored"]
    clean_sites_path = staged_dir / filenames["cleaned_sites_refactored"]
    geocode_path = mastergeo_dir / filenames["master_geocode"]

    #Output files
    output_path = staged_dir / filenames["aggregations_refactored"]

    # --- Fail fast on missing files ---
    _require_file(tract_site_path, "aggregations")
    _require_file(clean_sites_path, "aggregations")
    _require_file(geocode_path, "aggregations")

    # --- Load inputs ---
    logger.info("Loading tract–site interactions from: %s", tract_site_path)
    df_tract_site_interactions = read_csv(tract_site_path)

    logger.info("Loading cleaned sites from: %s", clean_sites_path)
    df_sites = read_csv(clean_sites_path)

    logger.info("Loading geocode master from: %s", geocode_path)
    df_geocodemap = pd.read_excel(geocode_path, sheet_name="MasterGeocodeMap")

    # --- Normalize column names ---
    df_tract_site_interactions.columns = df_tract_site_interactions.columns.str.strip()
    df_sites.columns = df_sites.columns.str.strip()
    df_geocodemap.columns = df_geocodemap.columns.str.strip()

    # --- Schema enforcement ---
    _require_columns(
        df_tract_site_interactions,
        ["Cover_Range", "Geoid", "Index_ID"],
        str(tract_site_path),
    )

    _require_columns(
        df_sites,
        ["Index_ID", "Site-Type", "Customer Segment", "Interested Party", "#_Stalls_Filled"],
        str(clean_sites_path),
    )

    _require_columns(
        df_geocodemap,
        ["CLEAN_County Geoid", "Metropolitan Division Code"],
        str(geocode_path),
    )

    # --- Type normalization  ---
    df_tract_site_interactions["Geoid"] = df_tract_site_interactions["Geoid"].astype(str)
    df_tract_site_interactions["Index_ID"] = df_tract_site_interactions["Index_ID"].astype(str)
    df_sites["Index_ID"] = df_sites["Index_ID"].astype(str)

    # Cover_Range should be numeric
    df_tract_site_interactions["Cover_Range"] = pd.to_numeric(
        df_tract_site_interactions["Cover_Range"], errors="coerce"
    )

    if df_tract_site_interactions["Cover_Range"].isna().any():
        n_bad = int(df_tract_site_interactions["Cover_Range"].isna().sum())
        logger.error(
            "[aggregations] %s rows have non-numeric Cover_Range in tract_site_interactions.",
            n_bad,
        )
        raise ValueError(
            "[aggregations] Non-numeric Cover_Range detected in tract_site_interactions."
        )

    available_ranges = sorted(df_tract_site_interactions["Cover_Range"].unique().tolist())
    logger.info("Available Cover_Range values: %s", available_ranges)

    # Warn if any expected buffer radii are missing (not fatal; upstream might change)
    missing_ranges = [r for r in BUFFERS if r not in set(available_ranges)]
    if missing_ranges:
        logger.warning(
            "[aggregations] Missing expected Cover_Range values in interactions: %s. "
            "Outputs for these radii may be empty.",
            missing_ranges,
        )

    # --- Tract aggregations ---
    tract_frames = []
    for r in BUFFERS:
        logger.info("Building tract-level aggregations for radius=%s miles", r)
        tract_frames.append(
            _build_tract_agg_for_buffer(r, df_tract_site_interactions, df_sites)
        )
    tract_agg_all = pd.concat(tract_frames, ignore_index=True)
    logger.info("Combined tract_agg_all shape: %s", tract_agg_all.shape)

    # --- County aggregations ---
    county_frames = []
    for r in BUFFERS:
        logger.info("Building county-level aggregations for radius=%s miles", r)
        county_frames.append(
            _build_county_agg_for_buffer(r, df_tract_site_interactions, df_sites)
        )
    county_agg_all = pd.concat(county_frames, ignore_index=True)
    logger.info("county_agg_all shape: %s", county_agg_all.shape)

    # --- MSA aggregations ---
    msa_map = _build_msa_map(df_geocodemap)
    if len(msa_map) == 0:
        logger.error("[aggregations] MSA map is empty. Check MasterGeocodeMap inputs.")
        raise ValueError("[aggregations] MSA map is empty; cannot compute MSA aggregations.")

    msa_frames = []
    for r in BUFFERS:
        logger.info("Building MSA-level aggregations for radius=%s miles", r)
        msa_frames.append(
            _build_msa_agg_for_buffer(r, df_tract_site_interactions, df_sites, msa_map)
        )
    msa_agg_all = pd.concat(msa_frames, ignore_index=True)
    logger.info("msa_agg_all shape: %s", msa_agg_all.shape)

    # --- Output sanity checks ---
    if len(tract_agg_all) == 0:
        logger.error("[aggregations] Tract aggregation output is empty.")
        raise ValueError("[aggregations] Tract aggregation output is empty.")
    if len(county_agg_all) == 0:
        logger.error("[aggregations] County aggregation output is empty.")
        raise ValueError("[aggregations] County aggregation output is empty.")
    if len(msa_agg_all) == 0:
        logger.error("[aggregations] MSA aggregation output is empty.")
        raise ValueError("[aggregations] MSA aggregation output is empty.")

    # --- Write Excel workbook (Tract / County / MSA) ---
    output_path.parent.mkdir(parents=True, exist_ok=True)

    logger.info("Writing Tract sheet to: %s", output_path)
    with pd.ExcelWriter(output_path, engine="openpyxl", mode="w") as writer:
        tract_agg_all.to_excel(writer, sheet_name="Tract", index=False)

    logger.info("Writing County sheet to: %s", output_path)
    with pd.ExcelWriter(
        output_path, engine="openpyxl", mode="a", if_sheet_exists="replace"
    ) as writer:
        county_agg_all.to_excel(writer, sheet_name="County", index=False)

    logger.info("Writing MSA sheet to: %s", output_path)
    with pd.ExcelWriter(
        output_path, engine="openpyxl", mode="a", if_sheet_exists="replace"
    ) as writer:
        msa_agg_all.to_excel(writer, sheet_name="MSA", index=False)

    logger.info("Step 3.4 complete. Saved aggregations workbook to: %s", output_path)
    return str(output_path)
