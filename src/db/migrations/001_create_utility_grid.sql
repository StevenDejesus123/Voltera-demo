-- ============================================================
-- 001_create_utility_grid.sql
-- Phase 3 EV Site Selection — Utility Grid Schema
--
-- Run via:  python -m src.db.migrate
--
-- No PostGIS required. Geometry is stored as JSONB (GeoJSON format).
-- All spatial operations (sjoin_nearest, territory flags) happen in
-- Python via GeoPandas / Shapely, not in the database.
-- ============================================================


-- ── fetch_log ────────────────────────────────────────────────────────────────
-- Tracks every fetch run so you can see when each utility was last refreshed
-- and how many rows were loaded.

CREATE TABLE IF NOT EXISTS fetch_log (
    id          SERIAL PRIMARY KEY,
    utility     TEXT        NOT NULL,
    layer       TEXT        NOT NULL,   -- 'ica_segments' | 'substations' | 'service_territory'
    fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    row_count   INTEGER,
    notes       TEXT
);


-- ── ica_segments ─────────────────────────────────────────────────────────────
-- One row per ICA line segment.
-- geometry_geojson stores the GeoJSON geometry object as JSONB.
-- county_fips is populated by src/db/assign_county_fips.py after each fetch.

CREATE TABLE IF NOT EXISTS ica_segments (
    id                       SERIAL PRIMARY KEY,
    utility                  TEXT    NOT NULL,   -- 'sce' | 'pge' | 'ladwp' | 'sdge'
    section_id               TEXT    NOT NULL,   -- source system ID (unique per utility)
    circuit_name             TEXT,
    substation_name          TEXT,
    circuit_voltage_kv       NUMERIC,
    load_hosting_capacity_kw NUMERIC,
    pv_hosting_capacity_kw   NUMERIC,
    conductor_type           TEXT,
    county_fips              TEXT,               -- pre-computed; NULL until assign_county_fips runs
    geometry_geojson         JSONB,              -- GeoJSON geometry object e.g. {"type":"LineString","coordinates":[...]}
    fetched_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ica_segments_utility_section_id_key UNIQUE (utility, section_id)
);

CREATE INDEX IF NOT EXISTS idx_ica_segments_utility
    ON ica_segments (utility);

CREATE INDEX IF NOT EXISTS idx_ica_segments_county
    ON ica_segments (county_fips);

CREATE INDEX IF NOT EXISTS idx_ica_segments_load_kw
    ON ica_segments (load_hosting_capacity_kw);


-- ── substations ──────────────────────────────────────────────────────────────
-- One row per substation point.
-- lat/lng stored as plain numerics for easy filtering; full geometry as JSONB.

CREATE TABLE IF NOT EXISTS substations (
    id                    SERIAL PRIMARY KEY,
    utility               TEXT    NOT NULL,
    substation_id         TEXT    NOT NULL,
    substation_name       TEXT,
    substation_voltage_kv NUMERIC,
    remaining_capacity_mw NUMERIC,
    lat                   NUMERIC,
    lng                   NUMERIC,
    geometry_geojson      JSONB,
    fetched_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT substations_utility_substation_id_key UNIQUE (utility, substation_id)
);

CREATE INDEX IF NOT EXISTS idx_substations_utility
    ON substations (utility);


-- ── service_territories ──────────────────────────────────────────────────────
-- Territory boundary polygons. Replaced wholesale on each fetch (no UNIQUE key).

CREATE TABLE IF NOT EXISTS service_territories (
    id               SERIAL PRIMARY KEY,
    utility          TEXT NOT NULL,
    geometry_geojson JSONB,
    fetched_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_territories_utility
    ON service_territories (utility);


-- ── schema_migrations ────────────────────────────────────────────────────────
-- Tracks which migration files have been applied so migrate.py is idempotent.

CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   TEXT        PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
