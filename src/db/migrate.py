"""
src/db/migrate.py — Database migration runner

Applies SQL migration files in src/db/migrations/ in filename order.
Each file is applied exactly once — already-applied files are skipped.

Usage:
    python -m src.db.migrate
    python -m src.db.migrate --dry-run    # show what would run, don't apply
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from src.db.connection import get_conn
from src.utils.logging_utils import get_logger

MIGRATIONS_DIR = Path(__file__).parent / "migrations"


def run_migrations(dry_run: bool = False) -> None:
    logger = get_logger("migrate")

    migration_files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    if not migration_files:
        logger.info("No migration files found in %s", MIGRATIONS_DIR)
        return

    logger.info("Found %d migration file(s) in %s", len(migration_files), MIGRATIONS_DIR)

    conn = get_conn()
    try:
        cur = conn.cursor()

        # Bootstrap the schema_migrations table if it doesn't exist yet.
        # We can't rely on the migration file for this since it's what tracks migrations.
        cur.execute("""
            CREATE TABLE IF NOT EXISTS schema_migrations (
                filename   TEXT        PRIMARY KEY,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        """)
        conn.commit()

        # Fetch already-applied migrations
        cur.execute("SELECT filename FROM schema_migrations")
        applied = {row["filename"] for row in cur.fetchall()}

        for path in migration_files:
            fname = path.name
            if fname in applied:
                logger.info("  SKIP   %s (already applied)", fname)
                continue

            sql = path.read_text(encoding="utf-8")
            logger.info("  APPLY  %s", fname)

            if dry_run:
                logger.info("  [dry-run] Would execute:\n%s", sql[:500] + ("..." if len(sql) > 500 else ""))
                continue

            cur.execute(sql)
            cur.execute(
                "INSERT INTO schema_migrations (filename) VALUES (%s)", (fname,)
            )
            conn.commit()
            logger.info("  OK     %s", fname)

        logger.info("Migrations complete.")

    except Exception as exc:
        conn.rollback()
        logger.error("Migration failed: %s", exc)
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run database migrations")
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Print SQL that would be applied without executing it"
    )
    args = parser.parse_args()

    try:
        run_migrations(dry_run=args.dry_run)
    except Exception:
        sys.exit(1)
