"""
src/db/load_from_geojson.py — Load utility grid data from local GeoJSON files into PostgreSQL.

Use this when the utility API is down or you want to reload without re-fetching.
Reads the existing GeoJSON backup files and upserts into the DB.

Usage:
    python -m src.db.load_from_geojson                  # all utilities
    python -m src.db.load_from_geojson --utility sce
    python -m src.db.load_from_geojson --utility pge
    python -m src.db.load_from_geojson --utility ladwp
    python -m src.db.load_from_geojson --utility sdge
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from src.etl.fetch_utility_grid import (
    NORMALIZERS,
    _get_db_conn,
    _log_fetch,
    _replace_service_territory,
    _upsert_ica_segments,
    _upsert_substations,
)
from src.utils.config_utils import load_config
from src.utils.logging_utils import get_logger

PROJECT_ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH  = PROJECT_ROOT / "config" / "settings.yaml"

UPSERT_FNS = {
    "ica_segments":      _upsert_ica_segments,
    "substations":       _upsert_substations,
    "service_territory": _replace_service_territory,
}

# GeoJSON files on disk are already normalized (saved that way by fetch_utility_grid).
# Re-running the normalizer would look for raw field names that no longer exist and
# produce empty IDs, collapsing all rows into one via ON CONFLICT.
# Always pass through — upsert functions read the standard fields directly.
def _passthrough(features):
    return features


def load_utility(utility: str, grid_dir: Path, conn, logger) -> None:
    # Use layers from NORMALIZERS to know which files to load, but skip re-normalization
    norms    = {k: _passthrough for k in NORMALIZERS.get(utility, {})}
    util_dir = grid_dir / utility

    logger.info("=== Loading %s from GeoJSON files ===", utility.upper())

    for layer_key, norm_fn in norms.items():
        path = util_dir / f"{layer_key}.geojson"
        if not path.exists():
            logger.warning("  SKIP %s/%s — file not found: %s", utility, layer_key, path)
            continue

        logger.info("  Reading %s...", path.name)
        with open(path, encoding="utf-8") as f:
            data = json.load(f)

        raw_features = data.get("features", [])
        if not raw_features:
            logger.warning("  SKIP %s/%s — file is empty", utility, layer_key)
            continue

        logger.info("  %d features read, normalizing...", len(raw_features))
        normalized = norm_fn(raw_features)

        upsert_fn = UPSERT_FNS.get(layer_key)
        if not upsert_fn:
            logger.warning("  No upsert function for layer %s — skipping", layer_key)
            continue

        try:
            n = upsert_fn(normalized, utility, conn, logger)
            _log_fetch(utility, layer_key, n, conn, logger)
        except Exception as exc:
            logger.error("  DB upsert failed for %s/%s: %s", utility, layer_key, exc)
            try:
                conn.rollback()
            except Exception:
                pass

    logger.info("  Done: %s", utility.upper())


def main(utilities: list[str] | None = None) -> None:
    logger = get_logger("load_from_geojson")
    config = load_config(CONFIG_PATH)

    grid_dir = PROJECT_ROOT / config["paths"].get("utility_grid_dir", "data/inputs/utility_grid")

    conn = _get_db_conn()
    if not conn:
        logger.error("No database connection — is DATABASE_URL set in .env?")
        return

    targets = utilities or list(NORMALIZERS.keys())
    for utility in targets:
        if utility not in NORMALIZERS:
            logger.error("Unknown utility '%s'. Valid: %s", utility, list(NORMALIZERS))
            continue
        load_utility(utility, grid_dir, conn, logger)

    conn.close()
    logger.info("=== All done ===")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Load utility grid GeoJSON files into PostgreSQL without re-fetching from APIs"
    )
    parser.add_argument(
        "--utility", type=str, default=None,
        choices=list(NORMALIZERS.keys()),
        help="Utility to load (default: all). Options: " + ", ".join(NORMALIZERS.keys()),
    )
    args = parser.parse_args()
    main(utilities=[args.utility] if args.utility else None)
