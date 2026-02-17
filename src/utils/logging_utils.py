"""
Basic logging utilities for ETL and ML pipelines.
"""

import logging
from pathlib import Path


def get_logger(name: str, log_dir: str | Path = "logs") -> logging.Logger:
    """
    Create and return a logger with file + console handlers.

    Parameters
    ----------
    name : str
        Name of the logger (usually module name).
    log_dir : str or Path
        Directory where log files will be written.

    Returns
    -------
    logging.Logger
    """
    log_dir = Path(log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)

    logger = logging.getLogger(name)
    logger.setLevel(logging.INFO)

    if not logger.handlers:
        # File handler
        fh = logging.FileHandler(log_dir / f"{name}.log")
        fh.setLevel(logging.INFO)

        # Console handler
        ch = logging.StreamHandler()
        ch.setLevel(logging.INFO)

        formatter = logging.Formatter(
            "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
        )
        fh.setFormatter(formatter)
        ch.setFormatter(formatter)

        logger.addHandler(fh)
        logger.addHandler(ch)

    return logger
