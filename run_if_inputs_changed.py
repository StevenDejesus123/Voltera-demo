from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from datetime import datetime

from src.utils.config_utils import load_config
from src.utils.logging_utils import get_logger
from src.utils.change_detection import (
    compute_watch_fingerprint,
    fingerprints_equal,
    load_fingerprint,
    save_fingerprint,
)

# ---------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------
def main() -> int:
    logger = get_logger("run_if_inputs_changed")

    logger.info("")
    logger.info("=" * 86)
    logger.info(f"=== Phase3 End-to-End Pipeline/ML Automation | {datetime.utcnow():%Y-%m-%d %H:%M:%S}Z ===")
    logger.info("=" * 86)

    # -----------------------------------------------------------------
    # Load configuration
    # -----------------------------------------------------------------
    #config = load_config()
    config = load_config("config/settings.yaml")


    known_sites_dir = Path(config["paths"]["inputs"]["known_sites_dir"])
    geofence_dir = Path(config["paths"]["inputs"]["geofence_dir"])
    settings_yaml = Path("config/settings.yaml")

    state_dir = Path("data/state")
    fingerprint_path = state_dir / "last_run_fingerprint.json"

    logger.info("Watching inputs:")
    logger.info(f"  Known-sites folder : {known_sites_dir}")
    logger.info(f"  Geofence folder    : {geofence_dir}")
    logger.info(f"  Settings file      : {settings_yaml}")
    logger.info("-" * 86)

    # -----------------------------------------------------------------
    # Compute current fingerprint
    # -----------------------------------------------------------------
    current_fp = compute_watch_fingerprint(
        known_sites_dir=known_sites_dir,
        geofence_dir=geofence_dir,
        settings_yaml=settings_yaml,
    )

    previous_fp = load_fingerprint(fingerprint_path)

    # -----------------------------------------------------------------
    # Compare fingerprints
    # -----------------------------------------------------------------
    if previous_fp and fingerprints_equal(previous_fp, current_fp):
        logger.info("No input changes detected. Skipping full refresh.")
        logger.info("=" * 86)
        logger.info("")
        return 0

    logger.info("Input changes detected. Triggering full refresh.")
    logger.info("=" * 86)
    # -----------------------------------------------------------------
    # Execute full pipeline
    # -----------------------------------------------------------------
    start_ts = datetime.utcnow()
    result = subprocess.run(
        [sys.executable, "run_full_refresh.py"],
        capture_output=False,
    )

    if result.returncode != 0:
        logger.error("Full refresh failed. Fingerprint will NOT be updated.")
        logger.info("=" * 86)
        logger.info("")
        return result.returncode

    # -----------------------------------------------------------------
    # Persist fingerprint after successful run
    # -----------------------------------------------------------------
    save_fingerprint(fingerprint_path, current_fp)

    elapsed = (datetime.utcnow() - start_ts).total_seconds()
    logger.info(f"Full refresh completed successfully in {elapsed:.1f}s")
    logger.info("Fingerprint updated.")
    logger.info("=" * 86)
    logger.info("")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
