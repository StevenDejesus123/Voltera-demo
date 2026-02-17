# Phase 3 — EV Site Selection Pipeline

## Overview
This repository contains the **Phase 3 production pipeline** for Voltera’s EV site selection and ranking system.  
Phase 3 delivers a **fully automated, Python-based ETL and ML ranking workflow**, replacing Tableau Prep–based processing and enabling deterministic, repeatable execution across Tract, County, and MSA geographies.

The system is designed as a **production batch pipeline**, optimized for reliability, auditability, and operational clarity.

---

## What This Pipeline Does
At a high level, Phase 3 performs the following:

- Ingests customer site data, geospatial inputs, and external datasets
- Executes multi-level ETL (tract / county / MSA)
- Performs geospatial buffering and site–tract interactions
- Trains and scores ranking models
- Produces ranked outputs and artifacts
- Archives outputs and maintains execution state
- Automates end-to-end execution
- Supports scheduled and change-aware execution

---

## Repository Structure
```text
Phase3/prod/
├── config/
│   └── settings.yaml          # Runtime configuration (paths, parameters, overrides)
│
├── src/
│   ├── etl/                   # ETL and geospatial processing
│   ├── ml/                    # Model training and scoring
│   └── utils/                 # Logging, IO, config, archiving, change detection
│
├── run_full_refresh.py        # Force full end-to-end pipeline run
├── run_if_inputs_changed.py   # Conditional run based on input change detection
├── run_phase3.bat             # Windows Task Scheduler entry point
├── requirements.txt           # Python dependencies
└── README.md
```

**Note:** Runtime folders such as `data/`, `logs/`, and `venv/` are intentionally excluded from version control and are created or populated at runtime.

---

## Execution Modes

### 1. Force Full Refresh
Runs the complete pipeline regardless of whether inputs have changed.

```bash
python run_full_refresh.py
```

Use this for:
- Initial environment setup
- Backfills
- Explicit reprocessing

---

### 2. Change-Aware Execution
Runs the pipeline **only if monitored inputs have changed** (based on input fingerprinting).

```bash
python run_if_inputs_changed.py
```

This mode is intended for:
- Scheduled automation
- Compute-efficient production runs
---

## Inputs & Outputs (High Level)

### Inputs
Inputs are expected to be present under `data/inputs/` and include:
- Customer / Voltera site data
- Geofence and spatial reference files
- External datasets
- Mapping data

These inputs are provisioned outside of version control and must be made available in the runtime environment (e.g., copied from an EC2 instance or a shared internal location) prior to pipeline execution.

### Outputs
Pipeline outputs are written to:
- `data/staged/` — intermediate ETL artifacts
- `data/outputs/` — final ranked datasets and deliverables
- `data/state/` — execution state and change-detection metadata
- `data/outputs/archive/` — timestamped archival snapshots

---

## Automation
Phase 3 is designed to run unattended via **Windows Task Scheduler** using:

```text
run_phase3.bat
```

The batch file activates the appropriate environment and invokes the change-aware execution path.

---

## Documentation
This README is an **orientation guide**.

Authoritative documentation lives in:
- Phase 3 Technical Documentation
- Phase 3 End User / Operator Guide

---

## Development & Governance Notes
- This repository represents a **production system**, not a research or experimentation sandbox.
- Direct commits to `main` should be restricted once branch protections are enabled.
- New development should occur on feature branches and be merged via pull requests.
- Runtime artifacts, data, logs, and environments are intentionally excluded from version control.

---

## Scope Boundary
This repository covers **Phase 3 only**, including:
- Automated ETL
- Automated Model training and ranking
- Scheduled and change-aware execution
---
Phase 3 represents a completed and validated production baseline within its defined scope.
