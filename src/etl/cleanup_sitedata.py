"""
Cleanup customer + Voltera site data.
Refactored from cleanup_sitedata.ipynb / cleanup_sitedata.py.
Made robust with (schema validation, error handling, logging).
"""

from __future__ import annotations

from pathlib import Path
import pandas as pd

from src.utils.io_utils import read_csv, write_csv
from src.utils.logging_utils import get_logger


# ---------------------------------------------------------------------
# REQUIRED INPUT COLUMNS (schema validation)
# ---------------------------------------------------------------------
REQUIRED_COLUMNS = [
    "Market",
    "State",
    "City",
    "Interested Party",
    "Site",
    "Street",
    "Voltera or Customer Interest",
    "Sum of #_Stalls_Filled",
    "Latitude",
    "Longitude",
    "County",
    "Zip",
    "Full FIPS (tract)",
    "Customer Segment",
]


def run_cleanup_sitedata(config: dict) -> str:
    """
    Run ETL Step 3.2: Clean and standardize customer + Voltera site data.

    Parameters
    ----------
    config : dict
        Loaded YAML config dictionary.

    Returns
    -------
    str
        Path to the cleaned site output file.
    """

    logger = get_logger("cleanup_sitedata")
    logger.info("Starting Step 3.2 - Cleanup Site Data")

    # --------------------------
    # Resolve paths from config
    # --------------------------
    sites_dir = Path(config["paths"]["inputs"]["sites"])
    staged_dir = Path(config["paths"]["staged"])
    staged_dir.mkdir(parents=True, exist_ok=True)

    input_file = sites_dir / "known-sites" / config["filenames"]["known_sites"]
    output_file = staged_dir / config["filenames"]["cleaned_sites_refactored"]

    logger.info(f"Loading known sites: {input_file}")

    # --------------------------------------------------
    # 0) Validate input file exists
    # --------------------------------------------------
    if not input_file.exists():
        logger.error(f"[cleanup_sitedata] Input site file not found: {input_file}")
        raise FileNotFoundError(
            f"[cleanup_sitedata] Input site file not found: {input_file}"
        )

    # --------------------------------------------------
    # 1) Load raw file
    # --------------------------------------------------
    df_raw = pd.read_csv(
        input_file,
        dtype=str,
        encoding_errors="ignore"
    )

    # Strip column name spaces
    df_raw.columns = [c.strip() for c in df_raw.columns]
    logger.debug(f"Columns in raw file: {df_raw.columns.tolist()}")

    # --------------------------------------------------
    # 2) Validate required columns
    # --------------------------------------------------
    missing = [c for c in REQUIRED_COLUMNS if c not in df_raw.columns]
    if missing:
        logger.error(
            f"[cleanup_sitedata] Missing required columns in {input_file}: {missing}. "
            "Update the site input file structure."
        )
        raise KeyError(
            f"[cleanup_sitedata] Missing required columns in {input_file}: {missing}. "
        )

    # --------------------------------------------------
    # Ensure key ID-like fields are strings
    # --------------------------------------------------
    for col in ["Full FIPS (tract)", "Zip"]:
        df_raw[col] = df_raw[col].astype(str).str.strip()

    # --------------------------------------------------
    # 3) Validate & left-pad Tract FIPS to 11 digits
    # --------------------------------------------------
    # Extract raw FIPS as string
    raw_fips = df_raw["Full FIPS (tract)"].astype(str).str.strip()

    # Raw FIPS must contain ONLY digits (no letters, no punctuation)
    invalid_raw = raw_fips.str.contains(r"\D", na=True)
    if invalid_raw.any():
        bad_count = invalid_raw.sum()
        logger.error(
            f"[cleanup_sitedata] {bad_count} rows contain non-digit Tract FIPS values "
            f"(example: {raw_fips[invalid_raw].iloc[0]!r})."
        )
        raise ValueError(
            "[cleanup_sitedata] Tract FIPS must contain only digits before padding."
        )

    # Pad raw FIPS to 11 digits
    df_raw["Full FIPS (tract)"] = raw_fips.str.zfill(11)

    # Validate padded FIPS (must be exactly 11 digits)
    invalid_padded = ~df_raw["Full FIPS (tract)"].str.match(r"^\d{11}$")
    if invalid_padded.any():
        bad_count = invalid_padded.sum()
        logger.error(
            f"[cleanup_sitedata] {bad_count} rows have invalid padded 11-digit FIPS values "
            f"(example: {df_raw['Full FIPS (tract)'][invalid_padded].iloc[0]!r})."
        )
        raise ValueError(
            "[cleanup_sitedata] Invalid 11-digit Tract FIPS detected after padding."
        )
    # --------------------------------------------------
    # 4) Detect and remove duplicate sites
    # --------------------------------------------------
    dup_sites = df_raw["Site"].duplicated(keep=False)
    if dup_sites.sum() > 0:
        logger.warning(f"[cleanup_sitedata] Duplicate site names found: {dup_sites.sum()}")

    df_raw = df_raw.drop_duplicates(subset="Site", keep="first").reset_index(drop=True)
    logger.info(f"Rows after dropping duplicate sites: {len(df_raw)}")

    # --------------------------------------------------
    # 5) Impute missing stall values
    # --------------------------------------------------
    stalls_source_col = "Sum of #_Stalls_Filled"
    stalls_target_col = "#_Stalls_Filled"

    df_raw[stalls_target_col] = pd.to_numeric(
        df_raw[stalls_source_col], errors="coerce"
    )
    mean_stalls = df_raw[stalls_target_col].mean(skipna=True)
    df_raw[stalls_target_col] = df_raw[stalls_target_col].fillna(mean_stalls)

    logger.info(
        f"Imputed missing '{stalls_target_col}' with mean value: {mean_stalls:.2f}"
    )

    # --------------------------------------------------
    # 6) Sort alphabetically by Site + add Index_ID
    # --------------------------------------------------
    df_raw = df_raw.sort_values("Site", ascending=True).reset_index(drop=True)
    df_raw["Index_ID"] = df_raw.index + 1

    # --------------------------------------------------
    # 7) Rename Site-Type
    # --------------------------------------------------
    df_raw = df_raw.rename(columns={"Voltera or Customer Interest": "Site-Type"})

    # --------------------------------------------------
    # 8) Ensure numeric columns are numeric
    # --------------------------------------------------
    numeric_cols = ["Index_ID", stalls_target_col, "Latitude", "Longitude"]
    for col in numeric_cols:
        df_raw[col] = pd.to_numeric(df_raw[col], errors="coerce")

    # Check for missing coordinates
    missing_coords = df_raw["Latitude"].isna().sum() + df_raw["Longitude"].isna().sum()
    if missing_coords > 0:
        logger.warning(
            f"[cleanup_sitedata] {missing_coords} rows have invalid/missing Latitude or Longitude."
        )

    # --------------------------------------------------
    # 9) Select final columns
    # --------------------------------------------------
    final_cols = [
        "Index_ID",
        "Site",
        "Site-Type",
        stalls_target_col,
        "Customer Segment",
        "Interested Party",
        "City",
        "State",
        "Latitude",
        "Longitude",
        "Market",
        "Full FIPS (tract)",
    ]
    existing_cols = [c for c in final_cols if c in df_raw.columns]
    df_raw = df_raw[existing_cols]

    # Prevent an empty output file
    if len(df_raw) == 0:
        logger.error("[cleanup_sitedata] Cleaning resulted in 0 rows.")
        raise ValueError("[cleanup_sitedata] Cleaning resulted in 0 rows.")

    logger.info(f"Final cleaned row count: {len(df_raw)}")

    # --------------------------------------------------
    # 10) Save output
    # --------------------------------------------------
    output_path = Path(output_file)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    write_csv(df_raw, output_path)

    logger.info(
        f"Step 3.2 complete. Saved cleaned sites to: {output_path} "
        f"(Rows: {len(df_raw):,})"
    )

    return str(output_path)
