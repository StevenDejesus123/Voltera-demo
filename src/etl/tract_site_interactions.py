"""
Tract–site interactions and counts (Step 3.3).

Refactored from tract_site_interactions.ipynb / notebook:
- Load cleaned sites from Step 3.2
- Load tract polygons
- Project both to a metric CRS (EPSG:2163)
- For each radius in miles, compute tract–site pairs via buffer/intersection
- Save Tableau-parity output to staged/
"""

from __future__ import annotations

from pathlib import Path
from typing import Tuple

import pandas as pd
import geopandas as gpd

from src.utils.io_utils import read_csv
from src.utils.logging_utils import get_logger


# Miles → meters conversion for buffers
MI_TO_M = 1609.34


def run_tract_site_interactions(config: dict) -> str:
    """
    Run ETL Step 3.3: Tract–site interaction counts.

    Parameters
    ----------
    config : dict
        Loaded YAML config.

    Returns
    -------
    str
        Path to the output CSV with tract–site interactions.
    """
    logger = get_logger("tract_site_interactions")
    logger.info("Starting Step 3.3 - Tract–Site Interactions")

    # --------------------------
    # Resolve paths from config
    # --------------------------
    staged_dir = Path(config["paths"]["staged"])
    spatial_dir = Path(config["paths"]["inputs"]["spatial"])

    # Input files
    sites_input = staged_dir / config["filenames"]["cleaned_sites_refactored"]
    tract_shp = spatial_dir / "Tract.shp"

    # Output files
    output_file = staged_dir / config["filenames"]["tract_site_interactions_refactored"]

    # -----------------------------------------
    # 0) Validate critical inputs exist
    # -----------------------------------------
    if not sites_input.exists():
        logger.error(f"[tract_site_interactions] Cleaned sites file not found: {sites_input}")
        raise FileNotFoundError(
            f"[tract_site_interactions] Cleaned sites file not found: {sites_input}"
        )

    if not tract_shp.exists():
        logger.error(f"[tract_site_interactions] Tract shapefile not found: {tract_shp}")
        raise FileNotFoundError(
            f"[tract_site_interactions] Tract shapefile not found: {tract_shp}"
        )

    # -----------------------------------------
    # 1) Load cleaned sites + schema validation
    # -----------------------------------------
    logger.info(f"Loading cleaned sites from: {sites_input}")
    df_sites = read_csv(sites_input)

    required_site_cols = ["Index_ID", "Latitude", "Longitude"]
    missing_site = [c for c in required_site_cols if c not in df_sites.columns]
    if missing_site:
        logger.error(
            f"[tract_site_interactions] Missing required column(s) in cleaned sites: {missing_site}"
        )
        raise KeyError(
            f"[tract_site_interactions] Missing required column(s) in cleaned sites: {missing_site}"
        )

    # Coerce coordinates to numeric so bad strings become NaN and are dropped below
    df_sites["Latitude"] = pd.to_numeric(df_sites["Latitude"], errors="coerce")
    df_sites["Longitude"] = pd.to_numeric(df_sites["Longitude"], errors="coerce")

    if df_sites["Index_ID"].isna().all():
        logger.error("[tract_site_interactions] All Index_ID values are missing in cleaned sites.")
        raise ValueError(
            "[tract_site_interactions] Index_ID must be populated for tract–site interactions."
        )

    # Drop rows without coordinates 
    before = len(df_sites)
    df_sites = df_sites[df_sites["Latitude"].notna() & df_sites["Longitude"].notna()]
    logger.info(
        f"Dropped {before - len(df_sites)} rows with missing/invalid coordinates. "
        f"Remaining: {len(df_sites)}"
    )

    if len(df_sites) == 0:
        logger.error(
            "[tract_site_interactions] No site rows remain after filtering invalid coordinates."
        )
        raise ValueError(
            "[tract_site_interactions] No valid sites remain (Latitude/Longitude missing or invalid)."
        )

    # Convert to GeoDataFrame in WGS84 (EPSG:4326)
    gdf_sites = gpd.GeoDataFrame(
        df_sites,
        geometry=gpd.points_from_xy(df_sites["Longitude"], df_sites["Latitude"]),
        crs="EPSG:4326",
    )
    logger.info(f"Sites GeoDataFrame created: {len(gdf_sites)} rows, CRS={gdf_sites.crs}")

    # -----------------------------------------
    # 2) Load Tract shapefile + validation
    # -----------------------------------------
    logger.info(f"Loading Tract shapefile from: {tract_shp}")
    gdf_tracts = gpd.read_file(tract_shp)
    logger.info(f"Tracts loaded: {len(gdf_tracts)} rows, CRS={gdf_tracts.crs}")

    if "GEOID" not in gdf_tracts.columns:
        logger.error("[tract_site_interactions] Expected column 'GEOID' in Tract shapefile.")
        raise KeyError("[tract_site_interactions] Expected column 'GEOID' in Tract shapefile.")

    if "geometry" not in gdf_tracts.columns:
        logger.error("[tract_site_interactions] Tract shapefile missing 'geometry' column.")
        raise KeyError("[tract_site_interactions] Tract shapefile missing 'geometry' column.")

    # Ensure CRS exists before projection
    if gdf_tracts.crs is None:
        logger.error(
            "[tract_site_interactions] Tract shapefile has no CRS defined; cannot safely project."
        )
        raise ValueError(
            "[tract_site_interactions] Tract shapefile must have a defined CRS."
        )

    # Drop empty geometries (warn, then proceed)
    empty_geom = gdf_tracts["geometry"].isna() | gdf_tracts["geometry"].is_empty
    if empty_geom.any():
        logger.warning(
            f"[tract_site_interactions] Dropping {int(empty_geom.sum())} tracts with empty geometry."
        )
        gdf_tracts = gdf_tracts.loc[~empty_geom].copy()

    if len(gdf_tracts) == 0:
        logger.error("[tract_site_interactions] No valid tract geometries remain after filtering.")
        raise ValueError(
            "[tract_site_interactions] Tract geometries are empty after filtering invalid geometry."
        )

    # -----------------------------------------
    # 3) Project both layers to metric CRS
    # -----------------------------------------
    target_crs = "EPSG:2163"  # US National Atlas Equal Area (meters)
    logger.info(f"Projecting sites and tracts to {target_crs} for distance buffers")

    gdf_sites_m = gdf_sites.to_crs(target_crs)
    gdf_tracts_m = gdf_tracts.to_crs(target_crs)

    logger.info(
        f"Projected CRS - sites: {gdf_sites_m.crs}, tracts: {gdf_tracts_m.crs}"
    )

    # -----------------------------------------
    # 4) Helper: one radius --> pairs + counts
    # -----------------------------------------
    def intersect_pairs_with_count(miles: float) -> Tuple[pd.DataFrame, pd.DataFrame]:
        """
        For a given radius in miles:
        - create Buffer around the sites
        - Spatially join tracts with those buffers
        - Deduplicate (Geoid, Index_ID) pairs
        - Compute count of distinct sites per (Cover_Range, Geoid)
        - Attach that count to every pair row
        """
        logger.info(f"Computing tract–site pairs for radius={miles} miles")

        buf = gdf_sites_m.copy()
        buf["geom_buf"] = buf.geometry.buffer(MI_TO_M * miles)

        # Spatial join: left = tracts (geometry), right = site buffers
        pairs = (
            gpd.sjoin(
                gdf_tracts_m[["GEOID", "geometry"]],
                buf.set_geometry("geom_buf")[["Index_ID", "geom_buf"]],
                how="inner",
                predicate="intersects",
            )
            .drop_duplicates(subset=["GEOID", "Index_ID"])
            .rename(columns={"GEOID": "Geoid"})
        )

        logger.info(
            f"Pairs for radius={miles} miles after dedupe: {len(pairs)} (unique Geoid, Index_ID)"
        )

        # Tableau-style fields
        pairs["Cover_Range"] = round(miles)
        pairs["Geometry"] = pairs.geometry.geom_type

        pairs = pairs[["Cover_Range", "Geoid", "Index_ID", "Geometry"]]

        # COUNTD(Index_ID) per (Cover_Range, Geoid)
        counts = (
            pairs.groupby(["Cover_Range", "Geoid"])["Index_ID"]
            .nunique()
            .reset_index(name="Count_Tract_Interact_Site_Range")
        )

        # Merge count back onto each pair row
        pairs_tbl = pairs.merge(
            counts, on=["Cover_Range", "Geoid"], how="left"
        )[["Cover_Range", "Geoid", "Index_ID", "Geometry", "Count_Tract_Interact_Site_Range"]]

        return pairs_tbl, counts

    # -----------------------------------------
    # 5) Loop over all radii and combine
    # -----------------------------------------
    radii = [0.0005, 1, 2, 3, 5, 25, 75, 100]
    pairs_all: list[pd.DataFrame] = []

    for r in radii:
        pairs_r, _ = intersect_pairs_with_count(r)
        logger.info(f"Radius={r} miles --> {len(pairs_r)} pairs")
        if len(pairs_r) == 0:
            logger.warning(
                f"[tract_site_interactions] No pairs produced for radius={r} miles."
            )
        pairs_all.append(pairs_r)

    if not pairs_all:
        logger.error("[tract_site_interactions] No tract–site pairs were generated.")
        raise RuntimeError("[tract_site_interactions] No tract–site pairs were generated.")

    tract_site_int = pd.concat(pairs_all, ignore_index=True)

    if len(tract_site_int) == 0:
        logger.error(
            "[tract_site_interactions] tract_site_int is empty after combining all radii."
        )
        raise RuntimeError(
            "[tract_site_interactions] No tract–site pairs were generated (empty output)."
        )

    # Ensure column order is exactly as expected (Tableau parity)
    expected_cols = [
        "Cover_Range",
        "Geoid",
        "Index_ID",
        "Geometry",
        "Count_Tract_Interact_Site_Range",
    ]
    missing_out = [c for c in expected_cols if c not in tract_site_int.columns]
    if missing_out:
        logger.error(
            f"[tract_site_interactions] Output missing expected columns: {missing_out}"
        )
        raise KeyError(
            f"[tract_site_interactions] Output missing expected columns: {missing_out}"
        )
    tract_site_int = tract_site_int[expected_cols]

    tract_site_int = tract_site_int.sort_values(
        ["Cover_Range", "Geoid", "Index_ID"]
    ).reset_index(drop=True)

    logger.info(
        f"Combined tract–site interactions: {len(tract_site_int)} rows "
        f"across radii={radii}"
    )

    # -----------------------------------------
    # 6) Save output
    # -----------------------------------------
    output_file.parent.mkdir(parents=True, exist_ok=True)
    tract_site_int.to_csv(output_file, index=False)

    logger.info(
        f"Step 3.3 complete. Saved tract–site interactions to: {output_file} "
        f"(Rows: {len(tract_site_int):,})"
    )

    return str(output_file)
