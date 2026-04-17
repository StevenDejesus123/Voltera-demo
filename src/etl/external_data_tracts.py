"""
External Data Integration for Tract Level (Step 3.5)

Refactored from external_data_tracts.ipynb / .py:
- Load all external datasets demographics, climate, AV testing, ports, airports, EV stations, costs (electric, fuel, labor, land), risk, regulation, and customer features, and then attaching
rideshare (NIQ) metrics.
- Preserve Tableau Prep business logic and column naming exactly
- Merge step-by-step in the same order as unrefactored pipeline
- Produce final Master Integration file for Tract level
"""


from pathlib import Path
from typing import Iterable, Sequence

import pandas as pd

from src.utils.io_utils import read_excel, read_csv
from src.utils.logging_utils import get_logger


def _require_file(path: Path, context: str) -> None:
    """Fail fast if an expected input file is missing."""
    if not path.exists():
        logger = get_logger("external_data_tracts")
        logger.error("[%s] Missing required input file: %s", context, path)
        raise FileNotFoundError(f"[{context}] Missing required input file: {path}")


def _require_columns(df: pd.DataFrame, required: Sequence[str], context: str) -> None:
    """Validate required columns exist before downstream transformations."""
    missing = [c for c in required if c not in df.columns]
    if missing:
        logger = get_logger("external_data_tracts")
        logger.error("[%s] Missing required columns: %s", context, missing)
        raise KeyError(f"[{context}] Missing required columns: {missing}")


def normalize_geoid(
    series: pd.Series,
    *,
    width: int,
    field_name: str,
    source: str,
    strict: bool,
    logger,
) -> pd.Series:
    """
    Normalize a GEOID-like key to a fixed-width, zero-padded digit string.

    Parameters
    ----------
    series : pd.Series
        Input GEOID series.
    width : int
        Desired width (tract=11, county=5).
    field_name : str
        Column being normalized (used for diagnostics).
    source : str
        File path or dataset identifier for diagnostics.
    strict : bool
        If True, raise on invalid values; if False, log warning and set invalid to NA.
    logger : logging.Logger
        Logger instance.

    Returns
    -------
    pd.Series
        Normalized GEOID series as string.
    """
    raw = series.astype(str).str.strip()
    raw = raw.replace({"": pd.NA, "nan": pd.NA, "None": pd.NA, "<NA>": pd.NA})

    # Reject non-digit values (excluding missing)
    non_missing = raw.notna()
    non_digit = non_missing & raw.str.contains(r"\D", na=False)
    if non_digit.any():
        bad_count = int(non_digit.sum())
        example = raw[non_digit].iloc[0]
        msg = (
            f"[{source}] {bad_count} rows have non-digit values in '{field_name}' "
            f"(example: {example!r}). Expected digits only."
        )
        if strict:
            logger.error(msg)
            raise ValueError(msg)
        logger.warning(msg)
        raw.loc[non_digit] = pd.NA

    # Left-pad to desired width
    padded = raw.copy()
    padded.loc[padded.notna()] = padded.loc[padded.notna()].str.zfill(width)

    # Post-pad validation: must be exactly N digits
    invalid = padded.notna() & (~padded.str.match(rf"^\d{{{width}}}$", na=False))
    if invalid.any():
        bad_count = int(invalid.sum())
        example = padded[invalid].iloc[0]
        msg = (
            f"[{source}] {bad_count} rows have invalid '{field_name}' after padding "
            f"(example: {example!r}). Expected exactly {width} digits."
        )
        if strict:
            logger.error(msg)
            raise ValueError(msg)
        logger.warning(msg)
        padded.loc[invalid] = pd.NA

    return padded

def load_demographics(config):
    """
    Load demographics data (Tract level).

    Returns
    -------
    pd.DataFrame
        Demographic dataset with Tract_GeoID padded to 11 digits.
    """
    logger = get_logger("external_data_tracts")

    external_dir = Path(config["paths"]["inputs"]["external"])
    demo_file = external_dir / config["filenames"]["external_demographic"]

    logger.info(f"Loading demographics from: {demo_file}")

    _require_file(demo_file, "demographics")
    demo = read_excel(demo_file, sheet_name="Tract")

    _require_columns(demo, ["Tract_GeoID"], context=str(demo_file))

    # Normalize to 11-digit tract GEOID
    demo["Tract_GeoID"] = normalize_geoid(demo["Tract_GeoID"], width=11, field_name="Tract_GeoID", source=str(demo_file), strict=True, logger=logger)

    logger.info(
        f"Demographics loaded: rows={len(demo)}, shape={demo.shape}"
    )

    return demo


# function to load climate data
def load_climate(config):
    """
    Load and aggregate climate dataset at the tract level.
    """
    logger = get_logger("external_data_tracts")

    external_dir = Path(config["paths"]["inputs"]["external"])
    climate_file = external_dir / config["filenames"]["external_climate"]

    logger.info(f"Loading climate data from: {climate_file}")

    _require_file(climate_file, "climate")
    climate_raw = read_excel(climate_file, sheet_name="Tract")

    _require_columns(climate_raw, ["CLEAN_Tract Geoid"], context=str(climate_file))

    # Normalize to 11-digit tract GEOID (renamed to Tract_GeoID during aggregation)
    climate_raw["CLEAN_Tract Geoid"] = normalize_geoid(
        climate_raw["CLEAN_Tract Geoid"], width=11, field_name="CLEAN_Tract Geoid", source=str(climate_file), strict=False, logger=logger
    )

    logger.info(
        f"Climate raw loaded: rows={len(climate_raw)}, shape={climate_raw.shape}"
    )

    # Aggregate like Tableau: average by CLEAN_Tract Geoid
    agg_cols = [c for c in climate_raw.columns if c != "CLEAN_Tract Geoid"]

    climate = (
        climate_raw
        .groupby("CLEAN_Tract Geoid", as_index=False)[agg_cols]
        .mean(numeric_only=True)
        .rename(columns={"CLEAN_Tract Geoid": "Tract_GeoID"})
    )

    logger.info(
        f"Climate aggregated: rows={len(climate)}, shape={climate.shape}"
    )

    return climate

# Function to merge demo + climate
def merge_demo_climate(demo: pd.DataFrame, climate: pd.DataFrame) -> pd.DataFrame:
    """
    Merge demographics and climate data at tract level.
    """
    logger = get_logger("external_data_tracts")

    # Ensure key column exists in both
    for name, df in [("demographics", demo), ("climate", climate)]:
        if "Tract_GeoID" not in df.columns:
            raise KeyError(f"Expected column 'Tract_GeoID' not found in {name} dataframe.")

    demo_climate = demo.merge(climate, on="Tract_GeoID", how="inner")

    logger.info(
        f"Rows after demo + climate merge: rows={len(demo_climate)}, shape={demo_climate.shape}"
    )

    return demo_climate


# Function to load & transform AV testing data
def load_av_testing(config) -> pd.DataFrame:
    """
    Load AV testing data and build tract-level AV features.
    """
    logger = get_logger("external_data_tracts")

    external_dir = Path(config["paths"]["inputs"]["external"])
    av_file = external_dir / config["filenames"]["external_avtesting"]

    logger.info(f"Loading AV testing data from: {av_file}")

    _require_file(av_file, "av_testing")
    av_raw = read_excel(av_file, sheet_name="Tract")

    _require_columns(av_raw, ["Tract_Geoid", "Range_Cover", "Number of AV Testing Sites"], context=str(av_file))
    _require_columns(av_raw, ["Number of Vehicles in Operation (Approx.)"], context=str(av_file))

    # Normalize to 11-digit tract GEOID
    av_raw["Tract_Geoid"] = normalize_geoid(av_raw["Tract_Geoid"], width=11, field_name="Tract_Geoid", source=str(av_file), strict=False, logger=logger)

    logger.info(
        f"AV raw loaded: rows={len(av_raw)}, shape={av_raw.shape}"
    )

    # Number_of_Vehicle_Filled = Number of Vehicles in Operation (Approx.) with NaN -> 1
    av_raw["Number of Vehicle_Filled"] = (
        av_raw["Number of Vehicles in Operation (Approx.)"].fillna(1)
    )

    # Group by Tract + Range_Cover
    av_group = (
        av_raw
        .groupby(["Tract_Geoid", "Range_Cover"], as_index=False)
        .agg(
            Number_of_Vehicle_Filled=("Number of Vehicle_Filled", "sum"),
            Number_of_AV_Testing_Sites=("Number of AV Testing Sites", "sum"),
        )
    )

    logger.info(
        f"AV grouped: rows={len(av_group)}, shape={av_group.shape}"
    )

    # Pivot for site counts
    sites_pivot = (
        av_group
        .pivot(
            index="Tract_Geoid",
            columns="Range_Cover",
            values="Number_of_AV_Testing_Sites",
        )
        .fillna(0)
    )
    sites_pivot.columns = [
        f"Count AV Testing - {c} mile" for c in sites_pivot.columns
    ]

    # Pivot for vehicle counts
    vehicles_pivot = (
        av_group
        .pivot(
            index="Tract_Geoid",
            columns="Range_Cover",
            values="Number_of_Vehicle_Filled",
        )
        .fillna(0)
    )
    vehicles_pivot.columns = [
        f"# of AV Testing Vehicles - {c} mile" for c in vehicles_pivot.columns
    ]

    # Combine features and restore index as column
    av_features = (
        pd.concat([sites_pivot, vehicles_pivot], axis=1)
        .reset_index()
    )

    av_features = av_features.rename(columns={"Tract_Geoid": "Tract_GeoID"})

    logger.info(
        f"AV features (tracts with AV testing): rows={len(av_features)}, shape={av_features.shape}"
    )

    return av_features



# Merge AV with previous demo+climate
def merge_av(demo_climate: pd.DataFrame, av_features: pd.DataFrame) -> pd.DataFrame:
    """
    Merge AV testing features into the main tract dataframe.
    """
    logger = get_logger("external_data_tracts")

    if "Tract_GeoID" not in demo_climate.columns:
        raise KeyError("Tract_GeoID missing in main dataframe before AV merge.")
        
    if "Tract_GeoID" not in av_features.columns:
        raise KeyError("Tract_GeoID missing in AV features dataframe.")

    av_demo_climate = demo_climate.merge(av_features, on="Tract_GeoID", how="left")

    logger.info(
        f"Rows after demo+climate+AV merge: rows={len(av_demo_climate)}, shape={av_demo_climate.shape}"
    )

    return av_demo_climate

# Function to load and transform ports data
def load_ports(config) -> pd.DataFrame:
    """
    Load port interaction data and build tract-level port features.
    - Load Integration_Port_Interact_Regions_Count_Volume_tonnage.xlsx
    - Rename Total Port Volume -> Total TEU, Tonnage -> Total Tonnage
    - Group by (Tract_GeoID, Buffer Miles)
    - Pivot to wide: tonnage, TEU, count of ports
    """
    logger = get_logger("external_data_tracts")

    external_dir = Path(config["paths"]["inputs"]["external"])
    port_file = external_dir / config["filenames"]["external_ports"]

    logger.info(f"Loading port data from: {port_file}")

    _require_file(port_file, "ports")
    ports_raw = read_excel(port_file, sheet_name="Tract")

    _require_columns(
        ports_raw,
        ["Tract_GeoID", "Buffer Miles", "Count of Ports", "Total Port Volume", "Tonnage"],
        context=str(port_file),
    )

    ports_raw["Tract_GeoID"] = normalize_geoid(ports_raw["Tract_GeoID"], width=11, field_name="Tract_GeoID", source=str(port_file), strict=False, logger=logger)

    # Rename
    ports_raw = ports_raw.rename(
        columns={
            "Total Port Volume": "Total TEU",
            "Tonnage": "Total Tonnage",
        }
    )

    logger.info(
        f"Ports raw loaded: rows={len(ports_raw)}, shape={ports_raw.shape}"
    )

    ports_group = (
        ports_raw
        .groupby(["Tract_GeoID", "Buffer Miles"], as_index=False)
        .agg(
            Count_Ports=("Count of Ports", "sum"),
            Total_TEU=("Total TEU", "sum"),
            Total_Tonnage=("Total Tonnage", "sum"),
        )
    )

    logger.info(
        f"Ports grouped: rows={len(ports_group)}, shape={ports_group.shape}"
    )

    # Tonnage
    ton_pivot = (
        ports_group
        .pivot(index="Tract_GeoID", columns="Buffer Miles", values="Total_Tonnage")
        .fillna(0)
    )
    ton_pivot.columns = [f"Total Tonnage - {c} mile" for c in ton_pivot.columns]

    # TEU
    teu_pivot = (
        ports_group
        .pivot(index="Tract_GeoID", columns="Buffer Miles", values="Total_TEU")
        .fillna(0)
    )
    teu_pivot.columns = [f"Total TEU - {c} mile" for c in teu_pivot.columns]

    # Count of ports
    count_pivot = (
        ports_group
        .pivot(index="Tract_GeoID", columns="Buffer Miles", values="Count_Ports")
        .fillna(0)
    )
    count_pivot.columns = [f"Count Port - {c} mile" for c in count_pivot.columns]

    ports_features = (
        pd.concat([ton_pivot, teu_pivot, count_pivot], axis=1)
        .reset_index()
    )

    logger.info(
        f"Ports features (tracts with ports): rows={len(ports_features)}, shape={ports_features.shape}"
    )

    return ports_features

# Function to load and transform airport data
def load_airports(config) -> pd.DataFrame:
    """
    Load airport interaction data and build tract-level airport features.

    - Load Integration_Airport_Interact_Regions_Count_Volume.xlsx
    - Group by (Tract_GeoID, Buffer Miles)
    - Pivot to wide: landed weight + count of airports
    """
    logger = get_logger("external_data_tracts")

    external_dir = Path(config["paths"]["inputs"]["external"])
    airport_file = external_dir / config["filenames"]["external_airports"]

    logger.info(f"Loading airport data from: {airport_file}")

    _require_file(airport_file, "airports")
    airport_raw = read_excel(airport_file, sheet_name="Tract")

    _require_columns(
        airport_raw,
        ["Tract_GeoID", "Buffer Miles", "Total_Landed_Weight_lbs_2018", "Count MajorAirports"],
        context=str(airport_file),
    )

    airport_raw["Tract_GeoID"] = normalize_geoid(airport_raw["Tract_GeoID"], width=11, field_name="Tract_GeoID", source=str(airport_file), strict=False, logger=logger)

    logger.info(
        f"Airport raw loaded: rows={len(airport_raw)}, shape={airport_raw.shape}"
    )

    airport_group = (
        airport_raw
        .groupby(["Tract_GeoID", "Buffer Miles"], as_index=False)
        .agg(
            Total_Landed_Weight=(
                "Total_Landed_Weight_lbs_2018",
                "sum",
            ),
            Count_Airports=("Count MajorAirports", "sum"),
        )
    )

    logger.info(
        f"Airport grouped: rows={len(airport_group)}, shape={airport_group.shape}"
    )

    land_pivot = (
        airport_group
        .pivot(
            index="Tract_GeoID",
            columns="Buffer Miles",
            values="Total_Landed_Weight",
        )
        .fillna(0)
    )
    land_pivot.columns = [
        f"Total Airport Land Weight - {c} mile" for c in land_pivot.columns
    ]

    count_air_pivot = (
        airport_group
        .pivot(
            index="Tract_GeoID",
            columns="Buffer Miles",
            values="Count_Airports",
        )
        .fillna(0)
    )
    count_air_pivot.columns = [
        f"Count Airport - {c} mile" for c in count_air_pivot.columns
    ]

    airport_features = (
        pd.concat([land_pivot, count_air_pivot], axis=1)
        .reset_index()
    )

    logger.info(
        f"Airport features: rows={len(airport_features)}, shape={airport_features.shape}"
    )

    return airport_features



# Function to merge ports and airports
def merge_port_air(ports_features: pd.DataFrame,
                   airport_features: pd.DataFrame) -> pd.DataFrame:
    """
    Combine port and airport features into a single dataframe.

    Mirrors:
    port_air_features = airport_features.merge(ports_features, on="Tract_GeoID", how="outer")
    """
    logger = get_logger("external_data_tracts")

    for name, df in [("ports_features", ports_features), ("airport_features", airport_features)]:
        if "Tract_GeoID" not in df.columns:
            raise KeyError(f"Tract_GeoID missing in {name} dataframe.")

    port_airports = airport_features.merge(
        ports_features,
        on="Tract_GeoID",
        how="outer",
    )

    logger.info(
        f"Port+Airport features: rows={len(port_airports)}, shape={port_airports.shape}"
    )

    return port_airports

def merge_port_air_into_main(av_demo_climate: pd.DataFrame, port_air: pd.DataFrame) -> pd.DataFrame:
    """
    Merge port+airport features into the main dataframe.
    """
    logger = get_logger("external_data_tracts")

    ports_airports_av_demo_climate = av_demo_climate.merge(port_air, on="Tract_GeoID", how="left")

    logger.info(f"Rows after port+airport merge: rows={len(ports_airports_av_demo_climate)}, shape={ports_airports_av_demo_climate.shape}")

    return ports_airports_av_demo_climate

def load_ev_stations(config) -> pd.DataFrame:
    """
    Load EV station data and build tract-level EV features.

    - Load Integration_EV_ChargingStaions_Regions_Count.xlsx
    - Use Tract_FIPS_Clean as ID
    - Group by (Tract_FIPS_Clean, EV_Network(Tesla or Not))
    - Aggregate Total DCFC + Number of EV Stations
    - Pivot to wide: Count EV Station - {Tesla/Non-Tesla}, Total DCFC - {Tesla/Non-Tesla}
    - Rename Tract_FIPS_Clean -> Tract_GeoID
    """
    logger = get_logger("external_data_tracts")

    external_dir = Path(config["paths"]["inputs"]["external"])
    ev_file = external_dir / config["filenames"]["external_ev_stations"]

    logger.info(f"Loading EV station data from: {ev_file}")

    _require_file(ev_file, "ev_stations")

    # Tract-level sheet
    ev_raw = read_excel(ev_file, sheet_name="Tract")

    _require_columns(
        ev_raw,
        [
            "Tract_FIPS_Clean",
            "EV_Network(Tesla or Not)",
            "Total DCFC Count",
            "Number of EV Stations",
        ],
        context=str(ev_file),
    )

    # Normalize to 11-digit tract GEOID
    ev_raw["Tract_FIPS_Clean"] = normalize_geoid(
        ev_raw["Tract_FIPS_Clean"], width=11, field_name="Tract_FIPS_Clean", source=str(ev_file), strict=False, logger=logger
    )

    logger.info(f"EV raw loaded: rows={len(ev_raw)}, shape={ev_raw.shape}")

    # Aggregate
    ev_group = (
        ev_raw
        .groupby(["Tract_FIPS_Clean", "EV_Network(Tesla or Not)"], as_index=False)
        .agg(
            Total_DCFC=("Total DCFC Count", "sum"),
            Count_EV_Station=("Number of EV Stations", "sum"),
        )
    )

    logger.info(f"EV grouped: rows={len(ev_group)}, shape={ev_group.shape}")

    # Pivot for Count EV Station
    count_station_pivot = (
        ev_group
        .pivot(
            index="Tract_FIPS_Clean",
            columns="EV_Network(Tesla or Not)",
            values="Count_EV_Station",
        )
        .fillna(0)
    )
    count_station_pivot.columns = [
        f"Count EV Station - {c}" for c in count_station_pivot.columns
    ]

    # Pivot for DCFC
    dcfc_pivot = (
        ev_group
        .pivot(
            index="Tract_FIPS_Clean",
            columns="EV_Network(Tesla or Not)",
            values="Total_DCFC",
        )
        .fillna(0)
    )
    dcfc_pivot.columns = [
        f"Total DCFC - {c}" for c in dcfc_pivot.columns
    ]

    # Combine pivoted columns and rename ID to Tract_GeoID
    ev_features = (
        pd.concat([count_station_pivot, dcfc_pivot], axis=1)
        .reset_index()
        .rename(columns={"Tract_FIPS_Clean": "Tract_GeoID"})
    )

    logger.info(
        f"EV features (tracts with EV stations): rows={len(ev_features)}, shape={ev_features.shape}"
    )

    return ev_features

def load_cost_data(config) -> pd.DataFrame:
    """
    Load and combine Electricity, Fuel, Labor, and Land cost data.
    - Electricity (Integration_Electricity_Price.xlsx)
    - Fuel (Integration_Gas_Price.xlsx)
    - Labor (Integration_Labor_Cost.xlsx)
    - Land (Integration_Land_Price.xlsx)

    Returns
    -------
    pd.DataFrame
        Combined cost dataframe at tract level: elec_fuel_labor_land
    """
    logger = get_logger("external_data_tracts")

    external_dir = Path(config["paths"]["inputs"]["external"])

    # --------------------
    # 7) Electricity Data
    # --------------------
    elec_file = external_dir / config["filenames"]["external_electricity"]
    logger.info(f"Loading electricity data from: {elec_file}")

    _require_file(elec_file, "electricity")

    elec = read_excel(elec_file, sheet_name="Tract")

    # Ensure required columns are there
    _require_columns(
        elec,
        [
            "Tract_GeoID",
           "Tract-Price (cent/kwh)"
        ],
        context=str(elec_file),
    )

    # Normalize GEOID
    elec["Tract_GeoID"] = normalize_geoid(
        elec["Tract_GeoID"], width=11, field_name="Tract_GeoID", source=str(elec_file), strict=False, logger=logger
    )

    elec = elec[["Tract_GeoID", "Tract-Price (cent/kwh)"]]

    logger.info(f"Electricity rows: {len(elec)}, shape={elec.shape}")

    # --------------------
    # 8) Fuel Data
    # --------------------
    fuel_file = external_dir / config["filenames"]["external_gas"]
    logger.info(f"Loading fuel data from: {fuel_file}")

    _require_file(fuel_file, "fuel")

    fuel = read_excel(fuel_file, sheet_name="Tract")

    # Ensure required columns are there
    _require_columns(
        fuel,
        [
            "Tract_GeoID",
           "Tract-Regular Gas Price ($/G)"
        ],
        context=str(fuel_file),
    )

    # Normalize GEOID
    fuel["Tract_GeoID"] = normalize_geoid(
        fuel["Tract_GeoID"], width=11, field_name="Tract_GeoID", source=str(fuel_file), strict=False, logger=logger
    )

    fuel = fuel[["Tract_GeoID", "Tract-Regular Gas Price ($/G)"]]

    logger.info(f"Fuel rows: {len(fuel)}, shape={fuel.shape}")

    # Combine Electricity + Fuel
    elec_fuel = elec.merge(fuel, on="Tract_GeoID", how="outer")
    logger.info(
        f"Electricity+Fuel rows: {len(elec_fuel)}, shape={elec_fuel.shape}"
    )

    # --------------------
    # 9) Labor Cost
    # --------------------
    labor_file = external_dir / config["filenames"]["external_labor"]
    logger.info(f"Loading labor data from: {labor_file}")

    _require_file(labor_file, "labor")

    labor = read_excel(labor_file, sheet_name="Tract")

    # Ensure required columns are there
    _require_columns(
        labor,
        [
            "Tract_GeoID"
        ],
        context=str(labor_file),
    )

    # Normalize GEOID
    labor["Tract_GeoID"] = normalize_geoid(
        labor["Tract_GeoID"], width=11, field_name="Tract_GeoID", source=str(labor_file), strict=False, logger=logger
    )

    logger.info(f"Labor rows: {len(labor)}, shape={labor.shape}")

    # Electricity + Fuel + Labor
    elec_fuel_labor = elec_fuel.merge(labor, on="Tract_GeoID", how="outer")
    logger.info(
        f"Electricity+Fuel+Labor rows: {len(elec_fuel_labor)}, shape={elec_fuel_labor.shape}"
    )

    # --------------------
    # 10) Land Cost Data
    # --------------------
    land_file = external_dir / config["filenames"]["external_land"]
    logger.info(f"Loading land data from: {land_file}")

    _require_file(land_file, "land")

    land_raw = read_excel(land_file, sheet_name="Tract")

    # Ensure required columns are there
    _require_columns(
        land_raw,
        [
           "Tract_GeoID",
           "Tract-Land Value (1/4 Acre Lot, Standardized)"
        ],
        context=str(land_file),
    )

    # Normalize GEOID
    land_raw["Tract_GeoID"] = normalize_geoid(
        land_raw["Tract_GeoID"], width=11, field_name="Tract_GeoID", source=str(land_file), strict=False, logger=logger
    )

    logger.info(f"Land raw rows: {len(land_raw)}, shape={land_raw.shape}")

    # Keep only land value column, as in original:
    land = land_raw[[
        "Tract_GeoID",
        "Tract-Land Value (1/4 Acre Lot, Standardized)",
    ]]

    land_group = (
        land
        .groupby("Tract_GeoID", as_index=False)
        .agg({"Tract-Land Value (1/4 Acre Lot, Standardized)": "mean"})
    )

    logger.info(
        f"Land aggregated rows: {len(land_group)}, shape={land_group.shape}"
    )

    # Combine Land with Electricity+Fuel+Labor
    elec_fuel_labor_land = elec_fuel_labor.merge(
        land_group,
        on="Tract_GeoID",
        how="outer",
    )

    logger.info(
        "Electricity + Fuel + Labor + Land rows: %d, shape=%s",
        len(elec_fuel_labor_land),
        elec_fuel_labor_land.shape,
    )

    return elec_fuel_labor_land

# Function to load and transform risk data
def load_risk(config) -> pd.DataFrame:
    """
    Load national risk data and build numeric risk features.

    - Load Integration_National_Risk.xlsx
    - id_col = 'Tract_GeoID'
    - Drop a few unused columns
    - Map textual risk levels to numeric codes for each risk column
    - Return risk_numeric with Tract_GeoID + *_# columns
    """
    logger = get_logger("external_data_tracts")

    external_dir = Path(config["paths"]["inputs"]["external"])
    risk_file = external_dir / config["filenames"]["external_risk"]

    logger.info(f"Loading risk data from: {risk_file}")

    _require_file(risk_file, "risk")
    
    risk = read_excel(risk_file, sheet_name="Tract")

    _require_columns(risk, ["Tract_GeoID"], context=str(risk_file))

    # Normalize to 11-digit tract GEOID
    risk["Tract_GeoID"] = normalize_geoid(risk["Tract_GeoID"], width=11, field_name="Tract_GeoID", source=str(risk_file), strict=False, logger=logger)

    logger.info(f"Risk raw rows: {len(risk)}, shape={risk.shape}")

    # Drop unused columns (same as original)
    cols_to_drop = [
        "Tract - Area (SQRT Miles)",
        "Tract - Total Population",
        "County_GeoID_from_Tract",
    ]
    risk = risk.drop(columns=[c for c in cols_to_drop if c in risk.columns])

    # Map textual risk → numeric for each risk column
    risk_map = {
        "Very High": 5,
        "Relatively High": 4,
        "Relatively Moderate": 3,
        "Relatively Low": 2,
        "Very Low": 1,
    }

    risk_cols = [
        "Tract_RISK_RATNG",
        "Tract_CFLD_RISKR",
        "Tract_CWAV_RISKR",
        "Tract_ERQK_RISKR",
        "Tract_HWAV_RISKR",
        "Tract_HRCN_RISKR",
        "Tract_ISTM_RISKR",
        "Tract_RFLD_RISKR",
        "Tract_TRND_RISKR",
        "Tract_WNTW_RISKR",
    ]

    for col in risk_cols:
        num_col = f"{col}_#"
        risk[num_col] = risk[col].map(risk_map)

    # Keep only numeric risk columns and Tract_GeoID
    risk_numeric = risk[["Tract_GeoID"] + [f"{c}_#" for c in risk_cols]]

    logger.info(
        "Risk numeric rows: %d, shape=%s",
        len(risk_numeric),
        risk_numeric.shape,
    )
    return risk_numeric

# Function to merge risk data with costs
def merge_risk(costs: pd.DataFrame, risk_numeric: pd.DataFrame) -> pd.DataFrame:
    """
    Combine Risk with Electricity, Fuel, Labor, Land.

    Mirrors:
    elec_fuel_labor_land_risk = elec_fuel_labor_land.merge(risk_numeric, on='Tract_GeoID', how='outer')
    """
    logger = get_logger("external_data_tracts")

    if "Tract_GeoID" not in costs.columns:
        raise KeyError("Tract_GeoID missing in costs dataframe before risk merge.")
    if "Tract_GeoID" not in risk_numeric.columns:
        raise KeyError("Tract_GeoID missing in risk_numeric dataframe.")

    risk_costs = costs.merge(risk_numeric, on="Tract_GeoID", how="outer")

    logger.info(
        "Rows after adding Risk: %d, shape=%s",
        len(risk_costs),
        risk_costs.shape,
    )

    return risk_costs

# Function to load and transform regulation data
def load_regulation(config) -> pd.DataFrame:
    """
    Load regulatory support data at tract level.

    - Load Integration_Regulatory_Support.xlsx
    - id_col = 'Tract_GeoID'
    - Drop a few unused columns
    """
    logger = get_logger("external_data_tracts")

    external_dir = Path(config["paths"]["inputs"]["external"])
    reg_file = external_dir / config["filenames"]["external_regulation"]

    logger.info(f"Loading regulation data from: {reg_file}")

    _require_file(reg_file, "regulation")
    
    reg = read_excel(reg_file, sheet_name="Tract")

    _require_columns(reg, ["Tract_GeoID"], context=str(reg_file))

    reg["Tract_GeoID"] = normalize_geoid(reg["Tract_GeoID"], width=11, field_name="Tract_GeoID", source=str(reg_file), strict=False, logger=logger)

    logger.info("Regulation raw rows: %d, shape=%s", len(reg), reg.shape)

    cols_to_drop = ["Tract - Area (SQRT Miles)", "Tract - Total Population"]
    reg = reg.drop(columns=[c for c in cols_to_drop if c in reg.columns])

    logger.info("Regulation cleaned rows: %d, shape=%s", len(reg), reg.shape)

    return reg

# Function to merge regulation with risk and costs
def merge_regulation(risk_costs: pd.DataFrame, reg: pd.DataFrame) -> pd.DataFrame:
    """
    Add regulation features to the cost+risk block.

    Mirrors:
    elec_fuel_labor_land_risk_regulation =
        elec_fuel_labor_land_risk.merge(reg, on='Tract_GeoID', how='outer')
    """
    logger = get_logger("external_data_tracts")

    if "Tract_GeoID" not in risk_costs.columns:
        raise KeyError("Tract_GeoID missing in costs dataframe before regulation merge.")
    if "Tract_GeoID" not in reg.columns:
        raise KeyError("Tract_GeoID missing in regulation dataframe.")

    reg_risk_costs = risk_costs.merge(reg, on="Tract_GeoID", how="outer")

    logger.info(
        "Rows after adding Regulation: %d, shape=%s",
        len(reg_risk_costs),
        reg_risk_costs.shape,
    )
    return reg_risk_costs

#Function to merge ev data with regulation+risk+costs
def merge_ev(reg_risk_costs: pd.DataFrame, ev_features: pd.DataFrame) -> pd.DataFrame:
    """
    Add EV station features to the costd+risk+regulation block.

    Mirrors:
    elec_fuel_labor_land_risk_regulation_ev =
        elec_fuel_labor_land_risk_regulation.merge(ev_features, on='Tract_GeoID', how='outer')
    """
    logger = get_logger("external_data_tracts")

    if "Tract_GeoID" not in reg_risk_costs.columns:
        raise KeyError("Tract_GeoID missing in costs dataframe before EV merge.")
    if "Tract_GeoID" not in ev_features.columns:
        raise KeyError("Tract_GeoID missing in EV features dataframe.")

    ev_reg_risk_costs = reg_risk_costs.merge(ev_features, on="Tract_GeoID", how="outer")

    logger.info(
        "Rows after adding EV features: %d, shape=%s",
        len(ev_reg_risk_costs),
        ev_reg_risk_costs.shape,
    )

    return ev_reg_risk_costs

def merge_external_block(demo_climate_av_port_airport: pd.DataFrame, ev_reg_risk_costs: pd.DataFrame) -> pd.DataFrame:
    """
    Merge all external cost+risk+reg+EV features into the main tract dataframe.

    Mirrors:
    df_external = df_demo_climate_AV_port_airport.merge(
        elec_fuel_labor_land_risk_regulation_ev,
        on='Tract_GeoID',
        how='left'
    )
    """
    logger = get_logger("external_data_tracts")

    if "Tract_GeoID" not in demo_climate_av_port_airport.columns:
        raise KeyError("Tract_GeoID missing in main dataframe before external merge.")
    if "Tract_GeoID" not in ev_reg_risk_costs.columns:
        raise KeyError("Tract_GeoID missing in external costs dataframe before merge.")

    df_external = demo_climate_av_port_airport.merge(ev_reg_risk_costs, on="Tract_GeoID", how="left")

    logger.info(
        "Rows after merging external block: rows=%d, shape=%s",
        len(df_external),
        df_external.shape,
    )

    return df_external

def load_tract_customer_features(config) -> pd.DataFrame:
    """
    Build tract-level customer features (AV and Non-AV) from the 3.4 aggregations output.

    - Read Integration_Voltera_Customer_Interests_Regions_Count_SUM (Tract sheet)
    - Group by (Range_Cover, Tract_Geoid, Customer Segment)
    - Aggregate Number of Customer Sites + Total_#_Stalls
    - Pivot for AV: stalls + counts by distance
    - Pivot for Non-AV: stalls + counts by distance
    - Combine into a single wide table keyed on Tract_GeoID
    """
    logger = get_logger("external_data_tracts")

    staged_dir = Path(config["paths"]["staged"])
    tract_file = staged_dir / config["filenames"]["aggregations_refactored"]

    logger.info(f"Loading tract customer aggregation data from: {tract_file}")

    _require_file(tract_file, "tract_customer_aggregations")
    tract_raw = read_excel(tract_file, sheet_name="Tract")

    _require_columns(
        tract_raw,
        [
            "Range_Cover",
            "Tract_Geoid",
            "Customer Segment",
            "Number of Customer Sites",
            "Total_#_Stalls",
        ],
        context=str(tract_file),
    )

    # Normalize to 11-digit tract GEOID
    tract_raw["Tract_Geoid"] = normalize_geoid(tract_raw["Tract_Geoid"], width=11, field_name="Tract_Geoid", source=str(tract_file), strict=True, logger=logger)

    # Ensure Range_Cover is numeric (used to create distance-labeled output columns)
    tract_raw["Range_Cover"] = pd.to_numeric(tract_raw["Range_Cover"], errors="coerce")
    
    if tract_raw["Range_Cover"].isna().any():
        bad_examples = (
            tract_raw.loc[tract_raw["Range_Cover"].isna(), "Range_Cover"]
            .head(5)
            .tolist()
        )
        logger.error(
            "[%s] Range_Cover contains non-numeric values (examples=%s)",
            tract_file,
            bad_examples,
        )
        raise ValueError(f"[{tract_file}] Range_Cover must be numeric.")

    logger.info("Tract aggregation raw rows: %d, shape=%s", len(tract_raw), tract_raw.shape)

    # Aggregate like Tableau: Range_Cover, Tract_Geoid, Customer Segment
    group_cols = ["Range_Cover", "Tract_Geoid", "Customer Segment"]
    agg_map = {
        "Number of Customer Sites": "sum",
        "Total_#_Stalls": "sum",
    }

    tract_grp = (
        tract_raw
        .groupby(group_cols, as_index=False)
        .agg(agg_map)
    )

    logger.info("Tract aggregation grouped rows: %d, shape=%s", len(tract_grp), tract_grp.shape)

    # -------- AV only --------
    av = tract_grp[tract_grp["Customer Segment"] == "AV"].copy()

    av_stalls = (
        av.pivot_table(
            index="Tract_Geoid",
            columns="Range_Cover",
            values="Total_#_Stalls",
            aggfunc="sum",
        )
        .rename(columns=lambda r: f"Total Stall Customer - {int(r)} mile - AV")
    )

    av_counts = (
        av.pivot_table(
            index="Tract_Geoid",
            columns="Range_Cover",
            values="Number of Customer Sites",
            aggfunc="sum",
        )
        .rename(columns=lambda r: f"Count Customer - {int(r)} mile - AV")
    )

    av_wide = pd.concat([av_stalls, av_counts], axis=1).reset_index()

    # -------- Non-AV only --------
    nav = tract_grp[tract_grp["Customer Segment"] == "Non-AV"].copy()

    nav_stalls = (
        nav.pivot_table(
            index="Tract_Geoid",
            columns="Range_Cover",
            values="Total_#_Stalls",
            aggfunc="sum",
        )
        .rename(columns=lambda r: f"Total Stall Customer - {int(r)} mile - Non-AV")
    )

    nav_counts = (
        nav.pivot_table(
            index="Tract_Geoid",
            columns="Range_Cover",
            values="Number of Customer Sites",
            aggfunc="sum",
        )
        .rename(columns=lambda r: f"Count Customer - {int(r)} mile - Non-AV")
    )

    nav_wide = pd.concat([nav_stalls, nav_counts], axis=1).reset_index()

    # Combine AV + Non-AV feature sets
    customer_features = av_wide.merge(nav_wide, on="Tract_Geoid", how="outer")

    # Rename to Tract_GeoID to be consistent with rest of pipeline
    customer_features = customer_features.rename(columns={"Tract_Geoid": "Tract_GeoID"})

    # Normalize again just in case
    customer_features["Tract_GeoID"] = (
        customer_features["Tract_GeoID"].astype(str).str.zfill(11)
    )

    logger.info(
        "Customer features (AV + Non-AV) rows: %d, shape=%s",
        len(customer_features),
        customer_features.shape,
    )

    return customer_features


def merge_customer_tract(df_external: pd.DataFrame,
                            tract_customer_features: pd.DataFrame) -> pd.DataFrame:
    """
    Merge tract-level customer features (AV + Non-AV) into the main dataframe.

    Mirrors:
    df_external_with_customers =
        df_external.merge(tract_customer_features, on='Tract_GeoID', how='left')
    """
    logger = get_logger("external_data_tracts")

    if "Tract_GeoID" not in df_external.columns:
        raise KeyError("Tract_GeoID missing in main dataframe before customer merge.")
    if "Tract_GeoID" not in tract_customer_features.columns:
        raise KeyError("Tract_GeoID missing in customer_features dataframe.")

    master_tract = df_external.merge(tract_customer_features, on="Tract_GeoID", how="left")

    logger.info(
        "Rows after merging customer features: rows=%d, shape=%s",
        len(master_tract),
        master_tract.shape,
    )

    return master_tract

RENAME_MAP = {
    # Demographics
    "Tract-Median Household Income in past 12 months-Fill-NULL":
        "Median Household Income in past 12 months",
    "Tract -Percent of workers who commuted by taxicab-Fill-NULL":
        "Percent of workers who commuted by taxicab",
    "Tract - Percent of Population that is Less Than 18 Years-Fill-NULL":
        "Percent of Population that is Less Than 18 Years",
    "Tract -Percent of workers who commuted by public transportation-Fill-NULL":
        "Percent of workers who commuted by public transportation",
    "Tract-Percent with Bachelor Degree-Fill-NULL":
        "Percent with Bachelor Degree",
    "Tract - Total Population_x":
        "Total Population",
    "Tract - Population Density (#/sqrtM)":
        "Population Density (#/sqrtM)",
    "Tract-Total Households":
        "Total Households",
    "Tract-Average Weekly Wage":
        "Average Weekly Wage",

    # Funding
    "Tract_Total_Funding_Amount": "Total_Funding_Amount",
    "Tract_Federal_Funding_Amount": "Federal_Funding_Amount",
    "Tract_State_Funding_Amount": "State_Funding_Amount",
    "Tract_NEVI_Funding_Amount": "NEVI_Funding_Amount",
    "Tract_State_Funding_Awards_Count": "State_Funding_Awards_Count",
    "Tract_Federal_Funding_Awards_Count": "Federal_Funding_Awards_Count",

    # Regulatory support
    "Tract_Existing_Laws": "Existing_Laws",

    # Cost
    "Tract-Regular Gas Price ($/G)": "Regular Gas Price ($/G)",
    "Tract-Price (cent/kwh)": "Price (cent/kwh)",

    # Risk numeric
    "Tract_RISK_RATNG_#": "RISK_RATNG_#",
    "Tract_CFLD_RISKR_#": "CFLD_RISKR_#",
    "Tract_CWAV_RISKR_#": "CWAV_RISKR_#",
    "Tract_ERQK_RISKR_#": "ERQK_RISKR_#",
    "Tract_HWAV_RISKR_#": "HWAV_RISKR_#",
    "Tract_HRCN_RISKR_#": "HRCN_RISKR_#",
    "Tract_ISTM_RISKR_#": "ISTM_RISKR_#",
    "Tract_RFLD_RISKR_#": "RFLD_RISKR_#",
    "Tract_TRND_RISKR_#": "TRND_RISKR_#",
    "Tract_WNTW_RISKR_#": "WNTW_RISKR_#",

    # Land value
    "Tract-Land Value (1/4 Acre Lot, Standardized)":
        "Land Value (1/4 Acre Lot, Standardized)",

    # Climate summary features
    "Tract - Area (SQRT Miles)_x": "Area (SQRT Miles)",
    "Tract_Rain_FilledwithState": "Precipitation",
    "Tract_Snow_FilledwithState": "Snowdays",
    "Tract_Temp_FilledwithState": "Temperature",
}

def apply_tract_renaming_and_cleanup(df: pd.DataFrame) -> pd.DataFrame:
    """
    Apply final Tract-level renaming and column cleanup BEFORE NIQ merge.

    Mirrors the original notebook steps:
    - Rename Tract_* columns to clean model-friendly names
    - Drop duplicate / suffix columns (_y, etc.)
    """
    logger = get_logger("external_data_tracts")

    # 1) Rename columns
    df = df.rename(columns=RENAME_MAP)

    # 2) Drop duplicate / unwanted columns seen in original notebook
    #    (these came from joins and were explicitly removed there)
    cols_to_drop = [
        "Tract - Area (SQRT Miles)_y",
        "Tract - Total Population_y",
        "HWAV_RISKR_#",   
    ]

    cols_to_drop = [c for c in cols_to_drop if c in df.columns]

    if cols_to_drop:
        logger.info(f"Dropping redundant columns: {cols_to_drop}")
        df = df.drop(columns=cols_to_drop)

    logger.info(
        "After tract renaming/cleanup: rows=%d, shape=%s",
        len(df),
        df.shape,
    )

    return df

# Function to load and transform NIQ data
def load_niq(config) -> pd.DataFrame:
    """
    Load rideshare (NIQ) data at tract level.

    Mirrors original notebook:
    - Use Integration_NIQ.xlsx
    - id_col = 'Tract_GeoID'
    - Rename '# trips' -> '# rideshare trips'
    """
    logger = get_logger("external_data_tracts")

    external_dir = Path(config["paths"]["inputs"]["external"])
    niq_file = external_dir / config["filenames"]["external_niq"]

    logger.info(f"Loading NIQ rideshare data from: {niq_file}")

    _require_file(niq_file, "niq")
    niq = read_excel(niq_file, sheet_name="Tract")

    _require_columns(niq, ["Tract_GeoID", "# trips"], context=str(niq_file))

    niq["Tract_GeoID"] = normalize_geoid(niq["Tract_GeoID"], width=11, field_name="Tract_GeoID", source=str(niq_file), strict=False, logger=logger)

    if "# trips" in niq.columns:
        niq = niq.rename(columns={"# trips": "# rideshare trips"})

    logger.info("NIQ rideshare rows: %d, shape=%s", len(niq), niq.shape)

    return niq

# Function to merge NIQ with Tract (already combined with other external datasets)
def merge_niq(df: pd.DataFrame, niq: pd.DataFrame) -> pd.DataFrame:
    """
    Merge NIQ rideshare data into the cleaned tract-level master.

    Mirrors:
    master_tract_final = master_tract_cleaned.merge(rideshare, on='Tract_GeoID', how='left')
    """
    logger = get_logger("external_data_tracts")

    if "Tract_GeoID" not in df.columns:
        raise KeyError("Tract_GeoID missing in main dataframe before NIQ merge.")
    if "Tract_GeoID" not in niq.columns:
        raise KeyError("Tract_GeoID missing in NIQ dataframe.")

    df = df.merge(niq, on="Tract_GeoID", how="left")

    logger.info(
        "Rows after NIQ merge (master_tract_final): rows=%d, shape=%s",
        len(df),
        df.shape,
    )

    return df


def run_external_data_tracts(config: dict) -> str:
    """
    Run ETL Step 3.5: External data integration for tract-level ML features.

    Parameters
    ----------
    config : dict
        Loaded YAML config.

    Returns
    -------
    str
        Path to final master Excel file.
    """

    logger = get_logger("external_data_tracts")
    logger.info("Starting Step 3.5 – External Data Integration (Tract Level)")

    # # Resolve staged output directory
    # outputs_dir = Path(config["paths"]["staged"])
    # outputs_dir.mkdir(parents=True, exist_ok=True)

    logger.info("Loading demographic data")
    demo = load_demographics(config)
    
    logger.info("Loading climate data")
    climate = load_climate(config)
    
    logger.info("Merging demographics + climate")
    df = merge_demo_climate(demo, climate)

    logger.info("Loading AV testing data")
    av = load_av_testing(config)

    logger.info("Merging AV with demo+climate")
    df = merge_av(df, av)
    
    logger.info("Loading ports") 
    ports = load_ports(config)

    logger.info("Loading airports")
    airports = load_airports(config)

    logger.info("Merging ports + airports")
    port_air = merge_port_air(ports, airports)

    logger.info("Merging ports+airports with AV+demo+climate")
    df = merge_port_air_into_main(df, port_air)
    # this will be merged later with ev+reg+risk+costs

    #------------------------------------------------------
    logger.info("Loading cost datasets (elec, fuel, labor, land)")
    costs = load_cost_data(config)

    logger.info("Loading national risk data")
    risk = load_risk(config)

    logger.info("Merge risk with costs")
    risk_costs = merge_risk(costs, risk)
    
    logger.info("Loading regulation data")
    regulation = load_regulation(config)

    logger.info("Merge regulation with risks+costs")
    reg_risk_costs = merge_regulation(risk_costs, regulation)

    logger.info("Loading ev station data")
    ev = load_ev_stations(config)

    logger.info("Merge ev data with reg+risk+costs")
    ev_reg_risk_costs = merge_ev(reg_risk_costs, ev)
    #---------------------------------------------------------

    logger.info("Merge demo+climate+av+port+airpots with ev+reg+risk+costs")
    df = merge_external_block(df, ev_reg_risk_costs)

    #-----------------------------------------------------
    logger.info("Loading tract-level customer interest data")
    tract_customer_features = load_tract_customer_features(config)

    #--------------------------------------------------------------------------
    logger.info("Merge external datasets until this point with tract features")
    df = merge_customer_tract(df, tract_customer_features)

    #------------------------------------------------------------------------------
    logger.info("Applying tract-level column renaming and cleanup before NIQ merge")
    df = apply_tract_renaming_and_cleanup(df)
    
    #----------------------------------------
    logger.info("Loading rideshare NIQ data")
    niq = load_niq(config)

    #-------------------------------------------
    logger.info("Merge NIQ with renamed tract features")
    df = merge_niq(df, niq)

    #---------------------------------------------
    #-----------------------------------------------
     # === Final write ===
    staged_dir = Path(config["paths"]["staged"])
    out_file = config["filenames"]["master_integration_refactored"]
    out_path = staged_dir / out_file

    _require_columns(df, ["Tract_GeoID"], context="master_tract_final")
    if df.empty:
        logger.error("Final tract master dataset is empty; upstream inputs or joins likely failed.")
        raise ValueError("Final tract master dataset is empty.")

    logger.info(f"Writing final master tract integration to: {out_path}")
    staged_dir.mkdir(parents=True, exist_ok=True)

    # Sheet name must be exactly "Tract" (same as original)
    with pd.ExcelWriter(out_path, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="Tract", index=False)

    logger.info("Saved final master tract file. Rows=%d, shape=%s", len(df), df.shape)

    return out_path
