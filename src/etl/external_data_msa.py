"""
External Data Integration for MSA Level (Step 3.5)

Refactored from external_data_msa.ipynb / .py:
- Load all external datasets (demographics, climate, AV testing, ports, airports, EV charging,
  electricity, fuel, labor, land, risk, regulation, rideshare)
- Produce final Master Integration file for MSA level
"""

from pathlib import Path
from typing import Dict, Dict, List, Iterable, Sequence

import pandas as pd

from src.utils.io_utils import read_excel
from src.utils.logging_utils import get_logger

logger = get_logger("external_data_msa")

def _require_file(path: Path, context: str) -> None:
    """Fail fast if an expected input file is missing."""
    if not path.exists():
        logger = get_logger("external_data_msa")
        logger.error("[%s] Missing required input file: %s", context, path)
        raise FileNotFoundError(f"[{context}] Missing required input file: {path}")

def _require_columns(df: pd.DataFrame, required: Sequence[str], context: str) -> None:
    """Validate required columns exist before downstream transformations."""
    missing = [c for c in required if c not in df.columns]
    if missing:
        logger = get_logger("external_data_msa")
        logger.error("[%s] Missing required columns: %s", context, missing)
        raise KeyError(f"[{context}] Missing required columns: {missing}")
# ---------------------------------------------------------------------------
# Helper path utilities
# ---------------------------------------------------------------------------

def _external_dir(config: Dict) -> Path:
    return Path(config["paths"]["inputs"]["external"])


def _staged_dir(config: Dict) -> Path:
    return Path(config["paths"]["staged"])


# ---------------------------------------------------------------------------
# 1. Demographics & Climate
# ---------------------------------------------------------------------------

def load_demographics(config: Dict) -> pd.DataFrame:
    """
    Load MSA-level demographic data.
    """
    external_dir = _external_dir(config)
    demo_file = external_dir / config["filenames"]["external_demographic"]

    logger.info("Loading MSA demographics from: %s", demo_file)

    # Ensure the required file is present
    _require_file(demo_file, "demographics")

    demo = read_excel(demo_file, sheet_name="MSA")
    
    # Ensure the required columns are present
    _require_columns(demo, ["Metropolitan Division Code"], context=str(demo_file))
    
    logger.info("Demographics loaded: rows=%d, shape=%s", len(demo), demo.shape)
    return demo


def load_climate(config: Dict) -> pd.DataFrame:
    """
    Load and aggregate climate dataset at the MSA level.
    """
    external_dir = _external_dir(config)
    climate_file = external_dir / config["filenames"]["external_climate"]

    logger.info("Loading MSA climate data from: %s", climate_file)
    
    # Ensure the required file is present
    _require_file(climate_file, "climate")

    climate_raw = read_excel(climate_file, sheet_name="MSA")
    
    # Ensure the required columns are present
    _require_columns(climate_raw, ["Metropolitan Division Code"], context=str(climate_file))

    logger.info(
        "Climate raw loaded: rows=%d, shape=%s",
        len(climate_raw),
        climate_raw.shape,
    )

    # Aggregate like Tableau: average by MSA code
    agg_cols = [c for c in climate_raw.columns if c != "Metropolitan Division Code"]

    climate = (
        climate_raw
        .groupby("Metropolitan Division Code", as_index=False)[agg_cols]
        .mean(numeric_only=True)
    )

    logger.info(
        "Climate aggregated: rows=%d, shape=%s",
        len(climate),
        climate.shape,
    )
    return climate


def merge_demo_climate(demo: pd.DataFrame, climate: pd.DataFrame) -> pd.DataFrame:
    """
    Inner-join demographics and climate on Metropolitan Division Code.
    """
    logger.info("Merging demographics + climate at MSA level")
    df = demo.merge(climate, on="Metropolitan Division Code", how="inner")

    logger.info(
        "Rows after demo + climate merge: rows=%d, shape=%s",
        len(df),
        df.shape,
    )
    return df


# ---------------------------------------------------------------------------
# 2. AV Testing data
# ---------------------------------------------------------------------------

def load_av_testing(config: Dict) -> pd.DataFrame:
    """
    Load AV testing data and build MSA-level AV features.
    """
    external_dir = _external_dir(config)
    av_file = external_dir / config["filenames"]["external_avtesting"]

    logger.info("Loading AV testing data from: %s", av_file)
    
    # Ensure the required file is present
    _require_file(av_file, "av testing")

    av_raw = read_excel(av_file, sheet_name="MSA")
    
    # Ensure the required columns are present
    required_cols = [
    "Metropolitan Division Code",
    "Range_Cover",
    "Number of Vehicles in Operation (Approx.)",
    "Count AV Testing Sites",
]
    _require_columns(av_raw, required_cols, context=str(av_file))

    logger.info("AV raw loaded: rows=%d, shape=%s", len(av_raw), av_raw.shape)

    av_raw["Number of Vehicle_Filled"] = (
        av_raw["Number of Vehicles in Operation (Approx.)"].fillna(1)
    )

    av_group = (
        av_raw
        .groupby(["Metropolitan Division Code", "Range_Cover"], as_index=False)
        .agg(
            Number_of_Vehicle_Filled=("Number of Vehicle_Filled", "sum"),
            Number_of_AV_Testing_Sites=("Count AV Testing Sites", "sum"),
        )
    )

    logger.info("AV grouped: rows=%d, shape=%s", len(av_group), av_group.shape)

    # Pivot for site counts
    sites_pivot = (
        av_group
        .pivot(index="Metropolitan Division Code",
               columns="Range_Cover",
               values="Number_of_AV_Testing_Sites")
        .fillna(0)
    )
    sites_pivot.columns = [f"Count AV Testing - {c} mile" for c in sites_pivot.columns]

    # Pivot for vehicle counts
    vehicles_pivot = (
        av_group
        .pivot(index="Metropolitan Division Code",
               columns="Range_Cover",
               values="Number_of_Vehicle_Filled")
        .fillna(0)
    )
    vehicles_pivot.columns = [
        f"# of AV Testing Vehicles - {c} mile" for c in vehicles_pivot.columns
    ]

    av_features = pd.concat([sites_pivot, vehicles_pivot], axis=1).reset_index()

    logger.info(
        "AV features prepared: rows=%d, shape=%s",
        len(av_features),
        av_features.shape,
    )
    return av_features


def merge_av_features(df_climate_demo: pd.DataFrame, av_features: pd.DataFrame) -> pd.DataFrame:
    """
    Left-join AV features onto the demo+climate table.
    """
    logger.info("Merging AV features with demo+climate at MSA level")
    df = df_climate_demo.merge(av_features, on="Metropolitan Division Code", how="left")

    logger.info(
        "Rows after adding AV features: rows=%d, shape=%s",
        len(df),
        df.shape,
    )
    return df


# ---------------------------------------------------------------------------
# 3. Ports & Airports
# ---------------------------------------------------------------------------

def load_ports(config: Dict) -> pd.DataFrame:
    """
    Load and aggregate port data, then build port features at the MSA level.
    """
    external_dir = _external_dir(config)
    ports_file = external_dir / config["filenames"]["external_ports"]

    logger.info("Loading port data from: %s", ports_file)
    
    # Ensure the required file is present
    _require_file(ports_file, "ports")

    ports_raw = read_excel(ports_file, sheet_name="MSA")
    
    # Ensure the required columns are present
    required_cols = [
        "Metropolitan Division Code",
        "Buffer_Miles",
        "Count of Ports",
        "Total Port Volume",
        "Tonnage",
    ]
    _require_columns(ports_raw, required_cols, context=str(ports_file))
    
    ports_raw = ports_raw.copy()
    ports_raw.rename(
        columns={
            "Total Port Volume": "Total TEU",
            "Tonnage": "Total Tonnage",
        },
        inplace=True,
    )

    logger.info("Ports raw loaded: rows=%d, shape=%s", len(ports_raw), ports_raw.shape)

    ports_group = (
        ports_raw
        .groupby(["Metropolitan Division Code", "Buffer_Miles"], as_index=False)
        .agg(
            Count_Ports=("Count of Ports", "sum"),
            Total_TEU=("Total TEU", "sum"),
            Total_Tonnage=("Total Tonnage", "sum"),
        )
    )

    logger.info("Ports grouped: rows=%d, shape=%s", len(ports_group), ports_group.shape)

    # Tonnage pivot
    ton_pivot = (
        ports_group
        .pivot(index="Metropolitan Division Code",
               columns="Buffer_Miles",
               values="Total_Tonnage")
        .fillna(0)
    )
    ton_pivot.columns = [f"Total Tonnage - {c} mile" for c in ton_pivot.columns]

    # TEU pivot
    teu_pivot = (
        ports_group
        .pivot(index="Metropolitan Division Code",
               columns="Buffer_Miles",
               values="Total_TEU")
        .fillna(0)
    )
    teu_pivot.columns = [f"Total TEU - {c} mile" for c in teu_pivot.columns]

    # Count ports pivot
    count_ports_pivot = (
        ports_group
        .pivot(index="Metropolitan Division Code",
               columns="Buffer_Miles",
               values="Count_Ports")
        .fillna(0)
    )
    count_ports_pivot.columns = [f"Count Port - {c} mile" for c in count_ports_pivot.columns]

    ports_features = pd.concat(
        [ton_pivot, teu_pivot, count_ports_pivot],
        axis=1,
    ).reset_index()

    logger.info(
        "Port features prepared: rows=%d, shape=%s",
        len(ports_features),
        ports_features.shape,
    )
    return ports_features


def load_airports(config: Dict) -> pd.DataFrame:
    """
    Load and aggregate airport data, then build airport features at the MSA level.
    """
    external_dir = _external_dir(config)
    airport_file = external_dir / config["filenames"]["external_airports"]

    logger.info("Loading airport data from: %s", airport_file)

    # Ensure the required file is present
    _require_file(airport_file, "airports")

    airport_raw = read_excel(airport_file, sheet_name="MSA")
    
    # Ensure the required columns are present
    required_cols = [
        "Metropolitan Division Code",
        "Buffer_Miles",
        "Total_Landed_Weight_lbs_2018",
        "Count Airports",
    ]
    _require_columns(airport_raw, required_cols, context=str(airport_file))
    
    logger.info(
        "Airport raw loaded: rows=%d, shape=%s",
        len(airport_raw),
        airport_raw.shape,
    )

    airport_group = (
        airport_raw
        .groupby(["Metropolitan Division Code", "Buffer_Miles"], as_index=False)
        .agg(
            Total_Landed_Weight=("Total_Landed_Weight_lbs_2018", "sum"),
            Count_Airports=("Count Airports", "sum"),
        )
    )

    logger.info(
        "Airport grouped: rows=%d, shape=%s",
        len(airport_group),
        airport_group.shape,
    )

    land_pivot = (
        airport_group
        .pivot(index="Metropolitan Division Code",
               columns="Buffer_Miles",
               values="Total_Landed_Weight")
        .fillna(0)
    )
    land_pivot.columns = [
        f"Total Airport Land Weight - {c} mile" for c in land_pivot.columns
    ]

    count_air_pivot = (
        airport_group
        .pivot(index="Metropolitan Division Code",
               columns="Buffer_Miles",
               values="Count_Airports")
        .fillna(0)
    )
    count_air_pivot.columns = [f"Count Airport - {c} mile" for c in count_air_pivot.columns]

    airport_features = pd.concat(
        [land_pivot, count_air_pivot],
        axis=1,
    ).reset_index()

    logger.info(
        "Airport features prepared: rows=%d, shape=%s",
        len(airport_features),
        airport_features.shape,
    )
    return airport_features


def merge_port_air_features(
    ports_features: pd.DataFrame,
    airport_features: pd.DataFrame,
) -> pd.DataFrame:
    """
    Outer-join port and airport features on Metropolitan Division Code.
    """
    logger.info("Merging port + airport features at MSA level")
    port_air = airport_features.merge(
        ports_features,
        on="Metropolitan Division Code",
        how="outer",
    )

    logger.info(
        "Port+Airport features merged: rows=%d, shape=%s",
        len(port_air),
        port_air.shape,
    )
    return port_air


def merge_demo_climate_av_port_air(
    df_climate_demo_av: pd.DataFrame,
    port_air_features: pd.DataFrame,
) -> pd.DataFrame:
    """
    Left-join port+airport features onto the demo+climate+AV table.
    """
    logger.info("Merging demo+climate+AV with port+airport at MSA level")
    df = df_climate_demo_av.merge(
        port_air_features,
        on="Metropolitan Division Code",
        how="left",
    )

    logger.info(
        "Rows after adding port+airport: rows=%d, shape=%s",
        len(df),
        df.shape,
    )
    return df


# ---------------------------------------------------------------------------
# 4. EV Station data
# ---------------------------------------------------------------------------

def load_ev_stations(config: Dict) -> pd.DataFrame:
    """
    Load and aggregate EV station data, producing EV features at the MSA level.
    """
    external_dir = _external_dir(config)
    ev_file = external_dir / config["filenames"]["external_ev_stations"]

    logger.info("Loading EV station data from: %s", ev_file)

    # Ensure the required file is present
    _require_file(ev_file, "ev stations")

    ev_raw = read_excel(ev_file, sheet_name="MSA")
    
    # Ensure the required columns are present
    required_cols = [
        "Metropolitan Division Code",
        "EV Network (Tesla or Not)",
        "Total DCFC Count",
        "Count EV Stations",
    ]
    _require_columns(ev_raw, required_cols, context=str(ev_file))
    
    logger.info("EV raw loaded: rows=%d, shape=%s", len(ev_raw), ev_raw.shape)

    ev_group = (
        ev_raw
        .groupby(["Metropolitan Division Code", "EV Network (Tesla or Not)"], as_index=False)
        .agg(
            Total_DCFC=("Total DCFC Count", "sum"),
            Count_EV_Station=("Count EV Stations", "sum"),
        )
    )

    logger.info("EV grouped: rows=%d, shape=%s", len(ev_group), ev_group.shape)

    # Pivot for Count EV Station
    count_station_pivot = (
        ev_group
        .pivot(index="Metropolitan Division Code",
               columns="EV Network (Tesla or Not)",
               values="Count_EV_Station")
        .fillna(0)
    )
    count_station_pivot.columns = [
        f"Count EV Station - {c}" for c in count_station_pivot.columns
    ]

    # Pivot for DCFC
    dcfc_pivot = (
        ev_group
        .pivot(index="Metropolitan Division Code",
               columns="EV Network (Tesla or Not)",
               values="Total_DCFC")
        .fillna(0)
    )
    dcfc_pivot.columns = [f"Total DCFC - {c}" for c in dcfc_pivot.columns]

    ev_features = pd.concat(
        [count_station_pivot, dcfc_pivot],
        axis=1,
    ).reset_index()

    logger.info(
        "EV features prepared: rows=%d, shape=%s",
        len(ev_features),
        ev_features.shape,
    )
    return ev_features


# ---------------------------------------------------------------------------
# 5. Electricity, Fuel, Labor, Land
# ---------------------------------------------------------------------------

def load_electricity(config: Dict) -> pd.DataFrame:
    """
    Load MSA-level electricity price data.
    """
    external_dir = _external_dir(config)
    elec_file = external_dir / config["filenames"]["external_electricity"]

    logger.info("Loading electricity data from: %s", elec_file)
    
    # Ensure the required file is present
    _require_file(elec_file, "electricity")

    elec = read_excel(elec_file, sheet_name="MSA")
    
    # Ensure the required columns are present
    required_cols = ["Metropolitan Division Code", "MSA-Price (cent/kwh)"]
    
    _require_columns(elec, required_cols, context=str(elec_file))
    
    elec = elec[required_cols].copy()

    logger.info("Electricity loaded: rows=%d, shape=%s", len(elec), elec.shape)
    return elec


def load_fuel(config: Dict) -> pd.DataFrame:
    """
    Load MSA-level fuel (gas) price data.
    """
    external_dir = _external_dir(config)
    fuel_file = external_dir / config["filenames"]["external_gas"]

    logger.info("Loading fuel data from: %s", fuel_file)

    # Ensure the required file is present
    _require_file(fuel_file, "fuel")

    fuel = read_excel(fuel_file, sheet_name="MSA")
    
    # Ensure the required columns are present
    required_cols = ["Metropolitan Division Code", "MSA-Regular Gas Price ($/G)"]
    
    _require_columns(fuel, required_cols, context=str(fuel_file))
    
    fuel = fuel[required_cols].copy()

    logger.info("Fuel loaded: rows=%d, shape=%s", len(fuel), fuel.shape)
    return fuel


def combine_electricity_fuel(elec: pd.DataFrame, fuel: pd.DataFrame) -> pd.DataFrame:
    """
    Outer-join electricity and fuel on Metropolitan Division Code.
    """
    logger.info("Merging electricity + fuel at MSA level")
    elec_fuel = elec.merge(
        fuel,
        on="Metropolitan Division Code",
        how="outer",
    )

    logger.info(
        "Electricity+Fuel merged: rows=%d, shape=%s",
        len(elec_fuel),
        elec_fuel.shape,
    )
    return elec_fuel


def load_labor(config: Dict) -> pd.DataFrame:
    """
    Load MSA-level labor cost data.
    """
    external_dir = _external_dir(config)
    labor_file = external_dir / config["filenames"]["external_labor"]

    logger.info("Loading labor cost data from: %s", labor_file)
    
    # Ensure the required file is present
    _require_file(labor_file, "labor")

    labor = read_excel(labor_file, sheet_name="MSA")
    
    # Ensure the required columns are present
    required_cols = ["Metropolitan Division Code"]
    
    _require_columns(labor, required_cols, context=str(labor_file))
    
    logger.info("Labor loaded: rows=%d, shape=%s", len(labor), labor.shape)
    return labor


def combine_elec_fuel_labor(
    elec_fuel: pd.DataFrame,
    labor: pd.DataFrame,
) -> pd.DataFrame:
    """
    Outer-join labor with electricity+fuel.
    """
    logger.info("Merging electricity+fuel with labor at MSA level")
    elec_fuel_labor = elec_fuel.merge(
        labor,
        on="Metropolitan Division Code",
        how="outer",
    )

    logger.info(
        "Electricity+Fuel+Labor merged: rows=%d, shape=%s",
        len(elec_fuel_labor),
        elec_fuel_labor.shape,
    )
    return elec_fuel_labor


def load_land(config: Dict) -> pd.DataFrame:
    """
    Load and aggregate MSA-level land cost data.
    """
    external_dir = _external_dir(config)
    land_file = external_dir / config["filenames"]["external_land"]

    logger.info("Loading land cost data from: %s", land_file)
    
    # Ensure the required file is present
    _require_file(land_file, "land")

    land_raw = read_excel(land_file, sheet_name="MSA")
    
    # Ensure the required columns are present
    required_cols = [
        "Metropolitan Division Code",
        "MSA-Land Value (1/4 Acre Lot)",
    ]
    
    _require_columns(land_raw, required_cols, context=str(land_file))
    
    land = land_raw[required_cols].copy()

    land_group = (
        land
        .groupby("Metropolitan Division Code", as_index=False)
        .agg({"MSA-Land Value (1/4 Acre Lot)": "mean"})
    )

    logger.info(
        "Land aggregated: rows=%d, shape=%s",
        len(land_group),
        land_group.shape,
    )
    return land_group


def combine_elec_fuel_labor_land(
    elec_fuel_labor: pd.DataFrame,
    land_group: pd.DataFrame,
) -> pd.DataFrame:
    """
    Outer-join land with electricity+fuel+labor.
    """
    logger.info("Merging electricity+fuel+labor with land at MSA level")
    elec_fuel_labor_land = elec_fuel_labor.merge(
        land_group,
        on="Metropolitan Division Code",
        how="outer",
    )

    logger.info(
        "Electricity+Fuel+Labor+Land merged: rows=%d, shape=%s",
        len(elec_fuel_labor_land),
        elec_fuel_labor_land.shape,
    )
    return elec_fuel_labor_land


# ---------------------------------------------------------------------------
# 6. Risk & Regulation
# ---------------------------------------------------------------------------

def load_risk(config: Dict) -> pd.DataFrame:
    """
    Load national risk data at the MSA level.
    MSA risk columns are already numeric, so no text→numeric mapping is needed.
    """
    external_dir = _external_dir(config)
    risk_file = external_dir / config["filenames"]["external_risk"]

    logger.info("Loading risk data from: %s", risk_file)

    # Ensure the required file is present
    _require_file(risk_file, "risk")

    risk = read_excel(risk_file, sheet_name="MSA")
    
    # Ensure the required columns are present
    required_cols = [
        "Metropolitan Division Code"
    ]
    _require_columns(risk, required_cols, context=str(risk_file))
    
    # Drop a couple of high-level MSA geometry/population columns (handled elsewhere)
    cols_to_drop = ["MSA-Area (SQRT Miles)", "MSA-Total Population"]
    drop_cols = [c for c in cols_to_drop if c in risk.columns]
    if drop_cols:
        risk = risk.drop(columns=drop_cols)

    logger.info("Risk loaded: rows=%d, shape=%s", len(risk), risk.shape)
    # For MSA the risk columns are already numeric
    risk_numeric = risk.copy()

    return risk_numeric


def combine_risk(
    elec_fuel_labor_land: pd.DataFrame,
    risk_numeric: pd.DataFrame,
) -> pd.DataFrame:
    """
    Outer-join risk data with electricity+fuel+labor+land.
    """
    logger.info("Merging risk data with electricity+fuel+labor+land at MSA level")
    elec_fuel_labor_land_risk = elec_fuel_labor_land.merge(
        risk_numeric,
        on="Metropolitan Division Code",
        how="outer",
    )

    logger.info(
        "Electricity+Fuel+Labor+Land+Risk merged: rows=%d, shape=%s",
        len(elec_fuel_labor_land_risk),
        elec_fuel_labor_land_risk.shape,
    )
    return elec_fuel_labor_land_risk


def load_regulation(config: Dict) -> pd.DataFrame:
    """
    Load regulation/support data at the MSA level.
    """
    external_dir = _external_dir(config)
    reg_file = external_dir / config["filenames"]["external_regulation"]

    logger.info("Loading regulation data from: %s", reg_file)
    
    # Ensure the required file is present
    _require_file(reg_file, "reg")

    reg = read_excel(reg_file, sheet_name="MSA")
    
    # Ensure the required columns are present
    required_cols = [
        "Metropolitan Division Code"
    ]
    _require_columns(reg, required_cols, context=str(reg_file))
    
    cols_to_drop = ["MSA-Area (SQRT Miles)", "MSA-Total Population"]
    drop_cols = [c for c in cols_to_drop if c in reg.columns]
    if drop_cols:
        reg = reg.drop(columns=drop_cols)

    logger.info("Regulation loaded: rows=%d, shape=%s", len(reg), reg.shape)
    return reg


def combine_regulation(
    elec_fuel_labor_land_risk: pd.DataFrame,
    reg: pd.DataFrame,
) -> pd.DataFrame:
    """
    Outer-join regulation with electricity+fuel+labor+land+risk.
    """
    logger.info("Merging regulation with electricity+fuel+labor+land+risk at MSA level")
    elec_fuel_labor_land_risk_regulation = elec_fuel_labor_land_risk.merge(
        reg,
        on="Metropolitan Division Code",
        how="outer",
    )

    logger.info(
        "Electricity+Fuel+Labor+Land+Risk+Regulation merged: rows=%d, shape=%s",
        len(elec_fuel_labor_land_risk_regulation),
        elec_fuel_labor_land_risk_regulation.shape,
    )
    return elec_fuel_labor_land_risk_regulation


def combine_with_ev(
    elec_fuel_labor_land_risk_regulation: pd.DataFrame,
    ev_features: pd.DataFrame,
) -> pd.DataFrame:
    """
    Outer-join EV station features with the cost+risk+regulation block.
    """
    logger.info("Merging EV features with cost+risk+regulation at MSA level")
    combined = elec_fuel_labor_land_risk_regulation.merge(
        ev_features,
        on="Metropolitan Division Code",
        how="outer",
    )

    logger.info(
        "After EV join: rows=%d, shape=%s",
        len(combined),
        combined.shape,
    )
    return combined


# ---------------------------------------------------------------------------
# 7. Combine external block with demo+climate+AV+port+airport
# ---------------------------------------------------------------------------

def merge_all_external(
    df_demo_climate_av_port_airport: pd.DataFrame,
    elec_fuel_labor_land_risk_regulation_ev: pd.DataFrame,
) -> pd.DataFrame:
    """
    Left-join the cost/risk/regulation/EV block onto the demo+climate+AV+port+airport table.
    """
    logger.info("Merging all external blocks with demo+climate+AV+port+airport at MSA level")
    df_external = df_demo_climate_av_port_airport.merge(
        elec_fuel_labor_land_risk_regulation_ev,
        on="Metropolitan Division Code",
        how="left",
    )

    logger.info(
        "Final external MSA table: rows=%d, shape=%s",
        len(df_external),
        df_external.shape,
    )
    return df_external


# ---------------------------------------------------------------------------
# 8. MSA site (customer) features from aggregations output
# ---------------------------------------------------------------------------

def load_msa_site_features(config: Dict) -> pd.DataFrame:
    """
    Load and pivot MSA-level customer site features from the aggregations output.
    """
    staged_dir = _staged_dir(config)
    agg_file = staged_dir / config["filenames"]["aggregations_refactored"]

    logger.info("Loading MSA site features from: %s", agg_file)

    # Ensure the required file is present
    _require_file(agg_file, "msa_customer_aggregations")

    msa_raw = read_excel(agg_file, sheet_name="MSA")
    
    # Ensure the required columns are present
    required_cols = [
        "Metropolitan Division Code", "Range_Cover", "Customer Segment",
        "Count_Customer_Sites", "Total_Stalls_Filled"
    ]
    _require_columns(msa_raw, required_cols, context=str(agg_file))
    
    logger.info("MSA raw site rows: shape=%s", msa_raw.shape)

    group_cols = ["Range_Cover", "Metropolitan Division Code", "Customer Segment"]
    agg_map = {
        "Count_Customer_Sites": "sum",
        "Total_Stalls_Filled": "sum",
    }

    # missing = [c for c in group_cols + list(agg_map.keys()) if c not in msa_raw.columns]
    # if missing:
    #     raise KeyError(f"Missing expected MSA site columns: {missing}")

    msa_grp = (
        msa_raw[group_cols + list(agg_map.keys())]
        .groupby(group_cols, as_index=False)
        .agg(agg_map)
    )

    logger.info("MSA grouped site rows: rows=%d, shape=%s", len(msa_grp), msa_grp.shape)

    # AV only
    av = msa_grp[msa_grp["Customer Segment"] == "AV"].copy()
    av_stalls = (
        av.pivot_table(
            index="Metropolitan Division Code",
            columns="Range_Cover",
            values="Total_Stalls_Filled",
            aggfunc="sum",
        )
        .rename(columns=lambda r: f"Total Stall Customer - {int(r)} mile - AV")
    )
    av_counts = (
        av.pivot_table(
            index="Metropolitan Division Code",
            columns="Range_Cover",
            values="Count_Customer_Sites",
            aggfunc="sum",
        )
        .rename(columns=lambda r: f"Count Customer - {int(r)} mile - AV")
    )
    av_wide = pd.concat([av_stalls, av_counts], axis=1).reset_index()

    # Non-AV only
    nav = msa_grp[msa_grp["Customer Segment"] == "Non-AV"].copy()
    nav_stalls = (
        nav.pivot_table(
            index="Metropolitan Division Code",
            columns="Range_Cover",
            values="Total_Stalls_Filled",
            aggfunc="sum",
        )
        .rename(columns=lambda r: f"Total Stall Customer - {int(r)} mile - Non-AV")
    )
    nav_counts = (
        nav.pivot_table(
            index="Metropolitan Division Code",
            columns="Range_Cover",
            values="Count_Customer_Sites",
            aggfunc="sum",
        )
        .rename(columns=lambda r: f"Count Customer - {int(r)} mile - Non-AV")
    )
    nav_wide = pd.concat([nav_stalls, nav_counts], axis=1).reset_index()

    # Combine AV + Non-AV wide tables
    msa_customer_features = av_wide.merge(
        nav_wide,
        on="Metropolitan Division Code",
        how="outer",
    )

    logger.info(
        "MSA customer features prepared: rows=%d, shape=%s",
        len(msa_customer_features),
        msa_customer_features.shape,
    )
    return msa_customer_features


def merge_msa_customer_features(
    df_external: pd.DataFrame,
    msa_customer_features: pd.DataFrame,
) -> pd.DataFrame:
    """
    Outer-join MSA customer features with the external block.
    """
    logger.info("Merging MSA customer features with external block")
    master_msa = df_external.merge(
        msa_customer_features,
        on="Metropolitan Division Code",
        how="outer",
    )

    logger.info(
        "Master MSA table (before rideshare/renaming): rows=%d, shape=%s",
        len(master_msa),
        master_msa.shape,
    )
    return master_msa


# ---------------------------------------------------------------------------
# 9. Column renaming and cleanup
# ---------------------------------------------------------------------------

MSA_RENAME_MAP: Dict[str, str] = {
    "MSA-Income": "Median Household Income in past 12 months",
    "MSA-% Taxicab": "Percent of workers who commuted by taxicab",
    "MSA-% Young": "Percent of Population that is Less Than 18 Years",
    "MSA - % Public Transportation": "Percent of workers who commuted by public transportation",
    "MSA- % Education Bachelor and Higher": "Percent with Bachelor Degree",
    "MSA-Total Population_x": "Total Population",
    "MSA - Population Density": "Population Density (#/sqrtM)",
    "MSA-Total Households": "Total Households",
    "MSA-Average Weekly Wage": "Average Weekly Wage",
    "MSA_Total_Funding_Amount": "Total_Funding_Amount",
    "MSA_Federal_Funding_Amount": "Federal_Funding_Amount",
    "MSA_State_Funding_Amount": "State_Funding_Amount",
    "MSA_NEVI_Funding_Amount": "NEVI_Funding_Amount",
    "MSA_State_Funding_Awards_Count": "State_Funding_Awards_Count",
    "MSA_Federal_Funding_Awards_Count": "Federal_Funding_Awards_Count",
    "MSA_Existing_Laws": "Existing_Laws",
    "MSA-Regular Gas Price ($/G)": "Regular Gas Price ($/G)",
    "MSA-Price (cent/kwh)": "Price (cent/kwh)",
    "MSA_Risk_#": "RISK_RATNG_#",
    "MSA_CFLD_#": "CFLD_RISKR_#",
    "MSA_CWAV_#": "CWAV_RISKR_#",
    "MSA_ERQK_#": "ERQK_RISKR_#",
    # HWAV risk not present for MSA 
    "MSA_HRCN_#": "HRCN_RISKR_#",
    "MSA_ISTM_#": "ISTM_RISKR_#",
    "MSA_RFLD_#": "RFLD_RISKR_#",
    "MSA_TRND_#": "TRND_RISKR_#",
    "MSA_WNTW_#": "WNTW_RISKR_#",
    "MSA-Land Value (1/4 Acre Lot)": "Land Value (1/4 Acre Lot, Standardized)",
    "MSA-Area (SQRT Miles)_x": "Area (SQRT Miles)",
    "MSA_Rain_FilledwithState": "Precipitation",
    "MSA_Snow_FilledwithState": "Snowdays",
    "MSA_Temp_FilledwithState": "Temperature",
}


def apply_msa_renaming_and_cleanup(master_msa: pd.DataFrame) -> pd.DataFrame:
    """
    Apply column renames and drop duplicated geometry/population columns.
    """
    logger.info("Applying MSA column renaming and cleanup")
    master_msa_cleaned = master_msa.rename(columns=MSA_RENAME_MAP)

    drop_cols = [c for c in ["MSA-Area (SQRT Miles)_y", "MSA-Total Population_y"] if c in master_msa_cleaned.columns]
    if drop_cols:
        master_msa_cleaned = master_msa_cleaned.drop(columns=drop_cols)

    logger.info(
        "After renaming/cleanup: rows=%d, shape=%s",
        len(master_msa_cleaned),
        master_msa_cleaned.shape,
    )
    return master_msa_cleaned


# ---------------------------------------------------------------------------
# 10. Rideshare (NIQ) and final write
# ---------------------------------------------------------------------------

def load_rideshare(config: Dict) -> pd.DataFrame:
    """
    Load rideshare (NIQ) data at the MSA level.
    """
    external_dir = _external_dir(config)
    ride_file = external_dir / config["filenames"]["external_niq"]

    logger.info("Loading rideshare (NIQ) data from: %s", ride_file)

    # Ensure the required file is present
    _require_file(ride_file, "rideshare (niq)")

    rideshare = read_excel(ride_file, sheet_name="MSA")
    
    # Ensure the required columns are present
    required_cols = [
        "Metropolitan Division Code", "# trips"
    ]
    _require_columns(rideshare, required_cols, context=str(ride_file))
    
    if "# trips" in rideshare.columns:
        rideshare = rideshare.rename(columns={"# trips": "# rideshare trips"})

    logger.info("Rideshare loaded: rows=%d, shape=%s", len(rideshare), rideshare.shape)
    return rideshare


def merge_rideshare(
    master_msa_cleaned: pd.DataFrame,
    rideshare: pd.DataFrame,
) -> pd.DataFrame:
    """
    Left-join rideshare onto the cleaned master MSA table.
    """
    logger.info("Merging rideshare with master MSA table")
    master_msa_final = master_msa_cleaned.merge(
        rideshare,
        on="Metropolitan Division Code",
        how="left",
    )

    logger.info(
        "Final MSA table (with rideshare): rows=%d, shape=%s",
        len(master_msa_final),
        master_msa_final.shape,
    )
    return master_msa_final


def write_master_msa(master_msa_final: pd.DataFrame, config: Dict) -> Path:
    """
    Write the final master MSA integration to the staged folder, sheet name 'MSA'.
    """
    staged_dir = _staged_dir(config)
    out_file = config["filenames"]["master_integration_refactored"]
    out_path = staged_dir / out_file

    logger.info("Writing final master MSA integration to: %s", out_path)
    staged_dir.mkdir(parents=True, exist_ok=True)

    if not out_path.exists():
        raise FileNotFoundError(
            f"Expected master workbook not found at {out_path}. "
            "Tract-level output must be created before writing the MSA sheet."
        )

    with pd.ExcelWriter(
        out_path, 
        engine="openpyxl",
        mode = "a", 
        if_sheet_exists="replace"
        ) as writer:
        master_msa_final.to_excel(writer, sheet_name="MSA", index=False)

    logger.info(
        "Saved final master MSA file. Rows=%d, shape=%s",
        len(master_msa_final),
        master_msa_final.shape,
    )
    return out_path


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------

def run_external_data_msa(config: Dict) -> Path:
    """
    Full MSA-level external data integration pipeline.

    - Demographics + climate
    - AV testing
    - Ports + airports
    - EV station features
    - Electricity, fuel, labor, land, risk, regulation
    - Combine with demo+climate+AV+ports+airports
    - MSA customer features (from aggregations output -  renamed
    - Rideshare (NIQ)
    - Final write to Master Integration workbook (MSA sheet)
    """
    logger = get_logger("external_data_msa")
    logger.info("=== Starting MSA external data integration (Step 3.5, MSA) ===")

    # 1) Demographics + climate
    demo = load_demographics(config)
    climate = load_climate(config)
    df_demo_climate = merge_demo_climate(demo, climate)

    # 2) AV testing
    av_features = load_av_testing(config)
    df_demo_climate_av = merge_av_features(df_demo_climate, av_features)

    # 3) Ports + airports
    ports_features = load_ports(config)
    airport_features = load_airports(config)
    port_air_features = merge_port_air_features(ports_features, airport_features)
    df_demo_climate_av_port_airport = merge_demo_climate_av_port_air(
        df_demo_climate_av,
        port_air_features,
    )

    # 4) EV station features
    ev_features = load_ev_stations(config)

    # 5) Electricity, fuel, labor, land
    elec = load_electricity(config)
    fuel = load_fuel(config)
    elec_fuel = combine_electricity_fuel(elec, fuel)
    labor = load_labor(config)
    elec_fuel_labor = combine_elec_fuel_labor(elec_fuel, labor)
    land = load_land(config)
    elec_fuel_labor_land = combine_elec_fuel_labor_land(elec_fuel_labor, land)

    # 6) Risk & regulation
    risk = load_risk(config)
    elec_fuel_labor_land_risk = combine_risk(elec_fuel_labor_land, risk)
    reg = load_regulation(config)
    elec_fuel_labor_land_risk_regulation = combine_regulation(
        elec_fuel_labor_land_risk,
        reg,
    )

    # 7) EV + elec+fuel+labor+land+risk+reg
    elec_fuel_labor_land_risk_regulation_ev = combine_with_ev(
        elec_fuel_labor_land_risk_regulation,
        ev_features,
    )

    # 8) Combine the above with demo+climate+AV+ports+airports
    df_external = merge_all_external(
        df_demo_climate_av_port_airport,
        elec_fuel_labor_land_risk_regulation_ev,
    )

    # 9) MSA site/customer features
    msa_customer_features = load_msa_site_features(config)
    master_msa = merge_msa_customer_features(df_external, msa_customer_features)

    # 10) Column renaming and cleanup
    master_msa_cleaned = apply_msa_renaming_and_cleanup(master_msa)

    # 11) Rideshare (NIQ)
    rideshare = load_rideshare(config)
    master_msa_final = merge_rideshare(master_msa_cleaned, rideshare)

    # 12) Final write
    out_path = write_master_msa(master_msa_final, config)

    logger.info("=== Finished MSA external data integration ===")
    return out_path
