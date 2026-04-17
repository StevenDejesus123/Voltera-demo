"""
extract_territory_kmz.py — Extract utility service territory polygons from the KMZ

Reads the client-provided National Utility Boundary Map KMZ and writes
individual service_territory.geojson files for each utility that doesn't
already have one sourced from an API.

Currently extracts:
  pge   — PACIFIC GAS & ELECTRIC CO.
  ladwp — LOS ANGELES DEPARTMENT OF WATER & POWER

Usage:
  python -m src.etl.extract_territory_kmz
"""

from __future__ import annotations

import os
import shutil
import tempfile
import zipfile
from pathlib import Path

import geopandas as gpd

from src.utils.logging_utils import get_logger

PROJECT_ROOT = Path(__file__).resolve().parents[2]
KMZ_PATH     = PROJECT_ROOT / "data" / "National Utility Boundary Map.kmz"
GRID_DIR     = PROJECT_ROOT / "data" / "inputs" / "utility_grid"

# Exact Name values in the KMZ for each utility
UTILITY_NAME_FILTERS = {
    "pge":   "Pacific Gas",                         # matches PACIFIC GAS & ELECTRIC CO.
    "ladwp": "Los Angeles Department of Water",     # matches LOS ANGELES DEPARTMENT OF WATER & POWER
}


def main() -> None:
    logger = get_logger("extract_territory_kmz")

    if not KMZ_PATH.exists():
        logger.error("KMZ not found: %s", KMZ_PATH)
        return

    # ── Load KMZ once ─────────────────────────────────────────────────────────
    logger.info("Reading %s …", KMZ_PATH.name)
    with zipfile.ZipFile(KMZ_PATH, "r") as z:
        kml_files = [n for n in z.namelist() if n.lower().endswith(".kml")]
        if not kml_files:
            logger.error("No .kml file found inside the KMZ")
            return
        tmpdir = tempfile.mkdtemp()
        try:
            kml_path = os.path.join(tmpdir, "territory.kml")
            with z.open(kml_files[0]) as src, open(kml_path, "wb") as dst:
                dst.write(src.read())
            gdf = gpd.read_file(kml_path, engine="pyogrio")
        finally:
            shutil.rmtree(tmpdir)

    logger.info("Loaded %d utility territory records", len(gdf))
    name_col = next((c for c in ["Name", "name", "NAME"] if c in gdf.columns), None)
    if not name_col:
        logger.error("No name column found in KMZ")
        return

    # ── Extract and write per utility ─────────────────────────────────────────
    for utility, name_filter in UTILITY_NAME_FILTERS.items():
        out_path = GRID_DIR / utility / "service_territory.geojson"

        if out_path.exists():
            logger.info("[%s] service_territory.geojson already exists — skipping", utility)
            continue

        matches = gdf[gdf[name_col].str.contains(name_filter, case=False, na=False)].copy()

        if matches.empty:
            logger.warning("[%s] No record found matching '%s'", utility, name_filter)
            continue

        logger.info("[%s] Found %d record(s): %s", utility, len(matches),
                    matches[name_col].tolist())

        territory = matches[["geometry"]].copy()
        territory["utility"] = utility
        territory = territory.to_crs("EPSG:4326")

        out_path.parent.mkdir(parents=True, exist_ok=True)
        territory.to_file(out_path, driver="GeoJSON")
        logger.info("[%s] Written: %s (%d feature(s))", utility, out_path, len(territory))

    logger.info("Done.")


if __name__ == "__main__":
    env_path = PROJECT_ROOT / ".env"
    if env_path.exists():
        for _line in env_path.read_text(encoding="utf-8").splitlines():
            _line = _line.strip()
            if _line and not _line.startswith("#") and "=" in _line:
                _k, _, _v = _line.partition("=")
                os.environ.setdefault(_k.strip(), _v.strip())

    main()
