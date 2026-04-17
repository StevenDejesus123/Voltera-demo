-- ============================================================
-- 002_create_overrides.sql
-- Substation override values — persisted per substation ID.
-- Replaces the browser localStorage approach so overrides are
-- shared across all users and sessions.
-- ============================================================

CREATE TABLE IF NOT EXISTS substation_overrides (
    substation_id   TEXT        PRIMARY KEY,
    capacity_mw     NUMERIC,
    voltage_kv      NUMERIC,
    notes           TEXT,
    last_verified   DATE,
    updated_by      TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
