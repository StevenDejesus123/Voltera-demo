#from __future__ import annotations

import json
import shutil
from datetime import datetime
from pathlib import Path
from typing import Dict, Iterable, Optional, Union, List

PathLike = Union[str, Path]


def _ensure_dir(p: Path) -> None:
    p.mkdir(parents=True, exist_ok=True)


def _copy_files(files: Iterable[Path], dest_dir: Path) -> List[str]:
    """
    Copy files into dest_dir preserving timestamps (copy2).
    Hard-fails if any file is missing to avoid partial archives.
    Returns list of filenames copied.
    """
    _ensure_dir(dest_dir)

    copied: List[str] = []
    for f in files:
        f = Path(f)
        if not f.exists():
            raise FileNotFoundError(f"Archive source file not found: {f}")
        if f.is_dir():
            raise IsADirectoryError(f"Expected file but got directory: {f}")

        shutil.copy2(f, dest_dir / f.name)
        copied.append(f.name)

    return copied


def archive_run_outputs(
    archive_root: PathLike,
    run_id: str,
    ranking_files: Iterable[PathLike],
    model_files: Iterable[PathLike],
    *,
    extra_metadata: Optional[Dict] = None,
) -> Dict[str, str]:
    """
    Create an immutable archive snapshot for a completed run.

    Layout:
      <archive_root>/<run_id>/
        rankings/
        models/
        run_metadata.json

    Call only after a successful end-to-end run.
    """
    archive_root = Path(archive_root)
    run_dir = archive_root / run_id
    rankings_dir = run_dir / "rankings"
    models_dir = run_dir / "models"
    metadata_path = run_dir / "run_metadata.json"

    _ensure_dir(rankings_dir)
    _ensure_dir(models_dir)

    ranking_files = [Path(p) for p in ranking_files]
    model_files = [Path(p) for p in model_files]

    copied_rankings = _copy_files(ranking_files, rankings_dir)
    copied_models = _copy_files(model_files, models_dir)

    metadata = {
        "run_id": run_id,
        "archived_at_utc": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "archive_root": str(archive_root),
        "run_dir": str(run_dir),
        "rankings": {"count": len(copied_rankings), "files": copied_rankings},
        "models": {"count": len(copied_models), "files": copied_models},
    }
    if extra_metadata:
        metadata["extra"] = extra_metadata

    with metadata_path.open("w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2)

    return {
        "run_id": run_id,
        "run_dir": str(run_dir),
        "rankings_dir": str(rankings_dir),
        "models_dir": str(models_dir),
        "metadata_path": str(metadata_path),
    }
