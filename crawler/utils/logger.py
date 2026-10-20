"""
Centralized structured logger with Rich console styling and file logging.
"""

import sys
import logging
from rich.logging import RichHandler
from crawler.config import settings


def get_logger(name: str = "EliteCrawler") -> logging.Logger:
    """Configures and returns a structured logger instance."""
    logger = logging.getLogger(name)
    if not logger.handlers:
        logger.setLevel(getattr(logging, settings.LOG_LEVEL.upper(), logging.INFO))
        
        console_handler = RichHandler(
            rich_tracebacks=True,
            markup=True,
            show_time=True,
            show_path=False
        )
        formatter = logging.Formatter("%(message)s", datefmt="[%X]")
        console_handler.setFormatter(formatter)
        logger.addHandler(console_handler)
        logger.propagate = False
        
    return logger


logger = get_logger()
