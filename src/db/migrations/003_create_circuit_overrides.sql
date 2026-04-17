-- Migration 003: circuit_overrides table
-- Stores analyst-corrected load availability, PV hosting, and voltage values for ICA circuits.

CREATE TABLE IF NOT EXISTS circuit_overrides (
    id              SERIAL PRIMARY KEY,
    utility         TEXT        NOT NULL,
    circuit_name    TEXT        NOT NULL,
    load_avail_kw   NUMERIC,
    pv_hosting_kw   NUMERIC,
    voltage_kv      NUMERIC,
    notes           TEXT,
    last_verified   DATE,
    updated_by      TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (utility, circuit_name)
);

CREATE INDEX IF NOT EXISTS circuit_overrides_utility_idx ON circuit_overrides (utility);
