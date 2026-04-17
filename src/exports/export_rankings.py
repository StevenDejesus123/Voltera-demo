"""
Export module for generating geospatial artifacts from ranking outputs.

Phase 3.2: Reporting Outputs & Export Optimization

This module:
- Joins model ranking outputs with tract/county/MSA geometries
- Exports to CSV/Excel, KML/KMZ, and GeoJSON formats
- Generates heat map styled layers for visualization
"""

from __future__ import annotations

import collections
import csv
import html
import json
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

import geopandas as gpd
import numpy as np
import pandas as pd
from shapely.geometry import mapping

from src.utils.logging_utils import get_logger
from src.exports.export_competitor_tracker import export_competitor_tracker


def _escape_xml(text: Any) -> str:
    """Escape special XML characters in text."""
    return html.escape(str(text))


def _count_vertices(gdf: gpd.GeoDataFrame) -> int:
    """Count total vertices in all geometries."""
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
    """Simplify geometries to reduce vertex count (tolerance in CRS units; 0.005 deg ~ 500m)."""
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
    """Add a Rank column based on probability score (descending, ties share rank)."""
    result = df.copy()
    result["Rank"] = result[prob_col].rank(ascending=False, method="min").astype(int)
    return result


def _probability_to_kml_color(prob: float, alpha: int = 200) -> str:
    """Convert probability [0,1] to a KML ABGR color (Red->Yellow->Green gradient)."""
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


def _load_rankings(rankings_path: Path, logger, levels: Optional[List[str]] = None) -> dict[str, pd.DataFrame]:
    """Load ranking outputs from Excel workbook (MSA/County/Tract sheets).

    Args:
        levels: If provided, only load these levels (e.g. ["tract"]).
                Defaults to all three levels.
    """
    logger.info("Loading rankings from: %s", rankings_path)

    target_levels = levels or ["msa", "county", "tract"]
    rankings = {}
    for level in ["MSA", "County", "Tract"]:
        if level.lower() not in target_levels:
            continue
        df = pd.read_excel(rankings_path, sheet_name=level)
        rankings[level.lower()] = df
        logger.info("  %s: %d rows loaded", level, len(df))

    return rankings


def _load_spatial_files(spatial_dir: Path, logger, levels: Optional[List[str]] = None) -> dict[str, gpd.GeoDataFrame]:
    """Load Tract.shp and/or County.shp from the spatial directory.

    Args:
        levels: If provided, only load spatial files needed for these levels.
                "msa" requires tract (for dissolve). Defaults to all.
    """
    spatial = {}

    tract_path = spatial_dir / "Tract.shp"
    county_path = spatial_dir / "County.shp"

    logger.info("Loading spatial files from: %s", spatial_dir)

    # Determine which files are needed
    need_tract = levels is None or "tract" in levels or "msa" in levels
    need_county = levels is None or "county" in levels

    if need_tract:
        if tract_path.exists():
            spatial["tract"] = gpd.read_file(tract_path)
            logger.info("  Tract.shp: %d geometries", len(spatial["tract"]))
        else:
            raise FileNotFoundError(f"Tract shapefile not found: {tract_path}")

    if need_county:
        if county_path.exists():
            spatial["county"] = gpd.read_file(county_path)
            logger.info("  County.shp: %d geometries", len(spatial["county"]))
        else:
            raise FileNotFoundError(f"County shapefile not found: {county_path}")

    return spatial


def _load_master_geocode(geocode_path: Path, logger) -> pd.DataFrame:
    """Load master geocode mapping (tract-to-MSA relationships)."""
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
    """Join rankings with spatial GeoDataFrame, handling GEOID type conversion."""
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
    """Find an ID column using preferred exact names first, then by keyword containment."""
    return _find_column(list(df.columns), preferred=preferred, keywords=keywords)


def _find_column(
    columns: List[str],
    preferred: Optional[List[str]] = None,
    keywords: Optional[List[str]] = None,
    exclude_keywords: Optional[List[str]] = None,
) -> Optional[str]:
    """Find a column name by exact match first, then by keyword containment.

    Parameters
    ----------
    columns : list of column names to search.
    preferred : exact column names to try first.
    keywords : lower-case substrings to match against column names.
    exclude_keywords : lower-case substrings that disqualify a column.
    """
    if preferred:
        for name in preferred:
            if name in columns:
                return name
    if keywords:
        for col in columns:
            low = col.lower()
            if exclude_keywords and any(ek in low for ek in exclude_keywords):
                continue
            if any(kw in low for kw in keywords):
                return col
    return None


def _dissolve_tracts_to_msa(
    tract_gdf: gpd.GeoDataFrame,
    msa_rankings: pd.DataFrame,
    master_geocode: pd.DataFrame,
    logger,
) -> gpd.GeoDataFrame:
    """Create MSA geometries by dissolving tract polygons and joining with rankings."""
    logger.info("Dissolving tracts to MSA boundaries...")

    # Determine tract and MSA id/name columns from master geocode
    gc_cols = list(master_geocode.columns)

    tract_col = _find_column(gc_cols, preferred=["CLEAN_Tract Geoid"], keywords=["tract"])
    # For tract_col, ensure it looks like a geoid column (not just any tract column)
    if tract_col and "geoid" not in tract_col.lower() and "geo" not in tract_col.lower():
        tract_col = _find_column(gc_cols, keywords=["tract geoid", "tract_geoid", "tract geo"]) or tract_col

    msa_id_col = _find_column(gc_cols, preferred=["CBSA Code"], keywords=["cbsa"])
    if msa_id_col is None:
        msa_id_col = _find_column(gc_cols, keywords=["code", "id", "fips"], exclude_keywords=["state", "county", "tract"])

    msa_name_col = _find_column(
        gc_cols,
        preferred=["Metropolitan Division Code"],
        keywords=["metropolitan", "division", "metro"],
        exclude_keywords=["state"],
    )
    if msa_name_col is None:
        msa_name_col = _find_column(gc_cols, keywords=["name"], exclude_keywords=["state"])

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
            def _pick_mode(s: pd.Series) -> Optional[str]:
                vals = s.dropna().astype(str)
                return vals.mode().iloc[0] if not vals.empty else None

            msa_id_map: dict = {}
            msa_name_map: dict = {}
            if dissolve_by in tracts_with_msa.columns:
                group = tracts_with_msa.groupby(dissolve_by)
                if msa_id_col and msa_id_col in tracts_with_msa.columns:
                    msa_id_map = group[msa_id_col].agg(_pick_mode).to_dict()
                if msa_name_col and msa_name_col in tracts_with_msa.columns:
                    msa_name_map = group[msa_name_col].agg(_pick_mode).to_dict()

            if dissolve_by in msa_geometries.columns:
                msa_geometries['msaID'] = msa_geometries[dissolve_by].map(msa_id_map.get)
                msa_geometries['msaName'] = msa_geometries[dissolve_by].map(msa_name_map.get)
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


_EXCLUDE_COLS = {"geometry", "_join_id", "_tract_id"}


def _ranking_columns(gdf: gpd.GeoDataFrame) -> list[str]:
    """Return exportable ranking columns (exclude geometry and spatial internals)."""
    return [c for c in gdf.columns if c not in _EXCLUDE_COLS and not c.startswith("B0")]


def _export_csv(gdf: gpd.GeoDataFrame, output_path: Path, level: str, logger) -> None:
    """Export rankings as CSV (without geometry)."""
    df = gdf[_ranking_columns(gdf)].copy()
    df.to_csv(output_path, index=False)
    logger.info("  CSV exported: %s (%d rows)", output_path.name, len(df))


def _export_excel(gdf: gpd.GeoDataFrame, output_path: Path, level: str, logger) -> None:
    """Export rankings as Excel (without geometry)."""
    df = gdf[_ranking_columns(gdf)].copy()
    df.to_excel(output_path, index=False, sheet_name=level.upper())
    logger.info("  Excel exported: %s (%d rows)", output_path.name, len(df))


def _select_export_columns(gdf: gpd.GeoDataFrame, level: str) -> list[str]:
    """Select columns relevant for geospatial exports (GeoJSON, Shapefile).

    Returns a list starting with "geometry" followed by ID, ranking, name,
    and analysis columns that exist in the GeoDataFrame.
    """
    cols = ["geometry"]

    # ID columns by level
    if level == "tract":
        id_cols = ["Tract_GeoID", "GEOID"]
    elif level == "county":
        id_cols = ["County_GeoID", "GEOID"]
    else:
        id_cols = ["Metropolitan Division Code"]

    for col in id_cols:
        if col in gdf.columns:
            cols.append(col)
            break

    # Ranking columns
    for col in ["Rank", "P", "Prediction-01", "1-P", "y_true"]:
        if col in gdf.columns:
            cols.append(col)

    # Name columns
    for col in ["NAME", "NAMELSAD", "State", "County"]:
        if col in gdf.columns:
            cols.append(col)

    # Analysis columns from FRONTEND_FEATURE_COLS
    feature_cols = FRONTEND_FEATURE_COLS.get(level.lower(), [])
    for src_col, _fe_key, _label in feature_cols:
        if src_col in gdf.columns and src_col not in cols:
            cols.append(src_col)

    return cols


def _export_geojson(gdf: gpd.GeoDataFrame, output_path: Path, level: str, logger) -> None:
    """Export as GeoJSON with analysis columns."""
    essential_cols = _select_export_columns(gdf, level)
    export_gdf = gdf[essential_cols].copy()
    export_gdf.to_file(output_path, driver="GeoJSON")
    logger.info("  GeoJSON exported: %s (%d features, %d cols)", output_path.name, len(export_gdf), len(essential_cols) - 1)


def _round_coords(obj, precision=6):
    """Recursively convert tuples to lists and round floats for JSON serializable coordinates."""
    if isinstance(obj, float):
        return round(obj, precision)
    if isinstance(obj, int):
        return obj
    if isinstance(obj, (list, tuple)):
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
        ("ISTM_RISKR_#", "stormRisk", "Storm Risk Rating"),
        ("Regular Gas Price ($/G)", "gasPrice", "Gas Price ($/gal)"),
        ("Price (cent/kwh)", "electricityPrice", "Electricity Price (¢/kWh)"),
        ("Land Value (1/4 Acre Lot, Standardized)", "landValue", "Land Value ($/lot)"),
    ],
    "county": [
        ("Count EV Station - Non-Tesla", "evStationCount", "EV Stations (Non-Tesla)"),
        ("Count Airport - 0 mile", "airportCount", "Nearby Airports"),
        ("Count AV Testing - 0 mile", "avTestingCount", "AV Testing Sites"),
        ("# of AV Testing Vehicles - 0 mile", "avTestingVehicles", "AV Testing Vehicles"),
        ("AV Testing Participants", "avTestingParticipants", "AV Testing Participants"),
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
        ("AV Testing Participants", "avTestingParticipants", "AV Testing Participants"),
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
        ("nearest_ica_load_kw", "gridLoadCapacity", "Grid Load Capacity (kW)"),
        ("nearest_subst_cap_mw", "substationCapacity", "Substation Capacity (MW)"),
        ("nearest_subst_dist_m", "substationDist", "Distance to Substation (m)"),
        ("nearest_ica_dist_m", "gridCircuitDist", "Distance to Grid Circuit (m)"),
        ("nearest_subst_utility", "utilityProvider", "Utility Provider"),
        ("nearest_ica_utility", "icaUtility", "Grid Circuit Utility"),
        ("in_sce_territory", "sceTerritory", "In SCE Territory"),
        ("in_pge_territory", "pgeTerritory", "In PG&E Territory"),
        ("in_ladwp_territory", "ladwpTerritory", "In LADWP Territory"),
        ("nearest_subst_name", "substationName", "Nearest Substation"),
        ("nearest_subst_voltage_kv", "substationVoltage", "Substation Voltage (kV)"),
        ("nearest_ica_circuit_name", "circuitName", "Grid Circuit Name"),
        ("nearest_ica_voltage_kv", "circuitVoltage", "Circuit Voltage (kV)"),
        ("nearest_ica_pv_kw", "pvCapacity", "PV Hosting Capacity (kW)"),
        ("grid_readiness_score", "gridReadinessScore", "Grid Readiness Score"),
    ],
}

# DBF field names are limited to 10 characters. This map provides curated
# short aliases for every column that may appear in shapefile exports.
# Unmapped columns fall back to truncation with collision detection.
SHP_COLUMN_MAP = {
    # ID columns
    "Tract_GeoID": "TRACT_ID",
    "County_GeoID": "CNTY_ID",
    "GEOID": "GEOID",
    "Metropolitan Division Code": "MSA_CODE",
    # Ranking columns
    "Rank": "RANK",
    "P": "P",
    "Prediction-01": "PRED_01",
    "1-P": "INV_P",
    "y_true": "Y_TRUE",
    # Name columns
    "NAME": "NAME",
    "NAMELSAD": "NAMELSAD",
    "State": "STATE",
    "County": "COUNTY",
    # EV & Transportation
    "Count EV Station - Non-Tesla": "EV_STNS",
    "Count EV Station - Non-Tesla_MSA": "EV_ST_MSA",
    "Count Airport - 0 mile": "AIRPORT_0",
    "Count Airport - 25 mile": "AIRPORT_25",
    "Count AV Testing - 0 mile": "AV_TEST_0",
    "Count AV Testing - 25 mile": "AV_TST_25",
    "# of AV Testing Vehicles - 0 mile": "AV_VEH_0",
    "# of AV Testing Vehicles - 25 mile": "AV_VEH_25",
    "AV Testing Participants": "AV_PARTIC",
    # Rideshare
    "# rideshare trips": "RIDESHARE",
    "rideshare_trip_per_capita": "RIDE_PCAP",
    "rideshare_trip_density": "RIDE_DENS",
    # Demographics
    "Total Population": "TOT_POP",
    "Population Density (#/sqrtM)": "POP_DENS",
    "Area (SQRT Miles)": "AREA_SQMI",
    "Median Household Income in past 12 months": "MED_INCOME",
    "Average Weekly Wage": "AVG_WAGE",
    "Percent of workers who commuted by public transportation": "TRANSIT_PC",
    # Funding
    "State_Funding_Awards_Count": "ST_FUND_CT",
    "Federal_Funding_Amount": "FED_FUND",
    # Climate
    "Snowdays": "SNOWDAYS",
    "Snowdays_MSA": "SNOW_MSA",
    "Temperature": "TEMP",
    "Temperature_MSA": "TEMP_MSA",
    "Precipitation": "PRECIP",
    # Risk ratings
    "HRCN_RISKR_#": "HRCN_RISK",
    "ISTM_RISKR_#": "ISTM_RISK",
    "ERQK_RISKR_#": "ERQK_RISK",
    # Pricing
    "Regular Gas Price ($/G)": "GAS_PRICE",
    "Price (cent/kwh)": "ELEC_PRICE",
    "Land Value (1/4 Acre Lot, Standardized)": "LAND_VALUE",
    # Utility grid
    "nearest_ica_load_kw": "ICA_LOAD",
    "nearest_subst_cap_mw": "SUBST_CAP",
    "nearest_subst_dist_m": "SUBST_DIST",
    "nearest_ica_dist_m": "ICA_DIST",
    "nearest_subst_utility": "UTILITY",
    "nearest_ica_utility": "ICA_UTIL",
    "in_sce_territory": "SCE_TERR",
    "in_pge_territory": "PGE_TERR",
    "in_ladwp_territory": "LADWP_TER",
    "nearest_subst_name": "SUBST_NAME",
    "nearest_subst_voltage_kv": "SUBST_KV",
    "nearest_ica_circuit_name": "ICA_CIR",
    "nearest_ica_voltage_kv": "ICA_KV",
    "nearest_ica_pv_kw": "ICA_PV",
    "grid_readiness_score": "GRID_READY",
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


def _to_int_str(val: Any) -> Optional[str]:
    """Coerce a scalar value to an integer string, or return None on failure."""
    try:
        return str(int(float(val)))
    except (TypeError, ValueError):
        return None


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
        participant_col = "Participant"
        sheet, src_id, count_col, target_range = configs[level]
        df = pd.read_excel(fpath, sheet_name=sheet, usecols=[src_id, "Range_Cover", count_col, vehicles_col, participant_col])
        df = df[df["Range_Cover"] == target_range]
        agg = df.groupby(src_id).agg(
            sites=(count_col, "sum"),
            vehicles=(vehicles_col, "sum"),
            participants=(participant_col, lambda x: sorted(set(str(p).strip() for p in x.dropna() if str(p).strip()))),
        ).reset_index()
        result = pd.DataFrame()
        result[join_col] = _normalize_geoid(agg[src_id], zfill_width)
        result[f"Count AV Testing - {target_range} mile"] = agg["sites"].values
        result[f"# of AV Testing Vehicles - {target_range} mile"] = agg["vehicles"].values
        result["AV Testing Participants"] = agg["participants"].values
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

    # --- Utility grid features (tract-level only) ---
    if level_lower == "tract":
        grid_path = external_dir.parent / "utility_grid" / "grid_features_tract.csv"
        if grid_path.exists():
            try:
                grid_df = pd.read_csv(grid_path)
                grid_df["Tract_GeoID"] = _normalize_geoid(grid_df["tract_id"], 11)
                grid_cols = ["Tract_GeoID", "nearest_ica_load_kw", "nearest_subst_cap_mw",
                             "nearest_subst_dist_m", "nearest_ica_dist_m", "nearest_subst_utility",
                             "nearest_ica_utility", "in_sce_territory", "in_pge_territory", "in_ladwp_territory",
                             "nearest_subst_name", "nearest_subst_voltage_kv",
                             "nearest_ica_circuit_name", "nearest_ica_voltage_kv", "nearest_ica_pv_kw"]
                grid_df = grid_df[[c for c in grid_cols if c in grid_df.columns]]
                # Compute grid readiness score (0-100): 50% ICA load + 30% inv. substation dist + 20% substation cap
                ica_load = grid_df["nearest_ica_load_kw"].fillna(0) if "nearest_ica_load_kw" in grid_df.columns else pd.Series(0, index=grid_df.index)
                subst_dist = grid_df["nearest_subst_dist_m"].replace(0, np.nan) if "nearest_subst_dist_m" in grid_df.columns else pd.Series(np.nan, index=grid_df.index)
                subst_dist = subst_dist.fillna(subst_dist.median())
                subst_cap = grid_df["nearest_subst_cap_mw"].fillna(0) if "nearest_subst_cap_mw" in grid_df.columns else pd.Series(0, index=grid_df.index)
                n = len(grid_df)
                ica_rank = ica_load.rank(pct=True)
                dist_rank = 1.0 - subst_dist.rank(pct=True)
                cap_rank = subst_cap.rank(pct=True)
                grid_df["grid_readiness_score"] = ((ica_rank * 0.5 + dist_rank * 0.3 + cap_rank * 0.2) * 100).round(1)
                frames.append(grid_df)
                logger.info("  Grid features loaded: %d tracts", len(grid_df))
            except Exception as e:
                logger.warning("  Failed to load grid_features_tract.csv: %s", e)

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


_MONETARY_KEYS = {
    "federalFundingAmount", "medianIncome", "avgWeeklyWage",
    "gasPrice", "landValue", "annualRent", "lastSalePrice",
}


def _format_factor_value(val: float, key: str = "") -> str:
    """Format a numeric value for factor description strings."""
    prefix = "$" if key in _MONETARY_KEYS else ""
    if val >= 1_000_000:
        return f"{prefix}{val / 1_000_000:.1f}M"
    if val >= 1_000:
        return f"{prefix}{val / 1_000:.1f}K"
    if val < 1:
        return f"{prefix}{val:.3f}"
    return f"{prefix}{val:.0f}"


# Thresholds for determining impact levels (low_threshold, high_threshold)
_IMPACT_THRESHOLDS: Dict[str, tuple] = {
    "evStationCount": (5, 20),
    "airportCount": (1, 3),
    "avTestingCount": (1, 5),
    "rideshareTrips": (1000, 10000),
    "population": (50000, 200000),
    "populationDensity": (500, 2000),
    "federalFundingAmount": (100000, 1000000),
    "stateFundingCount": (2, 10),
}


def _build_factors_from_features(row: pd.Series, level: str) -> List[Dict[str, str]]:
    """Build up to 5 most impactful factor objects for the frontend from feature values."""
    factors = []
    feature_cols = FRONTEND_FEATURE_COLS.get(level.lower(), [])

    for src_col, key, label in feature_cols:
        if src_col not in row.index:
            continue
        val = row.get(src_col)
        if isinstance(val, np.ndarray):
            continue
        try:
            if pd.isna(val):
                continue
        except (ValueError, TypeError):
            continue

        try:
            val_num = float(val)
        except (TypeError, ValueError):
            continue

        if abs(val_num) < 0.001:
            continue

        # Determine impact level
        lo, hi = _IMPACT_THRESHOLDS.get(key, (0, 0))
        if hi > 0:
            if val_num >= hi:
                impact = "high"
            elif val_num >= lo:
                impact = "medium"
            else:
                impact = "low"
        else:
            impact = "medium"

        factors.append({
            "name": label,
            "impact": impact,
            "value": val_num,
            "description": f"{label}: {_format_factor_value(val_num, key)}",
        })

    # Sort by value (descending) and take top 5, stripping the internal 'value' key
    factors.sort(key=lambda f: f.get("value", 0), reverse=True)
    return [{"name": f["name"], "impact": f["impact"], "description": f["description"]} for f in factors[:5]]


def _build_nearby_substations_index(
    grid_dir: Path,
    tracts_gdf: gpd.GeoDataFrame,
    id_col: str,
    radius_m: float = 10000.0,
    logger=None,
) -> dict:
    """
    For each tract, find all substations within radius_m metres of the tract centroid.
    Returns dict: tract_id (str) → list of substation dicts sorted by distance asc.
    """
    PROJ_CRS = "EPSG:5070"
    parts = []
    for util in ("sce", "pge", "ladwp"):
        path = grid_dir / util / "substations.geojson"
        if path.exists():
            try:
                parts.append(gpd.read_file(path))
            except Exception as exc:
                if logger:
                    logger.warning("  Could not load substations for %s: %s", util, exc)

    if not parts:
        return {}

    # Normalize all to WGS84 before concat (parts may have mixed CRS e.g. UTM)
    parts = [p.to_crs("EPSG:4326") if p.crs is not None else p for p in parts]
    subst_all = gpd.GeoDataFrame(pd.concat(parts, ignore_index=True), crs="EPSG:4326")
    # Stash WGS84 coords before reprojecting
    subst_all["_lat"] = subst_all.geometry.y
    subst_all["_lng"] = subst_all.geometry.x
    subst_proj = subst_all.to_crs(PROJ_CRS)

    # Project tracts; keep both full polygons and centroids
    tracts_proj = tracts_gdf[[id_col, "geometry"]].to_crs(PROJ_CRS).copy()
    tracts_proj = tracts_proj.rename(columns={id_col: "_tract_id"})
    tracts_cent = tracts_proj.copy()
    tracts_cent["geometry"] = tracts_cent.geometry.centroid
    centroid_map = {str(r["_tract_id"]): r.geometry for _, r in tracts_cent.iterrows()}

    # Criterion 1: substation falls inside the tract polygon (catches large tracts)
    joined_inside = gpd.sjoin(
        subst_proj, tracts_proj[["_tract_id", "geometry"]], how="inner", predicate="within"
    )

    # Criterion 2: substation within radius_m of tract centroid (catches nearby-but-outside)
    tracts_buf = tracts_cent.copy()
    tracts_buf["geometry"] = tracts_buf.geometry.buffer(radius_m)
    joined_buf = gpd.sjoin(
        subst_proj, tracts_buf[["_tract_id", "geometry"]], how="inner", predicate="within"
    )

    # Union both — deduplicate on (tract, substation) so no double-counting
    joined = (
        pd.concat([joined_inside, joined_buf], ignore_index=True)
        .drop_duplicates(subset=["_tract_id", "substation_id"])
    )

    index: dict = {}
    for _, row in joined.iterrows():
        tid = str(row["_tract_id"])
        cent = centroid_map.get(tid)
        dist_m = round(float(row.geometry.distance(cent)), 0) if cent is not None else None

        # Normalise fields common to SCE and PGE
        name = row.get("substation_name") or row.get("raw_sub_name") or ""
        cap = row.get("remaining_capacity_mw")
        volt = row.get("substation_voltage_kv")
        uid = row.get("substation_id") or row.get("utility", "")

        entry = {
            "id": f"{row.get('utility', 'util')}_{uid}",
            "name": str(name) if name else "",
            "utility": str(row.get("utility", "")),
            "lat": round(float(row["_lat"]), 6) if pd.notna(row["_lat"]) else None,
            "lng": round(float(row["_lng"]), 6) if pd.notna(row["_lng"]) else None,
            "capacityMw": round(float(cap), 3) if cap is not None and pd.notna(cap) else None,
            "voltageKv": round(float(volt), 1) if volt is not None and pd.notna(volt) else None,
            "distM": dist_m,
        }
        index.setdefault(tid, []).append(entry)

    # Sort each list by distance
    for tid in index:
        index[tid].sort(key=lambda x: x["distM"] if x["distM"] is not None else float("inf"))

    if logger:
        n_covered = sum(1 for v in index.values() if v)
        logger.info("  nearbySubstations index: %d tracts have ≥1 substation (polygon-inside or within %.0fm centroid buffer)", n_covered, radius_m)

    return index


def _export_substations_json(grid_dir: Path, exports_dir: Path, logger) -> None:
    """Export data/exports/substations.json — flat list of all substation points for frontend map pins."""
    parts = []
    for util in ("sce", "pge", "ladwp"):
        path = grid_dir / util / "substations.geojson"
        if path.exists():
            try:
                parts.append(gpd.read_file(path))
            except Exception as exc:
                logger.warning("  Could not load substations for %s: %s", util, exc)

    if not parts:
        logger.warning("  No substation data found — substations.json not written")
        return

    # Normalize all to WGS84 before concat (parts may have mixed CRS e.g. UTM)
    parts = [p.to_crs("EPSG:4326") if p.crs is not None else p for p in parts]
    subst_all = gpd.GeoDataFrame(pd.concat(parts, ignore_index=True), crs="EPSG:4326")
    subst_all["_lat"] = subst_all.geometry.y
    subst_all["_lng"] = subst_all.geometry.x

    records = []
    for _, row in subst_all.iterrows():
        lat = row.get("_lat")
        lng = row.get("_lng")
        if lat is None or lng is None or pd.isna(lat) or pd.isna(lng):
            continue
        name = row.get("substation_name") or row.get("raw_sub_name") or ""
        cap = row.get("remaining_capacity_mw")
        volt = row.get("substation_voltage_kv")
        uid = row.get("substation_id") or row.get("utility", "")
        records.append({
            "id": f"{row.get('utility', 'util')}_{uid}",
            "name": str(name) if name else "",
            "utility": str(row.get("utility", "")),
            "lat": round(float(lat), 6),
            "lng": round(float(lng), 6),
            "capacityMw": round(float(cap), 3) if cap is not None and pd.notna(cap) else None,
            "voltageKv": round(float(volt), 1) if volt is not None and pd.notna(volt) else None,
        })

    out_path = exports_dir / "substations.json"
    out_path.write_text(json.dumps(records, separators=(",", ":"), ensure_ascii=False))
    logger.info("  substations.json written: %d features", len(records))


def _export_circuits_json(grid_dir: Path, exports_dir: Path, logger) -> None:
    """Export circuits split by county into data/exports/circuits/county_{fips}.json.

    Only includes circuits at or below 33 kV (distribution level). Each county
    file is small enough to load on-demand (same pattern as tract_polygons/).
    A circuit segment is assigned to a county if its geometry intersects that county.
    """
    import json as _json

    # ── Load ICA segments ─────────────────────────────────────────────────────
    # NOTE: The fetch_utility_grid.py already normalises SCE capacity fields to kW.
    # The MW→kW ×1000 correction that previously lived here was removed — applying
    # it after the fetch fix caused a 1000× inflation (e.g. 3.67 MW → 3,670 MW).

    parts = []
    for util in ("sce", "pge", "ladwp", "sdge"):
        path = grid_dir / util / "ica_segments.geojson"
        if path.exists():
            try:
                gdf = gpd.read_file(path)
                # Normalise every utility's segments to WGS 84 before concat
                if gdf.crs is None:
                    gdf = gdf.set_crs("EPSG:4326")
                elif gdf.crs.to_epsg() != 4326:
                    gdf = gdf.to_crs("EPSG:4326")
                parts.append(gdf)
                logger.info("  Loaded %d ICA segments for %s", len(gdf), util.upper())
            except Exception as exc:
                logger.warning("  Could not load ICA segments for %s: %s", util, exc)

    if not parts:
        logger.warning("  No ICA segment data found — circuits/ not written")
        return

    all_segs = gpd.GeoDataFrame(pd.concat(parts, ignore_index=True), crs="EPSG:4326")

    # ── Filter to distribution-level circuits only (≤ 33 kV) ─────────────────
    kv_col = "circuit_voltage_kv"
    if kv_col in all_segs.columns:
        distribution = all_segs[
            all_segs[kv_col].isna() | (all_segs[kv_col] <= 33)
        ].copy()
        logger.info(
            "  Distribution filter (≤33 kV): %d / %d segments retained",
            len(distribution), len(all_segs),
        )
    else:
        distribution = all_segs.copy()
        logger.warning("  circuit_voltage_kv column not found — no voltage filter applied")

    if distribution.empty:
        logger.warning("  No distribution-level circuits found after filtering")
        return

    # ── Simplify geometry for web performance ─────────────────────────────────
    try:
        dist_proj = distribution.to_crs("EPSG:5070")   # Albers Equal Area — CONUS
        dist_proj["geometry"] = dist_proj.geometry.simplify(
            tolerance=20,            # ~20 m simplification tolerance
            preserve_topology=True,
        )
        distribution = dist_proj.to_crs("EPSG:4326")
    except Exception as exc:
        logger.warning("  Geometry simplification failed (%s) — using raw geometry", exc)

    # ── Load county shapefile for spatial join ────────────────────────────────
    spatial_dir = grid_dir.parent / "spatial"
    county_shp = spatial_dir / "County.shp"
    if not county_shp.exists():
        logger.warning("  County shapefile not found at %s — circuits/ not written", county_shp)
        return

    counties = gpd.read_file(county_shp).to_crs("EPSG:4326")
    # Find the county FIPS column (GEOID, FIPS, COUNTYFP, etc.)
    fips_col = next(
        (c for c in counties.columns if c.upper() in ("GEOID", "FIPS", "COUNTYFP10", "COUNTYFP", "GEO_ID")),
        None,
    )
    if fips_col is None:
        logger.warning("  Could not identify county FIPS column in %s. Columns: %s", county_shp, list(counties.columns))
        return
    logger.info("  County shapefile loaded: %d counties (FIPS col: %s)", len(counties), fips_col)

    # ── Spatial join: assign each circuit segment to county/counties ──────────
    # Use centroid for speed (representative point of segment → county lookup)
    distribution = distribution.reset_index(drop=True)
    distribution["_centroid"] = distribution.to_crs("EPSG:5070").geometry.centroid.to_crs("EPSG:4326")
    centroids = distribution.set_geometry("_centroid")

    joined = gpd.sjoin(
        centroids[["_centroid", "geometry"] + [c for c in distribution.columns if c not in ("_centroid", "geometry")]],
        counties[[fips_col, "geometry"]].rename(columns={fips_col: "_county_fips"}),
        how="left",
        predicate="within",
    )
    distribution["_county_fips"] = joined["_county_fips"].values

    # ── Build records helper ──────────────────────────────────────────────────
    def _row_to_record(row) -> dict | None:
        geom = row.geometry
        if geom is None or geom.is_empty:
            return None
        geom_type = geom.geom_type
        if geom_type == "LineString":
            coord_arrays = [[[round(x, 4), round(y, 4)] for x, y in geom.coords]]
        elif geom_type == "MultiLineString":
            coord_arrays = [
                [[round(x, 4), round(y, 4)] for x, y in line.coords]
                for line in geom.geoms
            ]
        elif geom_type == "Polygon":
            # SDG&E ICA segments are polygons (grid sections) — use exterior ring
            coord_arrays = [[[round(x, 4), round(y, 4)] for x, y in geom.exterior.coords]]
        elif geom_type == "MultiPolygon":
            coord_arrays = [
                [[round(x, 4), round(y, 4)] for x, y in p.exterior.coords]
                for p in geom.geoms
            ]
        else:
            return None

        load_kw = row.get("load_hosting_capacity_kw")
        pv_kw   = row.get("pv_hosting_capacity_kw")
        volt    = row.get(kv_col)
        util_id = str(row.get("utility", "") or "")
        sec_id  = str(row.get("section_id", "") or "")

        def _s(val) -> str:
            """NaN-safe string: returns '' for None/NaN/pandas NA."""
            if val is None: return ""
            try:
                if pd.isna(val): return ""
            except (TypeError, ValueError):
                pass
            return str(val)

        # Compact schema — short keys + omit null/empty values to minimise file size.
        # Frontend decodes via decodeCircuit() in MapExplorer.tsx.
        # Key map: u=utility, cn=circuitName, sn=substationName,
        #          vk=voltageKv, lk=loadAvailKw, pk=pvHostingKw, c=coords
        rec: dict = {"id": f"{util_id}_{sec_id}", "u": util_id, "c": coord_arrays}
        cn = _s(row.get("circuit_name"))
        sn = _s(row.get("substation_name"))
        if cn: rec["cn"] = cn
        if sn: rec["sn"] = sn
        if volt    is not None and pd.notna(volt):
            rec["vk"] = round(float(volt), 1)
        if load_kw is not None and pd.notna(load_kw):
            rec["lk"] = round(float(load_kw), 1)
        if pv_kw   is not None and pd.notna(pv_kw):
            rec["pk"] = round(float(pv_kw), 1)
        return rec

    # ── Write per-county files ────────────────────────────────────────────────
    out_dir = exports_dir / "circuits"
    out_dir.mkdir(exist_ok=True)

    county_groups: dict[str, list] = {}
    unmatched = 0
    for _, row in distribution.iterrows():
        fips = row.get("_county_fips")
        if pd.isna(fips) or fips is None:
            unmatched += 1
            continue
        fips_str = str(fips).zfill(5)
        rec = _row_to_record(row)
        if rec:
            county_groups.setdefault(fips_str, []).append(rec)

    total_records = 0
    total_size_mb = 0.0
    for fips_str, records in county_groups.items():
        out_path = out_dir / f"county_{fips_str}.json"
        out_path.write_text(_json.dumps(records, separators=(",", ":"), ensure_ascii=False))
        total_records += len(records)
        total_size_mb += out_path.stat().st_size / 1_048_576

    logger.info(
        "  circuits/ written: %d county files, %d segments, %.1f MB total (%.1f MB avg)",
        len(county_groups),
        total_records,
        total_size_mb,
        total_size_mb / len(county_groups) if county_groups else 0,
    )
    if unmatched:
        logger.warning("  %d segments could not be matched to a county (outside CONUS?)", unmatched)


def _extract_feature_details(row: pd.Series, level: str) -> Dict[str, Any]:
    """Extract feature details from a row to include in the region object."""
    details = {}
    feature_cols = FRONTEND_FEATURE_COLS.get(level.lower(), [])

    for src_col, key, _label in feature_cols:
        if src_col not in row.index:
            continue
        val = row.get(src_col)
        if isinstance(val, np.ndarray):
            continue
        # List-type columns (e.g. AV Testing Participants) — pass through as-is
        if isinstance(val, list):
            details[key] = val if val else None
            continue
        try:
            is_na = pd.isna(val)
        except (ValueError, TypeError):
            continue
        if is_na:
            details[key] = None
        elif isinstance(val, (int, np.integer)):
            details[key] = int(val)
        elif isinstance(val, (float, np.floating)):
            details[key] = round(float(val), 4)
        else:
            details[key] = val

    return details


def _export_frontend_jsons_for_level(gdf: gpd.GeoDataFrame, level: str, exports_dir: Path, logger, simplify_tolerance: float = 0.0001, master_geocode: Optional[pd.DataFrame] = None, grid_dir: Optional[Path] = None):
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

        # MSA-specific column detection (initialized to None for non-MSA levels)
        msa_id_col_for_export: Optional[str] = None
        msa_name_col_for_export: Optional[str] = None
        cbsa_to_msa_name: dict[str, str] = {}

        # For MSA level, prefer explicit CBSA/Metropolitan columns as id/name
        if level.lower() == "msa":
            msa_id_candidates = [c for c in simple.columns if any(k in c.lower() for k in ("cbsa", "cbsa code", "cbsa_code", "cbsaid"))]
            msa_name_candidates = [c for c in simple.columns if any(k in c.lower() for k in ("metropolitan", "division", "metro", "msa", "name"))]
            if msa_id_candidates:
                id_col = msa_id_candidates[0]
            elif msa_name_candidates:
                id_col = msa_name_candidates[0]
            msa_id_col_for_export = msa_id_candidates[0] if msa_id_candidates else None
            msa_name_col_for_export = msa_name_candidates[0] if msa_name_candidates else None

        features = []
        regions = []

        # Pre-compute nearby-substations index for tract level
        nearby_substations_index: dict = {}
        if level.lower() == "tract" and grid_dir is not None:
            try:
                nearby_substations_index = _build_nearby_substations_index(
                    grid_dir=grid_dir,
                    tracts_gdf=gdf_wgs,
                    id_col=_detect_id_column(gdf_wgs, preferred=["GEOID", "Tract_GeoID"]) or "GEOID",
                    radius_m=10000.0,
                    logger=logger,
                )
            except Exception as exc:
                logger.warning("  Could not build nearbySubstations index: %s", exc)

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
            gc_cols = list(master_geocode.columns)
            tract_col = _find_column(gc_cols, preferred=["CLEAN_Tract Geoid"], keywords=["tract geo", "tract_geo"])
            county_col = _find_column(gc_cols, preferred=["CLEAN_County Geoid"], keywords=["county geo", "county_geo"])
            msa_code_col = _find_column(gc_cols, preferred=["CBSA Code"], keywords=["cbsa"])
            msa_name_col = _find_column(gc_cols, preferred=["Metropolitan Division Code"], keywords=["metropolitan", "division", "metro"])

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
                        tract_to_msa_id[t] = _to_int_str(m_id_raw) or str(m_id_raw)
                    # name
                    if msa_name_col and not pd.isna(mg_row.get(msa_name_col)):
                        tract_to_msa_name[t] = str(mg_row.get(msa_name_col))

            # Build direct CBSA -> Metropolitan Division Code map for MSA-level naming
            if msa_code_col and msa_name_col:
                for _, mg_row in master_geocode.iterrows():
                    code = mg_row.get(msa_code_col)
                    name = mg_row.get(msa_name_col)
                    if pd.isna(code) or pd.isna(name):
                        continue
                    code_key = _to_int_str(code) or str(code)
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
                    if msa_id_col_for_export and pd.notna(row.get(msa_id_col_for_export)):
                        props['msaID'] = str(row.get(msa_id_col_for_export))
                    if msa_name_col_for_export and pd.notna(row.get(msa_name_col_for_export)):
                        props['msaName'] = str(row.get(msa_name_col_for_export))
                    # If we have a CBSA->name map, prefer that canonical name and ensure msaID is normalized
                    mid = props.get('msaID') or (str(gid) if gid is not None else None)
                    if mid is not None:
                        mid_norm = _to_int_str(mid) or str(mid)
                        props['msaID'] = mid_norm
                        if mid_norm in cbsa_to_msa_name:
                            props['msaName'] = cbsa_to_msa_name[mid_norm]
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

            score = 0.0
            for score_col in ("P", "score"):
                if score_col in row and pd.notna(row[score_col]):
                    score = float(row[score_col])
                    break

            # expose hierarchical ids on the region object for frontend
            county_for_region = None
            msa_for_region = None
            msa_name_for_region = None
            if level.lower() in ('tract', 'county'):
                county_for_region = props.get('countyID')
                msa_for_region = props.get('msaID')
                msa_name_for_region = props.get('msaName')
            elif level.lower() == 'msa':
                gid_norm = _to_int_str(gid) or str(gid)
                msa_for_region = gid_norm
                msa_name_for_region = cbsa_to_msa_name.get(gid_norm)

            # Extract feature details for this region
            feature_details = _extract_feature_details(row, level)

            # Inject nearby substations list for tract level
            if level.lower() == "tract" and nearby_substations_index:
                # gid may be float-padded; normalise to 11-digit string for lookup
                gid_str = str(gid).zfill(11) if str(gid).isdigit() else str(gid)
                nearby = nearby_substations_index.get(gid_str) or nearby_substations_index.get(str(gid)) or []
                feature_details["nearbySubstations"] = nearby if nearby else None

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
            # Embed filterable grid fields directly on tract regions so they survive
            # the slim_regions strip (which removes "details") and are available
            # for FilterPanel filtering without loading the details sidecar.
            if level.lower() == "tract":
                raw_cap = row.get("nearest_ica_load_kw")
                raw_score = row.get("grid_readiness_score")
                region_obj["gridLoadCapacity"] = float(raw_cap) if raw_cap is not None and not (isinstance(raw_cap, float) and np.isnan(raw_cap)) else None
                region_obj["gridReadinessScore"] = float(raw_score) if raw_score is not None and not (isinstance(raw_score, float) and np.isnan(raw_score)) else None

            # Normalize and enforce msaID as integer-string when possible
            if region_obj.get('msaID'):
                region_obj['msaID'] = _to_int_str(region_obj['msaID']) or str(region_obj['msaID'])

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
                mid_candidate = region_obj.get('msaID') or gid
                mid_norm = _to_int_str(mid_candidate) or (str(mid_candidate) if mid_candidate else None)

                if mid_norm is not None:
                    region_obj['id'] = mid_norm
                    region_obj['msaID'] = mid_norm

                # Determine canonical name: prefer cbsa_to_msa_name map, then explicit msa_name_col from row
                msa_name_val = cbsa_to_msa_name.get(mid_norm) if mid_norm else None

                # Fallback to any detected msa_name_col field on the row (explicit column), but DO NOT use tract NAME
                if msa_name_val is None and msa_name_col_for_export and pd.notna(row.get(msa_name_col_for_export)):
                    msa_name_val = str(row.get(msa_name_col_for_export))

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
            tract_poly_dir = exports_dir / "tract_polygons"
            tract_poly_dir.mkdir(exist_ok=True)
            by_county: dict = collections.defaultdict(list)
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

        # Slim list: omit factors/details so the list file stays small for fast initial load.
        # gridLoadCapacity / gridReadinessScore are kept (set at top-level for filter use).
        slim_regions = [
            {k: v for k, v in r.items() if k not in ("factors", "details")}
            for r in regions
        ]
        mock_path = exports_dir / f"mockRegions_{level}.json"
        mock_path.write_text(json.dumps(slim_regions, separators=(",", ":"), ensure_ascii=False))

        # For Tract level, also write per-county mockRegions files to avoid loading 25MB at once.
        # Frontend loads /data/exports/mockRegions_tract/county_{countyID}.json on demand.
        if level == "tract":
            mr_dir = exports_dir / "mockRegions_tract"
            mr_dir.mkdir(exist_ok=True)
            by_county_mr: dict = collections.defaultdict(list)
            for r in slim_regions:
                cid = r.get("countyID")
                if cid:
                    by_county_mr[cid].append(r)
            for cid, chunk in by_county_mr.items():
                (mr_dir / f"county_{cid}.json").write_text(
                    json.dumps(chunk, separators=(",", ":"), ensure_ascii=False)
                )
            logger.info("  mockRegions_tract/ written: %d county files", len(by_county_mr))

        # Details sidecar: keyed by id so the frontend can fetch one file per level on demand
        details_index = {r["id"]: {"factors": r.get("factors", []), "details": r.get("details", {})} for r in regions}
        details_path = exports_dir / f"regionDetails_{level}.json"
        details_path.write_text(json.dumps(details_index, separators=(",", ":"), ensure_ascii=False))

        # For Tract level, also write per-county detail files to avoid loading 112MB at once.
        # Frontend loads /data/exports/regionDetails_tract/county_{countyID}.json on demand.
        if level == "tract":
            rd_dir = exports_dir / "regionDetails_tract"
            rd_dir.mkdir(exist_ok=True)
            by_county_details: dict = collections.defaultdict(dict)
            for r in regions:
                cid = r.get("countyID")
                if cid:
                    by_county_details[cid][r["id"]] = {"factors": r.get("factors", []), "details": r.get("details", {})}
            for cid, chunk in by_county_details.items():
                chunk_path = rd_dir / f"county_{cid}.json"
                chunk_path.write_text(json.dumps(chunk, separators=(",", ":"), ensure_ascii=False))
            logger.info("  regionDetails_tract/ written: %d county files", len(by_county_details))

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
    """Export as KML with heat-map-styled polygons and simplified geometries."""
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

        # Build analysis lines from FRONTEND_FEATURE_COLS
        feature_cols = FRONTEND_FEATURE_COLS.get(level.lower(), [])
        analysis_lines = []
        for src_col, _fe_key, label in feature_cols:
            val = row.get(src_col)
            if val is not None and not (isinstance(val, float) and np.isnan(val)):
                if isinstance(val, float):
                    analysis_lines.append(f"{label}: {val:,.2f}")
                else:
                    analysis_lines.append(f"{label}: {val}")
        analysis_text = "\n".join(analysis_lines)
        if analysis_text:
            analysis_text = "\n---\n" + analysis_text

        placemark = f"""
    <Placemark>
        <name>{feature_name}</name>
        <description>Rank: {rank}
ID: {feature_id}
Probability: {prob:.4f}
Prediction: {prediction}{analysis_text}</description>
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


def _max_polygon_vertices(gdf: gpd.GeoDataFrame) -> int:
    """Return the maximum vertex count of any single polygon in the GeoDataFrame."""
    max_v = 0
    for geom in gdf.geometry:
        if geom is None or geom.is_empty:
            continue
        polys = [geom] if geom.geom_type == "Polygon" else (list(geom.geoms) if geom.geom_type == "MultiPolygon" else [])
        for poly in polys:
            v = len(poly.exterior.coords) + sum(len(ring.coords) for ring in poly.interiors)
            if v > max_v:
                max_v = v
    return max_v


def _export_shapefile(
    gdf: gpd.GeoDataFrame,
    output_dir: Path,
    level: str,
    logger,
    simplify_tolerance: float = 0.005,
    preserve_topology: bool = True,
) -> Optional[Path]:
    """Export as ESRI Shapefile packaged in a flat ZIP for LandVision compatibility.

    LandVision Shapefile Loader constraints:
    - ZIP with .shp, .dbf, .shx, .prj (minimum), no nested folders
    - Max 30MB ZIP, max 10,000 vertices per polygon
    - DBF field names max 10 characters
    - Projection: WGS84 (EPSG:4326)
    """
    cols = _select_export_columns(gdf, level)
    export_gdf = gdf[cols].copy()

    # Reproject to WGS84 and simplify
    export_gdf = export_gdf.to_crs(epsg=4326)
    export_gdf = _simplify_geometry(
        export_gdf,
        tolerance=simplify_tolerance,
        preserve_topology=preserve_topology,
        logger=logger,
    )

    # Per-polygon vertex safety check (LandVision limit: 10,000)
    max_vertices = _max_polygon_vertices(export_gdf)
    if max_vertices > 10000:
        logger.warning(
            "  Shapefile has polygons with up to %d vertices (LandVision limit: 10,000)",
            max_vertices,
        )

    # Build column rename map (DBF field names max 10 chars)
    rename_map = {}
    used_names = set()
    legend_entries = []

    feature_label_map = {}
    for src_col, _fe_key, feat_label in FRONTEND_FEATURE_COLS.get(level.lower(), []):
        feature_label_map[src_col] = feat_label

    for col in export_gdf.columns:
        if col == "geometry":
            continue

        if col in SHP_COLUMN_MAP:
            short = SHP_COLUMN_MAP[col]
        else:
            short = col[:10]

        # Handle collisions (keep result ≤ 10 chars for DBF)
        if short in used_names:
            base = short[:7]
            for i in range(1, 1000):
                candidate = f"{base}_{i}"[:10]
                if candidate not in used_names:
                    short = candidate
                    break

        used_names.add(short)
        if short != col:
            rename_map[col] = short

        label = feature_label_map.get(col, col)
        legend_entries.append((short, col, label))

    export_gdf = export_gdf.rename(columns=rename_map)

    # Write shapefile
    stem = f"rankings_{level}_shapefile"
    shp_path = output_dir / f"{stem}.shp"
    export_gdf.to_file(shp_path, driver="ESRI Shapefile", encoding="utf-8")
    logger.info("  Shapefile written: %s (%d features)", shp_path.name, len(export_gdf))

    # Write legend CSV (maps short DBF names to original names + descriptions)
    legend_path = output_dir / f"{stem}_legend.csv"
    with open(legend_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["short_name", "original_name", "description"])
        for short, orig, desc in legend_entries:
            writer.writerow([short, orig, desc])

    # Package as flat ZIP
    zip_path = output_dir / f"{stem}.zip"
    _zip_shapefile(shp_path, zip_path, logger, legend_csv_path=legend_path)

    # Clean up raw files — keep only the ZIP
    for ext in [".shp", ".dbf", ".shx", ".prj", ".cpg"]:
        component = output_dir / f"{stem}{ext}"
        if component.exists():
            component.unlink()
    if legend_path.exists():
        legend_path.unlink()

    return zip_path


def _zip_shapefile(
    shp_path: Path,
    zip_path: Path,
    logger,
    legend_csv_path: Optional[Path] = None,
) -> Path:
    """Package shapefile components into a flat ZIP (LandVision requirement).

    Collects .shp, .dbf, .shx, .prj, .cpg sidecar files and writes them
    into a ZIP with no subdirectory structure.
    """
    stem = shp_path.stem
    parent = shp_path.parent
    sidecar_exts = [".shp", ".dbf", ".shx", ".prj", ".cpg"]

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for ext in sidecar_exts:
            component = parent / f"{stem}{ext}"
            if component.exists():
                zf.write(component, component.name)

        if legend_csv_path and legend_csv_path.exists():
            zf.write(legend_csv_path, legend_csv_path.name)

    zip_size_mb = zip_path.stat().st_size / (1024 * 1024)
    logger.info("  Shapefile ZIP: %s (%.1f MB)", zip_path.name, zip_size_mb)
    if zip_size_mb > 30:
        logger.warning(
            "  WARNING: ZIP exceeds LandVision 30MB limit (%.1f MB)", zip_size_mb
        )

    return zip_path


def run_exports(config: Optional[dict] = None, cli_opts: Optional[dict] = None) -> dict[str, Any]:
    """Main entry point for generating all export artifacts (CSV, Excel, GeoJSON, KML/KMZ)."""
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
    shp_tolerance = simplify_config.get("shapefile_tolerance", 0.005)  # ~500m default for shapefile/LandVision
    preserve_topology = simplify_config.get("preserve_topology", True)

    logger.info("Export output directory: %s", exports_dir)
    logger.info("KML simplification: tolerance=%.4f, preserve_topology=%s", kml_tolerance, preserve_topology)
    logger.info("Frontend simplification: tolerance=%.4f", frontend_tolerance)
    logger.info("Shapefile simplification: tolerance=%.4f", shp_tolerance)

    # Determine target geography and formats EARLY so we can skip unnecessary I/O
    target_geo = None
    if cli_opts and cli_opts.get("geography"):
        g = cli_opts.get("geography")
        if isinstance(g, str):
            target_geo = g.lower()

    requested_formats = None
    if cli_opts and cli_opts.get("format"):
        requested_formats = {cli_opts.get("format").lower()}

    # Determine which levels actually need data
    if target_geo:
        needed_levels = [target_geo]
    else:
        needed_levels = ["tract", "county", "msa"]

    logger.info("Target geography: %s | Formats: %s", target_geo or "ALL", requested_formats or "ALL")

    # Load data — only the levels we actually need
    # Allow CLI override of rankings workbook path
    if cli_opts and cli_opts.get("ranking_file"):
        rf = cli_opts.get("ranking_file")
        # if absolute/relative path provided, prefer that
        rankings_path = Path(rf)

    rankings = _load_rankings(rankings_path, logger, levels=needed_levels)
    spatial = _load_spatial_files(spatial_dir, logger, levels=needed_levels)
    master_geocode = _load_master_geocode(geocode_path, logger)

    # Normalize GeoIDs early (needed for region filtering and spatial joins)
    _geoid_cfg = {
        "tract": ("Tract_GeoID", 11),
        "county": ("County_GeoID", 5),
    }
    for lvl, (id_col, zfill) in _geoid_cfg.items():
        if lvl in rankings and id_col in rankings[lvl].columns:
            rankings[lvl][id_col] = _normalize_geoid(rankings[lvl][id_col], zfill)

    # Early region filtering — do this BEFORE external data loading to reduce merge size
    if cli_opts and cli_opts.get("regions") is not None:
        regs = set(str(r) for r in cli_opts.get("regions"))
        for lvl, (id_col, _zfill) in _geoid_cfg.items():
            if lvl not in rankings:
                continue
            col = _detect_id_column(rankings[lvl], preferred=[id_col], keywords=[lvl])
            if col:
                before = len(rankings[lvl])
                rankings[lvl] = rankings[lvl][rankings[lvl][col].astype(str).isin(regs)]
                logger.info("  Filtered %s rankings: %d -> %d rows", lvl, before, len(rankings[lvl]))

    # Load external integration data — skip for shapefile-only (9+ min I/O not needed for LandVision)
    skip_external = requested_formats is not None and requested_formats == {"shapefile"}
    external_dir = Path(config["paths"]["inputs"].get("external", "data/inputs/external"))

    if skip_external:
        logger.info("Skipping external data loading (shapefile-only export)")
    else:
        logger.info("Loading external features for frontend details from: %s", external_dir)
        for _level in needed_levels:
            if _level not in rankings:
                continue
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
    exported_files = {"csv": [], "excel": [], "geojson": [], "kml": [], "kmz": [], "shapefile": []}

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

    def _should_export(fmt: str) -> bool:
        """Check whether a given format should be exported."""
        return requested_formats is None or fmt in requested_formats

    def _dispatch_exports(gdf: gpd.GeoDataFrame, level: str) -> None:
        """Run all requested format exports for a single level's GeoDataFrame."""
        csv_path = exports_dir / f"rankings_{level}.csv"
        excel_path = exports_dir / f"rankings_{level}.xlsx"
        geojson_path = exports_dir / f"rankings_{level}.geojson"
        kml_path = exports_dir / f"rankings_{level}.kml"
        kmz_path = exports_dir / f"rankings_{level}.kmz"

        if _should_export("csv"):
            _export_csv(gdf, csv_path, level, logger)
            exported_files["csv"].append(csv_path)
        if _should_export("excel"):
            _export_excel(gdf, excel_path, level, logger)
            exported_files["excel"].append(excel_path)
        if _should_export("geojson"):
            _export_geojson(gdf, geojson_path, level, logger)
            exported_files["geojson"].append(geojson_path)

        # Frontend JSON artifacts (full export only, not format-specific CLI calls)
        if config is not None and requested_formats is None:
            try:
                _grid_dir = external_dir.parent / "utility_grid"
                _export_frontend_jsons_for_level(gdf, level, exports_dir, logger, simplify_tolerance=frontend_tolerance, master_geocode=master_geocode, grid_dir=_grid_dir)
            except Exception as e:
                logger.warning("Failed to export frontend JSONs for %s: %s", level, e)

        # KML/KMZ: generate KML if either format is requested
        if _should_export("kml") or _should_export("kmz"):
            _export_kml(gdf, kml_path, level, logger, kml_tolerance, preserve_topology)
            if _should_export("kml"):
                exported_files["kml"].append(kml_path)

        if _should_export("kmz"):
            _export_kmz(kml_path, kmz_path, logger)
            exported_files["kmz"].append(kmz_path)

        if _should_export("shapefile"):
            shp_zip = _export_shapefile(gdf, exports_dir, level, logger, shp_tolerance, preserve_topology)
            if shp_zip:
                exported_files["shapefile"].append(shp_zip)

    # Export Tract and County levels (region filtering already applied above)
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

        _dispatch_exports(gdf, level)


    # Export MSA level (requires dissolving tracts) — skip if target is tract/county only
    if target_geo is not None and target_geo != "msa":
        logger.info("Skipping MSA level (target_geo=%s)", target_geo)
    elif "msa" not in rankings:
        logger.info("Skipping MSA level (no MSA rankings loaded)")
    else:
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

            _dispatch_exports(msa_gdf, "msa")

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
    # Skip competitor tracker for format-specific CLI calls (e.g. shapefile-only)
    if requested_formats is not None:
        logger.info("Skipping Competitor Tracker (format-specific export)")
    else:
        logger.info("")
        logger.info("=" * 80)
        logger.info("Exporting Competitor Tracker data...")
        logger.info("=" * 80)

    competitor_csv = Path(config["paths"]["inputs"].get("competitor_tracker", "data/inputs/Competitor Tracker.csv"))
    competitor_json = exports_dir / "competitorTracker.json"
    sf_json = exports_dir / "salesforceData.json"

    if requested_formats is None and competitor_csv.exists():
        try:
            competitor_stats = export_competitor_tracker(competitor_csv, competitor_json, sf_json=sf_json)
            logger.info("  Competitor Tracker exported: %s", competitor_json.name)
            logger.info("    Total sites: %d", competitor_stats.get("totalSites", 0))
            logger.info("    Sites with coordinates: %d", competitor_stats.get("sitesWithCoords", 0))
            logger.info("    Companies: %d", competitor_stats.get("companiesCount", 0))
            exported_files.setdefault("json", []).append(competitor_json)
        except Exception as e:
            logger.warning("Competitor Tracker export failed: %s", str(e))
    elif requested_formats is None:
        logger.warning("Competitor Tracker CSV not found: %s", competitor_csv)

    # Export substations.json + circuits.json for frontend map layers (full export only)
    if config is not None and requested_formats is None:
        grid_dir = external_dir.parent / "utility_grid"
        try:
            _export_substations_json(grid_dir, exports_dir, logger)
        except Exception as e:
            logger.warning("substations.json export failed: %s", str(e))
        try:
            _export_circuits_json(grid_dir, exports_dir, logger)
        except Exception as e:
            logger.warning("circuits.json export failed: %s", str(e))

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
