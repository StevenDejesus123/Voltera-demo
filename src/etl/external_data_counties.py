"""
External Data Integration for County Level (Step 3.5) - phase 2 report.

This module builds the county-level master integration dataset by
combining demographics, climate, AV testing, ports, airports, EV stations,
costs (electric, fuel, labor, land), risk, regulation, and customer features, and then attaching rideshare (NIQ) metrics.

The final output is a single wide table keyed on County_GeoID suitable
for downstream ML models.
"""

from pathlib import Path
from typing import Dict, List, Iterable, Sequence

import pandas as pd

from src.utils.io_utils import read_excel
from src.utils.logging_utils import get_logger


def _require_file(path: Path, context: str) -> None:
    """Fail fast if an expected input file is missing."""
    if not path.exists():
        logger = get_logger("external_data_counties")
        logger.error("[%s] Missing required input file: %s", context, path)
        raise FileNotFoundError(f"[{context}] Missing required input file: {path}")

def _require_columns(df: pd.DataFrame, required: Sequence[str], context: str) -> None:
    """Validate required columns exist before downstream transformations."""
    missing = [c for c in required if c not in df.columns]
    if missing:
        logger = get_logger("external_data_counties")
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
    
logger = get_logger("external_data_counties")


# ---------------------------------------------------------------------------
# Column renaming for final county master table
# ---------------------------------------------------------------------------

COUNTY_RENAME_MAP: Dict[str, str] = {
    # Demographics
    "County-Median Household Income in past 12 months-Fill-NULL": "Median Household Income in past 12 months",
    "County-Percent of workers who commuted by taxicab": "Percent of workers who commuted by taxicab",
    "County-Percent of Population that is Less Than 18 Years": "Percent of Population that is Less Than 18 Years",
    "County-Percent of workers who commuted by public transportation": "Percent of workers who commuted by public transportation",
    "County-Percent of Population 25 Years and Over whose Highest Education Completed is Bachelor's Degree or Higher": "Percent with Bachelor Degree",
    "County-Total Population_x": "Total Population",
    "County-Population Density (#/sqrtM)": "Population Density (#/sqrtM)",
    "County-Total Households": "Total Households",
    "County-Average Weekly Wage": "Average Weekly Wage",

    # Funding
    "County_Total_Funding_Amount": "Total_Funding_Amount",
    "County_Federal_Funding_Amount": "Federal_Funding_Amount",
    "County_State_Funding_Amount": "State_Funding_Amount",
    "County_NEVI_Funding_Amount": "NEVI_Funding_Amount",
    "County_State_Funding_Awards_Count": "State_Funding_Awards_Count",
    "County_Federal_Funding_Awards_Count": "Federal_Funding_Awards_Count",

    # Regulatory support
    "County_Existing_Laws": "Existing_Laws",

    # Costs
    "County-Regular Gas Price ($/G)": "Regular Gas Price ($/G)",
    "County-Price (cent/kwh)": "Price (cent/kwh)",

    # Risk numeric
    "County_RISK_RATNG_#": "RISK_RATNG_#",
    "County_CFLD_RISKR_#": "CFLD_RISKR_#",
    "County_CWAV_RISKR_#": "CWAV_RISKR_#",
    "County_ERQK_RISKR_#": "ERQK_RISKR_#",
    # "County_HWAV_RISKR_#": "HWAV_RISKR_#",  # commented in original
    "County_HRCN_RISKR_#": "HRCN_RISKR_#",
    "County_ISTM_RISKR_#": "ISTM_RISKR_#",
    "County_RFLD_RISKR_#": "RFLD_RISKR_#",
    "County_TRND_RISKR_#": "TRND_RISKR_#",
    "County_WNTW_RISKR_#": "WNTW_RISKR_#",

    # Land
    "County-Land Value (1/4 Acre Lot, Standardized)": "Land Value (1/4 Acre Lot, Standardized)",

    # Climate summary features
    "County-Area (SQRT Miles)_x": "Area (SQRT Miles)",
    "County_Rain_FilledwithState": "Precipitation",
    "County_Snow_FilledwithState": "Snowdays",
    "County_Temp_FilledwithState": "Temperature",
}


RISK_MAP: Dict[str, int] = {
    "Very High": 5,
    "Relatively High": 4,
    "Relatively Moderate": 3,
    "Relatively Low": 2,
    "Very Low": 1,
}


# ---------------------------------------------------------------------------
# Loaders for external datasets
# ---------------------------------------------------------------------------

def load_demographics(config: dict) -> pd.DataFrame:
    """Load county-level demographics with a normalized County_GeoID."""
    external_dir = Path(config["paths"]["inputs"]["external"])
    demo_file = external_dir / config["filenames"]["external_demographic"]

    # Ensure the required file is present
    _require_file(demo_file, "demographics")

    logger.info("Loading county demographics from: %s", demo_file)
    demo = read_excel(demo_file, sheet_name="County")
    
    # Ensure the required columns are present
    _require_columns(demo, ["County_GeoID"], context=str(demo_file))

    # Normalize to 5-digit county GEOID
    demo["County_GeoID"] = normalize_geoid(demo["County_GeoID"], width=5, field_name="County_GeoID", source=str(demo_file), strict=True, logger=logger)
    
    logger.info("Demographics rows: %d, shape=%s", len(demo), demo.shape)
    return demo


def load_climate(config: dict) -> pd.DataFrame:
    """Load and aggregate county-level climate data."""
    external_dir = Path(config["paths"]["inputs"]["external"])
    climate_file = external_dir / config["filenames"]["external_climate"]

    logger.info("Loading county climate from: %s", climate_file)
    
    # Ensure the required file is present
    _require_file(climate_file, "climate")
    climate_raw = read_excel(climate_file, sheet_name="County")
    
    # Ensure the required columns are present
    _require_columns(climate_raw, ["County_GeoID"], context=str(climate_file))

    # Normalize to 5-digit county GEOID
    climate_raw["County_GeoID"] = normalize_geoid(climate_raw["County_GeoID"], width=5, field_name="County_GeoID", source=str(climate_file), strict=False, logger=logger)

    agg_cols: List[str] = [c for c in climate_raw.columns if c != "County_GeoID"]
    climate = (
        climate_raw
        .groupby("County_GeoID", as_index=False)[agg_cols]
        .mean(numeric_only=True)
    )

    logger.info(
        "Climate rows after aggregation: rows=%d, shape=%s",
        len(climate),
        climate.shape,
    )
    return climate


def merge_demo_climate(demo: pd.DataFrame, climate: pd.DataFrame) -> pd.DataFrame:
    """Merge demographics and climate on County_GeoID."""
    df = demo.merge(climate, on="County_GeoID", how="inner")
    logger.info(
        "Rows after demo + climate merge: rows=%d, shape=%s",
        len(df),
        df.shape,
    )
    return df


def load_av_testing(config: dict) -> pd.DataFrame:
    """Load AV testing data and build county-level AV features."""
    external_dir = Path(config["paths"]["inputs"]["external"])
    av_file = external_dir / config["filenames"]["external_avtesting"]

    logger.info("Loading AV testing data from: %s", av_file)

    # Ensure the required file is present
    _require_file(av_file, "av testing")
    av_raw = read_excel(av_file, sheet_name="County")
    
    # Ensure the required columns are present
    _require_columns(av_raw, 
                     ["County_GeoID", "Range_Cover","Count AV Testing Sites",
                      "Number of Vehicles in Operation (Approx.)"
                     ], 
                     context=str(av_file))

    # Normalize to 5-digit county GEOID
    av_raw["County_GeoID"] = normalize_geoid(av_raw["County_GeoID"], width=5, field_name="County_GeoID", source=str(av_file), strict=False, logger=logger)
    

    # Fill missing vehicle counts with 1 as in the original logic
    av_raw["Number of Vehicle_Filled"] = (
        av_raw["Number of Vehicles in Operation (Approx.)"].fillna(1)
    )

    av_group = (
        av_raw
        .groupby(["County_GeoID", "Range_Cover"], as_index=False)
        .agg(
            Number_of_Vehicle_Filled=("Number of Vehicle_Filled", "sum"),
            Number_of_AV_Testing_Sites=("Count AV Testing Sites", "sum"),
        )
    )

    logger.info(
        "AV grouped rows: rows=%d, shape=%s",
        len(av_group),
        av_group.shape,
    )

    sites_pivot = (
        av_group
        .pivot(
            index="County_GeoID",
            columns="Range_Cover",
            values="Number_of_AV_Testing_Sites",
        )
        .fillna(0)
    )
    sites_pivot.columns = [
        f"Count AV Testing - {c} mile" for c in sites_pivot.columns
    ]

    vehicles_pivot = (
        av_group
        .pivot(
            index="County_GeoID",
            columns="Range_Cover",
            values="Number_of_Vehicle_Filled",
        )
        .fillna(0)
    )
    vehicles_pivot.columns = [
        f"# of AV Testing Vehicles - {c} mile" for c in vehicles_pivot.columns
    ]

    av_features = (
        pd.concat([sites_pivot, vehicles_pivot], axis=1)
        .reset_index()
    )

    logger.info(
        "AV features rows (counties with AV testing): rows=%d, shape=%s",
        len(av_features),
        av_features.shape,
    )
    return av_features


def merge_av(df: pd.DataFrame, av_features: pd.DataFrame) -> pd.DataFrame:
    """Merge AV testing features into demo+climate dataframe."""
    df = df.merge(av_features, on="County_GeoID", how="left")
    logger.info(
        "Rows after merging demo, climate, AV Testing: rows=%d, shape=%s",
        len(df),
        df.shape,
    )
    return df


def load_ports(config: dict) -> pd.DataFrame:
    """Load and pivot port interaction data at county level."""
    external_dir = Path(config["paths"]["inputs"]["external"])
    port_file = external_dir / config["filenames"]["external_ports"]

    logger.info("Loading port data from: %s", port_file)
    
    # Ensure the required file is present
    _require_file(port_file, "ports")
    ports_raw = read_excel(port_file, sheet_name="County")
    
    # Ensure the required columns are present
    _require_columns(ports_raw, 
                     ["County_GeoID", "Buffer Miles", "Count of Ports", 
                      "Total Port Volume","Tonnage"
                     ], 
                     context=str(port_file))

    # Normalize to 5-digit county GEOID
    ports_raw["County_GeoID"] = normalize_geoid(ports_raw["County_GeoID"], width=5, field_name="County_GeoID", source=str(port_file), strict=False, logger=logger)
    
    ports_raw = ports_raw.rename(
        columns={
            "Total Port Volume": "Total TEU",
            "Tonnage": "Total Tonnage",
        }
    )

    ports_group = (
        ports_raw
        .groupby(["County_GeoID", "Buffer Miles"], as_index=False)
        .agg(
            Count_Ports=("Count of Ports", "sum"),
            Total_TEU=("Total TEU", "sum"),
            Total_Tonnage=("Total Tonnage", "sum"),
        )
    )

    logger.info(
        "Ports grouped rows: rows=%d, shape=%s",
        len(ports_group),
        ports_group.shape,
    )

    ton_pivot = (
        ports_group
        .pivot(index="County_GeoID", columns="Buffer Miles", values="Total_Tonnage")
        .fillna(0)
    )
    ton_pivot.columns = [f"Total Tonnage - {c} mile" for c in ton_pivot.columns]

    teu_pivot = (
        ports_group
        .pivot(index="County_GeoID", columns="Buffer Miles", values="Total_TEU")
        .fillna(0)
    )
    teu_pivot.columns = [f"Total TEU - {c} mile" for c in teu_pivot.columns]

    count_pivot = (
        ports_group
        .pivot(index="County_GeoID", columns="Buffer Miles", values="Count_Ports")
        .fillna(0)
    )
    count_pivot.columns = [f"Count Port - {c} mile" for c in count_pivot.columns]

    ports_features = (
        pd.concat([ton_pivot, teu_pivot, count_pivot], axis=1)
        .reset_index()
    )

    logger.info(
        "Ports features rows (counties with ports): rows=%d, shape=%s",
        len(ports_features),
        ports_features.shape,
    )
    return ports_features


def load_airports(config: dict) -> pd.DataFrame:
    """Load and pivot airport interaction data at county level."""
    external_dir = Path(config["paths"]["inputs"]["external"])
    airport_file = external_dir / config["filenames"]["external_airports"]

    logger.info("Loading airport data from: %s", airport_file)
    
    # Ensure the required file is present
    _require_file(airport_file, "airports")
    airport_raw = read_excel(airport_file, sheet_name="County")
    
    # Ensure the required columns are present
    _require_columns(airport_raw, 
                     ["County_GeoID", "Buffer Miles", "Total_Landed_Weight_lbs_2018", 
                      "Count MajorAirports"
                     ], 
                     context=str(airport_file))

    # Normalize to 5-digit county GEOID
    airport_raw["County_GeoID"] = normalize_geoid(airport_raw["County_GeoID"], width=5, field_name="County_GeoID", source=str(airport_file), strict=False, logger=logger)
    
    airport_group = (
        airport_raw
        .groupby(["County_GeoID", "Buffer Miles"], as_index=False)
        .agg(
            Total_Landed_Weight=("Total_Landed_Weight_lbs_2018", "sum"),
            Count_Airports=("Count MajorAirports", "sum"),
        )
    )

    logger.info(
        "Airport grouped rows: rows=%d, shape=%s",
        len(airport_group),
        airport_group.shape,
    )

    land_pivot = (
        airport_group
        .pivot(
            index="County_GeoID",
            columns="Buffer Miles",
            values="Total_Landed_Weight",
        )
        .fillna(0)
    )
    land_pivot.columns = [
        f"Total Airport Land Weight - {c} mile" for c in land_pivot.columns
    ]

    count_pivot = (
        airport_group
        .pivot(
            index="County_GeoID",
            columns="Buffer Miles",
            values="Count_Airports",
        )
        .fillna(0)
    )
    count_pivot.columns = [
        f"Count Airport - {c} mile" for c in count_pivot.columns
    ]

    airport_features = pd.concat([land_pivot, count_pivot], axis=1).reset_index()

    logger.info(
        "Airport features rows (counties with airports): rows=%d, shape=%s",
        len(airport_features),
        airport_features.shape,
    )
    return airport_features


def build_port_air_features(
    ports_features: pd.DataFrame,
    airport_features: pd.DataFrame,
) -> pd.DataFrame:
    """Combine port and airport features on County_GeoID."""
    port_air = airport_features.merge(
        ports_features,
        on="County_GeoID",
        how="outer",
    )
    logger.info(
        "Port+Airport features rows: rows=%d, shape=%s",
        len(port_air),
        port_air.shape,
    )
    return port_air


def merge_port_air(df: pd.DataFrame, port_air_features: pd.DataFrame) -> pd.DataFrame:
    """Merge port+airport features into main dataframe."""
    df = df.merge(port_air_features, on="County_GeoID", how="left")
    logger.info(
        "Rows after merging port+airport with demo+climate+av: rows=%d, shape=%s",
        len(df),
        df.shape,
    )
    return df


def load_ev_stations(config: dict) -> pd.DataFrame:
    """Load and build EV charging features at county level."""
    external_dir = Path(config["paths"]["inputs"]["external"])
    ev_file = external_dir / config["filenames"]["external_ev_stations"]

    logger.info("Loading EV station data from: %s", ev_file)
    
    # Ensure the required file is present
    _require_file(ev_file, "ev stations")
    ev_raw = read_excel(ev_file, sheet_name="County")
    
    # Ensure the required columns are present
    _require_columns(ev_raw, 
                     ["County_GeoID", "EV_Network  (Tesla or Not)", "Total DCFC Count", 
                      "Count EV Stations"
                     ], 
                     context=str(ev_file))

    # Normalize to 5-digit county GEOID
    ev_raw["County_GeoID"] = normalize_geoid(ev_raw["County_GeoID"], width=5, field_name="County_GeoID", source=str(ev_file), strict=False, logger=logger)
    
    # Column name in the original data includes spaces around the parentheses
    network_col = "EV_Network  (Tesla or Not)"

    ev_group = (
        ev_raw
        .groupby(["County_GeoID", network_col], as_index=False)
        .agg(
            Total_DCFC=("Total DCFC Count", "sum"),
            Count_EV_Station=("Count EV Stations", "sum"),
        )
    )

    logger.info(
        "EV grouped rows: rows=%d, shape=%s",
        len(ev_group),
        ev_group.shape,
    )

    count_station_pivot = (
        ev_group
        .pivot(
            index="County_GeoID",
            columns=network_col,
            values="Count_EV_Station",
        )
        .fillna(0)
    )
    count_station_pivot.columns = [
        f"Count EV Station - {c}" for c in count_station_pivot.columns
    ]

    dcfc_pivot = (
        ev_group
        .pivot(
            index="County_GeoID",
            columns=network_col,
            values="Total_DCFC",
        )
        .fillna(0)
    )
    dcfc_pivot.columns = [
        f"Total DCFC - {c}" for c in dcfc_pivot.columns
    ]

    ev_features = (
        pd.concat([count_station_pivot, dcfc_pivot], axis=1)
        .reset_index()
    )

    logger.info(
        "EV features rows (counties with EV stations): rows=%d, shape=%s",
        len(ev_features),
        ev_features.shape,
    )
    return ev_features


def load_cost_data(config: dict) -> pd.DataFrame:
    """Load electricity, fuel, labor, and land cost data merged on Clean_County_GeoID."""
    external_dir = Path(config["paths"]["inputs"]["external"])

    # Electricity
    elec_file = external_dir / config["filenames"]["external_electricity"]
    logger.info("Loading electricity data from: %s", elec_file)
    
    # Ensure the required file is present
    _require_file(elec_file, "electricity")
    elec = read_excel(elec_file, sheet_name="County")
    
    # Ensure the required columns are present
    _require_columns(elec, 
                     ["Clean_County_GeoID", "County-Price (cent/kwh)"
                     ], 
                     context=str(elec_file))

    # Normalize to 5-digit county GEOID
    elec["Clean_County_GeoID"] = normalize_geoid(elec["Clean_County_GeoID"], width=5, field_name="Clean_County_GeoID", source=str(elec_file), strict=False, logger=logger)
       
    elec = elec[["Clean_County_GeoID", "County-Price (cent/kwh)"]]
    logger.info("Electricity rows: %d, shape=%s", len(elec), elec.shape)

    ## ------Fuel--------
    fuel_file = external_dir / config["filenames"]["external_gas"]
    logger.info("Loading fuel data from: %s", fuel_file)
    
    # Ensure the required file is present
    _require_file(fuel_file, "fuel")
    fuel = read_excel(fuel_file, sheet_name="County")
    
    # Ensure the required columns are present
    _require_columns(fuel, 
                     ["Clean_County_GeoID", "County-Regular Gas Price ($/G)"
                     ], 
                     context=str(fuel_file))

    # Normalize to 5-digit county GEOID
    fuel["Clean_County_GeoID"] = normalize_geoid(fuel["Clean_County_GeoID"], width=5, field_name="Clean_County_GeoID", source=str(fuel_file), strict=False, logger=logger)
    
    fuel = fuel[["Clean_County_GeoID", "County-Regular Gas Price ($/G)"]]
    logger.info("Fuel rows: %d, shape=%s", len(fuel), fuel.shape)

     # Merge Electricity + Fuel
    elec_fuel = elec.merge(
        fuel,
        on="Clean_County_GeoID",
        how="outer",
    )
    logger.info(
        "Electricity+Fuel rows: rows=%d, shape=%s",
        len(elec_fuel),
        elec_fuel.shape,
    )

    # Labor
    labor_file = external_dir / config["filenames"]["external_labor"]
    logger.info("Loading labor data from: %s", labor_file)

    # Ensure the required file is present
    _require_file(labor_file, "labor")
    labor = read_excel(labor_file, sheet_name="County")
    
    # Ensure the required columns are present
    _require_columns(labor, 
                     ["Clean_County_GeoID"
                     ], 
                     context=str(labor_file))

    # Normalize to 5-digit county GEOID
    labor["Clean_County_GeoID"] = normalize_geoid(labor["Clean_County_GeoID"], width=5, field_name="Clean_County_GeoID", source=str(labor_file), strict=False, logger=logger)
       
    logger.info("Labor rows: %d, shape=%s", len(labor), labor.shape)

    # Merge Electricity+Fuel+Labor
    elec_fuel_labor = elec_fuel.merge(
        labor,
        on="Clean_County_GeoID",
        how="outer",
    )
    logger.info(
        "Electricity+Fuel+Labor rows: rows=%d, shape=%s",
        len(elec_fuel_labor),
        elec_fuel_labor.shape,
    )

    # Land
    land_file = external_dir / config["filenames"]["external_land"]
    logger.info("Loading land cost data from: %s", land_file)

    # Ensure the required file is present
    _require_file(land_file, "land")
    land_raw = read_excel(land_file, sheet_name="County")
    
    # Ensure the required columns are present
    _require_columns(land_raw, 
                     ["Clean_County_GeoID", 
                      "County-Land Value (1/4 Acre Lot, Standardized)"
                     ], 
                     context=str(land_file))

    # Normalize to 5-digit county GEOID
    land_raw["Clean_County_GeoID"] = normalize_geoid(land_raw["Clean_County_GeoID"], width=5, field_name="Clean_County_GeoID", source=str(land_file), strict=False, logger=logger)
       
    land_group = land_raw[
        ["Clean_County_GeoID", "County-Land Value (1/4 Acre Lot, Standardized)"]
    ].copy()

    logger.info(
        "Land rows: rows=%d, shape=%s",
        len(land_group),
        land_group.shape,
    )

    # Merge Elec+Fuel+Labor+Land
    elec_fuel_labor_land = elec_fuel_labor.merge(
        land_group,
        on="Clean_County_GeoID",
        how="outer",
    )
    
    logger.info(
        "Electricity+Fuel+Labor+Land rows: rows=%d, shape=%s",
        len(elec_fuel_labor_land),
        elec_fuel_labor_land.shape,
    )

    return elec_fuel_labor_land


def load_risk(config: dict) -> pd.DataFrame:
    """Load national risk data and compute numeric risk scores per county."""
    external_dir = Path(config["paths"]["inputs"]["external"])
    risk_file = external_dir / config["filenames"]["external_risk"]

    logger.info("Loading risk data from: %s", risk_file)
    
    # Ensure the required file is present
    _require_file(risk_file, "risk")
    risk = read_excel(risk_file, sheet_name="County")
    
    # Ensure the required columns are present
    _require_columns(risk, 
                     ["Clean_County_GeoID"
                     ], 
                     context=str(risk_file))

    # Normalize to 5-digit county GEOID
    risk["Clean_County_GeoID"] = normalize_geoid(risk["Clean_County_GeoID"], width=5, field_name="Clean_County_GeoID", source=str(risk_file), strict=False, logger=logger)
    
    cols_to_drop = ["County - Area (SQRT Miles)", "County - Total Population"]
    risk = risk.drop(columns=[c for c in cols_to_drop if c in risk.columns])

    risk_cols: List[str] = [
        "County_RISK_RATNG",
        "County_CFLD_RISKR",
        "County_CWAV_RISKR",
        "County_ERQK_RISKR",
        # "County_HWAV_RISKR",  # left out as in the original
        "County_HRCN_RISKR",
        "County_ISTM_RISKR",
        "County_RFLD_RISKR",
        "County_TRND_RISKR",
        "County_WNTW_RISKR",
    ]

    for col in risk_cols:
        if col in risk.columns:
            num_col = f"{col}_#"
            risk[num_col] = risk[col].map(RISK_MAP)

    numeric_cols = [f"{c}_#" for c in risk_cols if f"{c}_#" in risk.columns]
    risk_numeric = risk[["Clean_County_GeoID"] + numeric_cols]

    logger.info(
        "Risk numeric rows: rows=%d, shape=%s",
        len(risk_numeric),
        risk_numeric.shape,
    )
    return risk_numeric


def merge_risk(costs: pd.DataFrame, risk: pd.DataFrame) -> pd.DataFrame:
    """Combine risk scores with cost block on Clean_County_GeoID."""
    merged = costs.merge(
        risk,
        on="Clean_County_GeoID",
        how="outer",
    )
    logger.info(
        "Costs+Risk rows: rows=%d, shape=%s",
        len(merged),
        merged.shape,
    )
    return merged


def load_regulation(config: dict) -> pd.DataFrame:
    """Load regulatory support data at county level keyed by Clean_County_GeoID."""
    external_dir = Path(config["paths"]["inputs"]["external"])
    reg_file = external_dir / config["filenames"]["external_regulation"]

    logger.info("Loading regulation data from: %s", reg_file)
    
    # Ensure the required file is present
    _require_file(reg_file, "reg")
    reg = read_excel(reg_file, sheet_name="County")
    
    # Ensure the required columns are present
    _require_columns(reg, 
                     ["Clean_County_GeoID"
                     ], 
                     context=str(reg_file))

    # Normalize to 5-digit county GEOID
    reg["Clean_County_GeoID"] = normalize_geoid(reg["Clean_County_GeoID"], width=5, field_name="Clean_County_GeoID", source=str(reg_file), strict=False, logger=logger)
    
    cols_to_drop = ["County-Area (SQRT Miles)", "County-Total Population"]
    reg = reg.drop(columns=[c for c in cols_to_drop if c in reg.columns])

    logger.info(
        "Regulation rows: rows=%d, shape=%s",
        len(reg),
        reg.shape,
    )
    return reg


def merge_regulation(costs_risk: pd.DataFrame, reg: pd.DataFrame) -> pd.DataFrame:
    """Merge regulation with cost+risk block and rename key to County_GeoID."""
    merged = costs_risk.merge(
        reg,
        on="Clean_County_GeoID",
        how="outer",
    )

    if "Clean_County_GeoID" in merged.columns:
        merged = merged.rename(columns={"Clean_County_GeoID": "County_GeoID"})

    logger.info(
        "Costs+Risk+Regulation rows: rows=%d, shape=%s",
        len(merged),
        merged.shape,
    )
    return merged


def merge_ev_block(
    costs_risk_reg: pd.DataFrame,
    ev_features: pd.DataFrame,
) -> pd.DataFrame:
    """Merge EV station features into cost+risk+regulation block."""
    if "County_GeoID" not in costs_risk_reg.columns:
        raise KeyError("Expected 'County_GeoID' in costs+risk+regulation block")

    merged = costs_risk_reg.merge(
        ev_features,
        on="County_GeoID",
        how="left",
    )
    logger.info(
        "Costs+Risk+Reg+EV rows: rows=%d, shape=%s",
        len(merged),
        merged.shape,
    )
    return merged


def merge_external_block(
    df_main: pd.DataFrame,
    ev_costs_risk_reg: pd.DataFrame,
) -> pd.DataFrame:
    """Merge the combined external block into the main county dataframe."""
    if "County_GeoID" not in df_main.columns:
        raise KeyError("Expected 'County_GeoID' in main dataframe")
    if "County_GeoID" not in ev_costs_risk_reg.columns:
        raise KeyError("Expected 'County_GeoID' in external block")

    df = df_main.merge(
        ev_costs_risk_reg,
        on="County_GeoID",
        how="left",
    )
    logger.info(
        "Rows after merging ev+reg+risk+costs with demo+climate+port+airport: rows=%d, shape=%s",
        len(df),
        df.shape,
    )
    return df


def load_county_customer_features(config: dict) -> pd.DataFrame:
    """Build county-level customer distance features from 3.4 aggregations output."""
    staged_dir = Path(config["paths"]["staged"])
    county_file = staged_dir / config["filenames"]["aggregations_refactored"]

    logger.info("Loading county aggregation data from: %s", county_file)
    

    # Ensure the required file is present
    _require_file(county_file, "county_customer_aggregations")
    county_raw = read_excel(county_file, sheet_name="County")
    
    # Ensure the required columns are present
    _require_columns(county_raw, 
                     ["County_GeoID", "Range_Cover", "Customer Segment",
                      "Count_Customer_Sites", "Total_Stalls_Filled"
                     ], 
                     context=str(county_file))

    # Normalize to 5-digit county GEOID
    county_raw["County_GeoID"] = normalize_geoid(county_raw["County_GeoID"], width=5, field_name="County_GeoID", source=str(county_file), strict=False, logger=logger)
    
    group_cols = ["Range_Cover", "County_GeoID", "Customer Segment"]
    agg_map = {
        "Count_Customer_Sites": "sum",
        "Total_Stalls_Filled": "sum",
    }

    county_grp = (
        county_raw[group_cols + list(agg_map.keys())]
        .groupby(group_cols, as_index=False)
        .agg(agg_map)
    )

    logger.info(
        "County grouped rows: rows=%d, shape=%s",
        len(county_grp),
        county_grp.shape,
    )

    # AV
    av = county_grp[county_grp["Customer Segment"] == "AV"].copy()

    av_stalls = (
        av.pivot_table(
            index="County_GeoID",
            columns="Range_Cover",
            values="Total_Stalls_Filled",
            aggfunc="sum",
        )
        .rename(columns=lambda r: f"Total Stall Customer - {int(r)} mile - AV")
    )

    av_counts = (
        av.pivot_table(
            index="County_GeoID",
            columns="Range_Cover",
            values="Count_Customer_Sites",
            aggfunc="sum",
        )
        .rename(columns=lambda r: f"Count Customer - {int(r)} mile - AV")
    )

    av_wide = pd.concat([av_stalls, av_counts], axis=1).reset_index()

    # Non-AV
    nav = county_grp[county_grp["Customer Segment"] == "Non-AV"].copy()

    nav_stalls = (
        nav.pivot_table(
            index="County_GeoID",
            columns="Range_Cover",
            values="Total_Stalls_Filled",
            aggfunc="sum",
        )
        .rename(columns=lambda r: f"Total Stall Customer - {int(r)} mile - Non-AV")
    )

    nav_counts = (
        nav.pivot_table(
            index="County_GeoID",
            columns="Range_Cover",
            values="Count_Customer_Sites",
            aggfunc="sum",
        )
        .rename(columns=lambda r: f"Count Customer - {int(r)} mile - Non-AV")
    )

    nav_wide = pd.concat([nav_stalls, nav_counts], axis=1).reset_index()

    customer_features = av_wide.merge(
        nav_wide,
        on="County_GeoID",
        how="outer",
    )

    logger.info(
        " County Customer features (AV + Non-AV) rows: rows=%d, shape=%s",
        len(customer_features),
        customer_features.shape,
    )
    return customer_features


def merge_customer_features(
    df: pd.DataFrame,
    customer_features: pd.DataFrame,
) -> pd.DataFrame:
    """Merge county-level customer distance features into main dataframe."""
    if "County_GeoID" not in df.columns:
        raise KeyError("Expected 'County_GeoID' in main dataframe before customer merge")
    if "County_GeoID" not in customer_features.columns:
        raise KeyError("Expected 'County_GeoID' in customer features dataframe")

    df = df.merge(
        customer_features,
        on="County_GeoID",
        how="outer",
    )
    logger.info(
        "Rows after merging customer features: rows=%d, shape=%s",
        len(df),
        df.shape,
    )
    return df


def apply_county_renaming_and_cleanup(df: pd.DataFrame) -> pd.DataFrame:
    """Apply final county-level renaming and drop redundant columns before NIQ merge."""
    df = df.rename(columns=COUNTY_RENAME_MAP)

    cols_to_drop = [
        "County-Area (SQRT Miles)_y",
        "County-Total Population_y",
    ]
    cols_to_drop = [c for c in cols_to_drop if c in df.columns]

    if cols_to_drop:
        logger.info("Dropping redundant columns: %s", cols_to_drop)
        df = df.drop(columns=cols_to_drop)

    logger.info(
        "After county renaming/cleanup: rows=%d, shape=%s",
        len(df),
        df.shape,
    )
    return df


def load_niq(config: dict) -> pd.DataFrame:
    """Load rideshare (NIQ) data at county level."""
    external_dir = Path(config["paths"]["inputs"]["external"])
    niq_file = external_dir / config["filenames"]["external_niq"]

    logger.info("Loading NIQ data from: %s", niq_file)
    
    # Ensure the required file is present
    _require_file(niq_file, "niq")
    niq = read_excel(niq_file, sheet_name="County")
    
    # Ensure the required columns are present
    _require_columns(niq, 
                     ["County_GeoID", "# trips"
                     ], 
                     context=str(niq_file))

    # Normalize to 5-digit county GEOID
    niq["County_GeoID"] = normalize_geoid(niq["County_GeoID"], width=5, field_name="County_GeoID", source=str(niq_file), strict=False, logger=logger)
    
    if "# trips" in niq.columns:
        niq = niq.rename(columns={"# trips": "# rideshare trips"})

    logger.info(
        "NIQ rows: rows=%d, shape=%s",
        len(niq),
        niq.shape,
    )
    return niq


def merge_niq(df: pd.DataFrame, niq: pd.DataFrame) -> pd.DataFrame:
    """Merge NIQ rideshare metrics into the county master table."""
    if "County_GeoID" not in df.columns:
        raise KeyError("Expected 'County_GeoID' in main dataframe before NIQ merge")
    if "County_GeoID" not in niq.columns:
        raise KeyError("Expected 'County_GeoID' in NIQ dataframe")

    merged = df.merge(
        niq,
        on="County_GeoID",
        how="left",
    )
    logger.info(
        "Rows after NIQ merge: rows=%d, shape=%s",
        len(merged),
        merged.shape,
    )
    return merged


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def run_external_data_counties(config: dict) -> str:
    """
    Run ETL Step 3.5: External data integration for County-level ML features.

    Parameters
    ----------
    config : dict
        Loaded YAML config.

    Returns
    -------
    str
        Path to final master Excel file.
    """
    logger = get_logger("external_data_counties")
    
    logger.info("Starting county-level external data integration (Step 3.5 - County)")

    # 1) Demographics + climate
    demo = load_demographics(config)
    climate = load_climate(config)
    df = merge_demo_climate(demo, climate)

    # 2) AV testing
    av_features = load_av_testing(config)
    df = merge_av(df, av_features)

    # 3) Ports + airports
    ports_features = load_ports(config)
    airport_features = load_airports(config)
    port_air_features = build_port_air_features(ports_features, airport_features)
    df = merge_port_air(df, port_air_features)

    # 4) EV stations
    ev_features = load_ev_stations(config)

    # 5) Costs, risk, regulation
    costs = load_cost_data(config)
    risk = load_risk(config)
    costs_risk = merge_risk(costs, risk)
    reg = load_regulation(config)
    costs_risk_reg = merge_regulation(costs_risk, reg)

    # 6) Add EV to costs_risk_reg then merge into main df
    ev_costs_risk_reg = merge_ev_block(costs_risk_reg, ev_features)
    df = merge_external_block(df, ev_costs_risk_reg)

    # 7) County customer distance features (from 3.4 output)
    customer_features = load_county_customer_features(config)
    df = merge_customer_features(df, customer_features)

    # 8) Apply final renaming/cleanup before NIQ
    df = apply_county_renaming_and_cleanup(df)

    # 9) NIQ rideshare
    niq = load_niq(config)
    df = merge_niq(df, niq)

    # 10) Final write
    staged_dir = Path(config["paths"]["staged"])
    out_file = config["filenames"]["master_integration_refactored"]
    out_path = staged_dir / out_file

    _require_columns(df, ["County_GeoID"], context="master_county_final")
    if df.empty:
        logger.error("Final county master dataset is empty; upstream inputs or joins likely failed.")
        raise ValueError("Final county master dataset is empty.")
        
    logger.info("Writing final county master integration to: %s", out_path)
    staged_dir.mkdir(parents=True, exist_ok=True)

    if not out_path.exists():
        raise FileNotFoundError(
            f"Expected master workbook not found at {out_path}. "
            "Tract-level output must be created before running county aggregation."
        )

    with pd.ExcelWriter(
        out_path, 
        engine="openpyxl", 
        mode= "a",
        if_sheet_exists="replace"
        ) as writer:
        df.to_excel(writer, sheet_name="County", index=False)

    logger.info(
        "Saved final county master file. rows=%d, shape=%s",
        len(df),
        df.shape,
    )

    return str(out_path)
