# run_full_refresh.py

from pathlib import Path
from datetime import datetime

from src.utils.config_utils import load_config
from src.utils.logging_utils import get_logger

from src.etl.cleanup_sitedata import run_cleanup_sitedata
from src.etl.tract_site_interactions import run_tract_site_interactions
from src.etl.aggregations import run_aggregations
from src.etl.external_data_tracts import run_external_data_tracts
from src.etl.external_data_counties import run_external_data_counties
from src.etl.external_data_msa import run_external_data_msa
from src.etl.geofence_etl import run_geofence   # or geofence_tracts if you named it that
from src.ml.train_rankings import run_training
from src.utils.archive_utils import archive_run_outputs #new
from src.exports.export_rankings import run_exports  # Phase 3.2: Export generation

SEP = "=" * 96
SUBSEP = "-" * 96


def log_banner(logger, title: str) -> None:
    logger.info("")  # spacer between runs
    logger.info(SEP)
    logger.info("=== %s ===", title)
    logger.info(SEP)


def log_step(logger, step_title: str) -> None:
    logger.info("")  # spacer between steps
    logger.info(SUBSEP)
    logger.info("%s", step_title)
    logger.info(SUBSEP)
    
def main() -> None:
    logger = get_logger("run_full_refresh")

    start_ts = datetime.now()
    run_id = start_ts.strftime("%Y%m%d_%H%M%S")

    log_banner(logger, f"Starting FULL REFRESH pipeline | Run ID: {run_id}")
    logger.info("Working directory: %s", Path.cwd())

    # 1. Load config
    config_path = Path("config/settings.yaml")
    if not config_path.exists():
        raise FileNotFoundError(f"[run_full_refresh] Config not found: {config_path.resolve()}")

    config = load_config(config_path)
    logger.info("Step 3.1 - Loaded config from: %s", config_path)

    # 2. 3.2 – cleanup / combine sites
    log_step(logger, "Step 3.2 — cleaning/combining site data...")
    run_cleanup_sitedata(config)
    logger.info("Step 3.2 complete.")

    # 3. 3.3 – tract–site spatial interactions
    log_step(logger, "Step 3.3 — tract–site spatial interactions...")
    run_tract_site_interactions(config)
    logger.info("Step 3.3 complete.")

    # 4. 3.4 – aggregations
    log_step(logger, "Step 3.4 — aggregations (tract/county/msa)...")
    run_aggregations(config)
    logger.info("Step 3.4 complete.")

    # 5. 3.5 – external data joins
    log_step(logger, "Step 3.5 — external data integration (tract)...")
    run_external_data_tracts(config)
    logger.info("Step 3.5 tract complete.")

    log_step(logger, "Step 3.5 — external data integration (county)...")
    run_external_data_counties(config)
    logger.info("Step 3.5 county complete.")

    log_step(logger, "Step 3.5 — external data integration (msa)...")
    run_external_data_msa(config)
    logger.info("Step 3.5 msa complete.")

    # 6. Section 4 – geofence ETL
    log_step(logger, "Section 4 — geofence tract intersections...")
    run_geofence(config)
    logger.info("Section 4 geofence ETL complete.")

    # 7. ML – training & rankings
    log_step(logger, "ML — training MSA/county/tract ranking models...")
    training_result = run_training(config)
    logger.info("ML training complete. Summary: %s", training_result)

    # 8. Phase 3.2 – Export generation (CSV, Excel, GeoJSON, KML/KMZ)
    log_step(logger, "Phase 3.2 — generating export artifacts...")
    export_result = run_exports(config)
    logger.info("Export generation complete. Files: %d", export_result["total_files"])

    # 9. Archive outputs (rankings + models + exports) for this run
    archive_root = Path(config["paths"]["archive_root"])
    outputs_root = Path(config["paths"]["outputs"])

    ml_outputs_cfg = config.get("ml", {}).get("ml_outputs", {})

    # Rankings: prefer single combined workbook (new); fall back to per-level files (legacy)
    ranking_files = []
    rankings_workbook = ml_outputs_cfg.get("rankings_workbook")
    if rankings_workbook:
        ranking_files = [outputs_root / rankings_workbook]
    else:
        for level in ["msa", "county", "tract"]:
            level_cfg = ml_outputs_cfg.get(level, {})
            ranking_name = level_cfg.get("ranking")
            if not ranking_name:
                raise KeyError(
                    f"[run_full_refresh] Missing ml.ml_outputs.rankings_workbook "
                    f"and missing ml.ml_outputs.{level}.ranking in settings.yaml"
                )
            ranking_files.append(outputs_root / ranking_name)

    # Models: one file per level
    model_files = []
    for level in ["msa", "county", "tract"]:
        level_cfg = ml_outputs_cfg.get(level, {})
        model_name = level_cfg.get("model")
        if not model_name:
            raise KeyError(
                f"[run_full_refresh] Missing ml.ml_outputs.{level}.model in settings.yaml"
            )
        model_files.append(outputs_root / model_name)

    logger.info("Archiving ranking/model outputs to: %s/%s", archive_root.as_posix(), run_id)

    archive_info = archive_run_outputs(
        archive_root=archive_root,
        run_id=run_id,
        ranking_files=ranking_files,
        model_files=model_files,
        extra_metadata={
            "config_path": "config/settings.yaml",
            "training_summary": training_result,
            "exports": export_result,
        },
    )

    logger.info(
        "Archive complete. Run dir: %s; metadata: %s",
        archive_info["run_dir"],
        archive_info["metadata_path"],
    )


    end_ts = datetime.now()
    elapsed = (end_ts - start_ts).total_seconds() / 60.0
    
    logger.info("")
    logger.info(SEP)
    logger.info("=== FULL REFRESH completed successfully in %.2f minutes ===", elapsed)
    logger.info(SEP)

if __name__ == "__main__":
    logger = get_logger("run_full_refresh")
    try:
        main()
    except Exception:
        logger.exception("FULL REFRESH failed with an unhandled exception.")
        raise
