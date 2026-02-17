#!/usr/bin/env python3
"""
CLI wrapper for the project's export module.
- Uses logging consistent with project conventions
- Supports flags or interactive prompts
- Headless batch mode via --yes
- If regions omitted -> export all available (regions=None)
"""
from __future__ import annotations

import argparse

import json
import logging
import os
from pathlib import Path
from typing import Dict, List, Optional

from src.exports.export_rankings import run_exports

# Configure module logger; higher-level app can reconfigure as needed.
LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(level=LOG_LEVEL, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("export_cli")

ALLOWED_GEOS = {"msa": "MSA", "county": "County", "tract": "Tract"}
ALLOWED_FORMATS = {"csv", "excel", "geojson", "kml", "kmz"}

root_dir = Path.cwd().parents[1]
DEFAULT_EXPORT_DIR = root_dir / "data" / "exports"

def parse_regions_arg(raw: Optional[str]) -> List[str]:
    if not raw:
        return []
    raw = raw.strip()
    if raw.startswith("@"):
        path = Path(raw[1:])
        if not path.exists():
            raise FileNotFoundError(f"Regions file not found: {path}")
        with path.open("r", encoding="utf-8") as fh:
            return [line.strip() for line in fh if line.strip()]
    return [r.strip() for r in raw.split(",") if r.strip()]


def interactive_choice(prompt_text: str, default: Optional[str] = None) -> str:
    try:
        val = input(f"{prompt_text} " + (f"[{default}] " if default else ""))
    except EOFError:
        # Non-interactive stdin; return default
        return default or ""
    return val.strip() or (default or "")



def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(description="Export ML ranking results (CLI).")
    p.add_argument("-g", "--geography", help="Geography: msa|county|tract")
    p.add_argument(
        "-r",
        "--regions",
        help="Comma-separated region IDs or @path/to/file (one ID per line). Omit to export all.",
    )
    p.add_argument(
        "-f",
        "--format",
        help="Output format: csv|excel|geojson|kml|kmz",
    )
    p.add_argument("-o", "--output-dir", help="Output directory for exported files")
    p.add_argument(
        "-i",
        "--ranking-file",
        help="Path to persisted ML ranking workbook (xlsx). If omitted, uses configured default.",
    )
    p.add_argument(
        "-y",
        "--yes",
        action="store_true",
        dest="headless",
        help="Headless mode: do not prompt; required flags must be provided",
    )
    args = p.parse_args(argv)

    geography = args.geography
    if not geography and not args.headless:
        geography = interactive_choice("Select geography (msa/county/tract):", "msa")
    if not geography:
        p.error("geography is required in headless mode (--yes)")

    geography_key = geography.lower()
    if geography_key not in ALLOWED_GEOS:
        p.error(f"Invalid geography: {geography}. Allowed: msa, county, tract")
    geography = ALLOWED_GEOS[geography_key]

    regions: Optional[List[str]] = parse_regions_arg(args.regions) if args.regions else []
    if not regions and not args.headless:
        raw = interactive_choice("Enter region IDs (comma-separated) or blank for all:", "")
        regions = parse_regions_arg(raw)
    # empty -> export all
    if not regions:
        regions = None

    fmt = args.format
    if not fmt and not args.headless:
        fmt = interactive_choice("Output format (csv|excel|geojson|kml|kmz):", "csv")
    if not fmt:
        p.error("format is required in headless mode (--yes)")
    fmt = fmt.lower()
    if fmt not in ALLOWED_FORMATS:
        p.error(f"Invalid format: {fmt}")

    outdir = Path(args.output_dir) if args.output_dir else DEFAULT_EXPORT_DIR
    outdir.mkdir(parents=True, exist_ok=True)

    ranking_file = args.ranking_file or ""
    if not ranking_file and not args.headless:
        ranking_file = interactive_choice("Path to ranking workbook (xlsx) or blank to use default:", "")

    opts: Dict = {
        "geography": geography,
        "regions": regions,
        "format": fmt,
        "output_dir": str(outdir),
        "ranking_file": ranking_file,
        "headless": bool(args.headless),
    }

    logger.info("Starting export: geography=%s format=%s regions=%s output=%s", geography, fmt, ("ALL" if regions is None else regions), outdir)

    try:
        logger.info("Invoking in-repo export function")
        res = run_exports(cli_opts=opts)
        if isinstance(res, dict):
            logger.info("Export metadata:\n%s", json.dumps(res, indent=2))
        logger.info("Export completed successfully")
        return 0
    except Exception:
        logger.exception("Export function failed")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
