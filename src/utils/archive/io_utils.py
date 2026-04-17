"""
I/O utilities for reading/writing data files.
"""

import pandas as pd
from pathlib import Path


def read_csv(path: str | Path) -> pd.DataFrame:
    """
    Read a CSV file with safe defaults.
    """
    path = Path(path)
    return pd.read_csv(path)


def read_excel(path: str | Path, sheet_name=0) -> pd.DataFrame:
    """
    Read an Excel file.
    """
    path = Path(path)
    return pd.read_excel(path, sheet_name=sheet_name)


def write_csv(df, path: str | Path) -> str:
    """
    Write DataFrame to CSV.
    """
    path = Path(path)
    df.to_csv(path, index=False)
    return str(path)
