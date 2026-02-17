# src/ml/train_rankings.py

"""
Training pipeline for MSA, County, and Tract ranking models.

This module replaces the original notebook-style model_training.py.
It performs only production-relevant ML steps:
- Load master integration datasets
- Load geofence-derived features
- Load master geocode mappings
- Prepare modeling datasets for each level
- Train logistic ranking models (MSA, County, Tract)
- Score all regions and export ranking outputs

EDA, Tableau comparisons, plots, and legacy paths remain in the old script.
"""

#from __future__ import annotations

import numpy as np
import pandas as pd
import joblib
from pathlib import Path
from typing import Dict, Sequence
import re
from typing import Any
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.metrics import (
    confusion_matrix,
    accuracy_score,
    precision_score,
    recall_score,
    roc_auc_score,
)


from src.utils.logging_utils import get_logger

logger = get_logger("train_rankings")

# 
# ------------------------------------------------------------------
# FINAL SELECTED FEATURES (after Section 5 heuristic selection) - details in notebook
# ------------------------------------------------------------------

MSA_FINAL_FEATURES = [
    "Count EV Station - Non-Tesla",
    "Count Airport - 0 mile",
    "Count AV Testing - 0 mile",
    "Percent of workers who commuted by taxicab",
    "State_Funding_Awards_Count",
    "Federal_Funding_Amount",
    "HRCN_RISKR_#",
    "Snowdays",
    "# rideshare trips",
    "rideshare_trip_per_capita",
    "Temperature",
]

COUNTY_FINAL_FEATURES = [
    "Count EV Station - Non-Tesla",
    "Total Airport Land Weight - 0 mile",
    "Count Airport - 0 mile",
    "# of AV Testing Vehicles - 0 mile",
    "Count AV Testing - 0 mile",
    "Area (SQRT Miles)",
    "Percent of workers who commuted by public transportation",
    "Federal_Funding_Amount",
    "State_Funding_Awards_Count",
    "HRCN_RISKR_#",
    "ISTM_RISKR_#",
    "Snowdays",
    "# rideshare trips",
    "rideshare_trip_per_capita",
    "Snowdays_MSA",
]

TRACT_FINAL_FEATURES = [
    "Total Airport Land Weight - 25 mile",
    "Count Airport - 25 mile",
    "# of AV Testing Vehicles - 25 mile",
    "Count AV Testing - 25 mile",
    "Population Density (#/sqrtM)",
    "Regular Gas Price ($/G)",
    "Average Weekly Wage",
    "ERQK_RISKR_#",
    "# rideshare trips",
    "rideshare_trip_density",
    "Snowdays_MSA",
    "Temperature_MSA",
    "Count EV Station - Non-Tesla_MSA",
    "rideshare_trip_density_STD_Diff",
]

# ------------------------------------------------------------------
# Y feature configuration (from legacy notebook Section 4)
# ------------------------------------------------------------------

Y_FEATURES = [
   'Total Stall Customer - 0 mile - AV',
   'Total Stall Customer - 1 mile - AV',  'Total Stall Customer - 2 mile - AV',
   'Total Stall Customer - 3 mile - AV',  'Total Stall Customer - 5 mile - AV',
   'Total Stall Customer - 25 mile - AV', 'Total Stall Customer - 75 mile - AV',
   'Total Stall Customer - 100 mile - AV',
   'Count Customer - 0 mile - AV', 'Count Customer - 1 mile - AV', 
   'Count Customer - 2 mile - AV', 'Count Customer - 3 mile - AV', 
   'Count Customer - 5 mile - AV', 'Count Customer - 25 mile - AV', 
   'Count Customer - 75 mile - AV','Count Customer - 100 mile - AV',
   'Total Stall Customer - 0 mile - Non-AV',
   'Total Stall Customer - 1 mile - Non-AV',
   'Total Stall Customer - 2 mile - Non-AV',
   'Total Stall Customer - 3 mile - Non-AV',
   'Total Stall Customer - 5 mile - Non-AV',
   'Total Stall Customer - 25 mile - Non-AV',
   'Total Stall Customer - 75 mile - Non-AV',
   'Total Stall Customer - 100 mile - Non-AV',
   'Count Customer - 0 mile - Non-AV', 'Count Customer - 1 mile - Non-AV',
   'Count Customer - 2 mile - Non-AV', 'Count Customer - 3 mile - Non-AV',
   'Count Customer - 5 mile - Non-AV', 'Count Customer - 25 mile - Non-AV',
   'Count Customer - 75 mile - Non-AV', 'Count Customer - 100 mile - Non-AV',
]

# Per-level ID columns
LEVEL_ID_COLS = {
    "msa": "Metropolitan Division Code",
    "county": "County_GeoID",
    "tract": "Tract_GeoID",   # our normalized tract ID; we can adjust if needed
}

#----------------------------------------------------------------------------
def _require_columns(df: pd.DataFrame, required: Sequence[str], context: str) -> None:
    """Validate required columns exist before downstream transformations."""
    missing = [c for c in required if c not in df.columns]
    if missing:
        logger.error("[%s] Missing required columns: %s", context, missing)
        raise KeyError(f"[{context}] Missing required columns: {missing}")
#---------------------------------------------

# helper functions for imputing
def _fill_mean(df: pd.DataFrame, col: str) -> None:
    """
    For a given numeric column:
    - set negative values to 0,
    - fill NaN with the column mean.
    """
    if col not in df.columns:
        return
    if not pd.api.types.is_numeric_dtype(df[col]):
        return

    df.loc[df[col] < 0, col] = 0
    mean_val = df[col].mean()
    df[col] = df[col].fillna(mean_val)


def _fill_value(df: pd.DataFrame, col: str, value: float = 0.0) -> None:
    """
    For a given numeric column:
    - set negative values to 0,
    - fill NaN with a fixed value (default 0).
    """
    if col not in df.columns:
        return
    if not pd.api.types.is_numeric_dtype(df[col]):
        return

    df.loc[df[col] < 0, col] = 0
    df[col] = df[col].fillna(value)


# -----------------------------------------------------------
# Path resolution helper
# -----------------------------------------------------------
def _resolve_paths(config: Dict) -> Dict[str, Path]:
    """
    Resolve all required input paths from settings.yaml.
    ONLY resolves paths, does not load data yet.
    """
    # ---- Config schema validation (fail fast) ----
    if "paths" not in config:
        raise KeyError("[train_rankings] Missing required config key: 'paths'")
    if "filenames" not in config:
        raise KeyError("[train_rankings] Missing required config key: 'filenames'")

    paths_cfg = config["paths"]
    filenames_cfg = config["filenames"]

    if "staged" not in paths_cfg:
        raise KeyError("[train_rankings] Missing required config key: paths.staged")
    if "inputs" not in paths_cfg or "mastergeocode" not in paths_cfg["inputs"]:
        raise KeyError("[train_rankings] Missing required config key: paths.inputs.mastergeocode")

    # ---- Resolve paths ----
    resolved = {
        # Master integration (Python output from 3.5)
        "master_integration": Path(paths_cfg["staged"]) / filenames_cfg["master_integration_refactored"],

        # Geofence tract output (from geofence_etl)
        "geofence_tracts": Path(paths_cfg["staged"]) / filenames_cfg["geofence_tracts"],

        # Master geocode file
        "master_geocode": Path(paths_cfg["inputs"]["mastergeocode"]) / filenames_cfg["master_geocode"],
    }

    # ---- Validate existence ----
    for key, p in resolved.items():
        # master_integration may not exist on first run
        if key == "master_integration":
            continue

        if not p.exists():
            logger.error(
                "[train_rankings] Required input file not found for '%s': %s",
                key,
                p,
            )
            raise FileNotFoundError(
                f"[train_rankings] Required input file not found for '{key}': {p}"
            )

    logger.info("[train_rankings] Resolved all input paths for training:")
    for k, v in resolved.items():
        logger.info("  %s: %s", k, v)

    return resolved


# -----------------------------------------------------------
# Data loading block (Step 1)
# -----------------------------------------------------------
def _load_raw_inputs(resolved_paths: Dict[str, Path]) -> Dict[str, pd.DataFrame]:
    """
    Load:
    - Master integration (3 sheets: MSA, County, Tract)
    - Geofence tract features
    - Master geocode mapping

    Returns a dictionary of raw DataFrames (no transformations yet).
    """
    logger.info("[train_rankings] Loading raw datasets for model training...")

    master_integration_path = resolved_paths["master_integration"]
    geofence_path = resolved_paths["geofence_tracts"]
    master_geocode_path = resolved_paths["master_geocode"]

    # ---- Master Integration: 3 sheets ----
    if not master_integration_path.exists():
        logger.error(
            "[train_rankings] Master integration file not found: %s",
            master_integration_path,
        )
        raise FileNotFoundError(
            f"[train_rankings] Master integration file not found: {master_integration_path}"
        )

    logger.info(
        "[train_rankings] Reading master integration Excel: %s",
        master_integration_path,
    )

    try:
        df_msa = pd.read_excel(master_integration_path, sheet_name="MSA")
        df_county = pd.read_excel(master_integration_path, sheet_name="County")
        df_tract = pd.read_excel(master_integration_path, sheet_name="Tract")
    except ValueError as e:
        logger.error(
            "[train_rankings] Missing required sheet(s) in master integration file: %s",
            master_integration_path,
        )
        raise

    if df_msa.empty or df_county.empty or df_tract.empty:
        logger.error(
            "[train_rankings] One or more master integration sheets are empty "
            "(MSA=%d, County=%d, Tract=%d)",
            len(df_msa),
            len(df_county),
            len(df_tract),
        )
        raise ValueError(
            "[train_rankings] Master integration contains empty required sheets."
        )

    logger.info(
        "[train_rankings] Loaded master integration: MSA=%d rows, County=%d rows, Tract=%d rows",
        len(df_msa),
        len(df_county),
        len(df_tract),
    )

    # ---- Geofence Tract File ----
    if not geofence_path.exists():
        logger.error(
            "[train_rankings] Geofence tract file not found: %s",
            geofence_path,
        )
        raise FileNotFoundError(
            f"[train_rankings] Geofence tract file not found: {geofence_path}"
        )

    logger.info(
        "[train_rankings] Reading geofence tract dataset: %s",
        geofence_path,
    )
    df_geofence = pd.read_excel(geofence_path)

    if df_geofence.empty:
        logger.error(
            "[train_rankings] Geofence tract dataset is empty: %s",
            geofence_path,
        )
        raise ValueError(
            "[train_rankings] Geofence tract dataset is empty."
        )

    logger.info(
        "[train_rankings] Loaded geofence rows: %d",
        len(df_geofence),
    )

    # ---- Master Geocode ----
    if not master_geocode_path.exists():
        logger.error(
            "[train_rankings] Master geocode file not found: %s",
            master_geocode_path,
        )
        raise FileNotFoundError(
            f"[train_rankings] Master geocode file not found: {master_geocode_path}"
        )

    logger.info(
        "[train_rankings] Reading master geocode file: %s",
        master_geocode_path,
    )

    try:
        df_geocode = pd.read_excel(
            master_geocode_path,
            sheet_name="MasterGeocodeMap",
        )
    except ValueError:
        logger.error(
            "[train_rankings] Missing 'MasterGeocodeMap' sheet in master geocode file: %s",
            master_geocode_path,
        )
        raise

    if df_geocode.empty:
        logger.error(
            "[train_rankings] Master geocode dataset is empty: %s",
            master_geocode_path,
        )
        raise ValueError(
            "[train_rankings] Master geocode dataset is empty."
        )

    logger.info(
        "[train_rankings] Loaded master geocode rows: %d",
        len(df_geocode),
    )

    return {
        "msa": df_msa,
        "county": df_county,
        "tract": df_tract,
        "geofence": df_geofence,
        "geocode": df_geocode,
    }


# function to strip spaces
def _normalize_col_name(name: str) -> str:
    """
    Normalize a single column name:
    - collapse multiple whitespace characters into a single space
    - strip leading/trailing spaces

    This keeps semantic names the same but removes accidental spacing differences
    between Tableau/Python outputs and across levels.
    """
    return re.sub(r"\s+", " ", str(name)).strip()

# function to normalize column names
def _normalize_column_names(raw_data: Dict[str, pd.DataFrame]) -> Dict[str, pd.DataFrame]:
    """
    Apply column-name normalization to all loaded DataFrames.

    This is especially useful to:
    - remove accidental double spaces,
    - make MSA/County/Tract columns easier to compare,
    - reduce noise when aligning feature sets.

    NOTE: This only changes headers, not data values.
    """
    normalized: Dict[str, pd.DataFrame] = {}

    for key, df in raw_data.items():
        df_copy = df.copy()
        old_cols = list(df_copy.columns)
        df_copy.columns = [re.sub(r"\s+", " ", str(c)).strip() for c in old_cols]

        logger.info(
            "Normalized columns for '%s': %d columns", key, len(df_copy.columns)
        )
        normalized[key] = df_copy

    return normalized

# function to add nnew rideshare features
def _add_rideshare_features(data: Dict[str, pd.DataFrame]) -> Dict[str, pd.DataFrame]:
    """
    Add rideshare_trip_per_capita and rideshare_trip_density to
    MSA, County, and Tract datasets.
    """
    updated: Dict[str, pd.DataFrame] = {}
    required = ["# rideshare trips", "Total Population", "Area (SQRT Miles)"]

    for level in ["msa", "county", "tract"]:
        df = data[level].copy()
        
        _require_columns(df, required, f"train_rankings:_add_rideshare_features:{level}")

        trips = pd.to_numeric(df["# rideshare trips"], errors="coerce")
        pop = pd.to_numeric(df["Total Population"], errors="coerce")
        area = pd.to_numeric(df["Area (SQRT Miles)"], errors="coerce")

        # bad_pop = pop.isna() | (pop <= 0)
        # bad_area = area.isna() | (area <= 0)

        # if bad_pop.any():
        #     logger.warning("[%s] %d rows have missing/<=0 Total Population; per_capita set to 0.", level, int(bad_pop.sum()))
        # if bad_area.any():
        #     logger.warning("[%s] %d rows have missing/<=0 Area; density set to 0.", level, int(bad_area.sum()))

        # df["rideshare_trip_per_capita"] = (trips / pop).where(~bad_pop, 0.0).replace([float("inf"), float("-inf")], 0.0)
        # df["rideshare_trip_density"] = (trips / area).where(~bad_area, 0.0).replace([float("inf"), float("-inf")], 0.0)

        df["rideshare_trip_per_capita"] = trips / pop
        df["rideshare_trip_density"] = trips / area

        updated[level] = df
        logger.info("Added rideshare features for %s: shape=%s", level, df.shape)

    updated["geofence"] = data["geofence"].copy()
    updated["geocode"] = data["geocode"].copy()
    return updated

def _attach_msa_context(data: Dict[str, pd.DataFrame]) -> Dict[str, pd.DataFrame]:
    """
    Attach MSA-level context to Tract and County.

    - Tract: gets MSA weather (Precipitation_MSA, Snowdays_MSA, Temperature_MSA)
        + 7 extra MSA features (EV stations, income, education, population,
          density, # rideshare trips, rideshare_trip_density), all with _MSA suffix.

    - County: gets ONLY MSA weather (Precipitation_MSA, Snowdays_MSA, Temperature_MSA).
    Mirrors the logic documented in Section 3.3 of the original model_training.py.
    """
    msa = data["msa"].copy()
    county = data["county"].copy()
    tract = data["tract"].copy()
    geocode = data["geocode"].copy()

    # -----------------------------
    # Required columns (fail fast)
    # -----------------------------
    msa_weather_cols = [
        "Metropolitan Division Code",
        "Precipitation",
        "Snowdays",
        "Temperature",
    ]
    msa_key_cols_for_tract = [
        "Metropolitan Division Code",
        "Count EV Station - Non-Tesla",
        "Median Household Income in past 12 months",
        "Percent with Bachelor Degree",
        "Total Population",
        "Population Density (#/sqrtM)",
        "# rideshare trips",
        "rideshare_trip_density",
    ]
    _require_columns(msa, msa_weather_cols, "train_rankings:_attach_msa_context:msa_weather")
    _require_columns(msa, msa_key_cols_for_tract, "train_rankings:_attach_msa_context:msa_key_tract")

    _require_columns(
        geocode,
        ["CLEAN_Tract Geoid", "CLEAN_County Geoid", "Metropolitan Division Code"],
        "train_rankings:_attach_msa_context:geocode",
    )
    _require_columns(tract, ["Tract_GeoID"], "train_rankings:_attach_msa_context:tract")
    _require_columns(county, ["County_GeoID"], "train_rankings:_attach_msa_context:county")

    # -----------------------------
    # 1) MSA weather features
    # -----------------------------
    df_msa_weather = msa[msa_weather_cols].copy()
    df_msa_weather = df_msa_weather.rename(
        columns={
            "Precipitation": "Precipitation_MSA",
            "Snowdays": "Snowdays_MSA",
            "Temperature": "Temperature_MSA",
        }
    )

    # -----------------------------
    # 2) MSA key features for TRACT
    # -----------------------------
    df_msa_key_tract = msa[msa_key_cols_for_tract].copy()
    df_msa_key_tract = df_msa_key_tract.rename(
        columns={
            "Count EV Station - Non-Tesla": "Count EV Station - Non-Tesla_MSA",
            "Median Household Income in past 12 months": "Median Household Income in past 12 months_MSA",
            "Percent with Bachelor Degree": "Percent with Bachelor Degree_MSA",
            "Total Population": "Total Population_MSA",
            "Population Density (#/sqrtM)": "Population Density (#/sqrtM)_MSA",
            "# rideshare trips": "# rideshare trips_MSA",
            "rideshare_trip_density": "rideshare_trip_density_MSA",
        }
    )
    # Combine weather + extra 7 features from msa for Tract 
    df_msa_for_tract = df_msa_key_tract.merge(
        df_msa_weather[
            [
                "Metropolitan Division Code",
                "Precipitation_MSA",
                "Snowdays_MSA",
                "Temperature_MSA",
            ]
        ],
        on="Metropolitan Division Code",
        how="left",
    )

    # -----------------------------
    # 3) Normalize keys
    # -----------------------------
    for col in ["Metropolitan Division Code"]:
        df_msa_for_tract[col] = df_msa_for_tract[col].astype(str).str.strip()
        df_msa_weather[col] = df_msa_weather[col].astype(str).str.strip()
        geocode[col] = geocode[col].astype(str).str.strip()

    geocode["CLEAN_Tract Geoid"] = geocode["CLEAN_Tract Geoid"].astype(str).str.strip()
    geocode["CLEAN_County Geoid"] = geocode["CLEAN_County Geoid"].astype(str).str.strip()

    tract["Tract_GeoID"] = tract["Tract_GeoID"].astype(str).str.strip()
    county["County_GeoID"] = county["County_GeoID"].astype(str).str.strip()

    # -----------------------------
    # 4) Attach MSA context to TRACT
    # -----------------------------
    tract_msa_map = (
        geocode[["CLEAN_Tract Geoid", "Metropolitan Division Code"]]
        .dropna(subset=["CLEAN_Tract Geoid", "Metropolitan Division Code"])
        .drop_duplicates(subset=["CLEAN_Tract Geoid"])
    )
    tract_with_msa_code = tract.merge(
        tract_msa_map,
        left_on="Tract_GeoID",
        right_on="CLEAN_Tract Geoid",
        how="left",
    )

    missing_msa_code = tract_with_msa_code["Metropolitan Division Code"].isna().sum()
    if missing_msa_code:
        logger.warning(
            "[train_rankings] Tract --> MSA mapping missing for %d rows (out of %d).",
            int(missing_msa_code),
            len(tract_with_msa_code),
        )

    tract_with_msa = tract_with_msa_code.merge(
        df_msa_for_tract,
        on="Metropolitan Division Code",
        how="left",
    )

    # # If MSA merge doesn't match, key MSA feature columns will be null
    # msa_feat_check = ["Snowdays_MSA", "Temperature_MSA", "Precipitation_MSA"]
    # null_msa_feats = tract_with_msa[msa_feat_check].isna().all(axis=1).sum()
    # if null_msa_feats:
    #     logger.warning(
    #         "[train_rankings] Tract rows with no MSA context after merge: %d (out of %d).",
    #         int(null_msa_feats),
    #         len(tract_with_msa),
    #     )

    logger.info("Tract with MSA context shape: %s", tract_with_msa.shape)

    # -----------------------------
    # 5) Attach MSA weather ONLY to COUNTY
    # -----------------------------
    county_msa_map = (
        geocode[["CLEAN_County Geoid", "Metropolitan Division Code"]]
        .dropna(subset=["CLEAN_County Geoid", "Metropolitan Division Code"])
        .drop_duplicates(subset=["CLEAN_County Geoid"])
    )

    county_with_msa_code = county.merge(
        county_msa_map,
        left_on="County_GeoID",
        right_on="CLEAN_County Geoid",
        how="left",
    )

    missing_county_msa = county_with_msa_code["Metropolitan Division Code"].isna().sum()
    if missing_county_msa:
        logger.warning(
            "[train_rankings] County→MSA mapping missing for %d rows (out of %d).",
            int(missing_county_msa),
            len(county_with_msa_code),
        )

    county_with_msa = county_with_msa_code.merge(
        df_msa_weather,
        on="Metropolitan Division Code",
        how="left",
    )

    # null_county_weather = county_with_msa[["Snowdays_MSA", "Temperature_MSA", "Precipitation_MSA"]].isna().all(axis=1).sum()
    # if null_county_weather:
    #     logger.warning(
    #         "[train_rankings] County rows with no MSA weather after merge: %d (out of %d).",
    #         int(null_county_weather),
    #         len(county_with_msa),
    #     )

    logger.info("County with MSA weather context shape: %s", county_with_msa.shape)

    # -----------------------------
    # 6) Return updated data dict
    # -----------------------------
    updated = data.copy()
    updated["tract"] = tract_with_msa
    updated["county"] = county_with_msa
    return updated


# Function to impute missing values
def _fill_missing_values(data: Dict[str, pd.DataFrame]) -> Dict[str, pd.DataFrame]:
    """
    Section 3.4 – Fill-in NULL Values :

    1) These continuous features are imputed with MEAN:
       (for Tract / County / MSA; _MSA weather only for Tract/County)

       'RISK_RATNG_#',
       'CFLD_RISKR_#',
       'CWAV_RISKR_#',
       'ERQK_RISKR_#',
       'HRCN_RISKR_#',
       'ISTM_RISKR_#',
       'RFLD_RISKR_#',
       'TRND_RISKR_#',
       'WNTW_RISKR_#',
       'Price (cent/kwh)',
       'Regular Gas Price ($/G)',
       'Average Weekly Wage',
       'Precipitation',
       'Snowdays',
       'Temperature',
       'Land Value (1/4 Acre Lot, Standardized)',
       and for Tract/County only:
       'Precipitation_MSA', 'Snowdays_MSA', 'Temperature_MSA'

    2) ALL OTHER numeric features (except the 7 sigma-based _MSA features below)
       are filled with ZERO.

    3) These 7 sigma-based _MSA features are left untouched (used in 3.5):

       'Count EV Station - Non-Tesla_MSA',
       'Median Household Income in past 12 months_MSA',
       'Percent with Bachelor Degree_MSA',
       'Total Population_MSA',
       'Population Density (#/sqrtM)_MSA',
       '# rideshare trips_MSA',
       'rideshare_trip_density_MSA'
    """

    mean_cols_base = [
        "RISK_RATNG_#",
        "CFLD_RISKR_#",
        "CWAV_RISKR_#",
        "ERQK_RISKR_#",
        "HRCN_RISKR_#",
        "ISTM_RISKR_#",
        "RFLD_RISKR_#",
        "TRND_RISKR_#",
        "WNTW_RISKR_#",
        "Price (cent/kwh)",
        "Regular Gas Price ($/G)",
        "Average Weekly Wage",
        "Precipitation",
        "Snowdays",
        "Temperature",
        "Land Value (1/4 Acre Lot, Standardized)",
    ]

    msa_weather_cols = [
        "Precipitation_MSA",
        "Snowdays_MSA",
        "Temperature_MSA",
    ]

    sigma_msa_features = {
        "Count EV Station - Non-Tesla_MSA",
        "Median Household Income in past 12 months_MSA",
        "Percent with Bachelor Degree_MSA",
        "Total Population_MSA",
        "Population Density (#/sqrtM)_MSA",
        "# rideshare trips_MSA",
        "rideshare_trip_density_MSA",
    }

    updated: Dict[str, pd.DataFrame] = {}

    for level in ["msa", "county", "tract"]:
        df = data[level].copy()

        # 1) Decide which columns are mean-imputed at this level
        mean_cols = list(mean_cols_base)
        if level in ("county", "tract"):
            mean_cols = mean_cols + msa_weather_cols

        mean_cols_present = [c for c in mean_cols if c in df.columns]

        logger.info(
            "Level '%s': mean-fill for %d columns", level, len(mean_cols_present)
        )
        for col in mean_cols_present:
            _fill_mean(df, col)

        # 2) Zero-fill all other numeric columns,
        #    EXCEPT the sigma-based _MSA features
        numeric_cols = [
            c for c in df.columns if pd.api.types.is_numeric_dtype(df[c])
        ]

        zero_fill_cols = [
            c
            for c in numeric_cols
            if c not in mean_cols_present and c not in sigma_msa_features
        ]

        logger.info(
            "Level '%s': zero-fill for %d columns", level, len(zero_fill_cols)
        )
        for col in zero_fill_cols:
            _fill_value(df, col, 0.0)

        updated[level] = df

    # geocode / geofence unchanged
    updated["geocode"] = data["geocode"].copy()
    updated["geofence"] = data["geofence"].copy()

    return updated

# Function to calculate msa sigma normalization features
def _add_msa_sigma_features(data: Dict[str, pd.DataFrame], 
                            group_col: str = "Metropolitan Division Code",
                            ) -> Dict[str, pd.DataFrame]:
    """
    Section 3.5 – Add_mean_std_differ equivalent.

    For each selected tract-level feature, within each MSA (group_col):
      - compute MSA mean, std, min, max
      - add columns:
          <feat>_Mean       : MSA mean
          <feat>_STD        : MSA std
          <feat>_STD_Diff   : (value - mean) / std
          <feat>_Mean_Diff  : (value - mean) / (max - min) * 100

    This is applied ONLY to the tract-level dataframe, mirroring the legacy
    Add_mean_std_differ(final_df_Tract, 'Metropolitan Division Code', selected_tract_features).
    """

    tract = data["tract"].copy()

    selected_tract_features = [
        "Count EV Station - Non-Tesla",
        "Median Household Income in past 12 months",
        "Percent with Bachelor Degree",
        "Total Population",
        "Population Density (#/sqrtM)",
        "# rideshare trips",
        "rideshare_trip_density",
    ]

    # Ensure group col exists
    if group_col not in tract.columns:

        logger.error("[train_rankings] Missing group column '%s' in tract; cannot compute MSA sigma features.", group_col)
        raise KeyError(f"[train_rankings] Missing group column '{group_col}' in tract.")

        updated = data.copy()
        updated["tract"] = tract
        return updated

    # Normalize group col type
    tract[group_col] = tract[group_col].astype(str).str.strip()

    for feat in selected_tract_features:
        if feat not in tract.columns:
            logger.warning("Selected feature '%s' not found in tract; skipping.", feat)
            continue
        
        tract[feat] = pd.to_numeric(tract[feat], errors="coerce")
        grp = tract.groupby(group_col)[feat]

        mean_vals = grp.transform("mean")
        std_vals = grp.transform("std")
        min_vals = grp.transform("min")
        max_vals = grp.transform("max")

        # Avoid divide-by-zero
        std_safe = std_vals.replace(0, np.nan)
        range_safe = (max_vals - min_vals).replace(0, np.nan)

        tract[f"{feat}_Mean"] = mean_vals
        tract[f"{feat}_STD"] = std_vals
        tract[f"{feat}_STD_Diff"] = (tract[feat] - mean_vals) / std_safe
        tract[f"{feat}_Mean_Diff"] = (tract[feat] - mean_vals) / range_safe * 100

        logger.info(
            "Added MSA sigma features for '%s': Mean, STD, STD_Diff, Mean_Diff",
            feat,
        )

    updated = data.copy()
    updated["tract"] = tract.drop(['CLEAN_Tract Geoid',group_col], axis=1, errors="ignore")
    updated["county"] = updated["county"].drop(['CLEAN_County Geoid',group_col], axis=1, errors="ignore")

    logger.info("MSA shape: %s", updated["msa"].shape)
    logger.info("County shape: %s", updated["county"].shape)
    logger.info("Tract shape after adding sigma msa features: %s", updated["tract"].shape)
    return updated


def _apply_msa_thesis_overrides(
    data: Dict[str, pd.DataFrame],
    config: Dict,
) -> Dict[str, pd.DataFrame]:
    """
    Simple thesis overrides for MSA-level Y_features.

    For each configured thesis MSA (AV or Non-AV):
      - Look up the MSA by 'Metropolitan Division Code'.
      - Consider ALL Y_FEATURES for that segment (Count + Total Stall, all radii).
      - If ALL those values are <= 0 or NaN:
          * add `count_customer` to all 'Count Customer - ... - <segment>' cols
          * add `total_stall`   to all 'Total Stall Customer - ... - <segment>' cols
      - If ANY is already > 0, leave that MSA unchanged.
    """

    overrides = (
        config.get("ml", {}).get("msa_thesis_overrides", [])
        or []
    )
    if not overrides:
        return data

    df_msa = data["msa"].copy()

    _require_columns(df_msa, ["Metropolitan Division Code"], "train_rankings:_apply_msa_thesis_overrides:msa")
    
    for entry in overrides:
        msa_code = str(entry.get("msa_code", "")).strip()
        segment = entry.get("segment", "AV").strip()
        label = entry.get("label", msa_code)
        count_val = entry.get("count_customer", 1)
        stall_val = entry.get("total_stall", 0)

        try:
            count_val = float(count_val)
            stall_val = float(stall_val)
        except Exception:
            logger.warning("Skipping MSA thesis override due to non-numeric values: %s", entry)
            continue

        if not msa_code or segment not in {"AV", "Non-AV"}:
            logger.warning(
                "Skipping MSA thesis override with invalid config: %s",
                entry,
            )
            continue

        # Find the MSA row(s)
        mask = df_msa["Metropolitan Division Code"].astype(str).str.strip() == msa_code
        if not mask.any():
            logger.warning(
                "MSA thesis override: no rows found for msa_code=%s (label=%s)",
                msa_code,
                label,
            )
            continue

        # Identify Y columns for this segment using exact naming
        segment_suffix = f"- {segment}"
        count_cols = [
            c
            for c in Y_FEATURES
            if c.startswith("Count Customer") and c.endswith(segment_suffix) and c in df_msa.columns
        ]
        stall_cols = [
            c
            for c in Y_FEATURES
            if c.startswith("Total Stall Customer") and c.endswith(segment_suffix) and c in df_msa.columns
        ]

        if not count_cols and not stall_cols:
            logger.warning(
                "MSA thesis override: no Y columns found for msa_code=%s, segment=%s",
                msa_code,
                segment,
            )
            continue

        # Check ONLY the 0-mile columns for this segment.
        # If 0-mile already has a positive value, we leave the MSA as-is.
        expected_zero_mile_cols = [
            f"Count Customer - 0 mile - {segment}",
            f"Total Stall Customer - 0 mile - {segment}",
        ]
        zero_mile_cols = [c for c in expected_zero_mile_cols if c in df_msa.columns]

        if not zero_mile_cols:
            logger.warning(
                "MSA thesis override: no 0-mile Y columns found for msa_code=%s, segment=%s "
                "(expected one of %s). Applying override anyway.",
                msa_code,
                segment,
                expected_zero_mile_cols,
            )
        else:
            subset_0 = df_msa.loc[mask, zero_mile_cols].fillna(0)
            if (subset_0 > 0).any().any():
                logger.info(
                    "MSA thesis override: msa_code=%s (label=%s, segment=%s) "
                    "already has positive 0-mile Y; leaving as-is.",
                    msa_code,
                    label,
                    segment,
                )
                continue


        logger.info(
            "MSA thesis override: applying override for msa_code=%s (label=%s, segment=%s).",
            msa_code,
            label,
            segment,
        )

        # Add values to Count Customer columns
        for col in count_cols:
            df_msa.loc[mask, col] = df_msa.loc[mask, col].fillna(0) + count_val

        # Add values to Total Stall Customer columns
        for col in stall_cols:
            df_msa.loc[mask, col] = df_msa.loc[mask, col].fillna(0) + stall_val

    updated = data.copy()
    updated["msa"] = df_msa
    return updated
    
def _apply_geofence_overrides(
    data: Dict[str, pd.DataFrame],
) -> Dict[str, pd.DataFrame]:
    """
    Geofence-driven Y overrides for AV 'Count Customer' features.

    Business rule:
      - Any tract inside a customer geofence polygon is treated as having
        at least one interested AV customer, even if no existing AV site
        is nearby.
      - This promotion propagates up to county and MSA if they are
        otherwise 'dark' for AV Count Customer.

    Concretely:
      1) For each geofenced tract in the main tract dataframe:
           - For all 'Count Customer - <radius> - AV' columns:
               * if value <= 0 or NaN, bump to 1.
      2) For each county that has at least one geofenced tract:
           - If ALL AV Count Customer columns for that county are <= 0/NaN,
             set them to 1.
      3) For each MSA that has at least one geofenced tract:
           - Using master geocode (CLEAN_County Geoid -> Metropolitan Division Code),
             if ALL AV Count Customer columns for that MSA are <= 0/NaN,
             set them to 1.
    """

    df_tract = data["tract"].copy()
    df_county = data["county"].copy()
    df_msa = data["msa"].copy()
    df_geofence = data["geofence"].copy()
    df_geocode = data["geocode"].copy()

    _require_columns(df_tract, ["Tract_GeoID"], "train_rankings:_apply_geofence_overrides:tract")
    _require_columns(df_geofence, ["Tract_GeoID"], "train_rankings:_apply_geofence_overrides:geofence")
    _require_columns(df_county, ["County_GeoID"], "train_rankings:_apply_geofence_overrides:county")
    _require_columns(df_msa, ["Metropolitan Division Code"], "train_rankings:_apply_geofence_overrides:msa")
    
    if df_geofence.empty:
        logger.info("Geofence overrides: no geofence rows; skipping.")
        return data

    # ------------------------------------------------------------------
    # 0. Identify AV Count Customer columns using Y_FEATURES
    # ------------------------------------------------------------------
    av_suffix = " - AV"
    av_count_cols = [
        c
        for c in Y_FEATURES
        if c.startswith("Count Customer") and c.endswith(av_suffix)
    ]

    tract_av_cols = [c for c in av_count_cols if c in df_tract.columns]
    county_av_cols = [c for c in av_count_cols if c in df_county.columns]
    msa_av_cols = [c for c in av_count_cols if c in df_msa.columns]

    if not tract_av_cols:
        logger.warning(
            "Geofence overrides: no AV Count Customer columns found in tract; nothing to do."
        )
        return data

    # ------------------------------------------------------------------
    # 1. Normalize Tract_GeoID in both dataframes
    # ------------------------------------------------------------------
    df_tract["Tract_GeoID"] = (
        df_tract["Tract_GeoID"].astype(str).str.strip().str.zfill(11)
    )
    df_geofence["Tract_GeoID"] = (
        df_geofence["Tract_GeoID"].astype(str).str.strip().str.zfill(11)
    )

    geofence_tract_ids = set(df_geofence["Tract_GeoID"].unique())
    logger.info(
        "Geofence overrides: %d unique geofenced tracts detected.",
        len(geofence_tract_ids),
    )

    # Mask for geofenced tracts in the main tract dataframe
    tract_mask = df_tract["Tract_GeoID"].isin(geofence_tract_ids)

    # ------------------------------------------------------------------
    # 2. Tract-level overrides
    # ------------------------------------------------------------------
    if tract_mask.any():
        logger.info(
            "Geofence overrides: applying tract-level overrides to %d tracts.",
            tract_mask.sum(),
        )

        # --- per-column lit vs newly bumped (tract) ---
        if tract_mask.any() and tract_av_cols:
            tract_before = df_tract.loc[tract_mask, tract_av_cols].fillna(0)
        
            for col in tract_av_cols:
                already_lit_col = int((tract_before[col] > 0).sum())
                newly_lit_col = int((tract_before[col] <= 0).sum())
                logger.info(
                    "Geofence overrides (tract): %s — %d already >0, %d newly bumped to 1 (out of %d geofenced).",
                    col,
                    already_lit_col,
                    newly_lit_col,
                    int(tract_mask.sum()),
                )

        for col in tract_av_cols:
            current = df_tract.loc[tract_mask, col].fillna(0)
            bumped = current.where(current > 0, 1)
            df_tract.loc[tract_mask, col] = bumped

    else:
        logger.info(
            "Geofence overrides: no matching tracts found in main tract dataframe."
        )

    # ------------------------------------------------------------------
    # 3. County-level overrides (from geofenced tracts)
    # ------------------------------------------------------------------
    # Derive county FIPS as first 5 digits of Tract_GeoID
    tract_county_ids = (
        df_tract.loc[tract_mask, "Tract_GeoID"]
        .astype(str)
        .str.strip()
        .str[:5]
    )
    geofence_county_ids = set(tract_county_ids.dropna().unique())

    if geofence_county_ids and county_av_cols:
        df_county["County_GeoID"] = (
            df_county["County_GeoID"].astype(str).str.strip().str.zfill(5)
        )

        county_mask = df_county["County_GeoID"].isin(geofence_county_ids)
        logger.info(
            "Geofence overrides: %d counties affected by geofenced tracts.",
            county_mask.sum(),
        )

        # --- per-column lit vs newly bumped (county) ---
        if county_mask.any() and county_av_cols:
            county_before = df_county.loc[county_mask, county_av_cols].fillna(0)
        
            for col in county_av_cols:
                already_lit_col = int((county_before[col] > 0).sum())
                newly_lit_col = int((county_before[col] <= 0).sum())
                logger.info(
                    "Geofence overrides (county): %s — %d already >0, %d newly bumped to 1 (out of %d geofenced).",
                    col,
                    already_lit_col,
                    newly_lit_col,
                    int(county_mask.sum()),
                )


        if county_mask.any():
            # Cell-wise bump: for each AV CountCustomer column, set to 1
            # wherever the county is geofenced and value is <= 0 / NaN.
            for col in county_av_cols:
                current = df_county.loc[county_mask, col].fillna(0)
                bumped = current.where(current > 0, 1)
                df_county.loc[county_mask, col] = bumped

    # ------------------------------------------------------------------
    # 4. MSA-level overrides (from geofenced counties via master geocode)
    # ------------------------------------------------------------------
    if msa_av_cols and not df_geocode.empty:
        # Normalize geocode county and MSA codes
        df_geocode["CLEAN_County Geoid"] = (
            df_geocode["CLEAN_County Geoid"].astype(str).str.strip().str.zfill(5)
        )
        if "Metropolitan Division Code" not in df_geocode.columns:
            logger.warning(
                "Geofence overrides: 'Metropolitan Division Code' not found in geocode; "
                "MSA-level overrides skipped."
            )
        else:
            df_geocode["Metropolitan Division Code"] = (
                df_geocode["Metropolitan Division Code"]
                .astype(str)
                .str.strip()
            )

            # Counties touched by geofenced tracts --> corresponding MSAs
            geocode_subset = df_geocode[
                df_geocode["CLEAN_County Geoid"].isin(geofence_county_ids)
            ]
            geofence_msa_codes = set(
                geocode_subset["Metropolitan Division Code"].dropna().unique()
            )

            df_msa["Metropolitan Division Code"] = (
                df_msa["Metropolitan Division Code"].astype(str).str.strip()
            )
            msa_mask = df_msa["Metropolitan Division Code"].isin(
                geofence_msa_codes
            )

            logger.info(
                "Geofence overrides: %d MSAs affected by geofenced tracts.",
                msa_mask.sum(),
            )

            # --- per-column lit vs newly bumped (MSA) ---
            if msa_mask.any() and msa_av_cols:
                msa_before = df_msa.loc[msa_mask, msa_av_cols].fillna(0)
            
                for col in msa_av_cols:
                    already_lit_col = int((msa_before[col] > 0).sum())
                    newly_lit_col = int((msa_before[col] <= 0).sum())
                    logger.info(
                        "Geofence overrides (MSA): %s — %d already >0, %d newly bumped to 1 (out of %d geofenced).",
                        col,
                        already_lit_col,
                        newly_lit_col,
                        int(msa_mask.sum()),
                    )

            if msa_mask.any():
                for col in msa_av_cols:
                    current = df_msa.loc[msa_mask, col].fillna(0)
                    bumped = current.where(current > 0, 1)
                    df_msa.loc[msa_mask, col] = bumped


    updated = data.copy()
    updated["tract"] = df_tract
    updated["county"] = df_county
    updated["msa"] = df_msa

    return updated

def _build_feature_matrices(
    data: Dict[str, pd.DataFrame]
    ) -> Dict[str, Dict[str, pd.DataFrame]]:
    """
    Section 4 – Feature engineering separation:
    
    For each level (MSA, County, Tract), return:
      - ID column      → df_id
      - X features     → df_x (numeric, excluding IDs + all Y_FEATURES)
      - Y_features     → df_y_features (all raw Y columns, not binarized)

    The actual Y (binary target) will be chosen later based on config or 
    modeling function parameters.
    """
    result: Dict[str, Dict[str, pd.DataFrame]] = {}

    for level in ["msa", "county", "tract"]:
        if level not in LEVEL_ID_COLS:
            logger.error("[train_rankings] LEVEL_ID_COLS missing key for level='%s'", level)
            raise KeyError(f"[train_rankings] LEVEL_ID_COLS missing key for level='{level}'")
            
        id_col = LEVEL_ID_COLS[level]

        df = data[level].copy()
        id_col = LEVEL_ID_COLS[level]

        # -----------------------------
        # 1. Extract ID column
        # -----------------------------
        if id_col not in df.columns:
            logger.warning(
                "ID column '%s' missing for level '%s'; returned ID dataframe will be empty.",
                id_col, level
            )
            df_id = pd.DataFrame()
        else:
            df_id = df[[id_col]].copy()

        # -----------------------------
        # 2. Extract Y_features
        # -----------------------------
        y_cols_present = [c for c in Y_FEATURES if c in df.columns]
        df_y_features = df[y_cols_present].copy()

        # -----------------------------
        # 3. Build X by removing:
        #    - ID column
        #    - all Y columns
        #    - any non-numeric column
        # -----------------------------
        drop_for_x = set(y_cols_present)
        drop_for_x.add(id_col)

        numeric_cols = [
            c for c in df.columns
            if pd.api.types.is_numeric_dtype(df[c])
        ]

        x_cols = [
            c for c in numeric_cols
            if c not in drop_for_x
        ]

        df_x = df[x_cols].copy()

        logger.info(
            "Level '%s': X has %d cols, Y_features has %d cols, ID=%s",
            level, len(x_cols), len(y_cols_present), id_col
        )

        result[level] = {
            "ID": df_id,
            "X": df_x,
            "Y_features": df_y_features,
        }

    return result

# Function to select final feature engineered features (X)
def _select_final_features(
    matrices: Dict[str, Dict[str, pd.DataFrame]]
) -> Dict[str, Dict[str, pd.DataFrame]]:
    """
    Apply the FINAL Section 5 feature selections for:
      - MSA
      - County
      - Tract

    Adds X_selected per level using the final lists from the notebook.
    """

    result = {}

    final_feature_map = {
        "msa": MSA_FINAL_FEATURES,
        "county": COUNTY_FINAL_FEATURES,
        "tract": TRACT_FINAL_FEATURES,
    }

    for level in ["msa", "county", "tract"]:
        level_dict = matrices[level]
        df_x = level_dict["X"]
        df_y_features = level_dict["Y_features"]
        df_id = level_dict["ID"]

        final_features = final_feature_map[level]

        # Check for missing features
        missing = [f for f in final_features if f not in df_x.columns]
        if missing:
            logger.warning(
                "Level '%s': Missing final selected features: %s",
                level, missing
            )

        # Subset X
        present = [f for f in final_features if f in df_x.columns]
        df_x_selected = df_x[present].copy()

        logger.info(
            "Level '%s': Selected %d final features (from %d requested).",
            level, len(present), len(final_features)
        )

        result[level] = {
            "ID": df_id,
            "X": df_x,
            "X_selected": df_x_selected,
            "Y_features": df_y_features,
        }

    return result

def _build_target_col_name(buffer_miles: int, segment: str) -> str:
    """
    Build the Count Customer column name given buffer and segment.
    Example: buffer=3, segment='AV' -> 'Count Customer - 3 mile - AV'
    """
    return f"Count Customer - {buffer_miles} mile - {segment}"


def _prepare_model_inputs(
    matrices_selected: Dict[str, Dict[str, pd.DataFrame]],
    config: Dict,
    ) -> Dict[str, Dict[str, pd.DataFrame]]:
    """
    For each level (msa, county, tract):
      - Read target definition from config['ml']['target_y'][level]:
          * buffer_miles
          * segment (AV / Non-AV)
      - Build the target column name, e.g. 'Count Customer - 3 mile - AV'.
      - Extract y_raw from Y_features.
      - Binarize: y = 1 if y_raw >= 1 else 0.
      - Take X := X_selected and fill any remaining NaNs with 0.
      - Return structure:
          level: {
              "ID": df_id,
              "X": df_x,                 # full numeric X
              "X_selected": df_x_sel,    # final features
              "X_model": X_model,        # X_selected with NaNs filled
              "y_raw": y_raw,
              "y": y_binary,
              "target_col": target_col_name,
          }
    """

    target_cfg = config.get("ml", {}).get("target_y", {})

    result: Dict[str, Dict[str, pd.DataFrame]] = {}

    for level in ["msa", "county", "tract"]:
        level_dict = matrices_selected[level]
        df_id = level_dict["ID"]
        df_x = level_dict["X"]
        df_x_sel = level_dict["X_selected"]
        df_y_features = level_dict["Y_features"]

        cfg_level = target_cfg.get(level, {})
        buffer_miles = cfg_level.get("buffer_miles", 3 if level != "msa" else 5)
        segment = cfg_level.get("segment", "AV")

        if segment not in {"AV", "Non-AV"}:
            raise ValueError(f"[train_rankings] Invalid segment for level '{level}': {segment}")

        target_col = _build_target_col_name(buffer_miles, segment)

        if target_col not in df_y_features.columns:
            logger.warning(
                "Level '%s': target column '%s' not found in Y_features. "
                "Available columns: %s",
                level,
                target_col,
                list(df_y_features.columns),
            )
            # Fallback: create a zero target to avoid hard crash
            y_raw = pd.Series(0, index=df_y_features.index, name=target_col)
        else:
            y_raw = df_y_features[target_col].copy()

        if target_col not in df_y_features.columns:
            logger.error(
                "[train_rankings] Level '%s': target column '%s' not found in Y_features. "
                "Check YAML target_y settings and upstream column naming.",
                level, target_col
            )
            raise KeyError(f"[train_rankings] Level '{level}' missing target column: {target_col}")
        
        y_raw = df_y_features[target_col].copy()

        # Binarize: >= 1 -> 1, else 0; treat NaN as 0
        y_raw_filled = y_raw.fillna(0)
        y_binary = (y_raw_filled >= 1).astype(int)

        # Final X for modeling: selected features, NaNs -> 0
        X_model = df_x_sel.copy().fillna(0)

        logger.info(
            "Level '%s': target='%s', positives=%d, total=%d",
            level,
            target_col,
            int(y_binary.sum()),
            len(y_binary),
        )

        result[level] = {
            "ID": df_id,
            "X": df_x,
            "X_selected": df_x_sel,
            "X_model": X_model,
            "Y_features": df_y_features,
            "y_raw": y_raw,
            "y": y_binary,
            "target_col": target_col,
        }

    return result

def _train_logistic_for_level(
    level: str,
    model_input: Dict[str, Any],
    config: Dict,
) -> Dict[str, Any]:
    """
    Train + evaluate a logistic regression model for one level
    (msa / county / tract) using:
      - X_model (final X features, NaNs already filled with 0)
      - y (binary 0/1 target)
      - target_col (for logging)

    Steps:
      1) stratified train/test split
      2) StandardScaler on X
      3) LogisticRegression with fixed hyperparameters
      4) Evaluate on train, test, and full
      5) Score full dataset (predict_proba) and build rankings dataframe
    """

    df_id = model_input["ID"]
    X = model_input["X_model"]
    y = model_input["y"]
    target_col = model_input["target_col"]

    # --------------------------------------------------------------
    # 1. Train/test split (stratified)
    # --------------------------------------------------------------
    ml_cfg = config.get("ml", {})
    split_cfg = ml_cfg.get("train_test_split", {})

    test_size = split_cfg.get("test_size", 0.33)
    random_state = split_cfg.get("random_state", 9)

    # check to see if its a single class y (to train we need binary)
    pos = int(pd.Series(y).sum())
    n = len(y)
    if pos == 0 or pos == n:
        logger.error(
            "[train_rankings] Level '%s': target '%s' has only one class (positives=%d, total=%d).",
            level, target_col, pos, n
        )
        raise ValueError(f"[train_rankings] Level '{level}' has single-class target; cannot train.")

    neg = n - pos
    if pos < 2 or neg < 2:
        raise ValueError(
            f"[train_rankings] Level '{level}': not enough samples per class for stratified split "
            f"(positives={pos}, negatives={neg}, total={n})."
        )

    
    X_train, X_test, y_train, y_test = train_test_split(
        X,
        y,
        test_size=test_size,
        random_state=random_state,
        stratify=y,
    )

    logger.info(
        "Level '%s': train/test split done. Train=%d, Test=%d, Positives(train)=%d, Positives(test)=%d",
        level,
        len(y_train),
        len(y_test),
        int(y_train.sum()),
        int(y_test.sum()),
    )

    # --------------------------------------------------------------
    # 2. Pipeline: StandardScaler + LogisticRegression
    # --------------------------------------------------------------
    # Hyperparameters mirror the original notebook
    if level == "msa":
        C_value = 0.01
    elif level == "county":
        C_value = 0.005
    else:  # tract
        C_value = 0.01
        
    clf = Pipeline(
        steps=[
            ("scaler", StandardScaler()),
            (
                "logreg",
                LogisticRegression(
                    C=C_value,
                    penalty="l2",
                    tol=0.01,
                    solver="liblinear",
                    class_weight="balanced",
                    max_iter=1000,
                ),
            ),
        ]
    )

    # --------------------------------------------------------------
    # 3. Fit model
    # --------------------------------------------------------------
    clf.fit(X_train, y_train)
    logger.info("Level '%s': logistic regression fitted (target=%s).", level, target_col)

    # --------------------------------------------------------------
    # 4. Evaluate on train, test, full
    # --------------------------------------------------------------
    def _evaluate_split(X_split, y_split, split_name: str) -> Dict[str, float]:
        y_pred = clf.predict(X_split)
        # For ROC AUC we need probabilities; handle edge case: all zeros or ones
        try:
            y_proba = clf.predict_proba(X_split)[:, 1]
            auc = roc_auc_score(y_split, y_proba)
        except Exception:
            y_proba = None
            auc = float("nan")

        acc = accuracy_score(y_split, y_pred)
        prec = precision_score(y_split, y_pred, zero_division=0)
        rec = recall_score(y_split, y_pred, zero_division=0)

        logger.info(
            "Level '%s' [%s]: accuracy=%.3f, precision=%.3f, recall=%.3f, roc_auc=%.3f",
            level,
            split_name,
            acc,
            prec,
            rec,
            auc,
        )

        return {
            "accuracy": acc,
            "precision": prec,
            "recall": rec,
            "roc_auc": auc,
        }

    metrics_train = _evaluate_split(X_train, y_train, "train")
    metrics_test = _evaluate_split(X_test, y_test, "test")
    metrics_full = _evaluate_split(X, y, "full")

    # Confusion matrix on full data (for logging)
    y_full_pred = clf.predict(X)
    cm_full = confusion_matrix(y, y_full_pred)
    logger.info(
        "Level '%s': full-data confusion matrix:\n%s",
        level,
        cm_full,
    )

    # --------------------------------------------------------------
    # 5. Score full dataset and build rankings
    # --------------------------------------------------------------
    y_proba_full = clf.predict_proba(X)[:, 1]   # P
    y_pred_full = clf.predict(X)                # 0/1
    y_proba_0 = 1.0 - y_proba_full             # 1-P

    df_rank = df_id.copy()
    df_rank["Prediction-01"] = y_pred_full
    df_rank["1-P"] = y_proba_0
    df_rank["P"] = y_proba_full
    # optional: keep raw y for debugging
    #df_rank["y_true"] = y.values
    df_rank["y_true"] = np.asarray(y)

    df_rank_sorted = df_rank.sort_values("P", ascending=False).reset_index(drop=True)

    result = {
        "level": level,
        "target_col": target_col,
        "model": clf,
        "metrics": {
            "train": metrics_train,
            "test": metrics_test,
            "full": metrics_full,
            "confusion_full": cm_full.tolist(),
        },
        "rankings": df_rank_sorted,
    }


    return result

# def _save_models_and_rankings(
#     results: Dict[str, Dict[str, Any]],
#     config: Dict,
#     ) -> None:
#     """
#     Save trained models and ranking outputs for each level
#     (msa, county, tract) using config-driven filenames.
#     """

#     if "paths" not in config or "outputs" not in config["paths"]:
#         raise KeyError("[train_rankings] Missing config.paths.outputs in settings.yaml")

#     outputs_root = Path(config["paths"]["outputs"])
#     ml_outputs_cfg = config.get("ml", {}).get("ml_outputs", {})

#     outputs_root.mkdir(parents=True, exist_ok=True)

#     for level in ["msa", "county", "tract"]:
#         if level not in results:
#             logger.warning("No results found for level '%s'; skipping save.", level)
#             continue

#         level_cfg = ml_outputs_cfg.get(level, {})
#         model_name = level_cfg.get(
#             "model",
#             f"{level}_logreg_model-refactored.sav",
#         )
#         ranking_name = level_cfg.get(
#             "ranking",
#             f"{level}_predication_results-refactored.xlsx",
#         )

#         model_path = outputs_root / model_name
#         ranking_path = outputs_root / ranking_name

#         model = results[level]["model"]
#         rankings_df = results[level]["rankings"]

#         logger.info(
#             "Saving %s model to: %s", level, model_path.as_posix()
#         )
#         joblib.dump(model, model_path)

#         logger.info(
#             "Saving %s rankings to: %s (rows=%d)",
#             level,
#             ranking_path.as_posix(),
#             len(rankings_df),
#         )
#         if rankings_df.empty:
#             logger.warning( 
#                 "[train_rankings] %s rankings dataframe is empty; file will still be written.",
#                 level,
#         )

#         rankings_df.to_excel(ranking_path, index=False)

def _save_models_and_rankings(
    results: Dict[str, Dict[str, Any]],
    config: Dict,
) -> None:
    """
    Save trained models for each level (msa, county, tract) and write
    a single rankings workbook with sheets: MSA, County, Tract.
    """

    if "paths" not in config or "outputs" not in config["paths"]:
        raise KeyError("[train_rankings] Missing config.paths.outputs in settings.yaml")

    outputs_root = Path(config["paths"]["outputs"])
    ml_outputs_cfg = config.get("ml", {}).get("ml_outputs", {})
    outputs_root.mkdir(parents=True, exist_ok=True)

    # ---- 1) Save models (unchanged behavior) ----
    for level in ["msa", "county", "tract"]:
        if level not in results:
            logger.warning("No results found for level '%s'; skipping save.", level)
            continue

        level_cfg = ml_outputs_cfg.get(level, {})
        model_name = level_cfg.get("model", f"{level}_logreg_model-refactored.sav")
        model_path = outputs_root / model_name

        model = results[level]["model"]
        logger.info("Saving %s model to: %s", level, model_path.as_posix())
        joblib.dump(model, model_path)

    # ---- 2) Save rankings into ONE workbook with sheets ----
    workbook_name = ml_outputs_cfg.get(
        "rankings_workbook",
        "4Cs_AVCustomer_Rankings_AllLevels-refactored.xlsx",
    )
    workbook_path = outputs_root / workbook_name

    sheet_map = {"msa": "MSA", "county": "County", "tract": "Tract"}

    logger.info("Saving combined rankings workbook to: %s", workbook_path.as_posix())

    with pd.ExcelWriter(workbook_path, engine="openpyxl") as writer:
        for level in ["msa", "county", "tract"]:
            if level not in results:
                continue
            rankings_df = results[level]["rankings"]
            sheet_name = sheet_map[level]

            if rankings_df.empty:
                logger.warning(
                    "[train_rankings] %s rankings dataframe is empty; sheet will still be written.",
                    level,
                )

            rankings_df.to_excel(writer, sheet_name=sheet_name, index=False)

    logger.info("Combined rankings workbook saved (sheets: MSA, County, Tract).")

# -----------------------------------------------------------
# Main entrypoint (still empty except Step 1)
# -----------------------------------------------------------
def run_training(config: Dict) -> Dict[str, str]:
    """
    Main training pipeline.
    Step 1: Resolve paths + load data (done)
    Step 2+: Add transformations, feature engineering, training, scoring, and outputs.
    """
    logger.info("=== Starting ranking model training ===")

    # Step 1 — path resolution + raw data loading
    resolved_paths = _resolve_paths(config)
    raw_data = _load_raw_inputs(resolved_paths)
    
    logger.info("Step 1 complete — raw data loaded.")
    
    # Step 2 — column-name normalization
    data_norm = _normalize_column_names(raw_data)

    logger.info("Step 2 complete — column names normalized.")
   
    # Step 3 — add few new rideshare features (Section 3.2 logic in notebook)
    data_rideshare = _add_rideshare_features(data_norm)
    logger.info("Step 3 complete — rideshare features added.")
    
    # Step 4 — add MSA context (Section 3.3 logic in notebook)
    data_with_msa_ctx = _attach_msa_context(data_rideshare)
    logger.info("Step 4 complete — msa context added to tract/county.")
        
    # Step 5 — impute missing values (Section 3.4 logic in notebook)
    data_filled = _fill_missing_values(data_with_msa_ctx)
    logger.info("Step 5 complete — missing values imputed.")
        
    # Step 6 - msa sigma features added to tract
    data_with_sigma = _add_msa_sigma_features(data_filled)
    logger.info("Step 6 complete — MSA sigma-based tract features added.")
        
    # Step 7: apply MSA thesis overrides (updates MSA Y-features)
    data_with_thesis = _apply_msa_thesis_overrides(data_with_sigma, config)
    logger.info("Step 7 complete — MSA thesis overrides applied (if configured).")
       
    # Step 8: apply geofence overrides (updates MSA Y-features)
    data_with_geofence = _apply_geofence_overrides(data_with_thesis)
    logger.info("Step 8 complete — geofence-based Y overrides applied.")
   
    # Step 9: Separate X and Y features
    data_XY = _build_feature_matrices(data_with_geofence)
    logger.info("Step 9 complete — X/Y matrices constructed for MSA, County, Tract.")
    
    # Step 10: Feature selection
    data_fs = _select_final_features(data_XY)
    logger.info("Step 10 complete — final feature selection applied for MSA, County, Tract.")

    # Step 11: Prepare Model inputs
    model_inputs = _prepare_model_inputs(data_fs, config)
    logger.info("Step 11 complete — target Y selected and binarized; X finalized for modeling.")
        
    # Step 12: Split, Train, Evaluate the Model
    results = {}
    for level in ["msa", "county", "tract"]:
        logger.info("=== Training logistic model for level: %s ===", level)
        results[level] = _train_logistic_for_level(level, model_inputs[level], config)

    # Step 13: save trained models and rankings
    _save_models_and_rankings(results, config)
    logger.info("Step 13 complete — models and rankings saved to outputs folder.")

    return {"status": "training_complete", "levels": list(results.keys())}
