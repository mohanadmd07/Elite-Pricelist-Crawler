"""
Review Loop and Corrections Manager.
Persists human corrections and verified overrides to data/pdf_corrections.json,
keyed by (sha256, page, row_or_code).
Applies saved decisions idempotently during rebuild runs.
"""

import json
from pathlib import Path
from datetime import datetime, timezone
from typing import Dict, List, Optional, Any, Tuple

from crawler.config import settings
from crawler.models import ProcedureItem, ManualCorrectionRecord
from crawler.utils.logger import logger


class CorrectionsManager:
    """Manages manual overrides and reviewer decisions for pricelist extractions."""

    def __init__(self, corrections_path: Optional[Path] = None):
        self.corrections_path = corrections_path or (settings.BASE_DIR / "data" / "pdf_corrections.json")
        self.corrections: Dict[str, ManualCorrectionRecord] = self._load()

    def _make_key(self, sha256: str, page: int, row_or_code: str) -> str:
        """Constructs unique dictionary lookup key."""
        return f"{sha256}:{page}:{str(row_or_code).strip()}"

    def _load(self) -> Dict[str, ManualCorrectionRecord]:
        """Loads corrections from disk."""
        if not self.corrections_path.exists():
            return {}
        try:
            with open(self.corrections_path, "r", encoding="utf-8") as f:
                raw = json.load(f)
            records = {}
            for k, v in raw.items():
                records[k] = ManualCorrectionRecord(**v)
            return records
        except Exception as e:
            logger.warning(f"Could not load corrections from {self.corrections_path}: {e}")
            return {}

    def save(self):
        """Atomically saves corrections dictionary to disk."""
        self.corrections_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.corrections_path.with_suffix(".tmp")
        data = {k: v.model_dump() for k, v in self.corrections.items()}
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        tmp.replace(self.corrections_path)

    def record_decision(
        self,
        sha256: str,
        page: int,
        row_or_code: str,
        action: str,  # accept | edit | reject
        corrected_name_en: Optional[str] = None,
        corrected_name_ar: Optional[str] = None,
        corrected_price: Optional[str] = None,
        reviewer: str = "staff",
        notes: Optional[str] = None,
    ) -> ManualCorrectionRecord:
        """Records a human review decision."""
        rec = ManualCorrectionRecord(
            sha256=sha256,
            page=page,
            row_or_code=row_or_code,
            action=action,
            corrected_name_english=corrected_name_en,
            corrected_name_arabic=corrected_name_ar,
            corrected_price=corrected_price,
            reviewer=reviewer,
            reviewed_at=datetime.now(timezone.utc).isoformat(),
            notes=notes,
        )
        key = self._make_key(sha256, page, row_or_code)
        self.corrections[key] = rec
        self.save()
        logger.info(f"Recorded correction decision for {key}: action={action}")
        return rec

    def apply_corrections(
        self, items: List[ProcedureItem]
    ) -> Tuple[List[ProcedureItem], List[ProcedureItem]]:
        """
        Applies saved decisions to an extracted list of ProcedureItems.
        Returns (retained_items, rejected_items).
        """
        retained: List[ProcedureItem] = []
        rejected: List[ProcedureItem] = []

        for item in items:
            # Determine item's key coordinates from sources
            sha256 = ""
            page = 0
            if item.sources and len(item.sources) > 0:
                s = item.sources[0]
                sha256 = s.get("sha256", "")
                page = s.get("page", 0)

            row_or_code = item.code or item.nameEnglish or item.nameArabic
            key = self._make_key(sha256, page, row_or_code)

            if key in self.corrections:
                decision = self.corrections[key]
                if decision.action == "reject":
                    rejected.append(item)
                    continue
                elif decision.action == "accept":
                    item.confidence = 1.0
                    item.flags = [f for f in item.flags if f != "needs_review"]
                elif decision.action == "edit":
                    if decision.corrected_name_english:
                        item.nameEnglish = decision.corrected_name_english
                    if decision.corrected_name_arabic:
                        item.nameArabic = decision.corrected_name_arabic
                    if decision.corrected_price:
                        item.price = decision.corrected_price
                    item.confidence = 1.0
                    item.flags = [f for f in item.flags if f != "needs_review"]

            retained.append(item)

        return retained, rejected
