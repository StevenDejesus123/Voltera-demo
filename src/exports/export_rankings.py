"""
Export module for generating geospatial artifacts from ranking outputs.

Phase 3.2: Reporting Outputs & Export Optimization

This module:
- Joins model ranking outputs with tract/county/MSA geometries
- Exports to CSV/Excel, KML/KMZ, and GeoJSON formats
- Generates heat map styled layers for visualization
"""

from __future__ import annotations

import html
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

import geopandas as gpd
import numpy as np
import pandas as pd
import json
from shapely.geometry import mapping

from src.utils.logging_utils import get_logger
from src.exports.export_competitor_tracker import export_competitor_tracker


def _escape_xml(text: Any) -> str:
    """
    Escape special XML characters in text.

    Parameters
    ----------
    text : Any
        Text to escape (will be converted to string).

    Returns
    -------
    str
        XML-safe string with &, <, >, ", ' escaped.
    """
    return html.escape(str(text))


def _count_vertices(gdf: gpd.GeoDataFrame) -> int:
    """
    Count total vertices in all geometries.

    Parameters
    ----------
    gdf : gpd.GeoDataFrame
        GeoDataFrame with geometry column.

    Returns
    -------
    int
        Total vertex count across all polygons.
    """
    total = 0
    for geom in gdf.geometry:
        if geom is None or geom.is_empty:
            continue
        if geom.geom_type == "Polygon":
            polygons = [geom]
        elif geom.geom_type == "MultiPolygon":
            polygons = list(geom.geoms)
        else:
            continue
        for poly in polygons:
            total += len(poly.exterior.coords)
            for interior in poly.interiors:
                total += len(interior.coords)
    return total


def _simplify_geometry(
    gdf: gpd.GeoDataFrame,
    tolerance: float,
    preserve_topology: bool = True,
    logger=None,
) -> gpd.GeoDataFrame:
    """
    Simplify geometries to reduce vertex count for KML export.

    Parameters
    ----------
    gdf : gpd.GeoDataFrame
        GeoDataFrame with geometry column.
    tolerance : float
        Simplification tolerance in the units of the CRS.
        For WGS84 (EPSG:4326), 0.005 degrees ≈ 500m.
    preserve_topology : bool
        Whether to preserve topology during simplification.
    logger
        Logger instance.

    Returns
    -------
    gpd.GeoDataFrame
        GeoDataFrame with simplified geometries.
    """
    original_vertices = _count_vertices(gdf)

    simplified = gdf.copy()
    simplified["geometry"] = simplified.geometry.simplify(
        tolerance=tolerance, preserve_topology=preserve_topology
    )

    new_vertices = _count_vertices(simplified)

    if logger:
        reduction = 100 * (1 - new_vertices / original_vertices) if original_vertices > 0 else 0
        logger.info(
            "  Simplified: %d -> %d vertices (%.1f%% reduction, tolerance=%.4f)",
            original_vertices,
            new_vertices,
            reduction,
            tolerance,
        )

    return simplified


def _add_rank_column(df: pd.DataFrame, prob_col: str = "P") -> pd.DataFrame:
    """
    Add a Rank column based on probability score (descending).

    Rank 1 = highest probability (best site candidate).

    Parameters
    ----------
    df : pd.DataFrame
        DataFrame with probability column.
    prob_col : str
        Name of the probability column. Default "P".

    Returns
    -------
    pd.DataFrame
        DataFrame with added "Rank" column.
    """
    result = df.copy()
    # Rank by P descending (highest P = Rank 1)
    # method="min" means ties get the same rank (1, 1, 3 not 1, 2, 3)
    result["Rank"] = result[prob_col].rank(ascending=False, method="min").astype(int)
    return result


def _probability_to_kml_color(prob: float, alpha: int = 200) -> str:
    """
    Convert probability score to KML color string (ABGR format).

    Uses a heat map gradient:
    - Low probability (0.0): Red (high risk / low attractiveness)
    - High probability (1.0): Green (good site candidate)

    Parameters
    ----------
    prob : float
        Probability score between 0 and 1.
    alpha : int
        Alpha transparency (0-255). Default 200 for slight transparency.

    Returns
    -------
    str
        KML color in ABGR hex format (e.g., 'c814F000').
    """
    prob = max(0.0, min(1.0, prob))  # Clamp to [0, 1]

    # Gradient: Red (low) -> Yellow (mid) -> Green (high)
    if prob < 0.5:
        # Red to Yellow
        red = 255
        green = int(255 * (prob * 2))
        blue = 0
    else:
        # Yellow to Green
        red = int(255 * (1 - (prob - 0.5) * 2))
        green = 255
        blue = 0

    # KML uses ABGR format (Alpha, Blue, Green, Red)
    return f"{alpha:02x}{blue:02x}{green:02x}{red:02x}"


def _load_rankings(rankings_path: Path, logger) -> dict[str, pd.DataFrame]:
    """
    Load ranking outputs from Excel workbook.

    Parameters
    ----------
    rankings_path : Path
        Path to the rankings Excel file with MSA/County/Tract sheets.
    logger
        Logger instance.

    Returns
    -------
    dict
        Dictionary with keys 'msa', 'county', 'tract' and DataFrame values.
    """
    logger.info("Loading rankings from: %s", rankings_path)

    rankings = {}
    for level in ["MSA", "County", "Tract"]:
        df = pd.read_excel(rankings_path, sheet_name=level)
        rankings[level.lower()] = df
        logger.info("  %s: %d rows loaded", level, len(df))

    return rankings


def _load_spatial_files(spatial_dir: Path, logger) -> dict[str, gpd.GeoDataFrame]:
    """
    Load tract and county shapefiles.

    Parameters
    ----------
    spatial_dir : Path
        Directory containing Tract.shp and County.shp.
    logger
        Logger instance.

    Returns
    -------
    dict
        Dictionary with 'tract' and 'county' GeoDataFrames.
    """
    spatial = {}

    tract_path = spatial_dir / "Tract.shp"
    county_path = spatial_dir / "County.shp"

    logger.info("Loading spatial files from: %s", spatial_dir)

    if tract_path.exists():
        spatial["tract"] = gpd.read_file(tract_path)
        logger.info("  Tract.shp: %d geometries", len(spatial["tract"]))
    else:
        raise FileNotFoundError(f"Tract shapefile not found: {tract_path}")

    if county_path.exists():
        spatial["county"] = gpd.read_file(county_path)
        logger.info("  County.shp: %d geometries", len(spatial["county"]))
    else:
        raise FileNotFoundError(f"County shapefile not found: {county_path}")

    return spatial


def _load_master_geocode(geocode_path: Path, logger) -> pd.DataFrame:
    """
    Load master geocode mapping file for tract-to-MSA relationships.

    Parameters
    ----------
    geocode_path : Path
        Path to master geocode Excel file.
    logger
        Logger instance.

    Returns
    -------
    pd.DataFrame
        Geocode mapping with Tract_GeoID and MSA columns.
    """
    logger.info("Loading master geocode from: %s", geocode_path)

    # The mapping is in the 'MasterGeocodeMap' sheet
    df = pd.read_excel(geocode_path, sheet_name="MasterGeocodeMap")

    # Standardize column names
    df.columns = df.columns.str.strip()

    logger.info("  Master geocode: %d rows, columns: %s", len(df), list(df.columns)[:10])

    return df


def _join_rankings_with_geometry(
    rankings_df: pd.DataFrame,
    spatial_gdf: gpd.GeoDataFrame,
    rankings_id_col: str,
    spatial_id_col: str = "GEOID",
    logger=None,
) -> gpd.GeoDataFrame:
    """
    Join rankings DataFrame with spatial GeoDataFrame.

    Handles GEOID type conversion (rankings may have int, spatial has str).

    Parameters
    ----------
    rankings_df : pd.DataFrame
        Rankings data with ID and probability columns.
    spatial_gdf : gpd.GeoDataFrame
        Spatial data with geometry and GEOID.
    rankings_id_col : str
        Column name for ID in rankings DataFrame.
    spatial_id_col : str
        Column name for ID in spatial GeoDataFrame.
    logger
        Logger instance.

    Returns
    -------
    gpd.GeoDataFrame
        Merged GeoDataFrame with rankings and geometry.
    """
    # Create copies to avoid modifying originals
    rankings = rankings_df.copy()
    spatial = spatial_gdf.copy()

    # Ensure both ID columns are strings for joining
    rankings["_join_id"] = rankings[rankings_id_col].astype(str).str.zfill(
        11 if "Tract" in rankings_id_col else 5
    )
    spatial["_join_id"] = spatial[spatial_id_col].astype(str)

    # Perform left join (keep all spatial geometries, add rankings where available)
    merged = spatial.merge(
        rankings,
        on="_join_id",
        how="inner",  # Only keep geometries that have rankings
    )

    # Drop temporary join column
    merged = merged.drop(columns=["_join_id"])

    # Add rank column based on probability
    merged = _add_rank_column(merged)

    if logger:
        logger.info(
            "  Joined %d rankings with %d geometries -> %d matched",
            len(rankings),
            len(spatial),
            len(merged),
        )

    return merged


def _detect_id_column(df: pd.DataFrame, preferred: Optional[List[str]] = None, keywords: Optional[List[str]] = None) -> Optional[str]:
    """
    Find an ID column in `df` using preferred exact names first, then by keyword containment.

    Parameters
    ----------
    df : pd.DataFrame
        Rankings dataframe to inspect.
    preferred : Optional[List[str]]
        List of exact column names to try first.
    keywords : Optional[List[str]]
        List of lower-case substrings to search for in column names.

    Returns
    -------
    Optional[str]
        Matching column name or None if not found.
    """
    cols = list(df.columns)
    if preferred:
        for name in preferred:
            if name in cols:
                return name
    if keywords:
        for col in cols:
            low = col.lower()
            for kw in keywords:
                if kw in low:
                    return col
    return None


def _dissolve_tracts_to_msa(
    tract_gdf: gpd.GeoDataFrame,
    msa_rankings: pd.DataFrame,
    master_geocode: pd.DataFrame,
    logger,
) -> gpd.GeoDataFrame:
    """
    Create MSA geometries by dissolving tract polygons.

    Parameters
    ----------
    tract_gdf : gpd.GeoDataFrame
        Tract spatial data.
    msa_rankings : pd.DataFrame
        MSA-level rankings.
    master_geocode : pd.DataFrame
        Tract-to-MSA mapping from MasterGeocodeMap sheet.
    logger
        Logger instance.

    Returns
    -------
    gpd.GeoDataFrame
        MSA geometries with rankings.
    """
    logger.info("Dissolving tracts to MSA boundaries...")

    # Determine tract and MSA id/name columns from master geocode
    tract_col = None
    msa_id_col = None
    msa_name_col = None

    # common expected names
    if "CLEAN_Tract Geoid" in master_geocode.columns:
        tract_col = "CLEAN_Tract Geoid"
    else:
        for c in master_geocode.columns:
            if "tract" in c.lower() and "geoid" in c.lower():
                tract_col = c
                break

    # prefer numeric MSA id column such as 'CBSA Code' or 'CBSA'
    for c in master_geocode.columns:
        cl = c.lower()
        if "cbsa" in cl or ("cbsa" in cl and "code" in cl) or ("cbsa code" in cl):
            msa_id_col = c
            break

    # fallback to any column containing 'cbsa' or 'msa' or 'metropolitan'
    if msa_id_col is None:
        for c in master_geocode.columns:
            if any(k in c.lower() for k in ("cbsa", "msa", "metropolitan", "metrop", "metropolitan division")):
                # prefer ones that don't look like names for id, else pick as name
                if any(k in c.lower() for k in ("code", "id", "fips", "cbsa")):
                    msa_id_col = c
                    break
                if msa_name_col is None:
                    msa_name_col = c

    # pick msa_name_col if not set - prefer explicit Metropolitan Division Code/name
    if msa_name_col is None and "Metropolitan Division Code" in master_geocode.columns:
        msa_name_col = "Metropolitan Division Code"
    if msa_name_col is None:
        for c in master_geocode.columns:
            cl = c.lower()
            # avoid generic State Name picks
            if "state" in cl:
                continue
            if any(k in cl for k in ("metropolitan", "division", "metro")):
                msa_name_col = c
                break
        # lastly allow 'name' if nothing better
        if msa_name_col is None:
            for c in master_geocode.columns:
                if "name" in c.lower():
                    msa_name_col = c
                    break

    if tract_col is None:
        raise ValueError(f"Tract column not found in master geocode. Available: {list(master_geocode.columns)}")
    if msa_id_col is None and msa_name_col is None:
        raise ValueError(f"No MSA identifier column found in master geocode. Available: {list(master_geocode.columns)}")

    logger.info("  Using Tract column: %s", tract_col)
    logger.info("  Using MSA id column: %s", msa_id_col)
    logger.info("  Using MSA name column: %s", msa_name_col)
    logger.info("  Master geocode columns sample: %s", list(master_geocode.columns)[:12])

    # Build tract -> msa id and name mapping
    tract_msa_map = master_geocode[[tract_col] + ([msa_id_col] if msa_id_col else []) + ([msa_name_col] if msa_name_col else [])].drop_duplicates()
    tract_msa_map['_tract_id'] = tract_msa_map[tract_col].astype(str).str.zfill(11)

    tracts_with_msa = tract_gdf.copy()
    tracts_with_msa['_tract_id'] = tracts_with_msa['GEOID'].astype(str)

    # merge id and name where available
    merge_cols = ['_tract_id']
    if msa_id_col:
        merge_cols.append(msa_id_col)
    if msa_name_col and msa_name_col not in merge_cols:
        merge_cols.append(msa_name_col)

    tracts_with_msa = tracts_with_msa.merge(
        tract_msa_map[merge_cols],
        on='_tract_id',
        how='left',
    )

    # Filter to tracts that have MSA assignment (either id or name)
    if msa_id_col:
        tracts_with_msa = tracts_with_msa[tracts_with_msa[msa_id_col].notna()]
    else:
        tracts_with_msa = tracts_with_msa[tracts_with_msa[msa_name_col].notna()]

    logger.info("  Tracts with MSA assignment: %d", len(tracts_with_msa))

    # Dissolve by MSA id if available, else by name
    dissolve_by = msa_id_col if msa_id_col in tracts_with_msa.columns else msa_name_col
    # If both id and name columns exist, preserve the name by using aggfunc='first'
    if msa_id_col and msa_name_col and msa_id_col in tracts_with_msa.columns and msa_name_col in tracts_with_msa.columns:
        msa_geometries = tracts_with_msa.dissolve(by=msa_id_col, as_index=False, aggfunc='first')
    else:
        msa_geometries = tracts_with_msa.dissolve(by=dissolve_by, as_index=False)
        logger.info("  Dissolved into %d MSA polygons (by %s)", len(msa_geometries), dissolve_by)

        # Build explicit msaID and msaName columns from the tract->MSA mapping
        try:
            msa_id_map = {}
            msa_name_map = {}
            if dissolve_by in tracts_with_msa.columns:
                group = tracts_with_msa.groupby(dissolve_by)
                if msa_id_col and msa_id_col in tracts_with_msa.columns:
                    def _pick_mode_id(s):
                        vals = s.dropna().astype(str)
                        return vals.mode().iloc[0] if not vals.empty else None

                    msa_id_map = group[msa_id_col].agg(_pick_mode_id).to_dict()

                if msa_name_col and msa_name_col in tracts_with_msa.columns:
                    def _pick_mode_name(s):
                        vals = s.dropna().astype(str)
                        return vals.mode().iloc[0] if not vals.empty else None

                    msa_name_map = group[msa_name_col].agg(_pick_mode_name).to_dict()

            # attach maps to dissolved geometries
            if dissolve_by in msa_geometries.columns:
                msa_geometries['msaID'] = msa_geometries[dissolve_by].map(lambda k: msa_id_map.get(k) if k in msa_id_map else None)
                msa_geometries['msaName'] = msa_geometries[dissolve_by].map(lambda k: msa_name_map.get(k) if k in msa_name_map else None)
        except Exception as e:
            logger.warning("  Failed to compute msaID/msaName maps: %s", str(e))
    # log sample values and columns to help debug joins
    if dissolve_by in msa_geometries.columns:
        try:
            logger.info("  sample dissolve keys: %s", list(msa_geometries[dissolve_by].dropna().astype(str).head(10).unique()))
        except Exception:
            logger.info("  sample dissolve keys unavailable")
    logger.info("  msa_geometries columns: %s", list(msa_geometries.columns)[:20])

    # Determine column in msa_rankings to join on: prefer numeric id matching msa_id_col, else name
    msa_rankings_col = None
    if msa_id_col:
        for col in msa_rankings.columns:
            if col.lower() == msa_id_col.lower() or 'cbsa' in col.lower() or 'code' in col.lower() or 'id' in col.lower():
                msa_rankings_col = col
                break
    if msa_rankings_col is None:
        for col in msa_rankings.columns:
            if any(k in col.lower() for k in ('metropolitan', 'msa', 'name', 'division')):
                msa_rankings_col = col
                break
    if msa_rankings_col is None:
        msa_rankings_col = msa_rankings.columns[0]

    # Normalize join keys to strings (coerce numeric codes to int strings) to avoid dtype mismatch
    def _normalize_key_series(s: pd.Series) -> pd.Series:
        s_orig = s.astype(str)
        s_num = pd.to_numeric(s, errors='coerce')
        mask = s_num.notna()
        try:
            s_orig.loc[mask] = s_num.loc[mask].astype(int).astype(str)
        except Exception:
            s_orig.loc[mask] = s_num.loc[mask].apply(lambda v: str(int(float(v))) if pd.notna(v) else "")
        return s_orig.str.strip()

    # Decide which key to use for joining: prefer numeric id if rankings contain it, otherwise use name
    join_using = None
    if msa_rankings_col:
        rk = msa_rankings_col.lower()
        if msa_id_col and (rk == msa_id_col.lower() or any(k in rk for k in ('cbsa', 'code', 'id'))):
            join_using = msa_id_col
        else:
            join_using = msa_name_col if msa_name_col in msa_geometries.columns else (msa_id_col if msa_id_col in msa_geometries.columns else dissolve_by)
    else:
        join_using = dissolve_by

    # ensure join_using exists on both sides; normalize both
    if join_using in msa_geometries.columns:
        msa_geometries[join_using] = _normalize_key_series(msa_geometries[join_using])
    if msa_rankings_col in msa_rankings.columns:
        msa_rankings[msa_rankings_col] = _normalize_key_series(msa_rankings[msa_rankings_col])

    # Attempt merge using chosen key
    msa_gdf = msa_geometries.merge(
        msa_rankings,
        left_on=join_using,
        right_on=msa_rankings_col,
        how='inner',
    )

    # If no matches and we used id, attempt join by normalized name as fallback
    if msa_gdf.empty and msa_name_col and msa_name_col in msa_geometries.columns and msa_rankings_col:
        try:
            # normalize names (lower, remove punctuation) for fuzzy join
            def _norm_name_series(s: pd.Series) -> pd.Series:
                return s.astype(str).str.lower().str.replace(r"[^a-z0-9\\s]", "", regex=True).str.strip()

            msa_geometries['_msa_name_norm'] = _norm_name_series(msa_geometries[msa_name_col])
            msa_rankings['_rank_name_norm'] = _norm_name_series(msa_rankings[msa_rankings_col])

            logger.info("  Attempting name-based fallback join using normalized columns")

            msa_gdf = msa_geometries.merge(
                msa_rankings,
                left_on='_msa_name_norm',
                right_on='_rank_name_norm',
                how='inner',
            )
            if not msa_gdf.empty:
                logger.info("  Merge succeeded using normalized MSA name column '%s' after id join failed", msa_name_col)
            else:
                logger.info("  Name-based fallback merge produced 0 rows")
        except Exception as ex:
            logger.warning("  Name-based fallback merge failed: %s", str(ex))

    # Add rank column based on probability
    msa_gdf = _add_rank_column(msa_gdf)

    logger.info("  Final MSA GeoDataFrame: %d features", len(msa_gdf))
    return msa_gdf


def _export_csv(gdf: gpd.GeoDataFrame, output_path: Path, level: str, logger) -> None:
    """Export rankings as CSV (without geometry)."""
    # Select only ranking columns (exclude geometry and most spatial attributes)
    exclude_cols = ["geometry", "_join_id", "_tract_id"]
    cols_to_export = [c for c in gdf.columns if c not in exclude_cols and not c.startswith("B0")]

    df = gdf[cols_to_export].copy()
    df.to_csv(output_path, index=False)
    logger.info("  CSV exported: %s (%d rows)", output_path.name, len(df))


def _export_excel(gdf: gpd.GeoDataFrame, output_path: Path, level: str, logger) -> None:
    """Export rankings as Excel (without geometry)."""
    exclude_cols = ["geometry", "_join_id", "_tract_id"]
    cols_to_export = [c for c in gdf.columns if c not in exclude_cols and not c.startswith("B0")]

    df = gdf[cols_to_export].copy()
    df.to_excel(output_path, index=False, sheet_name=level.upper())
    logger.info("  Excel exported: %s (%d rows)", output_path.name, len(df))


def _export_geojson(gdf: gpd.GeoDataFrame, output_path: Path, level: str, logger) -> None:
    """Export as GeoJSON."""
    # Keep only essential columns for GeoJSON
    essential_cols = ["geometry"]

    # Add ID column
    if level == "tract":
        id_cols = ["Tract_GeoID", "GEOID"]
    elif level == "county":
        id_cols = ["County_GeoID", "GEOID"]
    else:
        id_cols = ["Metropolitan Division Code"]

    for col in id_cols:
        if col in gdf.columns:
            essential_cols.append(col)
            break

    # Add ranking columns
    for col in ["Rank", "P", "Prediction-01", "1-P", "y_true"]:
        if col in gdf.columns:
            essential_cols.append(col)

    # Add name columns if available
    for col in ["NAME", "NAMELSAD", "State", "County"]:
        if col in gdf.columns:
            essential_cols.append(col)

    export_gdf = gdf[essential_cols].copy()
    export_gdf.to_file(output_path, driver="GeoJSON")
    logger.info("  GeoJSON exported: %s (%d features)", output_path.name, len(export_gdf))


def _round_coords(obj, precision=6):
    """Recursively convert tuples to lists and round floats for JSON serializable coordinates."""
    if isinstance(obj, (float, int)):
        if isinstance(obj, float):
            return round(obj, precision)
        return obj
    if isinstance(obj, tuple):
        return [_round_coords(v, precision) for v in obj]
    if isinstance(obj, list):
        return [_round_coords(v, precision) for v in obj]
    if isinstance(obj, dict):
        return {k: _round_coords(v, precision) for k, v in obj.items()}
    return obj


# Feature columns to include for each level in frontend export
FRONTEND_FEATURE_COLS = {
    "msa": [
        ("Count EV Station - Non-Tesla", "evStationCount", "EV Stations (Non-Tesla)"),
        ("Count Airport - 0 mile", "airportCount", "Nearby Airports"),
        ("Count AV Testing - 0 mile", "avTestingCount", "AV Testing Sites"),
        ("State_Funding_Awards_Count", "stateFundingCount", "State Funding Awards"),
        ("Federal_Funding_Amount", "federalFundingAmount", "Federal Funding ($)"),
        ("# rideshare trips", "rideshareTrips", "Rideshare Trips"),
        ("rideshare_trip_per_capita", "ridesharePerCapita", "Rideshare Per Capita"),
        ("Total Population", "population", "Total Population"),
        ("Population Density (#/sqrtM)", "populationDensity", "Population Density"),
        ("Median Household Income in past 12 months", "medianIncome", "Median Income"),
        ("Average Weekly Wage", "avgWeeklyWage", "Avg Weekly Wage"),
        ("Percent of workers who commuted by public transportation", "publicTransitPct", "Public Transit %"),
        ("Area (SQRT Miles)", "areaSqrtMiles", "Area (Sqrt Miles)"),
        ("Snowdays", "snowdays", "Annual Snow Days"),
        ("Temperature", "temperature", "Avg Temperature"),
        ("Precipitation", "precipitation", "Annual Precipitation (in)"),
        ("HRCN_RISKR_#", "hurricaneRisk", "Hurricane Risk Rating"),
        ("Regular Gas Price ($/G)", "gasPrice", "Gas Price ($/gal)"),
        ("Price (cent/kwh)", "electricityPrice", "Electricity Price (¢/kWh)"),
        ("Land Value (1/4 Acre Lot, Standardized)", "landValue", "Land Value ($/lot)"),
    ],
    "county": [
        ("Count EV Station - Non-Tesla", "evStationCount", "EV Stations (Non-Tesla)"),
        ("Count Airport - 0 mile", "airportCount", "Nearby Airports"),
        ("Count AV Testing - 0 mile", "avTestingCount", "AV Testing Sites"),
        ("# of AV Testing Vehicles - 0 mile", "avTestingVehicles", "AV Testing Vehicles"),
        ("State_Funding_Awards_Count", "stateFundingCount", "State Funding Awards"),
        ("Federal_Funding_Amount", "federalFundingAmount", "Federal Funding ($)"),
        ("# rideshare trips", "rideshareTrips", "Rideshare Trips"),
        ("rideshare_trip_per_capita", "ridesharePerCapita", "Rideshare Per Capita"),
        ("Total Population", "population", "Total Population"),
        ("Population Density (#/sqrtM)", "populationDensity", "Population Density"),
        ("Area (SQRT Miles)", "areaSqrtMiles", "Area (Sqrt Miles)"),
        ("Median Household Income in past 12 months", "medianIncome", "Median Income"),
        ("Average Weekly Wage", "avgWeeklyWage", "Avg Weekly Wage"),
        ("Percent of workers who commuted by public transportation", "publicTransitPct", "Public Transit %"),
        ("Snowdays", "snowdays", "Annual Snow Days"),
        ("Temperature", "temperature", "Avg Temperature"),
        ("Precipitation", "precipitation", "Annual Precipitation (in)"),
        ("HRCN_RISKR_#", "hurricaneRisk", "Hurricane Risk Rating"),
        ("ISTM_RISKR_#", "stormRisk", "Storm Risk Rating"),
        ("Regular Gas Price ($/G)", "gasPrice", "Gas Price ($/gal)"),
        ("Price (cent/kwh)", "electricityPrice", "Electricity Price (¢/kWh)"),
        ("Land Value (1/4 Acre Lot, Standardized)", "landValue", "Land Value ($/lot)"),
    ],
    "tract": [
        ("Count Airport - 25 mile", "airportCount", "Airports within 25mi"),
        ("Count AV Testing - 25 mile", "avTestingCount", "AV Testing Sites (25mi)"),
        ("# of AV Testing Vehicles - 25 mile", "avTestingVehicles", "AV Testing Vehicles (25mi)"),
        ("Count EV Station - Non-Tesla", "evStationCount", "EV Stations (Non-Tesla)"),
        ("# rideshare trips", "rideshareTrips", "Rideshare Trips"),
        ("rideshare_trip_density", "rideshareDensity", "Rideshare Density"),
        ("Total Population", "population", "Total Population"),
        ("Population Density (#/sqrtM)", "populationDensity", "Population Density"),
        ("Median Household Income in past 12 months", "medianIncome", "Median Income"),
        ("Percent of workers who commuted by public transportation", "publicTransitPct", "Public Transit %"),
        ("Regular Gas Price ($/G)", "gasPrice", "Gas Price ($/gal)"),
        ("Price (cent/kwh)", "electricityPrice", "Electricity Price (¢/kWh)"),
        ("Land Value (1/4 Acre Lot, Standardized)", "landValue", "Land Value ($/lot)"),
        ("Average Weekly Wage", "avgWeeklyWage", "Avg Weekly Wage"),
        ("Count EV Station - Non-Tesla_MSA", "evStationCountMSA", "EV Stations in MSA"),
        ("Snowdays", "snowdays", "Annual Snow Days"),
        ("Snowdays_MSA", "snowdaysMSA", "Snow Days (MSA)"),
        ("Temperature", "temperature", "Avg Temperature"),
        ("Temperature_MSA", "temperatureMSA", "Temperature (MSA)"),
        ("Precipitation", "precipitation", "Annual Precipitation (in)"),
        ("ERQK_RISKR_#", "earthquakeRisk", "Earthquake Risk Rating"),
    ],
}

# ---------------------------------------------------------------------------
# External data loading for frontend detail enrichment
# ---------------------------------------------------------------------------

RISK_TEXT_MAP = {
    "Very High": 5,
    "Relatively High": 4,
    "Relatively Moderate": 3,
    "Relatively Low": 2,
    "Very Low": 1,
    "No Rating": 0,
    "Not Applicable": 0,
}

# Simple (non-pivot) feature loads per geographic level.
# Each tuple: (filename, sheet, source_id_col, {source_col: target_col})
# target_col names match the source-column names used in FRONTEND_FEATURE_COLS.
_SIMPLE_LOADS: dict[str, list] = {
    "tract": [
        ("Integration_Gas_Price.xlsx", "Tract", "Tract_GeoID",
         {"Tract-Regular Gas Price ($/G)": "Regular Gas Price ($/G)"}),
        ("Integration_Electricity_Price.xlsx", "Tract", "Tract_GeoID",
         {"Tract-Price (cent/kwh)": "Price (cent/kwh)"}),
        ("Integration_Land_Price.xlsx", "Tract", "Tract_GeoID",
         {"Tract-Land Value (1/4 Acre Lot, Standardized)": "Land Value (1/4 Acre Lot, Standardized)"}),
        ("Integration_Labor_Cost.xlsx", "Tract", "Tract_GeoID",
         {"Tract-Average Weekly Wage": "Average Weekly Wage"}),
        ("Integration_Climate.xlsx", "Tract", "CLEAN_Tract Geoid", {
            "Tract_Temp_FilledwithState": "Temperature",
            "Tract_Snow_FilledwithState": "Snowdays",
            "Tract_Rain_FilledwithState": "Precipitation",
        }),
        ("Integration_Demographic.xlsx", "Tract", "Tract_GeoID", {
            "Tract - Total Population": "Total Population",
            "Tract - Population Density (#/sqrtM)": "Population Density (#/sqrtM)",
            "Tract-Median Household Income in past 12 months-Fill-NULL": "Median Household Income in past 12 months",
            "Tract -Percent of workers who commuted by public transportation-Fill-NULL": "Percent of workers who commuted by public transportation",
            "Tract - Area (SQRT Miles)": "Area (SQRT Miles)",
        }),
        ("Integration_NIQ.xlsx", "Tract", "Tract_GeoID",
         {"# trips": "# rideshare trips"}),
        ("Integration_Regulatory_Support.xlsx", "Tract", "Tract_GeoID", {
            "Tract_State_Funding_Awards_Count": "State_Funding_Awards_Count",
            "Tract_Federal_Funding_Amount": "Federal_Funding_Amount",
        }),
    ],
    "county": [
        ("Integration_Gas_Price.xlsx", "County", "Clean_County_GeoID",
         {"County-Regular Gas Price ($/G)": "Regular Gas Price ($/G)"}),
        ("Integration_Electricity_Price.xlsx", "County", "Clean_County_GeoID",
         {"County-Price (cent/kwh)": "Price (cent/kwh)"}),
        ("Integration_Land_Price.xlsx", "County", "Clean_County_GeoID",
         {"County-Land Value (1/4 Acre Lot, Standardized)": "Land Value (1/4 Acre Lot, Standardized)"}),
        ("Integration_Labor_Cost.xlsx", "County", "Clean_County_GeoID",
         {"County-Average Weekly Wage": "Average Weekly Wage"}),
        ("Integration_Climate.xlsx", "County", "County_GeoID", {
            "County_Temp_FilledwithState": "Temperature",
            "County_Snow_FilledwithState": "Snowdays",
            "County_Rain_FilledwithState": "Precipitation",
        }),
        ("Integration_Demographic.xlsx", "County", "County_GeoID", {
            "County-Total Population": "Total Population",
            "County-Population Density (#/sqrtM)": "Population Density (#/sqrtM)",
            "County-Median Household Income in past 12 months-Fill-NULL": "Median Household Income in past 12 months",
            "County-Percent of workers who commuted by public transportation": "Percent of workers who commuted by public transportation",
            "County-Area (SQRT Miles)": "Area (SQRT Miles)",
        }),
        ("Integration_NIQ.xlsx", "County", "County_GeoID",
         {"# trips": "# rideshare trips"}),
        ("Integration_Regulatory_Support.xlsx", "County", "Clean_County_GeoID", {
            "County_State_Funding_Awards_Count": "State_Funding_Awards_Count",
            "County_Federal_Funding_Amount": "Federal_Funding_Amount",
        }),
    ],
    "msa": [
        ("Integration_Gas_Price.xlsx", "MSA", "Metropolitan Division Code",
         {"MSA-Regular Gas Price ($/G)": "Regular Gas Price ($/G)"}),
        ("Integration_Electricity_Price.xlsx", "MSA", "Metropolitan Division Code",
         {"MSA-Price (cent/kwh)": "Price (cent/kwh)"}),
        ("Integration_Land_Price.xlsx", "MSA", "Metropolitan Division Code",
         {"MSA-Land Value (1/4 Acre Lot)": "Land Value (1/4 Acre Lot, Standardized)"}),
        ("Integration_Labor_Cost.xlsx", "MSA", "Metropolitan Division Code",
         {"MSA-Average Weekly Wage": "Average Weekly Wage"}),
        ("Integration_Climate.xlsx", "MSA", "Metropolitan Division Code", {
            "MSA_Temp_FilledwithState": "Temperature",
            "MSA_Snow_FilledwithState": "Snowdays",
            "MSA_Rain_FilledwithState": "Precipitation",
        }),
        ("Integration_Demographic.xlsx", "MSA", "Metropolitan Division Code", {
            "MSA-Total Population": "Total Population",
            "MSA - Population Density": "Population Density (#/sqrtM)",
            "MSA-Income": "Median Household Income in past 12 months",
            "MSA - % Public Transportation": "Percent of workers who commuted by public transportation",
            "MSA-Area (SQRT Miles)": "Area (SQRT Miles)",
        }),
        ("Integration_NIQ.xlsx", "MSA", "Metropolitan Division Code",
         {"# trips": "# rideshare trips"}),
        ("Integration_Regulatory_Support.xlsx", "MSA", "Metropolitan Division Code", {
            "MSA_State_Funding_Awards_Count": "State_Funding_Awards_Count",
            "MSA_Federal_Funding_Amount": "Federal_Funding_Amount",
        }),
    ],
}


def _normalize_geoid(series: pd.Series, zfill_width: int) -> pd.Series:
    """Coerce numeric GeoIDs to clean integer strings and optionally zero-pad."""
    num = pd.to_numeric(series, errors="coerce")
    mask = num.notna()
    result = series.astype(str).str.strip().copy()
    result.loc[mask] = num.loc[mask].astype(int).astype(str)
    if zfill_width > 0:
        result = result.str.zfill(zfill_width)
    return result


def _load_risk_features(level: str, external_dir: Path, join_col: str, zfill_width: int, logger) -> Optional[pd.DataFrame]:
    """Load national risk ratings, mapping text labels to numeric scores for tract/county."""
    fpath = external_dir / "Integration_National_Risk.xlsx"
    if not fpath.exists():
        return None
    try:
        configs = {
            "tract": ("Tract", "Tract_GeoID", {
                "Tract_HRCN_RISKR": "HRCN_RISKR_#", "Tract_ISTM_RISKR": "ISTM_RISKR_#",
                "Tract_ERQK_RISKR": "ERQK_RISKR_#", "Tract_CFLD_RISKR": "CFLD_RISKR_#",
                "Tract_TRND_RISKR": "TRND_RISKR_#", "Tract_RFLD_RISKR": "RFLD_RISKR_#",
            }, True),
            "county": ("County", "Clean_County_GeoID", {
                "County_HRCN_RISKR": "HRCN_RISKR_#", "County_ISTM_RISKR": "ISTM_RISKR_#",
                "County_ERQK_RISKR": "ERQK_RISKR_#", "County_CFLD_RISKR": "CFLD_RISKR_#",
                "County_TRND_RISKR": "TRND_RISKR_#", "County_RFLD_RISKR": "RFLD_RISKR_#",
            }, True),
            "msa": ("MSA", "Metropolitan Division Code", {
                "MSA_HRCN_#": "HRCN_RISKR_#", "MSA_ISTM_#": "ISTM_RISKR_#",
                "MSA_ERQK_#": "ERQK_RISKR_#", "MSA_CFLD_#": "CFLD_RISKR_#",
                "MSA_TRND_#": "TRND_RISKR_#", "MSA_RFLD_#": "RFLD_RISKR_#",
            }, False),
        }
        sheet, src_id, rename_map, needs_text_map = configs[level]
        df = pd.read_excel(fpath, sheet_name=sheet)
        available_cols = [c for c in [src_id] + list(rename_map.keys()) if c in df.columns]
        df = df[available_cols].copy()

        if needs_text_map:
            for col in rename_map:
                if col in df.columns:
                    df[col] = df[col].map(RISK_TEXT_MAP).fillna(0)

        df = df.rename(columns=rename_map)
        df[join_col] = _normalize_geoid(df[src_id], zfill_width)
        if src_id != join_col:
            df = df.drop(columns=[src_id])
        keep = [join_col] + [v for v in rename_map.values() if v in df.columns]
        return df[keep]
    except Exception as e:
        logger.warning("  Risk features load failed: %s", e)
        return None


def _load_ev_charging_features(level: str, external_dir: Path, join_col: str, zfill_width: int, logger) -> Optional[pd.DataFrame]:
    """Load EV station counts pivoted by network type (Tesla / Non-Tesla)."""
    fpath = external_dir / "Integration_EV_ChargingStaions_Regions_Count.xlsx"
    if not fpath.exists():
        return None
    try:
        configs = {
            "tract": ("Tract", "Tract_FIPS_Clean", "EV_Network(Tesla or Not)", "Number of EV Stations"),
            "county": ("County", "County_GeoID", "EV_Network  (Tesla or Not)", "Count EV Stations"),
            "msa": ("MSA", "Metropolitan Division Code", "EV Network (Tesla or Not)", "Count EV Stations"),
        }
        sheet, src_id, network_col, count_col = configs[level]
        df = pd.read_excel(fpath, sheet_name=sheet, usecols=[src_id, network_col, count_col])
        pivot = df.pivot_table(index=src_id, columns=network_col, values=count_col, aggfunc="sum", fill_value=0).reset_index()
        result = pd.DataFrame()
        result[join_col] = _normalize_geoid(pivot[src_id], zfill_width)
        if "Non-Tesla" in pivot.columns:
            result["Count EV Station - Non-Tesla"] = pivot["Non-Tesla"].values
        return result
    except Exception as e:
        logger.warning("  EV charging features load failed: %s", e)
        return None


def _load_airport_features(level: str, external_dir: Path, join_col: str, zfill_width: int, logger) -> Optional[pd.DataFrame]:
    """Load airport counts filtered to the target buffer distance per level."""
    fpath = external_dir / "Integration_Airport_Interact_Regions_Count_Volume.xlsx"
    if not fpath.exists():
        return None
    try:
        configs = {
            "tract": ("Tract", "Tract_GeoID", "Buffer Miles", "Count MajorAirports", 25),
            "county": ("County", "County_GeoID", "Buffer Miles", "Count MajorAirports", 0),
            "msa": ("MSA", "Metropolitan Division Code", "Buffer_Miles", "Count Airports", 0),
        }
        sheet, src_id, buf_col, count_col, target_buf = configs[level]
        df = pd.read_excel(fpath, sheet_name=sheet, usecols=[src_id, buf_col, count_col])
        df = df[df[buf_col] == target_buf]
        agg = df.groupby(src_id)[count_col].sum().reset_index()
        result = pd.DataFrame()
        result[join_col] = _normalize_geoid(agg[src_id], zfill_width)
        result[f"Count Airport - {target_buf} mile"] = agg[count_col].values
        return result
    except Exception as e:
        logger.warning("  Airport features load failed: %s", e)
        return None


def _load_av_testing_features(level: str, external_dir: Path, join_col: str, zfill_width: int, logger) -> Optional[pd.DataFrame]:
    """Load AV testing site and vehicle counts at the target range per level."""
    fpath = external_dir / "Integration_AVTestingSite_Regions_Count_SUM.xlsx"
    if not fpath.exists():
        return None
    try:
        configs = {
            "tract": ("Tract", "Tract_Geoid", "Number of AV Testing Sites", 25),
            "county": ("County", "County_GeoID", "Count AV Testing Sites", 0),
            "msa": ("MSA", "Metropolitan Division Code", "Count AV Testing Sites", 0),
        }
        vehicles_col = "Number of Vehicles in Operation (Approx.)"
        sheet, src_id, count_col, target_range = configs[level]
        df = pd.read_excel(fpath, sheet_name=sheet, usecols=[src_id, "Range_Cover", count_col, vehicles_col])
        df = df[df["Range_Cover"] == target_range]
        agg = df.groupby(src_id).agg(
            sites=(count_col, "sum"),
            vehicles=(vehicles_col, "sum"),
        ).reset_index()
        result = pd.DataFrame()
        result[join_col] = _normalize_geoid(agg[src_id], zfill_width)
        result[f"Count AV Testing - {target_range} mile"] = agg["sites"].values
        result[f"# of AV Testing Vehicles - {target_range} mile"] = agg["vehicles"].values
        return result
    except Exception as e:
        logger.warning("  AV testing features load failed: %s", e)
        return None


def _load_external_features(level: str, external_dir: Path, master_geocode: Optional[pd.DataFrame], logger) -> pd.DataFrame:
    """
    Load all external integration data for a geographic level.

    Reads from data/inputs/external/*.xlsx, normalizes GeoIDs, and returns
    a single DataFrame whose columns match the source names referenced in
    FRONTEND_FEATURE_COLS — so that _extract_feature_details finds them on
    the merged GeoDataFrame when generating the frontend JSONs.
    """
    level_lower = level.lower()
    join_col = {"tract": "Tract_GeoID", "county": "County_GeoID", "msa": "Metropolitan Division Code"}[level_lower]
    zfill_width = {"tract": 11, "county": 5, "msa": 0}[level_lower]

    frames: list[pd.DataFrame] = []

    # --- Simple column loads (costs, climate, demographics, NIQ, regulation) ---
    for fname, sheet, src_id_col, rename_map in _SIMPLE_LOADS.get(level_lower, []):
        fpath = external_dir / fname
        if not fpath.exists():
            continue
        try:
            cols_needed = [src_id_col] + list(rename_map.keys())
            df = pd.read_excel(fpath, sheet_name=sheet, usecols=cols_needed)
            df[join_col] = _normalize_geoid(df[src_id_col], zfill_width)
            if src_id_col != join_col:
                df = df.drop(columns=[src_id_col])
            df = df.rename(columns=rename_map)
            frames.append(df[[join_col] + list(rename_map.values())])
        except Exception as e:
            logger.warning("  Failed to load %s/%s: %s", fname, sheet, e)

    # --- Risk (text-to-numeric mapping for tract/county) ---
    risk_df = _load_risk_features(level_lower, external_dir, join_col, zfill_width, logger)
    if risk_df is not None:
        frames.append(risk_df)

    # --- EV Charging (pivot by network type) ---
    ev_df = _load_ev_charging_features(level_lower, external_dir, join_col, zfill_width, logger)
    if ev_df is not None:
        frames.append(ev_df)

    # --- Airports (filter by buffer distance) ---
    airport_df = _load_airport_features(level_lower, external_dir, join_col, zfill_width, logger)
    if airport_df is not None:
        frames.append(airport_df)

    # --- AV Testing (filter by range, sum sites + vehicles) ---
    av_df = _load_av_testing_features(level_lower, external_dir, join_col, zfill_width, logger)
    if av_df is not None:
        frames.append(av_df)

    if not frames:
        return pd.DataFrame()

    # Deduplicate each frame on join key to prevent row multiplication during merge
    frames = [f.drop_duplicates(subset=[join_col]) for f in frames]

    # Merge all feature frames on the join key
    result = frames[0]
    for df in frames[1:]:
        result = result.merge(df, on=join_col, how="outer")

    # --- Derived fields ---
    if "# rideshare trips" in result.columns:
        if "Total Population" in result.columns:
            pop = result["Total Population"].replace(0, np.nan)
            result["rideshare_trip_per_capita"] = result["# rideshare trips"] / pop
        if "Area (SQRT Miles)" in result.columns:
            area = result["Area (SQRT Miles)"].replace(0, np.nan)
            result["rideshare_trip_density"] = result["# rideshare trips"] / area

    # --- Tract-level MSA aggregations (Temperature_MSA, Snowdays_MSA, EV count at MSA) ---
    if level_lower == "tract" and master_geocode is not None:
        try:
            tract_gc_col = None
            msa_gc_col = None
            for c in master_geocode.columns:
                if "tract" in c.lower() and "geo" in c.lower() and tract_gc_col is None:
                    tract_gc_col = c
                if any(k in c.lower() for k in ("metropolitan", "division")) and msa_gc_col is None:
                    msa_gc_col = c

            if tract_gc_col and msa_gc_col:
                mapping = master_geocode[[tract_gc_col, msa_gc_col]].drop_duplicates().copy()
                mapping["Tract_GeoID"] = _normalize_geoid(mapping[tract_gc_col], 11)
                mapping = mapping[["Tract_GeoID", msa_gc_col]]

                # MSA climate → Temperature_MSA, Snowdays_MSA
                climate_path = external_dir / "Integration_Climate.xlsx"
                if climate_path.exists():
                    msa_climate = pd.read_excel(
                        climate_path, sheet_name="MSA",
                        usecols=[msa_gc_col, "MSA_Temp_FilledwithState", "MSA_Snow_FilledwithState"],
                    )
                    msa_climate = msa_climate.rename(columns={
                        "MSA_Temp_FilledwithState": "Temperature_MSA",
                        "MSA_Snow_FilledwithState": "Snowdays_MSA",
                    })
                    tract_msa = mapping.merge(msa_climate, on=msa_gc_col, how="left")
                    result = result.merge(tract_msa[["Tract_GeoID", "Temperature_MSA", "Snowdays_MSA"]], on="Tract_GeoID", how="left")

                # MSA EV → Count EV Station - Non-Tesla_MSA
                ev_path = external_dir / "Integration_EV_ChargingStaions_Regions_Count.xlsx"
                if ev_path.exists():
                    msa_ev = pd.read_excel(ev_path, sheet_name="MSA")
                    msa_ev_nt = msa_ev[msa_ev["EV Network (Tesla or Not)"] == "Non-Tesla"].copy()
                    msa_ev_nt = msa_ev_nt.rename(columns={"Count EV Stations": "Count EV Station - Non-Tesla_MSA"})
                    tract_msa_ev = mapping.merge(
                        msa_ev_nt[[msa_gc_col, "Count EV Station - Non-Tesla_MSA"]], on=msa_gc_col, how="left"
                    )
                    result = result.merge(tract_msa_ev[["Tract_GeoID", "Count EV Station - Non-Tesla_MSA"]], on="Tract_GeoID", how="left")
        except Exception as e:
            logger.warning("  MSA aggregation for tract features failed: %s", e)

    return result


def _build_factors_from_features(row: pd.Series, level: str) -> List[Dict[str, str]]:
    """
    Build factor objects for the frontend from feature values.
    Returns a list of up to 5 most impactful factors.
    """
    factors = []
    level_lower = level.lower()
    feature_cols = FRONTEND_FEATURE_COLS.get(level_lower, [])

    # Thresholds for impact levels (relative to typical values)
    impact_thresholds = {
        "evStationCount": (5, 20),       # low < 5, med 5-20, high > 20
        "airportCount": (1, 3),
        "avTestingCount": (1, 5),
        "rideshareTrips": (1000, 10000),
        "population": (50000, 200000),
        "populationDensity": (500, 2000),
        "federalFundingAmount": (100000, 1000000),
        "stateFundingCount": (2, 10),
    }

    for src_col, key, label in feature_cols:
        if src_col not in row.index:
            continue
        val = row.get(src_col)
        if pd.isna(val):
            continue

        try:
            val_num = float(val)
        except (TypeError, ValueError):
            continue

        # Skip zero or near-zero values
        if abs(val_num) < 0.001:
            continue

        # Determine impact level
        thresholds = impact_thresholds.get(key, (0, 0))
        if thresholds[1] > 0:
            if val_num >= thresholds[1]:
                impact = "high"
            elif val_num >= thresholds[0]:
                impact = "medium"
            else:
                impact = "low"
        else:
            # For unspecified fields, use a simple heuristic
            impact = "medium"

        # Format value for description
        if val_num >= 1000000:
            val_str = f"${val_num/1000000:.1f}M"
        elif val_num >= 1000:
            val_str = f"{val_num/1000:.1f}K"
        elif isinstance(val_num, float) and val_num < 1:
            val_str = f"{val_num:.3f}"
        else:
            val_str = f"{val_num:.0f}"

        factors.append({
            "name": label,
            "impact": impact,
            "value": val_num,
            "description": f"{label}: {val_str}",
        })

    # Sort by value (descending) and take top 5
    factors.sort(key=lambda f: f.get("value", 0), reverse=True)
    # Remove the internal 'value' key before returning
    return [{"name": f["name"], "impact": f["impact"], "description": f["description"]} for f in factors[:5]]


def _extract_feature_details(row: pd.Series, level: str) -> Dict[str, Any]:
    """
    Extract feature details from a row to include in the region object.
    """
    details = {}
    level_lower = level.lower()
    feature_cols = FRONTEND_FEATURE_COLS.get(level_lower, [])

    for src_col, key, _label in feature_cols:
        if src_col not in row.index:
            continue
        val = row.get(src_col)
        if pd.isna(val):
            details[key] = None
        else:
            try:
                # Convert to appropriate type
                if isinstance(val, (int, np.integer)):
                    details[key] = int(val)
                elif isinstance(val, (float, np.floating)):
                    details[key] = round(float(val), 4)
                else:
                    details[key] = val
            except Exception:
                details[key] = None

    return details


def _export_frontend_jsons_for_level(gdf: gpd.GeoDataFrame, level: str, exports_dir: Path, logger, simplify_tolerance: float = 0.0001, master_geocode: Optional[pd.DataFrame] = None):
    """
    Export two JSON files for frontend consumption:
      - geoPolygons_{level}.json : GeoJSON FeatureCollection (simplified)
      - mockRegions_{level}.json : array of Region-like objects used by `mockData.ts`
    """
    try:
        # ensure WGS84
        try:
            gdf_wgs = gdf.to_crs(epsg=4326)
        except Exception:
            gdf_wgs = gdf.copy()

        simple = _simplify_geometry(gdf_wgs, tolerance=simplify_tolerance, preserve_topology=True, logger=logger)

        id_col = _detect_id_column(simple, preferred=["GEOID", "Tract_GeoID", "County_GEOID", "County_GeoID", "ID", "id"], keywords=["geo", "id"]) or None
        if id_col is None:
            simple = simple.reset_index().rename(columns={"index": "_idx"})
            id_col = "_idx"

        # For MSA level, prefer explicit CBSA/Metropolitan columns as id/name
        if level.lower() == "msa":
            msa_id_candidates = [c for c in simple.columns if any(k in c.lower() for k in ("cbsa", "cbsa code", "cbsa_code", "cbsaid"))]
            msa_name_candidates = [c for c in simple.columns if any(k in c.lower() for k in ("metropolitan", "division", "metro", "msa", "name"))]
            if msa_id_candidates:
                id_col = msa_id_candidates[0]
            elif msa_name_candidates:
                # fallback to name if no numeric id available
                id_col = msa_name_candidates[0]
            # expose which columns we detected for msa id/name
            try:
                msa_id_col_for_export = msa_id_candidates[0] if msa_id_candidates else None
            except Exception:
                msa_id_col_for_export = None
            try:
                msa_name_col_for_export = msa_name_candidates[0] if msa_name_candidates else None
            except Exception:
                msa_name_col_for_export = None

        features = []
        regions = []

        # Prepare master geocode mappings if provided
        tract_to_msa_id = {}
        tract_to_msa_name = {}
        county_to_msa_id = {}
        county_to_msa_name = {}
        if master_geocode is not None:
            # Preferred schema:
            # CLEAN_Tract Geoid -> tract id (11-digit)
            # CLEAN_County Geoid -> county id (5-digit)
            # CBSA Code -> MSA unique numeric id
            # Metropolitan Division Code -> MSA name
            tract_col = None
            county_col = None
            msa_code_col = None
            msa_name_col = None

            # exact matches first
            if "CLEAN_Tract Geoid" in master_geocode.columns:
                tract_col = "CLEAN_Tract Geoid"
            if "CLEAN_County Geoid" in master_geocode.columns:
                county_col = "CLEAN_County Geoid"
            if "CBSA Code" in master_geocode.columns:
                msa_code_col = "CBSA Code"
            if "Metropolitan Division Code" in master_geocode.columns:
                msa_name_col = "Metropolitan Division Code"

            # fallbacks: detect by keywords
            if tract_col is None:
                for c in master_geocode.columns:
                    if "tract" in c.lower() and "geo" in c.lower():
                        tract_col = c
                        break
            if county_col is None:
                for c in master_geocode.columns:
                    if "county" in c.lower() and "geo" in c.lower():
                        county_col = c
                        break
            if msa_code_col is None:
                for c in master_geocode.columns:
                    if "cbsa" in c.lower() or ("cbsa" in c.lower() and "code" in c.lower()):
                        msa_code_col = c
                        break
            if msa_name_col is None:
                for c in master_geocode.columns:
                    if any(k in c.lower() for k in ("metropolitan", "division", "metro")):
                        msa_name_col = c
                        break

            # Build tract -> msa id/name mapping
            if tract_col is not None:
                for _, mg_row in master_geocode.iterrows():
                    t = mg_row.get(tract_col)
                    if pd.isna(t):
                        continue
                    t = str(t).strip()
                    t = t.zfill(11) if t.isdigit() else t

                    # id (prefer CBSA code if present)
                    if msa_code_col and not pd.isna(mg_row.get(msa_code_col)):
                        m_id_raw = mg_row.get(msa_code_col)
                        try:
                            m_id = str(int(float(m_id_raw)))
                        except Exception:
                            m_id = str(m_id_raw)
                        tract_to_msa_id[t] = m_id
                    # name
                    if msa_name_col and not pd.isna(mg_row.get(msa_name_col)):
                        tract_to_msa_name[t] = str(mg_row.get(msa_name_col))

            # Build direct CBSA -> Metropolitan Division Code map for MSA-level naming
            cbsa_to_msa_name = {}
            if msa_code_col and msa_name_col:
                for _, mg_row in master_geocode.iterrows():
                    code = mg_row.get(msa_code_col)
                    name = mg_row.get(msa_name_col)
                    if pd.isna(code) or pd.isna(name):
                        continue
                    try:
                        code_key = str(int(float(code)))
                    except Exception:
                        code_key = str(code)
                    cbsa_to_msa_name[code_key] = str(name)

            # Build county -> msa by majority vote of tracts (choose id first, then name)
            tmp = {}
            tmp_names = {}
            for t in tract_to_msa_id.keys() | tract_to_msa_name.keys():
                m_id = tract_to_msa_id.get(t)
                m_name = tract_to_msa_name.get(t)
                county_id = t[:5]
                tmp.setdefault(county_id, []).append(m_id)
                tmp_names.setdefault(county_id, []).append(m_name)

            for county_id, msas in tmp.items():
                # pick most common non-None msa id
                candidates = [m for m in msas if m is not None]
                if candidates:
                    chosen = max(set(candidates), key=candidates.count)
                    county_to_msa_id[county_id] = chosen
                    # choose name most common among entries with chosen id
                    names = [n for (mid, n) in zip(msas, tmp_names[county_id]) if mid == chosen and n]
                    if names:
                        county_to_msa_name[county_id] = max(set(names), key=names.count)
                else:
                    # fallback to most common name if id missing
                    names_only = [n for n in tmp_names[county_id] if n]
                    if names_only:
                        county_to_msa_name[county_id] = max(set(names_only), key=names_only.count)

        for _, row in simple.iterrows():
            gid_val = row.get(id_col, None)
            if gid_val is None:
                gid_val = row.name
            gid = str(gid_val)

            geom = row.geometry
            if geom is None or geom.is_empty:
                continue

            geom_json = mapping(geom)
            geom_json = _round_coords(geom_json)

            # properties minimal for geoPolygons
            props = {"id": gid}

            # attach hierarchical ids
            # For tract rows, add countyID and msaID (attempt via tract GEOID)
            try:
                if level.lower() == 'tract':
                    tract_id = gid
                    # if numeric-like, ensure zero-padded 11
                    if tract_id.isdigit():
                        tract_id = tract_id.zfill(11)
                    county_id = tract_id[:5]
                    props['countyID'] = county_id
                    props['msaID'] = tract_to_msa_id.get(tract_id) or county_to_msa_id.get(county_id)
                    props['msaName'] = tract_to_msa_name.get(tract_id) or county_to_msa_name.get(county_id)
                elif level.lower() == 'county':
                    county_id = gid
                    # normalize
                    if county_id.isdigit():
                        county_id = county_id.zfill(5)
                    props['countyID'] = county_id
                    props['msaID'] = county_to_msa_id.get(county_id)
                    props['msaName'] = county_to_msa_name.get(county_id)
                elif level.lower() == 'msa':
                    # include msaID and msaName on properties when available
                    try:
                        if 'msa_id_col_for_export' in locals() and msa_id_col_for_export and pd.notna(row.get(msa_id_col_for_export)):
                            props['msaID'] = str(row.get(msa_id_col_for_export))
                        if 'msa_name_col_for_export' in locals() and msa_name_col_for_export and pd.notna(row.get(msa_name_col_for_export)):
                            props['msaName'] = str(row.get(msa_name_col_for_export))
                    except Exception:
                        pass
                    # If we have a CBSA->name map, prefer that canonical name and ensure msaID is normalized
                    try:
                        if 'cbsa_to_msa_name' in locals():
                            # normalize props['msaID'] if present
                            mid = props.get('msaID')
                            if mid is None and gid is not None:
                                mid = str(gid)
                            if mid is not None:
                                mid_norm = None
                                try:
                                    mid_norm = str(int(float(mid)))
                                except Exception:
                                    mid_norm = str(mid)
                                props['msaID'] = mid_norm
                                # override msaName from canonical map when available
                                if mid_norm in cbsa_to_msa_name:
                                    props['msaName'] = cbsa_to_msa_name.get(mid_norm)
                    except Exception:
                        pass
            except Exception:
                pass

            features.append({"type": "Feature", "properties": props, "geometry": geom_json})

            # build region object for mockData
            centroid = None
            try:
                c = geom.centroid
                centroid = [round(float(c.x), 6), round(float(c.y), 6)]
            except Exception:
                centroid = [0.0, 0.0]

            score = None
            if "P" in row and pd.notna(row["P"]):
                score = float(row["P"])
            elif "score" in row and pd.notna(row["score"]):
                score = float(row["score"])
            else:
                score = 0.0

            # expose hierarchical ids on the region object for frontend
            county_for_region = None
            msa_for_region = None
            msa_name_for_region = None
            try:
                if level.lower() == 'tract':
                    county_for_region = props.get('countyID')
                    msa_for_region = props.get('msaID')
                    msa_name_for_region = props.get('msaName')
                elif level.lower() == 'county':
                    county_for_region = props.get('countyID')
                    msa_for_region = props.get('msaID')
                    msa_name_for_region = props.get('msaName')
                elif level.lower() == 'msa':
                    # region id is the MSA identifier (prefer CBSA code if available)
                    msa_for_region = gid
                    # try to canonicalize msaName from CBSA->Metropolitan Division Code mapping
                    try:
                        if 'cbsa_to_msa_name' in locals():
                            gid_norm = None
                            try:
                                gid_norm = str(int(float(gid)))
                            except Exception:
                                gid_norm = str(gid)
                            msa_name_for_region = cbsa_to_msa_name.get(gid_norm)
                            # also set msa_for_region to normalized id
                            msa_for_region = gid_norm
                    except Exception:
                        pass
            except Exception:
                pass

            # Extract feature details for this region
            feature_details = _extract_feature_details(row, level)

            # Build factors from features
            factors = _build_factors_from_features(row, level)

            # Build a clean region object. For MSA level we avoid using per-tract NAME
            region_obj = {
                "id": gid,
                "name": "",
                "geoLevel": level.upper() if level.lower() in ("msa", "county", "tract") else level,
                "rank": int(row.get("Rank", 0) or 0),
                "score": float(score),
                "customerCount": int(row.get("customerCount", 0) or 0),
                "inGeofence": bool(row.get("inGeofence", False)),
                "lat": centroid[1],
                "lng": centroid[0],
                "countyID": county_for_region,
                "msaID": msa_for_region,
                "msaName": msa_name_for_region,
                "factors": factors,
                "details": feature_details,
            }

            # Normalize and enforce msaID as integer-string when possible
            if region_obj.get('msaID'):
                try:
                    region_obj['msaID'] = str(int(float(region_obj['msaID'])))
                except Exception:
                    region_obj['msaID'] = str(region_obj['msaID'])

            # For non-MSA levels, set a friendly name if available (county/tract)
            if level.lower() in ('tract', 'county'):
                # Prefer explicit name columns on the row, avoid falling back to arbitrary NAME for MSA
                preferred_name = None
                for nc in ("NAME", "NAMELSAD", "name"):
                    try:
                        if pd.notna(row.get(nc)):
                            preferred_name = str(row.get(nc))
                            break
                    except Exception:
                        continue
                region_obj['name'] = preferred_name or ""

            # For MSA-level regions, force canonical CBSA id and use Metropolitan Division Code
            if level.lower() == 'msa':
                # Determine normalized MSA id (prefer detected gid or msaID)
                mid_candidate = region_obj.get('msaID') or gid
                mid_norm = None
                try:
                    if mid_candidate is not None:
                        mid_norm = str(int(float(mid_candidate)))
                except Exception:
                    mid_norm = str(mid_candidate)

                if mid_norm is not None:
                    region_obj['id'] = mid_norm
                    region_obj['msaID'] = mid_norm

                # Determine canonical name: prefer cbsa_to_msa_name map, then explicit msa_name_col from row
                msa_name_val = None
                try:
                    if 'cbsa_to_msa_name' in locals() and mid_norm and mid_norm in cbsa_to_msa_name:
                        msa_name_val = cbsa_to_msa_name[mid_norm]
                except Exception:
                    msa_name_val = None

                # Fallback to any detected msa_name_col field on the row (explicit column), but DO NOT use tract NAME
                try:
                    if msa_name_val is None and 'msa_name_col_for_export' in locals() and msa_name_col_for_export and pd.notna(row.get(msa_name_col_for_export)):
                        msa_name_val = str(row.get(msa_name_col_for_export))
                except Exception:
                    pass

                # Final assignment (empty string rather than leaking tract-level names)
                region_obj['name'] = msa_name_val or ""
                region_obj['msaName'] = msa_name_val or ""

            regions.append(region_obj)

        geo_out = {"type": "FeatureCollection", "features": features}
        geo_path = exports_dir / f"geoPolygons_{level}.json"
        geo_path.write_text(json.dumps(geo_out, separators=(",", ":"), ensure_ascii=False))

        # For Tract level, also write per-county polygon files to avoid loading 300MB+ at once.
        # Frontend loads /data/exports/tract_polygons/county_{countyID}.json on demand.
        if level == "tract":
            import collections as _collections
            tract_poly_dir = exports_dir / "tract_polygons"
            tract_poly_dir.mkdir(exist_ok=True)
            by_county: dict = _collections.defaultdict(list)
            for feat in features:
                cid = (feat.get("properties") or {}).get("countyID")
                if cid:
                    by_county[cid].append(feat)
            for cid, feats in by_county.items():
                fc = {"type": "FeatureCollection", "features": feats}
                (tract_poly_dir / f"county_{cid}.json").write_text(
                    json.dumps(fc, separators=(",", ":"), ensure_ascii=False)
                )
            logger.info("  Tract per-county polygon files written: %d counties → %s/", len(by_county), tract_poly_dir.name)

        # Slim list: omit factors/details so the list file stays small for fast initial load
        slim_regions = [
            {k: v for k, v in r.items() if k not in ("factors", "details")}
            for r in regions
        ]
        mock_path = exports_dir / f"mockRegions_{level}.json"
        mock_path.write_text(json.dumps(slim_regions, separators=(",", ":"), ensure_ascii=False))

        # Details sidecar: keyed by id so the frontend can fetch one file per level on demand
        details_index = {r["id"]: {"factors": r.get("factors", []), "details": r.get("details", {})} for r in regions}
        details_path = exports_dir / f"regionDetails_{level}.json"
        details_path.write_text(json.dumps(details_index, separators=(",", ":"), ensure_ascii=False))

        logger.info(
            "  Frontend JSONs written for %s: %s, %s, %s",
            level, geo_path.name, mock_path.name, details_path.name,
        )

    except Exception as e:
        logger.warning("  Failed to write frontend JSONs for %s: %s", level, str(e))


def _export_kml(
    gdf: gpd.GeoDataFrame,
    output_path: Path,
    level: str,
    logger,
    simplify_tolerance: float = 0.005,
    preserve_topology: bool = True,
) -> None:
    """
    Export as KML with heat map styling and geometry simplification.

    Creates a KML file with polygons colored by probability score.
    Simplifies geometries to stay under Google Earth's 250K vertex limit.

    Parameters
    ----------
    gdf : gpd.GeoDataFrame
        GeoDataFrame with geometry and ranking columns.
    output_path : Path
        Output KML file path.
    level : str
        Geographic level ('tract', 'county', 'msa').
    logger
        Logger instance.
    simplify_tolerance : float
        Simplification tolerance in degrees. Default 0.005 (~500m).
    preserve_topology : bool
        Whether to preserve topology during simplification.
    """
    # Ensure we have a probability column
    if "P" not in gdf.columns:
        logger.warning("  No 'P' column found, skipping KML export for %s", level)
        return

    # Build KML content
    kml_header = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
    <name>EV Site Rankings - {level}</name>
    <description>Probability-based rankings for EV charging site selection. Green = high probability, Red = low probability.</description>
"""

    kml_footer = """</Document>
</kml>"""

    # Convert to WGS84 for KML
    gdf_wgs84 = gdf.to_crs(epsg=4326)

    # Simplify geometries for Google Earth compatibility
    gdf_simple = _simplify_geometry(
        gdf_wgs84,
        tolerance=simplify_tolerance,
        preserve_topology=preserve_topology,
        logger=logger,
    )

    # Build placemarks
    placemarks = []

    # Determine ID and name columns
    if level == "tract":
        id_col = "Tract_GeoID" if "Tract_GeoID" in gdf_simple.columns else "GEOID"
        name_col = "NAMELSAD" if "NAMELSAD" in gdf_simple.columns else id_col
    elif level == "county":
        id_col = "County_GeoID" if "County_GeoID" in gdf_simple.columns else "GEOID"
        name_col = "NAMELSAD" if "NAMELSAD" in gdf_simple.columns else id_col
    else:  # msa
        id_col = "Metropolitan Division Code"
        name_col = id_col

    for idx, row in gdf_simple.iterrows():
        prob = row["P"]
        color = _probability_to_kml_color(prob)

        # Get geometry as KML coordinates
        geom = row.geometry
        if geom is None or geom.is_empty:
            continue

        # Handle different geometry types
        if geom.geom_type == "Polygon":
            polygons = [geom]
        elif geom.geom_type == "MultiPolygon":
            polygons = list(geom.geoms)
        else:
            continue

        # Build coordinate strings for all polygons (including interior holes)
        polygon_kml = ""
        for poly in polygons:
            # Exterior ring
            exterior_coords = " ".join(
                f"{x},{y},0" for x, y in poly.exterior.coords
            )
            polygon_kml += f"""
            <Polygon>
                <outerBoundaryIs>
                    <LinearRing>
                        <coordinates>{exterior_coords}</coordinates>
                    </LinearRing>
                </outerBoundaryIs>"""

            # Interior rings (holes - lakes, islands, etc.)
            for interior in poly.interiors:
                interior_coords = " ".join(
                    f"{x},{y},0" for x, y in interior.coords
                )
                polygon_kml += f"""
                <innerBoundaryIs>
                    <LinearRing>
                        <coordinates>{interior_coords}</coordinates>
                    </LinearRing>
                </innerBoundaryIs>"""

            polygon_kml += """
            </Polygon>"""

        # Get name and ID with XML escaping
        feature_id = _escape_xml(row.get(id_col, idx))
        feature_name = _escape_xml(row.get(name_col, feature_id))
        prediction = int(row.get("Prediction-01", 0))
        rank = row.get("Rank", "N/A")

        placemark = f"""
    <Placemark>
        <name>{feature_name}</name>
        <description>Rank: {rank}
ID: {feature_id}
Probability: {prob:.4f}
Prediction: {prediction}</description>
        <Style>
            <PolyStyle>
                <color>{color}</color>
                <outline>1</outline>
            </PolyStyle>
            <LineStyle>
                <color>ff000000</color>
                <width>1</width>
            </LineStyle>
        </Style>
        <MultiGeometry>{polygon_kml}
        </MultiGeometry>
    </Placemark>"""

        placemarks.append(placemark)

    # Write KML file
    kml_content = kml_header.format(level=level.upper()) + "\n".join(placemarks) + kml_footer

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(kml_content)

    logger.info("  KML exported: %s (%d placemarks)", output_path.name, len(placemarks))


def _export_kmz(kml_path: Path, kmz_path: Path, logger) -> None:
    """Compress KML to KMZ format."""
    with zipfile.ZipFile(kmz_path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.write(kml_path, "doc.kml")

    logger.info("  KMZ exported: %s", kmz_path.name)


def run_exports(config: Optional[dict] = None, cli_opts: Optional[dict] = None) -> dict[str, Any]:
    """
    Main entry point for generating export artifacts.

    Parameters
    ----------
    config : dict
        Configuration dictionary from settings.yaml.

    Returns
    -------
    dict
        Summary of exported files.
    """
    logger = get_logger("export_rankings")

    # If config not provided (called from CLI), try loading default config
    if config is None:
        try:
            from src.utils.config_utils import load_config

            cfg_path = Path.cwd() / "config" / "settings.yaml"
            if not cfg_path.exists():
                raise FileNotFoundError(f"Config not found: {cfg_path}")
            config = load_config(cfg_path)
        except Exception as e:
            logger.exception("Failed loading default config: %s", e)
            raise

    logger.info("=" * 80)
    logger.info("Starting export generation...")
    logger.info("=" * 80)

    # Get paths from config
    outputs_dir = Path(config["paths"]["outputs"])
    spatial_dir = Path(config["paths"]["inputs"]["spatial"])
    geocode_dir = Path(config["paths"]["inputs"]["mastergeocode"])

    # Get filenames from config
    rankings_filename = config["ml"]["ml_outputs"]["rankings_workbook"]
    geocode_filename = config["filenames"]["master_geocode"]

    rankings_path = outputs_dir / rankings_filename
    geocode_path = geocode_dir / geocode_filename

    # Create exports output directory
    export_config = config.get("exports", {})
    exports_dir = Path(export_config.get("output_dir", "data/exports"))

    # Apply CLI override for output dir if provided
    if cli_opts and cli_opts.get("output_dir"):
        exports_dir = Path(cli_opts.get("output_dir"))
    exports_dir.mkdir(parents=True, exist_ok=True)

    # Get simplification settings for KML export and frontend
    simplify_config = export_config.get("simplification", {})
    kml_tolerance = simplify_config.get("kml_tolerance", 0.005)  # ~500m default for KML/KMZ
    frontend_tolerance = simplify_config.get("frontend_tolerance", 0.0001)  # ~10m default for frontend to avoid gaps
    preserve_topology = simplify_config.get("preserve_topology", True)

    logger.info("Export output directory: %s", exports_dir)
    logger.info("KML simplification: tolerance=%.4f, preserve_topology=%s", kml_tolerance, preserve_topology)
    logger.info("Frontend simplification: tolerance=%.4f", frontend_tolerance)

    # Load data
    # Allow CLI override of rankings workbook path
    if cli_opts and cli_opts.get("ranking_file"):
        rf = cli_opts.get("ranking_file")
        # if absolute/relative path provided, prefer that
        rankings_path = Path(rf)

    rankings = _load_rankings(rankings_path, logger)
    spatial = _load_spatial_files(spatial_dir, logger)
    master_geocode = _load_master_geocode(geocode_path, logger)

    # Load external integration data and merge into rankings for frontend detail enrichment
    external_dir = Path(config["paths"]["inputs"].get("external", "data/inputs/external"))
    logger.info("Loading external features for frontend details from: %s", external_dir)
    for _level in ["tract", "county", "msa"]:
        ext_features = _load_external_features(_level, external_dir, master_geocode, logger)
        if ext_features.empty:
            logger.warning("  No external features loaded for %s", _level)
            continue
        _id_col = {"tract": "Tract_GeoID", "county": "County_GeoID", "msa": "Metropolitan Division Code"}[_level]
        _zfill = {"tract": 11, "county": 5, "msa": 0}[_level]
        rankings[_level][_id_col] = _normalize_geoid(rankings[_level][_id_col], _zfill)
        rankings[_level] = rankings[_level].merge(ext_features, on=_id_col, how="left")
        logger.info("  Merged %d external feature columns into %s rankings", len(ext_features.columns) - 1, _level)

    # Track exported files
    exported_files = {"csv": [], "excel": [], "geojson": [], "kml": [], "kmz": []}

    # Process each level
    levels_config = {
        "tract": {
            "rankings_id_col": "Tract_GeoID",
            "spatial_key": "tract",
        },
        "county": {
            "rankings_id_col": "County_GeoID",
            "spatial_key": "county",
        },
    }

    # Determine target geography (if invoked from CLI)
    target_geo = None
    if cli_opts and cli_opts.get("geography"):
        g = cli_opts.get("geography")
        if isinstance(g, str):
            target_geo = g.lower()

    # Determine requested formats (CLI may request single format)
    requested_formats = None
    if cli_opts and cli_opts.get("format"):
        requested_formats = {cli_opts.get("format").lower()}

    # Export Tract and County levels
    # If CLI specified regions, filter rankings tables before joining
    if cli_opts and cli_opts.get("regions") is not None:
        regs = set(str(r) for r in cli_opts.get("regions"))
        for lvl, lvl_cfg in levels_config.items():
            # prefer the configured ID column name, fall back to keyword match
            id_col = _detect_id_column(rankings[lvl], preferred=[lvl_cfg["rankings_id_col"]], keywords=[lvl])
            if id_col:
                rankings[lvl] = rankings[lvl][rankings[lvl][id_col].astype(str).isin(regs)]

    for level, level_config in levels_config.items():
        # Skip levels not requested by CLI
        if target_geo and level != target_geo:
            continue
        logger.info("")
        logger.info("-" * 60)
        logger.info("Processing %s level exports...", level.upper())
        logger.info("-" * 60)

        # Join rankings with geometry
        gdf = _join_rankings_with_geometry(
            rankings_df=rankings[level],
            spatial_gdf=spatial[level_config["spatial_key"]],
            rankings_id_col=level_config["rankings_id_col"],
            logger=logger,
        )

        # Export formats
        csv_path = exports_dir / f"rankings_{level}.csv"
        excel_path = exports_dir / f"rankings_{level}.xlsx"
        geojson_path = exports_dir / f"rankings_{level}.geojson"
        kml_path = exports_dir / f"rankings_{level}.kml"
        kmz_path = exports_dir / f"rankings_{level}.kmz"

        # Export only requested formats (if specified), otherwise all
        if (requested_formats is None) or ("csv" in requested_formats):
            _export_csv(gdf, csv_path, level, logger)
            exported_files["csv"].append(csv_path)
        if (requested_formats is None) or ("excel" in requested_formats):
            _export_excel(gdf, excel_path, level, logger)
            exported_files["excel"].append(excel_path)
        if (requested_formats is None) or ("geojson" in requested_formats):
            _export_geojson(gdf, geojson_path, level, logger)
            exported_files["geojson"].append(geojson_path)

        # Export small frontend JSON artifacts for dev UI (when run programmatically)
        if config is not None:
            try:
                _export_frontend_jsons_for_level(gdf, level, exports_dir, logger, simplify_tolerance=frontend_tolerance, master_geocode=master_geocode)
            except Exception as e:
                logger.warning("Failed to export frontend JSONs for %s: %s", level, e)

        # Generate KML if KML or KMZ requested; only include KML in results if explicitly requested
        needs_kml = (requested_formats is None) or ("kml" in requested_formats) or ("kmz" in requested_formats)
        if needs_kml:
            _export_kml(gdf, kml_path, level, logger, kml_tolerance, preserve_topology)
            if (requested_formats is None) or ("kml" in requested_formats):
                exported_files["kml"].append(kml_path)

        # Produce KMZ if requested (requires KML present)
        if (requested_formats is None) or ("kmz" in requested_formats):
            # ensure KML exists (was generated above when needed)
            _export_kmz(kml_path, kmz_path, logger)
            exported_files["kmz"].append(kmz_path)


    # Export MSA level (requires dissolving tracts)
    logger.info("")
    logger.info("-" * 60)
    logger.info("Processing MSA level exports...")
    logger.info("-" * 60)

    # If CLI specified regions, filter MSA rankings similarly using the helper
    if cli_opts and cli_opts.get("regions") is not None:
        regs = set(str(r) for r in cli_opts.get("regions"))
        msa_rankings = rankings.get("msa")
        msa_id_col = _detect_id_column(msa_rankings, preferred=None, keywords=["msa", "metropolitan"])
        if msa_id_col:
            rankings["msa"] = msa_rankings[msa_rankings[msa_id_col].astype(str).isin(regs)]

    try:
        msa_gdf = _dissolve_tracts_to_msa(
            tract_gdf=spatial["tract"],
            msa_rankings=rankings["msa"],
            master_geocode=master_geocode,
            logger=logger,
        )

        csv_path = exports_dir / "rankings_msa.csv"
        excel_path = exports_dir / "rankings_msa.xlsx"
        geojson_path = exports_dir / "rankings_msa.geojson"
        kml_path = exports_dir / "rankings_msa.kml"
        kmz_path = exports_dir / "rankings_msa.kmz"

        # Skip MSA export if CLI requested a different geography
        if (target_geo is None) or (target_geo == "msa"):
            if (requested_formats is None) or ("csv" in requested_formats):
                _export_csv(msa_gdf, csv_path, "msa", logger)
                exported_files["csv"].append(csv_path)
            if (requested_formats is None) or ("excel" in requested_formats):
                _export_excel(msa_gdf, excel_path, "msa", logger)
                exported_files["excel"].append(excel_path)
            if (requested_formats is None) or ("geojson" in requested_formats):
                _export_geojson(msa_gdf, geojson_path, "msa", logger)
                exported_files["geojson"].append(geojson_path)

            # Frontend JSONs for MSA
            if config is not None:
                try:
                    _export_frontend_jsons_for_level(msa_gdf, "msa", exports_dir, logger, simplify_tolerance=frontend_tolerance, master_geocode=master_geocode)
                except Exception as e:
                    logger.warning("Failed to export frontend JSONs for msa: %s", e)

            needs_kml = (requested_formats is None) or ("kml" in requested_formats) or ("kmz" in requested_formats)
            if needs_kml:
                _export_kml(msa_gdf, kml_path, "msa", logger, kml_tolerance, preserve_topology)
                if (requested_formats is None) or ("kml" in requested_formats):
                    exported_files["kml"].append(kml_path)

            if (requested_formats is None) or ("kmz" in requested_formats):
                _export_kmz(kml_path, kmz_path, logger)
                exported_files["kmz"].append(kmz_path)

    except Exception as e:
        logger.warning("MSA geospatial export failed: %s", str(e))
        logger.info("Falling back to CSV-only export for MSA...")

        # At minimum, export MSA rankings as CSV/Excel without geometry
        csv_path = exports_dir / "rankings_msa.csv"
        excel_path = exports_dir / "rankings_msa.xlsx"

        rankings["msa"].to_csv(csv_path, index=False)
        rankings["msa"].to_excel(excel_path, index=False, sheet_name="MSA")

        exported_files["csv"].append(csv_path)
        exported_files["excel"].append(excel_path)

        logger.info("  CSV exported: %s", csv_path.name)
        logger.info("  Excel exported: %s", excel_path.name)

    # ── Competitor Tracker Export ────────────────────────────────────────────────
    logger.info("")
    logger.info("=" * 80)
    logger.info("Exporting Competitor Tracker data...")
    logger.info("=" * 80)

    competitor_csv = Path(config["paths"]["inputs"].get("competitor_tracker", "data/inputs/Competitor Tracker.csv"))
    competitor_json = exports_dir / "competitorTracker.json"

    if competitor_csv.exists():
        try:
            competitor_stats = export_competitor_tracker(competitor_csv, competitor_json)
            logger.info("  Competitor Tracker exported: %s", competitor_json.name)
            logger.info("    Total sites: %d", competitor_stats.get("totalSites", 0))
            logger.info("    Sites with coordinates: %d", competitor_stats.get("sitesWithCoords", 0))
            logger.info("    Companies: %d", competitor_stats.get("companiesCount", 0))
            exported_files.setdefault("json", []).append(competitor_json)
        except Exception as e:
            logger.warning("Competitor Tracker export failed: %s", str(e))
    else:
        logger.warning("Competitor Tracker CSV not found: %s", competitor_csv)

    # Summary
    logger.info("")
    logger.info("=" * 80)
    logger.info("Export generation complete!")
    logger.info("=" * 80)

    total_files = sum(len(files) for files in exported_files.values())
    logger.info("Total files exported: %d", total_files)
    logger.info("Export directory: %s", exports_dir)

    return {
        "exports_dir": str(exports_dir),
        "files": {fmt: [str(p) for p in paths] for fmt, paths in exported_files.items()},
        "total_files": total_files,
    }


if __name__ == "__main__":
    # Standalone execution
    from src.utils.config_utils import load_config

    config_path = Path("config/settings.yaml")
    if not config_path.exists():
        raise FileNotFoundError(f"Config not found: {config_path}")

    config = load_config(config_path)
    result = run_exports(config)
    print(f"\nExport complete: {result['total_files']} files generated")
