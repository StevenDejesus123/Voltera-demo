# src/etl/geofence_etl.py

from __future__ import annotations

from pathlib import Path
from zipfile import ZipFile
import io
import re
from typing import Dict, Sequence

import pandas as pd
import geopandas as gpd

from src.utils.logging_utils import get_logger

LOGGER_NAME = "geofence_etl"
logger = get_logger(LOGGER_NAME)

# Mapping from lowercase vendor tokens in filenames to Interested Party
KNOWN_PARTIES: Dict[str, str] = {
    "uber": "Uber",
    "waymo": "Waymo",
    "zoox": "Zoox",
    "moove": "Moove",
}

def _require_file(path: Path, context: str) -> None:
    """Fail fast if an expected input file is missing."""
    if not path.exists():
        logger.error("[%s] Missing required input file: %s", context, path)
        raise FileNotFoundError(f"[{context}] Missing required input file: {path}")


def _require_dir(path: Path, context: str) -> None:
    """Fail fast if an expected input directory is missing."""
    if not path.exists() or not path.is_dir():
        logger.error("[%s] Missing required input directory: %s", context, path)
        raise FileNotFoundError(f"[{context}] Missing required input directory: {path}")


def _require_columns(df: pd.DataFrame, required: Sequence[str], context: str) -> None:
    """Validate required columns exist before downstream transformations."""
    missing = [c for c in required if c not in df.columns]
    if missing:
        logger.error("[%s] Missing required columns: %s", context, missing)
        raise KeyError(f"[{context}] Missing required columns: {missing}")


def read_geofence_file(path: Path) -> gpd.GeoDataFrame:
    """
    Read a single .kml or .kmz geofence file into a GeoDataFrame.

    - .kml: read directly
    - .kmz: unzip in memory and read the internal .kml
    Adds a Tableau-style 'Table_Name' column based on the filename.
    """
    _require_file(path, "read_geofence_file")

    suffix = path.suffix.lower()

    # Case 1: direct KML
    if suffix == ".kml":
        logger.info("Reading KML geofence: %s", path.name)
        gdf = gpd.read_file(path)

    # Case 2: KMZ → open ZIP → extract .kml in memory
    elif suffix == ".kmz":
        logger.info("Reading KMZ geofence: %s", path.name)
        with ZipFile(path, "r") as z:
            # List all items inside KMZ and find the first .kml
            kml_names = [n for n in z.namelist() if n.lower().endswith(".kml")]
            if not kml_names:
                logger.error("No .kml found inside KMZ file: %s", path)
                raise ValueError(f"No .kml found inside KMZ file: {path}")

            if len(kml_names) > 1:
                logger.warning(
                    "KMZ contains multiple .kml files; using first: %s (all=%s)",
                    kml_names[0],
                    kml_names,
                )

            kml_name = kml_names[0]

            # Load KML file directly from memory as bytes
            with z.open(kml_name) as kml_file:
                kml_bytes = kml_file.read()
                if not kml_bytes:
                    logger.error(
                        "Extracted .kml entry is empty inside KMZ: %s (entry=%s)",
                        path,
                        kml_name,
                    )
                    raise ValueError(f"Empty .kml found inside KMZ file: {path} (entry={kml_name})")

                gdf = gpd.read_file(io.BytesIO(kml_bytes))

    else:
        logger.error("Unsupported geofence file type: %s", path)
        raise ValueError(f"Unsupported file type: {path}")

    if gdf is None or len(gdf) == 0:
        logger.error("Geofence file produced no features: %s", path)
        raise ValueError(f"Geofence file produced no features: {path}")

    if "geometry" not in gdf.columns:
        logger.error("Geofence file missing geometry column: %s", path)
        raise KeyError(f"Geofence file missing geometry column: {path}")

    # Add source filename to mimic Legacy Tableau's "Table Name"
    gdf["Table_Name"] = path.name

    # Normalize optional KML name fields across kml variations
    # Some KMLs expose 'name' (lowercase) or no name field at all.
    if "Name" not in gdf.columns:
        if "name" in gdf.columns:
            gdf = gdf.rename(columns={"name": "Name"})
        else:
            # Default to the filename-derived Table_Name for stability
            gdf["Name"] = gdf["Table_Name"]

    # Clean up types/whitespace
    gdf["Name"] = gdf["Name"].fillna(gdf["Table_Name"]).astype(str).str.strip()

    return gdf


def infer_interested_party(table_name: str) -> str:
    """Infer 'Interested Party' from the filename (Table_Name)."""
    name = table_name.lower()

    # 1) Check against known vendors (extensible in one place)
    for key, party in KNOWN_PARTIES.items():
        if key in name:
            return party

    # 2) Fallback: extract any capitalized word in the original filename
    caps = re.findall(r"[A-Z][a-zA-Z0-9]+", table_name)
    if caps:
        return caps[0]

    # 3) Final fallback
    return "Unknown"


def _resolve_paths(config: dict) -> tuple[Path, Path, Path]:
    """
    Resolve geofence input dir, tract shapefile, and staged output dir
    from config/settings.yaml.
    """
    sites_dir = Path(config["paths"]["inputs"]["sites"])
    spatial_dir = Path(config["paths"]["inputs"]["spatial"])
    staged_dir = Path(config["paths"]["staged"])

    geofence_dir = sites_dir / "geofence-data"
    tract_path = spatial_dir / "Tract.shp"

    return geofence_dir, tract_path, staged_dir


def run_geofence(config: dict) -> str:
    """
    Run Section 4 Geofence ETL.

    Steps:
    - Read all customer-provided KML/KMZ geofence files
    - Reproject to tract CRS and explode multipolygons
    - Spatial join tracts <--> geofences (intersects)
    - Rename GEOID --> Tract_GeoID
    - Add derived columns and save tract-level geofence output to staged folder.

    Returns
    -------
    str
        Path to the final Excel file with tract-level geofence features.
    """

    logger.info("Starting geofence ETL")

    geofence_dir, tract_path, staged_dir = _resolve_paths(config)

    _require_dir(geofence_dir, str(geofence_dir))
    _require_file(tract_path, str(tract_path))

    if "filenames" not in config or "geofence_tracts" not in config["filenames"]:
        raise KeyError("[geofence_etl] Missing config['filenames']['geofence_tracts']")

    logger.info("Geofence directory: %s", geofence_dir)
    logger.info("Tract shapefile: %s", tract_path)

    # ------------------------------------------------------------------
    # 1. Load all geofence KML/KMZ files
    # ------------------------------------------------------------------
    geofence_gdfs: list[gpd.GeoDataFrame] = []

    for path in sorted(geofence_dir.iterdir()):
        if path.suffix.lower() not in {".kml", ".kmz"}:
            continue

        logger.info("Loading geofence file: %s", path.name)
        gdf = read_geofence_file(path)
        geofence_gdfs.append(gdf)

    if not geofence_gdfs:
        raise RuntimeError(f"No KML/KMZ files found in {geofence_dir}")

    geofences_all = gpd.GeoDataFrame(
        pd.concat(geofence_gdfs, ignore_index=True),
        crs=geofence_gdfs[0].crs,
    )

    _require_columns(geofences_all, ["Table_Name", "geometry"], "geofences_all")

    # Drop empty geometries (warn, then proceed)
    empty_geo = geofences_all["geometry"].isna() | geofences_all["geometry"].is_empty
    if empty_geo.any():
        logger.warning(
            "[geofences_all] Dropping %d rows with empty geometry.",
            int(empty_geo.sum()),
        )
        geofences_all = geofences_all.loc[~empty_geo].copy()

    if len(geofences_all) == 0:
        raise ValueError("[geofences_all] No valid geofence geometries remain after filtering empty rows.")

    logger.info("Finished loading geofences")
    logger.info("Geofences CRS: %s", geofences_all.crs)
    logger.info("Total geofence rows: %d", len(geofences_all))
    logger.info(
        "Unique files (Table_Name): %d",
        geofences_all["Table_Name"].nunique(),
    )
    logger.debug("Geofence columns: %s", list(geofences_all.columns))

    # Preserve all geometry types (polygons and points) to match current Tableau output
    geofences_poly = geofences_all.copy()

    geofences_poly["geom_type"] = geofences_poly.geometry.geom_type

    logger.info("Total geofence rows retained: %d", len(geofences_poly))
    logger.debug(
        "Counts by file and geom_type:\n%s",
        geofences_poly.groupby("Table_Name")["geom_type"].value_counts(),
    )

    # ------------------------------------------------------------------
    # 2. Load tract shapefile and align CRS
    # ------------------------------------------------------------------
    tracts = gpd.read_file(tract_path)
    _require_columns(tracts, ["GEOID", "geometry"], str(tract_path))

    # Drop empty tract geometries (warn, then proceed)
    empty_t = tracts["geometry"].isna() | tracts["geometry"].is_empty
    if empty_t.any():
        logger.warning(
            "[%s] Dropping %d tracts with empty geometry.",
            tract_path,
            int(empty_t.sum()),
        )
        tracts = tracts.loc[~empty_t].copy()

    if len(tracts) == 0:
        raise ValueError(f"[{tract_path}] Tract shapefile has no valid geometries after filtering empty rows.")

    if tracts.crs is None:
        raise ValueError(f"[{tract_path}] Tract shapefile has no CRS defined; cannot safely intersect geofences.")

    logger.info("Loaded tracts: rows=%d, CRS=%s", len(tracts), tracts.crs)

    # KML is typically EPSG:4326; if CRS is missing, assume WGS84 and continue
    if geofences_poly.crs is None:
        logger.warning("[geofences] CRS is undefined. Assuming EPSG:4326 (WGS84).")
        geofences_poly = geofences_poly.set_crs(epsg=4326, allow_override=True)

    # Reproject geofences to match tract CRS
    geofences_poly_tract_crs = geofences_poly.to_crs(tracts.crs)
    logger.info(
        "Reprojected geofences to tract CRS. New CRS: %s",
        geofences_poly_tract_crs.crs,
    )

    # Explode multipolygons so each geometry piece is a separate row
    geofences_poly_tract_crs_exp = geofences_poly_tract_crs.explode(ignore_index=True)
    logger.info(
        "Geofences before explode: %d, after explode: %d",
        len(geofences_poly_tract_crs),
        len(geofences_poly_tract_crs_exp),
    )

    # Prepare minimal columns needed from each layer
    tracts_for_join = tracts[["GEOID", "geometry"]].copy()

    _require_columns(
        geofences_poly_tract_crs_exp,
        ["Table_Name", "geometry"],
        "geofences_poly_tract_crs_exp",
    )

    # 'Name' should exist due to normalization in read_geofence_file, but default again defensively if any future path bypasses it.
    if "Name" not in geofences_poly_tract_crs_exp.columns:
        geofences_poly_tract_crs_exp["Name"] = geofences_poly_tract_crs_exp["Table_Name"]

    geofences_for_join = geofences_poly_tract_crs_exp[["Name", "Table_Name", "geometry"]].copy()

    # Spatial join: which tracts intersect which geofence geometries
    logger.info("Performing spatial join between tracts and geofences")
    tract_geofence_join = gpd.sjoin(
        tracts_for_join,
        geofences_for_join,
        how="inner",
        predicate="intersects",
    )

    if len(tract_geofence_join) == 0:
        raise ValueError(
            "[geofence_etl] Spatial join produced 0 rows. Common causes: CRS mismatch, "
            "empty/invalid geofences, or incorrect tract boundaries."
        )

    # Rename GEOID to Tract_GeoID
    tract_geofence_join = tract_geofence_join.rename(columns={"GEOID": "Tract_GeoID"})
    logger.info("Joined rows: %d", len(tract_geofence_join))

    # ------------------------------------------------------------------
    # 3. Build final geo features table
    # ------------------------------------------------------------------
    geo = tract_geofence_join.copy()

    # Interested Party extraction from Table_Name
    geo["Interested Party"] = geo["Table_Name"].apply(infer_interested_party)

    # Constant columns (aligned with existing Tableau outputs)
    geo["Site-Type"] = "Customer Interest"
    geo["Customer Segment"] = "AV"
    geo["Range_Cover"] = 0
    geo["Count Customer Sites"] = 1
    geo["Total_Stalls_Filled"] = 37.5

    # index_right came from sjoin; no longer needed in final table
    if "index_right" in geo.columns:
        geo = geo.drop(columns=["index_right"])

    # Number of distinct tracts per (Table_Name, Name) geometry
    geo["Tracts_Per_Polygon"] = geo.groupby(["Table_Name", "Name"])["Tract_GeoID"].transform("nunique")

    # Number of distinct tracts per geofence file
    geo["Tracts_Per_table"] = geo.groupby("Table_Name")["Tract_GeoID"].transform("nunique")

    cols = [
        "Tract_GeoID",
        "Site-Type",
        "Customer Segment",
        "Interested Party",
        "Range_Cover",
        "Count Customer Sites",
        "Total_Stalls_Filled",
        "Table_Name",
        "Name",
        "Tracts_Per_table",
        "Tracts_Per_Polygon",
    ]

    _require_columns(geo, cols, "geo_final_build")
    geo_final = geo[cols].copy()
    logger.info("Final geofence tract table shape: %s", geo_final.shape)

    if len(geo_final) == 0:
        raise ValueError("[geofence_etl] Final geofence tract table is empty; upstream join produced no usable rows.")

    # ------------------------------------------------------------------
    # 4. Save to staged folder
    # ------------------------------------------------------------------
    out_filename = config["filenames"]["geofence_tracts"]
    out_path = staged_dir / out_filename

    out_path.parent.mkdir(parents=True, exist_ok=True)
    geo_final.to_excel(out_path, index=False)

    logger.info(
        "Saved geofence tract file: %s (rows=%d)",
        out_path.resolve(),
        len(geo_final),
    )

    return str(out_path)
