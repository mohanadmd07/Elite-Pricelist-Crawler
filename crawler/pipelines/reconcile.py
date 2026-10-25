"""
Reconciliation Pipeline between Excel and PDF Pricelists.
Cross-references catalog rows extracted from PDF and Excel files for a given year:

- Aligns rows by catalog SKU/code, then by normalized bilingual nomenclature.
- Detects matches, price discrepancies, and missing items in either source.
- Applies precedence (Excel authoritative unless explicitly marked superseded).
- Emits CSV audit report to reports/pdf_vs_excel_<year>.csv.
- Unresolved conflicts route to human review queue.
"""

import csv
from pathlib import Path
from typing import List, Dict, Tuple, Optional, Any

from crawler.config import settings
from crawler.models import ProcedureItem, ReconciliationItem
from crawler.normalizers import (
    normalize_text,
    normalize_arabic,
    parse_numeric_price,
    format_price_string,
    clean_text,
)
from crawler.utils.logger import logger


class PricelistReconciler:
    """Reconciles duplicate or parallel extractions from Excel and PDF."""

    def __init__(self, year: str, reports_dir: Optional[Path] = None):
        self.year = year
        self.reports_dir = reports_dir or (settings.BASE_DIR / "reports")
        self.reports_dir.mkdir(parents=True, exist_ok=True)

    def _make_key(self, item: ProcedureItem) -> str:
        """Computes a normalized matching key for an item."""
        if item.code and str(item.code).strip():
            return f"code:{str(item.code).strip().lower()}"
        norm_en = normalize_text(item.nameEnglish)
        norm_ar = normalize_arabic(item.nameArabic)
        return f"name:{norm_en}|{norm_ar}"

    def reconcile(
        self, excel_items: List[ProcedureItem], pdf_items: List[ProcedureItem]
    ) -> Tuple[List[ProcedureItem], List[ReconciliationItem]]:
        """
        Reconciles Excel items and PDF items:
        - Excel is default authoritative for pricing.
        - PDF provides secondary confirmation, boosting confidence to 1.0 on match.
        - Discrepancies are logged to reports/pdf_vs_excel_<year>.csv.
        """
        excel_map: Dict[str, ProcedureItem] = {}
        for item in excel_items:
            key = self._make_key(item)
            excel_map[key] = item

        pdf_map: Dict[str, ProcedureItem] = {}
        for item in pdf_items:
            key = self._make_key(item)
            pdf_map[key] = item

        all_keys = set(excel_map.keys()) | set(pdf_map.keys())
        reconciliation_records: List[ReconciliationItem] = []
        canonical_items: List[ProcedureItem] = []

        for key in sorted(all_keys):
            ex_item = excel_map.get(key)
            pdf_item = pdf_map.get(key)

            if ex_item and pdf_item:
                ex_price = parse_numeric_price(ex_item.price) or 0.0
                pdf_price = parse_numeric_price(pdf_item.price) or 0.0
                price_diff = abs(ex_price - pdf_price)

                if price_diff < 0.01:
                    # Match
                    rec = ReconciliationItem(
                        year=self.year,
                        code=ex_item.code or pdf_item.code,
                        match_status="match",
                        excel_name=ex_item.nameEnglish or ex_item.nameArabic,
                        pdf_name=pdf_item.nameEnglish or pdf_item.nameArabic,
                        excel_price=ex_price,
                        pdf_price=pdf_price,
                        price_diff=0.0,
                        price_diff_percent=0.0,
                        resolved_price=ex_price,
                        resolution_source="both",
                        needs_review=False,
                    )
                    # Merge provenance
                    merged_sources = list(ex_item.sources)
                    for s in pdf_item.sources:
                        if s not in merged_sources:
                            merged_sources.append(s)
                    ex_item.sources = merged_sources
                    ex_item.confidence = 1.0  # Dual-confirmed
                    canonical_items.append(ex_item)

                else:
                    # Price Mismatch
                    diff_pct = (price_diff / ex_price * 100.0) if ex_price > 0 else 0.0
                    rec = ReconciliationItem(
                        year=self.year,
                        code=ex_item.code or pdf_item.code,
                        match_status="price_mismatch",
                        excel_name=ex_item.nameEnglish or ex_item.nameArabic,
                        pdf_name=pdf_item.nameEnglish or pdf_item.nameArabic,
                        excel_price=ex_price,
                        pdf_price=pdf_price,
                        price_diff=price_diff,
                        price_diff_percent=round(diff_pct, 2),
                        resolved_price=ex_price,  # Precedence: Excel authoritative
                        resolution_source="excel_precedence",
                        needs_review=True,
                    )
                    ex_item.flags.append(f"price_mismatch_vs_pdf({pdf_price})")
                    ex_item.confidence = 0.85
                    canonical_items.append(ex_item)

            elif ex_item and not pdf_item:
                ex_price = parse_numeric_price(ex_item.price) or 0.0
                rec = ReconciliationItem(
                    year=self.year,
                    code=ex_item.code,
                    match_status="missing_in_pdf",
                    excel_name=ex_item.nameEnglish or ex_item.nameArabic,
                    pdf_name=None,
                    excel_price=ex_price,
                    pdf_price=None,
                    price_diff=None,
                    price_diff_percent=None,
                    resolved_price=ex_price,
                    resolution_source="excel_only",
                    needs_review=False,
                )
                canonical_items.append(ex_item)

            elif pdf_item and not ex_item:
                pdf_price = parse_numeric_price(pdf_item.price) or 0.0
                rec = ReconciliationItem(
                    year=self.year,
                    code=pdf_item.code,
                    match_status="missing_in_excel",
                    excel_name=None,
                    pdf_name=pdf_item.nameEnglish or pdf_item.nameArabic,
                    excel_price=None,
                    pdf_price=pdf_price,
                    price_diff=None,
                    price_diff_percent=None,
                    resolved_price=pdf_price,
                    resolution_source="pdf_only",
                    needs_review=True,
                )
                pdf_item.flags.append("pdf_only_candidate")
                pdf_item.confidence = min(pdf_item.confidence, 0.80)
                canonical_items.append(pdf_item)

            reconciliation_records.append(rec)

        # Export reconciliation CSV
        csv_path = self.reports_dir / f"pdf_vs_excel_{self.year}.csv"
        with open(csv_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow([
                "Year", "Code", "Status", "Excel Name", "PDF Name",
                "Excel Price", "PDF Price", "Diff EGP", "Diff %",
                "Resolved Price", "Source", "Needs Review"
            ])
            for r in reconciliation_records:
                writer.writerow([
                    r.year, r.code or "", r.match_status, r.excel_name or "", r.pdf_name or "",
                    r.excel_price or "", r.pdf_price or "", r.price_diff or "", r.price_diff_percent or "",
                    r.resolved_price or "", r.resolution_source or "", "YES" if r.needs_review else "NO"
                ])

        logger.info(
            f"Reconciliation for {self.year}: {len(reconciliation_records)} aligned rows "
            f"written to {csv_path}"
        )
        return canonical_items, reconciliation_records
