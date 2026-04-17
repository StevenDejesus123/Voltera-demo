"""
src/api/main.py — FastAPI backend for Phase 3 EV Site Selection

Serves utility grid data from PostgreSQL and persists substation overrides.

Endpoints:
  GET  /api/substations              — all substations from DB
  GET  /api/overrides                — all substation overrides
  PUT  /api/overrides/{id}           — create or update an override
  DELETE /api/overrides/{id}         — remove an override

Run:
  uvicorn src.api.main:app --reload --port 8000

The Vite dev server proxies /api/substations and /api/overrides to this server.
"""

from __future__ import annotations

from datetime import date
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from src.db.connection import get_engine

app = FastAPI(title="Phase 3 EV Site Selection API", version="1.0.0")

# Allow the Vite dev server (port 3000) to call this API
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:5173"],
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["*"],
)


# ── Models ────────────────────────────────────────────────────────────────────

class SubstationOverride(BaseModel):
    capacityMw:    Optional[float] = None
    voltageKv:     Optional[float] = None
    notes:         Optional[str]   = None
    lastVerified:  Optional[str]   = None   # ISO date string e.g. "2026-04-16"
    updatedBy:     Optional[str]   = None


class CircuitOverride(BaseModel):
    loadAvailKw:   Optional[float] = None
    pvHostingKw:   Optional[float] = None
    voltageKv:     Optional[float] = None
    notes:         Optional[str]   = None
    lastVerified:  Optional[str]   = None
    updatedBy:     Optional[str]   = None


# ── Substations ───────────────────────────────────────────────────────────────

@app.get("/api/substations")
def get_substations():
    """
    Return all substations from the database.
    Merges any saved overrides on top of the raw values before returning.
    """
    import pandas as pd

    engine = get_engine()

    substations = pd.read_sql(
        """
        SELECT
            s.utility || '_' || s.substation_id   AS id,
            s.utility,
            s.substation_name                      AS name,
            s.substation_voltage_kv                AS voltageKv,
            s.remaining_capacity_mw                AS capacityMw,
            s.lat,
            s.lng
        FROM substations s
        WHERE s.lat IS NOT NULL AND s.lng IS NOT NULL
        ORDER BY s.utility, s.substation_name
        """,
        engine,
    )

    overrides = pd.read_sql(
        "SELECT substation_id, capacity_mw, voltage_kv, notes, last_verified, updated_by FROM substation_overrides",
        engine,
    ).set_index("substation_id")

    records = []
    for row in substations.itertuples(index=False):
        rec = {
            "id":         row.id,
            "utility":    row.utility,
            "name":       row.name,
            "voltageKv":  float(row.voltageKv)  if row.voltageKv  is not None else None,
            "capacityMw": float(row.capacityMw) if row.capacityMw is not None else None,
            "lat":        float(row.lat),
            "lng":        float(row.lng),
            "hasOverride": False,
        }
        if row.id in overrides.index:
            ov = overrides.loc[row.id]
            if ov.capacity_mw is not None:
                rec["capacityMw"] = float(ov.capacity_mw)
            if ov.voltage_kv is not None:
                rec["voltageKv"] = float(ov.voltage_kv)
            rec["hasOverride"]          = True
            rec["overrideNotes"]        = ov.notes
            rec["overrideLastVerified"] = str(ov.last_verified) if ov.last_verified else None
        records.append(rec)

    return records


# ── Overrides ─────────────────────────────────────────────────────────────────

@app.get("/api/overrides")
def get_overrides():
    """Return all substation overrides as a {substation_id: override} map."""
    import pandas as pd

    engine = get_engine()
    df = pd.read_sql(
        "SELECT substation_id, capacity_mw, voltage_kv, notes, last_verified, updated_by FROM substation_overrides",
        engine,
    )

    result = {}
    for row in df.itertuples(index=False):
        result[row.substation_id] = {
            "capacityMw":   float(row.capacity_mw)   if row.capacity_mw   is not None else None,
            "voltageKv":    float(row.voltage_kv)    if row.voltage_kv    is not None else None,
            "notes":        row.notes,
            "lastVerified": str(row.last_verified)   if row.last_verified else None,
            "updatedBy":    row.updated_by,
        }
    return result


@app.put("/api/overrides/{substation_id}")
def upsert_override(substation_id: str, override: SubstationOverride):
    """Create or update an override for a substation."""
    from sqlalchemy import text

    engine = get_engine()

    last_verified = None
    if override.lastVerified:
        try:
            last_verified = date.fromisoformat(override.lastVerified)
        except ValueError:
            pass

    with engine.begin() as conn:
        conn.execute(
            text("""
                INSERT INTO substation_overrides
                    (substation_id, capacity_mw, voltage_kv, notes, last_verified, updated_by, updated_at)
                VALUES
                    (:sid, :cap, :volt, :notes, :lv, :by, now())
                ON CONFLICT (substation_id) DO UPDATE SET
                    capacity_mw   = EXCLUDED.capacity_mw,
                    voltage_kv    = EXCLUDED.voltage_kv,
                    notes         = EXCLUDED.notes,
                    last_verified = EXCLUDED.last_verified,
                    updated_by    = EXCLUDED.updated_by,
                    updated_at    = now()
            """),
            {
                "sid":   substation_id,
                "cap":   override.capacityMw,
                "volt":  override.voltageKv,
                "notes": override.notes,
                "lv":    last_verified,
                "by":    override.updatedBy,
            },
        )

    return {"status": "ok", "id": substation_id}


@app.delete("/api/overrides/{substation_id}")
def delete_override(substation_id: str):
    """Remove an override for a substation."""
    from sqlalchemy import text

    engine = get_engine()
    with engine.begin() as conn:
        result = conn.execute(
            text("DELETE FROM substation_overrides WHERE substation_id = :sid"),
            {"sid": substation_id},
        )
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Override not found")

    return {"status": "ok", "id": substation_id}


# ── Circuit Overrides ─────────────────────────────────────────────────────────
# Circuit override ID format (from frontend): "{utility}::{circuit_name}"

@app.get("/api/overrides/circuits")
def get_circuit_overrides():
    """Return all circuit overrides as {id: override} map. ID = 'utility::circuit_name'."""
    import pandas as pd

    engine = get_engine()
    df = pd.read_sql(
        "SELECT utility, circuit_name, load_avail_kw, pv_hosting_kw, voltage_kv, notes, last_verified, updated_by FROM circuit_overrides",
        engine,
    )

    result = {}
    for row in df.itertuples(index=False):
        key = f"{row.utility}::{row.circuit_name}"
        result[key] = {
            "loadAvailKw":  float(row.load_avail_kw) if row.load_avail_kw is not None else None,
            "pvHostingKw":  float(row.pv_hosting_kw) if row.pv_hosting_kw is not None else None,
            "voltageKv":    float(row.voltage_kv)    if row.voltage_kv    is not None else None,
            "notes":        row.notes,
            "lastVerified": str(row.last_verified)   if row.last_verified else None,
            "updatedBy":    row.updated_by,
        }
    return result


@app.put("/api/overrides/circuits/{override_id:path}")
def upsert_circuit_override(override_id: str, override: CircuitOverride):
    """Create or update a circuit override. override_id = 'utility::circuit_name'."""
    from sqlalchemy import text

    if "::" not in override_id:
        raise HTTPException(status_code=400, detail="override_id must be 'utility::circuit_name'")
    utility, circuit_name = override_id.split("::", 1)

    last_verified = None
    if override.lastVerified:
        try:
            last_verified = date.fromisoformat(override.lastVerified)
        except ValueError:
            pass

    engine = get_engine()
    with engine.begin() as conn:
        conn.execute(
            text("""
                INSERT INTO circuit_overrides
                    (utility, circuit_name, load_avail_kw, pv_hosting_kw, voltage_kv,
                     notes, last_verified, updated_by, updated_at)
                VALUES
                    (:utility, :cn, :lkw, :pkw, :volt, :notes, :lv, :by, now())
                ON CONFLICT (utility, circuit_name) DO UPDATE SET
                    load_avail_kw = EXCLUDED.load_avail_kw,
                    pv_hosting_kw = EXCLUDED.pv_hosting_kw,
                    voltage_kv    = EXCLUDED.voltage_kv,
                    notes         = EXCLUDED.notes,
                    last_verified = EXCLUDED.last_verified,
                    updated_by    = EXCLUDED.updated_by,
                    updated_at    = now()
            """),
            {
                "utility": utility,
                "cn":      circuit_name,
                "lkw":     override.loadAvailKw,
                "pkw":     override.pvHostingKw,
                "volt":    override.voltageKv,
                "notes":   override.notes,
                "lv":      last_verified,
                "by":      override.updatedBy,
            },
        )

    return {"status": "ok", "id": override_id}


@app.delete("/api/overrides/circuits/{override_id:path}")
def delete_circuit_override(override_id: str):
    """Remove a circuit override. override_id = 'utility::circuit_name'."""
    from sqlalchemy import text

    if "::" not in override_id:
        raise HTTPException(status_code=400, detail="override_id must be 'utility::circuit_name'")
    utility, circuit_name = override_id.split("::", 1)

    engine = get_engine()
    with engine.begin() as conn:
        result = conn.execute(
            text("DELETE FROM circuit_overrides WHERE utility = :utility AND circuit_name = :cn"),
            {"utility": utility, "cn": circuit_name},
        )
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Override not found")

    return {"status": "ok", "id": override_id}


# ── Health check ──────────────────────────────────────────────────────────────

@app.get("/api/health")
def health():
    return {"status": "ok"}


# ── Production static file serving ───────────────────────────────────────────
# In development the Vite dev server handles /data/exports/* and serves the
# React app.  In production (Railway) FastAPI takes over both responsibilities.
# These mounts must come AFTER all /api/* routes so the SPA catch-all never
# intercepts API calls.

from pathlib import Path  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from fastapi.responses import FileResponse  # noqa: E402

_ROOT         = Path(__file__).resolve().parent.parent.parent
_BUILD        = _ROOT / "build"
_DATA_EXPORTS = _ROOT / "data" / "exports"

# Pre-computed data exports (JSON / GeoJSON / CSV / ZIP)
if _DATA_EXPORTS.exists():
    app.mount("/data/exports", StaticFiles(directory=str(_DATA_EXPORTS)), name="data-exports")

# Vite build output
if _BUILD.exists():
    # Hashed asset files produced by Vite (JS / CSS bundles)
    _ASSETS = _BUILD / "assets"
    if _ASSETS.exists():
        app.mount("/assets", StaticFiles(directory=str(_ASSETS)), name="vite-assets")

    @app.get("/{full_path:path}")
    def serve_spa(full_path: str):
        """SPA fallback — serve exact file if it exists, otherwise index.html."""
        target = _BUILD / full_path
        if target.exists() and target.is_file():
            return FileResponse(str(target))
        return FileResponse(str(_BUILD / "index.html"))
