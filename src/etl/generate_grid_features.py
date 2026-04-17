"""
generate_grid_features.py — Phase 3.4 Utility Grid Feature Engineering

Spatial-joins the downloaded utility grid GeoJSON files onto census-tract
centroids to produce one feature row per tract.

Features produced
─────────────────
  nearest_subst_dist_m      — metres to nearest substation (any utility)
  nearest_subst_name        — substation name
  nearest_subst_cap_mw      — remaining capacity MW  (NaN if unavailable)
  nearest_subst_voltage_kv  — primary voltage kV    (NaN if unavailable)
  nearest_subst_utility     — "sce" | "pge" | "sdge" | ""
  nearest_ica_dist_m        — metres to nearest ICA line section (any utility)
  nearest_ica_load_kw       — load hosting capacity kW (NaN if unavailable)
  nearest_ica_pv_kw         — PV  hosting capacity kW  (NaN if unavailable)
  nearest_ica_utility       — "sce" | "pge" | "ladwp" | "sdge" | ""
  in_sce_territory          — 1 if tract centroid inside SCE territory, else 0
  in_pge_territory          — 1 if tract centroid inside PG&E territory, else 0
  in_sdge_territory         — 1 if tract centroid inside SDG&E territory, else 0

Output
──────
  data/inputs/utility_grid/grid_features_tract.csv

Usage
─────
  python -m src.etl.generate_grid_features
  python -m src.etl.generate_grid_features --skip-territory
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
from shapely.geometry import Point

from src.utils.config_utils import load_config
from src.utils.logging_utils import get_logger


# ─────────────────────────────────────────────────────────────────────────────
# Database layer loaders (used when DATABASE_URL is set)
# ─────────────────────────────────────────────────────────────────────────────

def _geojson_to_gdf(df: pd.DataFrame, geom_col: str = "geometry_geojson") -> gpd.GeoDataFrame:
    """
    Convert a DataFrame with a GeoJSON geometry column (string or dict)
    into a GeoDataFrame. Uses Shapely's shape() for reconstruction.
    """
    import json as _json
    from shapely.geometry import shape

    def _parse(g):
        if g is None:
            return None
        if isinstance(g, str):
            g = _json.loads(g)
        try:
            return shape(g)
        except Exception:
            return None

    geometries = df[geom_col].apply(_parse)
    gdf = gpd.GeoDataFrame(df.drop(columns=[geom_col]), geometry=geometries, crs="EPSG:4326")
    return gdf[gdf.geometry.notna()].reset_index(drop=True)


def _load_ica_from_db(logger) -> gpd.GeoDataFrame | None:
    """
    Load all ICA segments from PostgreSQL.
    Geometry stored as JSONB — reconstructed into Shapely objects in Python.
    Returns None if the DB is unavailable or the table is empty.
    """
    try:
        from src.db.connection import get_engine
        engine = get_engine()
        logger.info("  Reading ica_segments from database...")
        df = pd.read_sql(
            """
            SELECT
                utility,
                section_id,
                circuit_name,
                circuit_voltage_kv,
                load_hosting_capacity_kw,
                pv_hosting_capacity_kw,
                geometry_geojson::text AS geometry_geojson
            FROM ica_segments
            WHERE geometry_geojson IS NOT NULL
            """,
            engine,
        )
        if df.empty:
            logger.warning("  ica_segments table is empty — falling back to GeoJSON files")
            return None
        logger.info("  Loaded %d ICA segments from database, reconstructing geometries...", len(df))
        gdf = _geojson_to_gdf(df)
        logger.info("  %d valid geometries after reconstruction", len(gdf))
        return gdf
    except Exception as exc:
        logger.warning("  DB read failed for ica_segments (%s) — falling back to GeoJSON", exc)
        return None


def _load_substations_from_db(logger) -> gpd.GeoDataFrame | None:
    """
    Load all substations from PostgreSQL.
    Returns None if the DB is unavailable or the table is empty.
    """
    try:
        from src.db.connection import get_engine
        engine = get_engine()
        logger.info("  Reading substations from database...")
        df = pd.read_sql(
            """
            SELECT
                utility,
                substation_id,
                substation_name,
                substation_voltage_kv,
                remaining_capacity_mw,
                geometry_geojson::text AS geometry_geojson
            FROM substations
            WHERE geometry_geojson IS NOT NULL
            """,
            engine,
        )
        if df.empty:
            logger.warning("  substations table is empty — falling back to GeoJSON files")
            return None
        logger.info("  Loaded %d substations from database", len(df))
        return _geojson_to_gdf(df)
    except Exception as exc:
        logger.warning("  DB read failed for substations (%s) — falling back to GeoJSON", exc)
        return None


def _load_territory_from_db(utility: str, logger) -> gpd.GeoDataFrame | None:
    """
    Load service territory polygons for one utility from PostgreSQL.
    Returns None if unavailable.
    """
    try:
        from src.db.connection import get_engine
        engine = get_engine()
        df = pd.read_sql(
            "SELECT geometry_geojson::text AS geometry_geojson FROM service_territories WHERE utility = %(utility)s",
            engine,
            params={"utility": utility},
        )
        if df.empty:
            return None
        gdf = _geojson_to_gdf(df)
        logger.info("  Loaded %d territory polygons for %s from database", len(gdf), utility.upper())
        return gdf
    except Exception as exc:
        logger.warning("  DB read failed for %s territory (%s)", utility, exc)
        return None


def _use_db() -> bool:
    """Return True if DATABASE_URL is set and the DB connection module is available."""
    try:
        from src.db.connection import check_connection
        return bool(os.environ.get("DATABASE_URL")) and check_connection()
    except Exception:
        return False

# ── Project paths ──────────────────────────────────────────────────────────────

PROJECT_ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH  = PROJECT_ROOT / "config" / "settings.yaml"

# Projected CRS for accurate meter distances (Albers Equal Area — CONUS)
PROJ_CRS = "EPSG:5070"

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _load_geojson(path: Path, logger) -> gpd.GeoDataFrame | None:
    """Load a GeoJSON file, returning None (with warning) if missing or empty."""
    if not path.exists():
        logger.warning("  File not found, skipping: %s", path)
        return None
    try:
        gdf = gpd.read_file(path)
        if gdf.empty:
            logger.warning("  Empty GeoJSON, skipping: %s", path)
            return None
        logger.info("  Loaded %d features from %s", len(gdf), path.name)
        return gdf
    except Exception as exc:
        logger.warning("  Failed to read %s: %s — skipping", path.name, exc)
        return None


def _combine_layers(parts: list[gpd.GeoDataFrame | None]) -> gpd.GeoDataFrame | None:
    """Concatenate non-None GeoDataFrames; return None if all are None.
    Reprojects all parts to EPSG:4326 before concat to avoid CRS mismatch."""
    valid = [p for p in parts if p is not None]
    if not valid:
        return None
    # Normalize all to WGS84 so concat doesn't fail on mixed CRS
    valid = [p.to_crs("EPSG:4326") if p.crs is not None else p for p in valid]
    if len(valid) == 1:
        return valid[0].reset_index(drop=True)
    return pd.concat(valid, ignore_index=True)


def _nearest_join(
    centroids: gpd.GeoDataFrame,
    targets: gpd.GeoDataFrame,
    prefix: str,
    col_map: dict[str, str],
) -> pd.DataFrame:
    """
    sjoin_nearest between projected centroids (points) and targets.

    Returns a DataFrame indexed like `centroids` with columns:
        {prefix}_dist_m   — distance in metres
        {prefix}_{col}    — for each (src_col -> dest_col) in col_map
    """
    # Ensure same CRS
    targets_proj = targets.to_crs(PROJ_CRS)

    joined = gpd.sjoin_nearest(
        centroids[["geometry"]],
        targets_proj,
        how="left",
        distance_col=f"{prefix}_dist_m",
        max_distance=None,
    )

    # Keep only the first match per tract (sjoin_nearest can produce duplicates
    # when multiple features are equidistant)
    joined = joined[~joined.index.duplicated(keep="first")]

    result = pd.DataFrame(index=centroids.index)
    result[f"{prefix}_dist_m"] = joined[f"{prefix}_dist_m"]

    for src_col, dest_col in col_map.items():
        result[f"{prefix}_{dest_col}"] = joined.get(src_col, np.nan)

    return result


def _territory_flags_from_gdf(
    centroids: gpd.GeoDataFrame,
    territory_gdf: gpd.GeoDataFrame,
    utility_name: str,
    logger,
) -> pd.Series:
    """
    Same as _territory_flags but accepts an already-loaded GeoDataFrame
    (used when reading from the database instead of a file).
    """
    col_name = f"in_{utility_name}_territory"
    territory_proj = territory_gdf.to_crs(PROJ_CRS)
    joined = gpd.sjoin(
        centroids[["geometry"]],
        territory_proj[["geometry"]],
        how="left",
        predicate="within",
    )
    in_territory = ~joined["index_right"].isna()
    in_territory = in_territory.groupby(level=0).any()
    result = in_territory.reindex(centroids.index).fillna(False).astype(int)
    result.name = col_name
    n_in = result.sum()
    logger.info(
        "  %s territory: %d / %d tracts inside (%.1f%%)",
        utility_name.upper(), n_in, len(centroids), 100 * n_in / max(len(centroids), 1),
    )
    return result


def _territory_flags(
    centroids: gpd.GeoDataFrame,
    territory_path: Path,
    utility_name: str,
    logger,
) -> pd.Series:
    """
    Returns a 0/1 Series (indexed like centroids) indicating whether each
    centroid falls inside any polygon in the territory file.
    """
    col_name = f"in_{utility_name}_territory"
    gdf = _load_geojson(territory_path, logger)
    if gdf is None:
        logger.warning("  No territory data for %s — column set to 0", utility_name)
        return pd.Series(0, index=centroids.index, name=col_name)

    territory_proj = gdf.to_crs(PROJ_CRS)
    joined = gpd.sjoin(
        centroids[["geometry"]],
        territory_proj[["geometry"]],
        how="left",
        predicate="within",
    )
    # Any row that survived the join is within the territory
    in_territory = ~joined["index_right"].isna()
    # De-duplicate (centroid could match multiple territory polygons)
    in_territory = in_territory.groupby(level=0).any()
    result = in_territory.reindex(centroids.index).fillna(False).astype(int)
    result.name = col_name

    n_in = result.sum()
    logger.info(
        "  %s territory: %d / %d tracts inside (%.1f%%)",
        utility_name.upper(), n_in, len(centroids), 100 * n_in / max(len(centroids), 1),
    )
    return result


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def main(skip_territory: bool = False, no_db: bool = False) -> None:
    logger = get_logger("generate_grid_features")
    config = load_config(CONFIG_PATH)

    spatial_dir   = PROJECT_ROOT / config["paths"]["inputs"]["spatial"]
    grid_dir      = PROJECT_ROOT / config["paths"].get("utility_grid_dir", "data/inputs/utility_grid")
    output_path   = PROJECT_ROOT / config["paths"].get(
        "grid_features_tract", "data/inputs/utility_grid/grid_features_tract.csv"
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # ── 1. Load tract shapefile and compute projected centroids ───────────────
    logger.info("=== Loading tract shapefile ===")
    tracts_raw = gpd.read_file(spatial_dir / "Tract.shp")
    logger.info("  %d tracts loaded (CRS: %s)", len(tracts_raw), tracts_raw.crs)

    # Standardise ID column
    tract_id_col = "GEOID" if "GEOID" in tracts_raw.columns else tracts_raw.columns[0]
    logger.info("  Using tract ID column: %s", tract_id_col)

    tracts_proj = tracts_raw[[tract_id_col, "geometry"]].to_crs(PROJ_CRS).copy()
    tracts_proj["geometry"] = tracts_proj.geometry.centroid
    tracts_proj = tracts_proj.rename(columns={tract_id_col: "tract_id"})
    tracts_proj = tracts_proj.set_index("tract_id")

    logger.info("  Centroids computed in %s", PROJ_CRS)

    # ── 2. Load utility grid data (DB preferred, GeoJSON fallback) ───────────
    logger.info("=== Loading utility grid data ===")

    utilities = ["sce", "pge", "ladwp", "sdge"]
    use_database = (not no_db) and _use_db()

    if use_database:
        logger.info("  Source: PostgreSQL (DATABASE_URL is set)")
        combined_ica   = _load_ica_from_db(logger)
        combined_subst = _load_substations_from_db(logger)
        # Fall through to GeoJSON for any layer that came back None
        if combined_ica is None or combined_subst is None:
            logger.info("  Partial DB load — supplementing with GeoJSON files")
    else:
        combined_ica   = None
        combined_subst = None

    if not use_database or combined_ica is None:
        logger.info("  Source: GeoJSON files (ica_segments)")
        ica_parts: list[gpd.GeoDataFrame | None] = []
        for util in utilities:
            ica_parts.append(_load_geojson(grid_dir / util / "ica_segments.geojson", logger))
        combined_ica = _combine_layers(ica_parts)

    if not use_database or combined_subst is None:
        logger.info("  Source: GeoJSON files (substations)")
        subst_parts: list[gpd.GeoDataFrame | None] = []
        for util in utilities:
            subst_parts.append(_load_geojson(grid_dir / util / "substations.geojson", logger))
        combined_subst = _combine_layers(subst_parts)

    # ── 3. Nearest-substation join ────────────────────────────────────────────
    result = pd.DataFrame(index=tracts_proj.index)

    if combined_subst is not None and not combined_subst.empty:
        logger.info("=== Nearest-substation spatial join (%d substations) ===", len(combined_subst))

        # Reproject to PROJ_CRS — centroids already in PROJ_CRS
        combined_subst_proj = combined_subst.to_crs(PROJ_CRS)

        subst_features = _nearest_join(
            centroids=tracts_proj,
            targets=combined_subst_proj,
            prefix="nearest_subst",
            col_map={
                "substation_name":       "name",
                "remaining_capacity_mw": "cap_mw",
                "substation_voltage_kv": "voltage_kv",
                "utility":               "utility",
            },
        )
        result = result.join(subst_features)
        logger.info(
            "  Nearest-substation join complete. "
            "Median distance: %.0f m  Max: %.0f m",
            result["nearest_subst_dist_m"].median(),
            result["nearest_subst_dist_m"].max(),
        )
    else:
        logger.warning("No substation data available — substation columns will be empty")
        for col in ("nearest_subst_dist_m", "nearest_subst_name",
                    "nearest_subst_cap_mw", "nearest_subst_voltage_kv",
                    "nearest_subst_utility"):
            result[col] = np.nan

    # ── 4. Nearest-ICA-segment join ───────────────────────────────────────────
    if combined_ica is not None and not combined_ica.empty:
        logger.info("=== Nearest-ICA-segment spatial join (%d segments) ===", len(combined_ica))

        combined_ica_proj = combined_ica.to_crs(PROJ_CRS)

        ica_features = _nearest_join(
            centroids=tracts_proj,
            targets=combined_ica_proj,
            prefix="nearest_ica",
            col_map={
                "load_hosting_capacity_kw": "load_kw",
                "pv_hosting_capacity_kw":   "pv_kw",
                "circuit_name":             "circuit_name",
                "circuit_voltage_kv":       "voltage_kv",
                "utility":                  "utility",
            },
        )
        result = result.join(ica_features)
        logger.info(
            "  Nearest-ICA join complete. "
            "Median distance: %.0f m  Max: %.0f m",
            result["nearest_ica_dist_m"].median(),
            result["nearest_ica_dist_m"].max(),
        )
    else:
        logger.warning("No ICA segment data available — ICA columns will be empty")
        for col in ("nearest_ica_dist_m", "nearest_ica_load_kw",
                    "nearest_ica_pv_kw", "nearest_ica_circuit_name",
                    "nearest_ica_voltage_kv", "nearest_ica_utility"):
            result[col] = np.nan

    # ── 5. Service-territory flags ────────────────────────────────────────────
    if not skip_territory:
        logger.info("=== Service territory flags ===")
        for util in utilities:
            # Try DB first, fall back to GeoJSON file
            terr_gdf = _load_territory_from_db(util, logger) if use_database else None
            if terr_gdf is not None:
                flag = _territory_flags_from_gdf(tracts_proj, terr_gdf, util, logger)
            else:
                terr_path = grid_dir / util / "service_territory.geojson"
                flag = _territory_flags(tracts_proj, terr_path, util, logger)
            result[flag.name] = flag
    else:
        logger.info("=== Skipping territory flags (--skip-territory) ===")
        for util in utilities:
            result[f"in_{util}_territory"] = np.nan

    # ── 6. Round distances for readability ───────────────────────────────────
    for col in result.columns:
        if col.endswith("_dist_m"):
            result[col] = result[col].round(1)
        elif col.endswith(("_kw", "_mw", "_kv")):
            result[col] = result[col].round(3)

    # ── 7. Reset index, set tract_id column, write CSV ────────────────────────
    result = result.reset_index()   # tract_id back as column
    logger.info("=== Writing output ===")
    logger.info("  Rows: %d  Columns: %d", len(result), len(result.columns))
    logger.info("  Path: %s", output_path)

    result.to_csv(output_path, index=False)

    # Quick coverage summary
    if "nearest_subst_dist_m" in result.columns:
        n_covered = result["nearest_subst_dist_m"].notna().sum()
        logger.info(
            "  Substation coverage: %d / %d tracts (%.1f%%)",
            n_covered, len(result), 100 * n_covered / max(len(result), 1),
        )
    if "nearest_ica_dist_m" in result.columns:
        n_ica = result["nearest_ica_dist_m"].notna().sum()
        logger.info(
            "  ICA segment coverage: %d / %d tracts (%.1f%%)",
            n_ica, len(result), 100 * n_ica / max(len(result), 1),
        )

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
        description="Spatial-join utility grid data onto tract centroids"
    )
    parser.add_argument(
        "--skip-territory",
        action="store_true",
        default=False,
        help="Skip the service-territory point-in-polygon join (faster, no territory flags)",
    )
    parser.add_argument(
        "--no-db",
        action="store_true",
        default=False,
        help="Force GeoJSON file loading even if DATABASE_URL is set. "
             "Use this for the spatial join step — loading 2.6M rows from DB is slower than files.",
    )
    args = parser.parse_args()
    main(skip_territory=args.skip_territory, no_db=args.no_db)
