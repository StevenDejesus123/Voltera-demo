"""
src/db/connection.py — PostgreSQL connection helpers

Reads DATABASE_URL from environment (set in .env or Railway's injected vars).

Usage:
    from src.db.connection import get_engine, get_conn

    # SQLAlchemy engine — for pandas/geopandas read_sql / read_postgis
    engine = get_engine()
    df = pd.read_sql("SELECT * FROM substations", engine)

    # Raw psycopg2 connection — for bulk upserts via execute_values
    with get_conn() as conn:
        with conn.cursor() as cur:
            execute_values(cur, sql, rows)
        conn.commit()
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

import psycopg2
import psycopg2.extras
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine


# ── Load .env if present (mirrors pattern in fetch_utility_grid.py) ───────────

def _load_dotenv() -> None:
    env_path = Path(__file__).resolve().parents[2] / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip())


_load_dotenv()


# ── Helpers ───────────────────────────────────────────────────────────────────

def _database_url() -> str:
    url = os.environ.get("DATABASE_URL", "")
    if not url:
        raise RuntimeError(
            "DATABASE_URL is not set. Add it to your .env file or Railway "
            "environment variables.\n"
            "Format: postgresql://user:password@host:port/dbname"
        )
    return url


def _sqlalchemy_url(url: str) -> str:
    """Railway uses postgresql:// — SQLAlchemy 2.x requires postgresql+psycopg2://."""
    if url.startswith("postgresql://"):
        return url.replace("postgresql://", "postgresql+psycopg2://", 1)
    return url


# ── Public API ────────────────────────────────────────────────────────────────

@lru_cache(maxsize=1)
def get_engine() -> Engine:
    """
    Return a cached SQLAlchemy engine.
    Use for pandas read_sql() and geopandas read_postgis().
    """
    url = _sqlalchemy_url(_database_url())
    return create_engine(url, pool_pre_ping=True, pool_size=5, max_overflow=10)


def get_conn() -> psycopg2.extensions.connection:
    """
    Return a new psycopg2 connection.
    Caller is responsible for commit/rollback and closing.
    Prefer using as a context manager:

        with get_conn() as conn:   # auto-commits on exit, rolls back on exception
            ...
    """
    return psycopg2.connect(_database_url(), cursor_factory=psycopg2.extras.RealDictCursor)


def check_connection() -> bool:
    """Quick connectivity test. Returns True on success, False on failure."""
    try:
        engine = get_engine()
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return True
    except Exception as exc:
        print(f"Database connection failed: {exc}")
        return False
