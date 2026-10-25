"""
Pydantic v2 domain models for structured data validation and pipeline typing.
Supports additive provenance, confidence scoring, quality flags, and source inventory.
"""

from datetime import datetime
from typing import Optional, Dict, Any, List, Literal
from pydantic import BaseModel, Field, field_validator, ConfigDict


class ProcedureItem(BaseModel):
    """Represents a validated medical or clinical procedure item with provenance."""
    model_config = ConfigDict(populate_by_name=True, str_strip_whitespace=True)

    nameEnglish: str = Field(default="", description="Sanitized English name of the procedure")
    nameArabic: str = Field(default="", description="Sanitized Arabic name of the procedure")
    price: str = Field(..., description="Stringified numeric price in EGP (e.g. '1500')")
    sectionName: str = Field(..., description="Clinical department, specialty, or sheet name")
    sourceFile: str = Field(..., description="Source workbook or source URL of the item")
    code: Optional[str] = Field(default=None, description="Optional procedure catalog SKU or code")
    outsourced: Optional[bool] = Field(default=None, description="Flag for send-out / external tests")

    # Additive Provenance & Quality Metadata (Hard Constraint: Additive only, no breaking changes)
    sources: List[Dict[str, Any]] = Field(default_factory=list, description="Audit trace: file, sha256, page, bbox")
    extractor: str = Field(default="excel", description="Extraction strategy: excel | L1 | L2 | L3 | L4")
    extractorVersion: str = Field(default="1.2.0", description="Version of the extraction engine")
    confidence: float = Field(default=1.0, ge=0.0, le=1.0, description="Confidence score between 0.0 and 1.0")
    flags: List[str] = Field(default_factory=list, description="Quality flags: needs_review, price_outlier, etc.")

    @field_validator("price")
    @classmethod
    def validate_price(cls, v: str) -> str:
        s = str(v).replace(",", "").replace("EGP", "").replace("LE", "").replace("ج.م", "").strip()
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


class BatchSummary(BaseModel):
    """Summary of batch deduplication or extraction execution."""
    year_or_source: str
    total_extracted: int
    duplicates_removed: int
    output_path: Optional[str] = None


class CrawlRequest(BaseModel):
    """Specification for web spider HTTP / browser requests."""
    url: str
    method: str = "GET"
    headers: Optional[Dict[str, str]] = None
    params: Optional[Dict[str, Any]] = None
    timeout: float = 30.0
    use_browser: bool = False


class CrawlResponse(BaseModel):
    """Parsed HTTP / rendered response from web spider."""
    url: str
    status_code: int
    html: str
    headers: Dict[str, str] = Field(default_factory=dict)
    elapsed_seconds: float = 0.0


class SourceFileMetadata(BaseModel):
    """Inventory metadata for a scanned source file (Excel or PDF)."""
    file_path: str
    file_name: str
    file_type: Literal["excel", "pdf"]
    year: str
    sha256: str
    file_size_bytes: int
    page_count: int
    has_text_layer: bool
    is_scanned_only: bool
    detected_language: str = "mixed"
    layout_type: str = "table"
    last_scanned_at: str


class SourceInventory(BaseModel):
    """Catalog of all known Excel and PDF pricelist sources."""
    schemaVersion: int = 1
    generatedAt: str
    sources: List[SourceFileMetadata] = Field(default_factory=list)


class ReconciliationItem(BaseModel):
    """Reconciliation result between PDF and Excel extraction for a specific procedure."""
    year: str
    code: Optional[str] = None
    match_status: Literal["match", "price_mismatch", "missing_in_pdf", "missing_in_excel", "name_conflict"]
    excel_name: Optional[str] = None
    pdf_name: Optional[str] = None
    excel_price: Optional[float] = None
    pdf_price: Optional[float] = None
    price_diff: Optional[float] = None
    price_diff_percent: Optional[float] = None
    resolved_price: Optional[float] = None
    resolution_source: Optional[str] = None
    needs_review: bool = False


class ManualCorrectionRecord(BaseModel):
    """Persisted manual review decision from the CLI review loop."""
    sha256: str
    page: int
    row_or_code: str
    action: Literal["accept", "edit", "reject"]
    corrected_name_english: Optional[str] = None
    corrected_name_arabic: Optional[str] = None
    corrected_price: Optional[str] = None
    reviewer: str = "staff"
    reviewed_at: str
    notes: Optional[str] = None


class BuildManifest(BaseModel):
    """Atomic build manifest tracking reproducible export outputs."""
    schemaVersion: int = 2
    buildTimestamp: str
    targetYears: List[str]
    inputHashes: Dict[str, str]
    extractorVersions: Dict[str, str]
    totalExtractedRows: int
    totalCleanExportedRows: int
    totalReviewQueueRows: int
    flagSummary: Dict[str, int]
    exportChecksums: Dict[str, str]
