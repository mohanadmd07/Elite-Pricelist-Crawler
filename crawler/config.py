"""
Configuration management using Pydantic Settings.
Reads environment variables or falls back to robust production defaults.
"""

from pathlib import Path
from typing import List, Optional
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class CrawlerSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore"
    )

    # Base Paths
    BASE_DIR: Path = Path(__file__).resolve().parent.parent
    DATA_DIR: Path = BASE_DIR / "data"
    PUBLIC_DIR: Path = BASE_DIR / "public"

    # Network / HTTP Settings
    REQUEST_TIMEOUT: float = Field(default=30.0, description="HTTP request timeout in seconds")
    MAX_RETRIES: int = Field(default=4, description="Max retry attempts for failed requests")
    RETRY_BACKOFF_FACTOR: float = Field(default=1.5, description="Exponential backoff factor")
    CONCURRENT_REQUESTS: int = Field(default=5, description="Max concurrent async requests")
    DOWNLOAD_DELAY_MIN: float = Field(default=1.0, description="Minimum randomized delay between requests")
    DOWNLOAD_DELAY_MAX: float = Field(default=3.0, description="Maximum randomized delay between requests")

    # Anti-bot & Evasion
    USE_PROXY: bool = Field(default=False, description="Enable proxy rotation")
    PROXIES: List[str] = Field(default_factory=list, description="List of proxy URLs (http://user:pass@host:port)")
    VERIFY_SSL: bool = Field(default=True, description="Enforce SSL verification")

    # Target Web URLs (if crawling online healthcare pricelist portals)
    TARGET_URLS: List[str] = Field(
        default_factory=lambda: [
            "https://elitehospital.org/pricelists",
        ]
    )

    # Logging
    LOG_LEVEL: str = Field(default="INFO", description="Log level: DEBUG, INFO, WARNING, ERROR")


settings = CrawlerSettings()
