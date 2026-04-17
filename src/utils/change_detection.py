from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Tuple, Union


PathLike = Union[str, Path]


def _file_signature(path: Path) -> Dict:
    """
    Return a lightweight fingerprint for a single file.
    Uses size + last modified time (mtime).
    """
    stat = path.stat()
    return {
        "path": str(path),
        "type": "file",
        "size_bytes": int(stat.st_size),
        "mtime_epoch": float(stat.st_mtime),
    }


def _folder_signature(folder: Path, *, include_exts: Tuple[str, ...] = ()) -> Dict:
    """
    Return a fingerprint for a folder based on contained files.
    Uses (relative path, size, mtime) for each included file.

    include_exts:
      - if provided, only includes files with these extensions (case-insensitive)
      - if empty, includes all files
    """
    if not folder.exists():
        raise FileNotFoundError(f"Folder not found: {folder}")
    if not folder.is_dir():
        raise NotADirectoryError(f"Expected folder but got file: {folder}")

    include_exts_lower = tuple(e.lower() for e in include_exts)

    entries: List[Dict] = []
    for p in sorted(folder.rglob("*")):
        if not p.is_file():
            continue
        if include_exts_lower:
            if p.suffix.lower() not in include_exts_lower:
                continue

        stat = p.stat()
        entries.append(
            {
                "rel_path": str(p.relative_to(folder)),
                "size_bytes": int(stat.st_size),
                "mtime_epoch": float(stat.st_mtime),
            }
        )

    # Aggregate a stable signature; keep entries for transparency/debuggability
    total_size = sum(e["size_bytes"] for e in entries)
    latest_mtime = max((e["mtime_epoch"] for e in entries), default=0.0)

    return {
        "path": str(folder),
        "type": "folder",
        "file_count": len(entries),
        "total_size_bytes": int(total_size),
        "latest_mtime_epoch": float(latest_mtime),
        "files": entries,
    }


def compute_watch_fingerprint(
    known_sites_dir: PathLike,
    geofence_dir: PathLike,
    settings_yaml: PathLike,
) -> Dict:
    """
    Compute the full fingerprint for A.3 watched inputs:
      - known-sites folder (all files)
      - geofence-data folder (only .kml/.kmz)
      - settings.yaml file
    """
    known_sites_dir = Path(known_sites_dir)
    geofence_dir = Path(geofence_dir)
    settings_yaml = Path(settings_yaml)

    fp = {
        "computed_at_utc": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "known_sites": _folder_signature(known_sites_dir),
        "geofence": _folder_signature(geofence_dir, include_exts=(".kml", ".kmz")),
        "settings_yaml": _file_signature(settings_yaml),
    }
    return fp


def fingerprints_equal(fp_a: Dict, fp_b: Dict) -> bool:
    """
    Compare two fingerprints ignoring computed_at_utc.
    """
    a = dict(fp_a)
    b = dict(fp_b)
    a.pop("computed_at_utc", None)
    b.pop("computed_at_utc", None)
    return a == b


def load_fingerprint(path: PathLike) -> Dict:
    path = Path(path)
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def save_fingerprint(path: PathLike, fingerprint: Dict) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(fingerprint, f, indent=2)
