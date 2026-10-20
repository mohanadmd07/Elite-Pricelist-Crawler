"""
Pydantic v2 domain models for structured data validation and pipeline typing.
"""

from datetime import datetime
from typing import Optional, Dict, Any, List
from pydantic import BaseModel, Field, field_validator, ConfigDict


class ProcedureItem(BaseModel):
    """Represents a validated medical or clinical procedure item."""
    model_config = ConfigDict(populate_by_name=True, str_strip_whitespace=True)

    nameEnglish: str = Field(default="", description="Sanitized English name of the procedure")
    nameArabic: str = Field(default="", description="Sanitized Arabic name of the procedure")
    price: str = Field(..., description="Stringified numeric price in EGP (e.g. '1500')")
    sectionName: str = Field(..., description="Clinical department, specialty, or sheet name")
    sourceFile: str = Field(..., description="Source workbook or source URL of the item")
    code: Optional[str] = Field(default=None, description="Optional procedure catalog SKU or code")
    outsourced: Optional[bool] = Field(default=None, description="Flag for send-out / external tests")

    @field_validator("price")
    @classmethod
    def validate_price(cls, v: str) -> str:
        s = str(v).replace(",", "").replace("EGP", "").strip()
        try:
            val = float(s)
            if val <= 0:
                raise ValueError("Price must be strictly positive")
            return str(int(val)) if val.is_integer() else f"{val:.2f}".rstrip("0").rstrip(".")
        except Exception:
            raise ValueError(f"Invalid price value: {v}")

    @field_validator("nameEnglish", "nameArabic")
    @classmethod
    def check_names(cls, v: str) -> str:
        return v.strip()

    def get_dedupe_key(self) -> tuple:
        """Returns the canonical deduplication tuple."""
        return (
            self.nameEnglish.strip().lower(),
            self.nameArabic.strip(),
            self.price,
            self.sectionName.strip().lower()
        )


class CrawlRequest(BaseModel):
    """Specification for an HTTP or Browser crawl target."""
    url: str
    method: str = "GET"
    headers: Dict[str, str] = Field(default_factory=dict)
    params: Dict[str, str] = Field(default_factory=dict)
    use_browser: bool = False
    wait_selector: Optional[str] = None
    timeout: float = 30.0


class CrawlResponse(BaseModel):
    """Standardized response from web crawlers."""
    url: str
    status_code: int
    html: str
    headers: Dict[str, str] = Field(default_factory=dict)
    elapsed_seconds: float = 0.0


class BatchSummary(BaseModel):
    """Summary metrics of a batch extraction job."""
    year_or_source: str
    total_extracted: int
    duplicates_removed: int
    dropped_rows: int = 0
    output_path: Optional[str] = None
    timestamp: datetime = Field(default_factory=datetime.utcnow)
