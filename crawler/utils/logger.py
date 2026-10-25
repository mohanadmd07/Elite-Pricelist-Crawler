"""
Centralized structured logger with Rich console styling, JSON formatting,
and automated PHI redaction filter.
"""

import re
import os
import json
import logging
from datetime import datetime, timezone
from rich.logging import RichHandler
from crawler.config import settings

PHI_PATTERNS = [
    (re.compile(r"\b01[0125]\d{8}\b"), "[REDACTED_PHONE]"),
    (re.compile(r"\b[23]\d{13}\b"), "[REDACTED_NATIONAL_ID]"),
    (re.compile(r"(?:MRN|الملف|رقم الملف)\s*[:=]\s*[A-Za-z0-9_-]+", re.IGNORECASE), "MRN: [REDACTED_MRN]"),
    (re.compile(r"(?:Patient(?:\s*Name)?|المريض|اسم المريض)\s*[:=]\s*[\w\s\u0600-\u06FF]+", re.IGNORECASE), "Patient: [REDACTED_NAME]"),
]


class PhiRedactionFilter(logging.Filter):
    """Scans and masks Egyptian healthcare PHI before emission to any sink."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            msg = record.msg
            for pattern, repl in PHI_PATTERNS:
                msg = pattern.sub(repl, msg)
            record.msg = msg

        if record.args:
            if isinstance(record.args, dict):
                cleaned_args = {}
                for k, v in record.args.items():
                    if isinstance(v, str):
                        for pattern, repl in PHI_PATTERNS:
                            v = pattern.sub(repl, v)
                    cleaned_args[k] = v
                record.args = cleaned_args
            elif isinstance(record.args, tuple):
                cleaned_tuple = []
                for v in record.args:
                    if isinstance(v, str):
                        for pattern, repl in PHI_PATTERNS:
                            v = pattern.sub(repl, v)
                    cleaned_tuple.append(v)
                record.args = tuple(cleaned_tuple)
        return True


class JsonFormatter(logging.Formatter):
    """Outputs structured single-line JSON logs."""

    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)


def get_logger(name: str = "EliteCrawler") -> logging.Logger:
    """Configures and returns a structured logger instance."""
    logger_instance = logging.getLogger(name)
    if not logger_instance.handlers:
        logger_instance.setLevel(getattr(logging, settings.LOG_LEVEL.upper(), logging.INFO))

        # Add PHI filter
        phi_filter = PhiRedactionFilter()
        logger_instance.addFilter(phi_filter)

        is_json = os.getenv("LOG_FORMAT") == "json" or os.getenv("ENV") == "production"

        if is_json:
            handler = logging.StreamHandler()
            handler.setFormatter(JsonFormatter())
            handler.addFilter(phi_filter)
            logger_instance.addHandler(handler)
        else:
            console_handler = RichHandler(
                rich_tracebacks=True,
                markup=True,
                show_time=True,
                show_path=False,
            )
            formatter = logging.Formatter("%(message)s", datefmt="[%X]")
            console_handler.setFormatter(formatter)
            console_handler.addFilter(phi_filter)
            logger_instance.addHandler(console_handler)

        logger_instance.propagate = False

    return logger_instance


logger = get_logger()
